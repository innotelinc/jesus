#!/usr/bin/env python3
"""The engine's HTTP door: what it is, and one way to hand it a page.

Telno's Fax screen asks `/status` before it offers to send anything, and refuses
to queue a document when the engine answers but has no registered modem — a fax
machine with no line. That is why the modem's registration is the first thing
this reports: it is the difference between "the engine is up" and "a fax could
actually leave".

`POST /send` takes a TIFF as the request body with the destination in
`x-fax-to`. It is deliberately the same shape as `sendfax`, because HylaFAX is
what does the sending: the API is a door onto the spool, not a second fax
implementation.
"""
import json
import os
import re
import subprocess
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPOOL = Path(os.environ.get("FAX_SPOOL", "/var/spool/hylafax"))
TOKEN = os.environ.get("FAX_ENGINE_TOKEN", "")
PORT = int(os.environ.get("FAX_ENGINE_PORT", "8080"))
DEVICES = [d.strip() for d in os.environ.get("FAX_MODEMS", "ttyIAX0,ttyIAX1").split(",") if d.strip()]
STATION = os.environ.get("FAX_STATION_ID", "Telno")
NUMBER = os.environ.get("FAX_NUMBER", "")


def run(*cmd, timeout=10):
    """A subprocess whose failure is data, not an exception."""
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout.strip(), done.stderr.strip()
    except Exception as err:  # noqa: BLE001 - whatever went wrong is the answer
        return 1, "", str(err)


def asterisk(*args):
    code, out, _ = run("asterisk", "-rx", " ".join(args), timeout=6)
    return out if code == 0 else ""


def registrations():
    """Which modem peers are registered, from the IAX2 server itself.

    iaxmodem is the client and Asterisk the server, so "registered" here means
    the modem process is alive and authenticated — not merely that a config file
    exists.
    """
    rows = {}
    for line in asterisk("iax2", "show", "registry").splitlines()[1:]:
        fields = line.split()
        if len(fields) < 6:
            continue
        username, state = fields[2], fields[-1]
        rows[username] = {
            "host": fields[0],
            "state": state,
            "registered": state.lower().startswith("registered"),
        }
    return rows


def links():
    """Peer reachability, which catches a registered modem whose UDP path died."""
    rows = {}
    for line in asterisk("iax2", "show", "peers").splitlines():
        match = re.match(r"^(iax\d+)(?:/\S+)?\s+(\S+)\s+\(S\)\s+\S+\s+(\d+)\s+(.*)$", line)
        if match:
            rows[match.group(1)] = {
                "address": match.group(2),
                "port": match.group(3),
                "status": match.group(4).strip(),
            }
    return rows


def hylafax():
    faxq = run("pgrep", "-x", "faxq")[0] == 0
    hfaxd = run("pgrep", "-x", "hfaxd")[0] == 0
    _, version, _ = run("dpkg-query", "-W", "-f=${Version}", "hylafax-server")
    return {"ready": faxq, "faxq": faxq, "hfaxd": hfaxd, "version": version or None}


def counts():
    def tiffs(folder):
        try:
            return sorted(p.name for p in (SPOOL / folder).glob("*.tif*"))
        except OSError:
            return []

    return {
        "recvq": len(tiffs("recvq")),
        "sendq": len(tiffs("sendq")),
        "doneq": len(tiffs("doneq")),
    }


def modems():
    """The modem is alive when the peer answers the switch's own poke.

    These peers are static (host and port are in iax.conf), so a registration is
    not what makes a modem reachable and iaxmodem's registration attempt is
    refused by a modern Asterisk. The honest liveness signal is the IAX2
    qualify: OK or LAGGED means the iaxmodem process holds that port and
    answered, UNREACHABLE means the tty exists but nothing is behind it.
    """
    registered, reachable = registrations(), links()
    out = []
    for index, device in enumerate(DEVICES):
        peer = "iax%d" % index
        reg = registered.get(peer, {})
        link = reachable.get(peer, {})
        status = (link.get("status") or "").upper()
        alive = bool(reg.get("registered")) or status.startswith(("OK", "LAGGED"))
        out.append(
            {
                "device": "/dev/%s" % device,
                "peer": peer,
                "registered": alive,
                "state": reg.get("state") if reg.get("registered") else (link.get("status") or "unknown"),
                "address": link.get("address"),
                "port": link.get("port"),
            }
        )
    return out


def status():
    m = modems()
    fax = hylafax()
    serving = bool(m) and any(x["registered"] for x in m)
    return {
        "engine": "iax+hylafax",
        "station": STATION,
        "number": NUMBER,
        "serving": serving and fax["ready"],
        # Telno reads `modem`; `modems` is here so a two-modem engine can say
        # which one is dead instead of flattening both into one state.
        "modem": m[0] if m else {"device": None, "registered": False, "state": "no modem configured"},
        "modems": m,
        "hylafax": fax,
        "spool": counts(),
        "uptime": int(time.time() - STARTED),
    }


STARTED = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = "telno-fax-engine"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the container log readable
        print("[fax] %s %s" % (self.address_string(), fmt % args), flush=True)

    def send_json(self, code, body):
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def authorised(self):
        if not TOKEN:
            return True
        return self.headers.get("x-fax-token", "") == TOKEN

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/healthz", "/health"):
            return self.send_json(200, {"ok": True})
        if path in ("/status", "/"):
            if not self.authorised():
                return self.send_json(401, {"error": "unauthorized"})
            return self.send_json(200, status())
        if path == "/jobs":
            if not self.authorised():
                return self.send_json(401, {"error": "unauthorized"})
            code, out, _ = run("faxstat", "-s")
            return self.send_json(200, {"jobs": out.splitlines() if code == 0 else [], "ok": code == 0})
        return self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] not in ("/send", "/fax"):
            return self.send_json(404, {"error": "not found"})
        if not self.authorised():
            return self.send_json(401, {"error": "unauthorized"})
        to = re.sub(r"\D", "", self.headers.get("x-fax-to", ""))
        if not to:
            return self.send_json(400, {"error": "x-fax-to must carry the destination number"})
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            return self.send_json(400, {"error": "a TIFF document is required"})
        body = self.rfile.read(length)
        if not body.startswith((b"II*\x00", b"MM\x00*")):
            return self.send_json(415, {"error": "the body is not a TIFF"})

        SPOOL.joinpath("tmp").mkdir(parents=True, exist_ok=True)
        staged = SPOOL / "tmp" / ("api-%s.tif" % uuid.uuid4().hex)
        staged.write_bytes(body)
        args = ["sendfax", "-n", "-d", to]
        sender = re.sub(r"\D", "", self.headers.get("x-fax-from", "")) or NUMBER
        if sender:
            args += ["-f", sender]
        args.append(str(staged))
        code, out, err = run(*args, timeout=30)
        try:
            staged.unlink()
        except OSError:
            pass
        if code != 0:
            return self.send_json(502, {"error": err or out or "sendfax refused the document"})
        match = re.search(r"request id is (\d+)", out)
        return self.send_json(202, {"ok": True, "job": match.group(1) if match else None, "output": out})


if __name__ == "__main__":
    print("[fax] status door on :%d" % PORT, flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
