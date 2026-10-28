#!/usr/bin/env python3
"""Capstone phone node — two-way SMS gateway for Termux.

One process, two directions:

  OUTBOUND (Capstone -> phone)
    POST /sms/            Authorization: Bearer <key>
                          {"number": "+15551234567", "text": "hello"}
    -> 200 {"stat": true, "transport": "phone"}

    The modem is tried first. When it refuses (no SIM, no credit, no
    permission) and a PJSIP fallback is configured, the message is re-sent as
    a SIP MESSAGE over Asterisk pjsip instead, and `transport` says which path
    carried it. Configure the fallback with PJSIP_SMS_HOST/USER/PASSWORD (and
    optionally PJSIP_SMS_PORT/DOMAIN/TO). Set SMS_FALLBACK=none to disable it.

  INBOUND (phone -> Capstone)
    termux-sms-list is polled; new inbox messages are POSTed to Capstone's
    /sms-inbound with a bearer token, so replies become visible without Zeus.
    Enable with --forward-url (or FORWARD_URL), token from
    CAPSTONE_SMS_INBOUND_TOKEN. Each message carries a stable id, so a retry
    after a failed forward is deduplicated by the receiver.

    The very first poll records the existing inbox as already-seen and forwards
    nothing — pointing this at a phone with a year of messages should not fire
    a year of webhooks. Use --forward-backlog to override.

Contract details kept from OpenSMS, because Capstone's client and Settings card
depend on them: `GET /health` (no auth) answers 200 ready / 503 not-ready,
`POST /sms/` answers 200 with {"stat": true|false} and an `error` on refusal,
and a bad key is a 401 {"detail": "Invalid or expired API key"}.

Termux setup is in phone-node/install-termux.sh; the architecture and the
phone-vs-host split are in docs/phone-node.md.

Usage:
    python3 opensms_termux_bridge.py --key-file ~/.opensms-bridge/key
    python3 opensms_termux_bridge.py --key-file ~/.opensms-bridge/key \
        --forward-url https://capstone.lan:8443/api/sms-inbound --poll-seconds 20
    python3 opensms_termux_bridge.py --key-file ~/.opensms-bridge/key --check
"""

import argparse
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sip_message  # noqa: E402  (sibling module, not a package)

DEFAULT_PORT = 9292
DEFAULT_BIND = "0.0.0.0"
MAX_BODY = 8 * 1024
SEND_TIMEOUT_S = 45
BACKEND = "termux"

SMS_BIN = "termux-sms-send"
LIST_BIN = "termux-sms-list"
SMS_OVERRIDE_ENV = "TERMUX_SMS_SEND"
LIST_OVERRIDE_ENV = "TERMUX_SMS_LIST"
FALLBACK_ENV = "SMS_FALLBACK"          # chain (default) | phone | none
FORWARD_URL_ENV = "FORWARD_URL"
FORWARD_TOKEN_ENV = "CAPSTONE_SMS_INBOUND_TOKEN"
SEEN_LIMIT = 500


class Refused(Exception):
    """The phone declined to send; carried to the client as `error`."""


# ── process helpers ─────────────────────────────────────────────────────────
def _run(cmd, timeout=SEND_TIMEOUT_S):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError:
        raise Refused(f"{cmd[0]} not found — install the Termux:API app and `pkg install termux-api`")
    except subprocess.TimeoutExpired:
        raise Refused(f"{cmd[0]} timed out after {timeout}s")
    return proc.returncode, (proc.stdout or "").strip(), (proc.stderr or "").strip()


def _prefix(env_var, default_binary):
    """argv prefix, honouring the documented JSON-array test/override hook."""
    raw = (os.environ.get(env_var) or "").strip()
    if not raw:
        return [default_binary]
    try:
        prefix = json.loads(raw)
    except ValueError:
        raise SystemExit(f'{env_var} must be a JSON array, e.g. \'["/usr/bin/tool", "--flag"]\'')
    if not isinstance(prefix, list) or not prefix or not all(isinstance(p, str) for p in prefix):
        raise SystemExit(f"{env_var} must be a non-empty JSON array of strings")
    return prefix


def sms_prefix():
    return _prefix(SMS_OVERRIDE_ENV, SMS_BIN)


def list_prefix():
    return _prefix(LIST_OVERRIDE_ENV, LIST_BIN)


def _available(binary):
    if os.sep in binary or (os.altsep and os.altsep in binary):
        return os.path.isfile(binary) and os.access(binary, os.X_OK)
    return shutil.which(binary) is not None


# ── outbound transports ─────────────────────────────────────────────────────
def phone_ready():
    binary = sms_prefix()[0]
    if not _available(binary):
        return False, (f"{binary} not found — pkg install termux-api (and the Termux:API app), "
                       f"or point {SMS_OVERRIDE_ENV} at another sender")
    return True, ""


def pjsip_ready():
    """(client or None, detail)."""
    try:
        client = sip_message.client_from_env()
    except sip_message.SipError as exc:
        return None, f"pjsip fallback misconfigured: {exc}"
    if client is None:
        return None, "pjsip fallback not configured (PJSIP_SMS_HOST/USER/PASSWORD)"
    return client, ""


def send_via_phone(number, text):
    prefix = sms_prefix()
    # -n takes the recipient; the body is positional, so a leading dash cannot
    # become a flag.
    rc, out, err = _run(prefix + ["-n", number, text])
    if rc != 0:
        raise Refused(err or out or f"{prefix[0]} exited {rc}")
    return "phone"


def send_via_pjsip(number, text, client=None):
    client = client or pjsip_ready()[0]
    if client is None:
        raise Refused(pjsip_ready()[1])
    domain = (os.environ.get("PJSIP_SMS_DOMAIN") or client.host).strip()
    template = (os.environ.get("PJSIP_SMS_TO") or "sip:{number}@" + domain).strip()
    try:
        client.send(template.format(number=number), text)
    except sip_message.SipError as exc:
        raise Refused(f"pjsip: {exc}")
    return "pjsip"


def send(number, text):
    """Send via the configured chain. Returns {'stat': True, 'transport': ...}."""
    number = str(number or "").strip()
    text = str(text or "")
    if not number:
        raise Refused("recipient number must not be empty")
    if not text:
        raise Refused("SMS body must not be empty")

    mode = (os.environ.get(FALLBACK_ENV) or "chain").strip().lower()
    reasons = []

    if mode in ("chain", "phone"):
        try:
            return {"stat": True, "transport": send_via_phone(number, text)}
        except Refused as exc:
            reasons.append(f"phone: {exc}")
            if mode == "phone":
                raise Refused("; ".join(reasons))

    if mode in ("chain", "pjsip"):
        client, detail = pjsip_ready()
        if client is None:
            reasons.append(detail)
        else:
            try:
                return {"stat": True, "transport": send_via_pjsip(number, text, client)}
            except Refused as exc:
                reasons.append(str(exc))

    raise Refused("; ".join(r for r in reasons if r) or "no transport could send")


# ── inbound: poll the inbox, forward to Capstone ────────────────────────────
def _state_path(path=None):
    return os.path.expanduser(path or os.environ.get("INBOUND_STATE")
                              or "~/.opensms-bridge/inbound-state.json")


def load_seen(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {"initialised": False, "ids": []}
    except (OSError, ValueError):
        return {"initialised": False, "ids": []}


def save_seen(path, state):
    ids = state.get("ids", [])[-SEEN_LIMIT:]
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"initialised": bool(state.get("initialised")), "ids": ids}, fh)
    os.replace(tmp, path)
    state["ids"] = ids


def message_id(msg):
    raw = "|".join(str(msg.get(k, "")) for k in ("number", "date", "body"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def parse_inbox(raw):
    """Termux's `termux-sms-list` JSON -> inbox messages, newest last."""
    try:
        rows = json.loads(raw or "[]")
    except ValueError:
        return []
    out = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        if str(row.get("type", "")).lower() != "inbox":
            continue
        out.append({
            "id": message_id(row),
            "from": str(row.get("number", "")),
            "body": str(row.get("body", "")),
            "received_at": str(row.get("date", "")),
            "sim": row.get("sim_slot", 0),
        })
    return out


def _post_json(url, payload, token, timeout=15):
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-Capstone-SMS-Token"] = token
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status


def poll_once(forward_url=None, token=None, state_file=None, forward_backlog=False,
              list_limit=25, sink=None):
    """One poll cycle. Returns a summary dict; never raises for a bad poll.

    `sink` is (url, token) -> status, injectable so the cycle is testable
    without a network.
    """
    forward_url = forward_url or os.environ.get(FORWARD_URL_ENV, "")
    token = token if token is not None else os.environ.get(FORWARD_TOKEN_ENV, "")
    state_file = _state_path(state_file)
    state = load_seen(state_file)
    summary = {"listed": 0, "new": 0, "forwarded": 0, "failed": 0, "error": ""}

    if not forward_url:
        summary["error"] = "no forward URL configured"
        return summary

    prefix = list_prefix()
    if not _available(prefix[0]):
        summary["error"] = f"{prefix[0]} not available — pkg install termux-api"
        return summary
    try:
        rc, out, err = _run(prefix + ["-l", str(int(list_limit))], timeout=20)
    except Refused as exc:
        summary["error"] = str(exc)
        return summary
    if rc != 0:
        summary["error"] = err or out or f"{prefix[0]} exited {rc}"
        return summary

    messages = parse_inbox(out)
    summary["listed"] = len(messages)
    seen = set(state.get("ids", []))

    if not state.get("initialised") and not forward_backlog:
        # First run: adopt the existing inbox as the baseline.
        state["initialised"] = True
        state["ids"] = list(seen | {m["id"] for m in messages})[-SEEN_LIMIT:]
        save_seen(state_file, state)
        summary["error"] = "baseline recorded; existing messages not forwarded"
        return summary

    post = sink or (lambda url, payload, tok: _post_json(url, payload, tok))
    for msg in messages:
        if msg["id"] in seen:
            continue
        summary["new"] += 1
        try:
            post(forward_url, msg, token)
        except Exception as exc:  # noqa: BLE001 - a failed forward must retry next cycle
            summary["failed"] += 1
            summary["error"] = f"forward failed: {exc}"
            continue
        seen.add(msg["id"])
        summary["forwarded"] += 1

    state["initialised"] = True
    state["ids"] = list(seen)[-SEEN_LIMIT:]
    save_seen(state_file, state)
    return summary


class InboxPoller(threading.Thread):
    def __init__(self, interval, **kwargs):
        super().__init__(daemon=True)
        self.interval = max(5, int(interval))
        self.kwargs = kwargs
        self._stop = threading.Event()
        self.last = {"listed": 0, "new": 0, "forwarded": 0, "failed": 0, "error": ""}
        self.last_success = 0.0

    def run(self):
        while not self._stop.is_set():
            try:
                self.last = poll_once(**self.kwargs)
                if self.last.get("forwarded"):
                    self.last_success = time.time()
                if self.last.get("error"):
                    print(f"inbound: {self.last['error']}", file=sys.stderr, flush=True)
            except Exception as exc:  # noqa: BLE001 - the poller must never die
                self.last = {"listed": 0, "new": 0, "forwarded": 0, "failed": 0,
                             "error": f"poll crashed: {exc}"}
                print(f"inbound: poll crashed: {exc}", file=sys.stderr, flush=True)
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


# ── HTTP surface ────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "capstone-phone-node"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the key out of the log
        sink = getattr(self.server, "log_sink", None)
        if sink is None:
            return
        try:
            sink.write("%s %s\n" % (self.address_string(), fmt % args))
            sink.flush()
        except (OSError, ValueError):
            pass

    def _json(self, code, payload, close=False):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _path(self):
        return urllib.parse.urlsplit(self.path).path

    def _authorised(self):
        expected = getattr(self.server, "api_key", "")
        scheme, _, presented = (self.headers.get("Authorization") or "").partition(" ")
        if scheme.lower() != "bearer" or not expected:
            return False
        return hmac.compare_digest(presented.strip(), expected)

    def do_GET(self):
        path = self._path().rstrip("/") or "/"
        if path == "/":
            return self._json(200, {"gateway": "capstone-phone-node", "backend": BACKEND,
                                    "routes": ["POST /sms/", "GET /health"]})
        if path == "/health":
            ready, detail = phone_ready()
            client, fallback_detail = pjsip_ready()
            poller = getattr(self.server, "poller", None)
            payload = {
                "gateway": "capstone-phone-node",
                "backend": BACKEND,
                "ready": ready,
                "transports": {
                    "phone": {"ready": ready, **({"detail": detail} if detail else {})},
                    "pjsip": {"ready": client is not None, "detail": fallback_detail},
                },
                "inbound": {
                    "enabled": poller is not None,
                    "last": poller.last if poller else None,
                    "last_success": poller.last_success if poller else 0,
                },
            }
            if detail:
                payload["detail"] = detail
            return self._json(200 if ready else 503, payload)
        return self._json(404, {"detail": "not found"})

    def do_POST(self):
        path = self._path().rstrip("/")
        if path != "/sms":
            return self._json(404, {"detail": "not found"}, close=True)
        if not self._authorised():
            return self._json(401, {"detail": "Invalid or expired API key"}, close=True)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"stat": False, "error": "bad Content-Length"}, close=True)
        if length > MAX_BODY:
            return self._json(413, {"stat": False, "error": "body too large"}, close=True)

        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"stat": False, "error": "body must be JSON"}, close=True)
        if not isinstance(body, dict):
            return self._json(400, {"stat": False, "error": "body must be a JSON object"}, close=True)

        started = time.monotonic()
        try:
            payload = send(body.get("number"), body.get("text", body.get("sub_text", "")))
        except Refused as exc:
            payload = {"stat": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - never 500 on caller input
            payload = {"stat": False, "error": f"unexpected: {exc}"}

        self.log_message("POST /sms/ -> stat=%s transport=%s in %.2fs",
                         payload.get("stat"), payload.get("transport"),
                         time.monotonic() - started)
        return self._json(200, payload, close=True)


def build_server(bind, port, api_key, log_sink=None, poller=None):
    srv = ThreadingHTTPServer((bind, port), Handler)
    srv.daemon_threads = True
    srv.api_key = api_key
    srv.log_sink = log_sink
    srv.poller = poller
    return srv


# ── CLI ─────────────────────────────────────────────────────────────────────
def load_key(args):
    if args.key:
        return args.key.strip()
    path = os.path.expanduser(args.key_file or "~/.opensms-bridge/key")
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        raise SystemExit(
            f"cannot read API key from {path}: {exc}\n"
            "Run phone-node/install-termux.sh first, or pass --key / --key-file."
        )


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Capstone phone node — two-way SMS gateway for Termux",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--bind", default=DEFAULT_BIND)
    ap.add_argument("--port", type=int, default=int(os.environ.get("OPENSMS_PORT") or DEFAULT_PORT))
    ap.add_argument("--key", default=os.environ.get("OPENSMS_API_KEY", ""))
    ap.add_argument("--key-file", default=os.environ.get("OPENSMS_KEY_FILE", "~/.opensms-bridge/key"))
    ap.add_argument("--log-file", default="")
    ap.add_argument("--forward-url", default=os.environ.get(FORWARD_URL_ENV, ""),
                    help="Capstone /sms-inbound URL; enables inbound polling")
    ap.add_argument("--forward-token", default=os.environ.get(FORWARD_TOKEN_ENV, ""))
    ap.add_argument("--forward-token-file", default=os.environ.get("FORWARD_TOKEN_FILE", ""),
                    help="read the inbound token from a file (keeps it out of argv)")
    ap.add_argument("--poll-seconds", type=int, default=int(os.environ.get("POLL_SECONDS") or 20),
                    help="inbound poll interval (0 disables; minimum 5)")
    ap.add_argument("--list-limit", type=int, default=25)
    ap.add_argument("--forward-backlog", action="store_true",
                    help="forward the existing inbox on the first poll")
    ap.add_argument("--state-file", default=os.environ.get("INBOUND_STATE", ""))
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)

    ready, detail = phone_ready()
    client, fallback_detail = pjsip_ready()
    if args.check:
        permission_ok, permission_detail = (False, detail)
        if ready:
            prefix = list_prefix()
            if (os.environ.get(SMS_OVERRIDE_ENV) or "").strip():
                permission_ok, permission_detail = True, f"sender overridden via {SMS_OVERRIDE_ENV}"
            else:
                try:
                    rc, out, err = _run(prefix + ["-l", "1"], timeout=10)
                    permission_ok = rc == 0
                    permission_detail = "SMS permission granted" if permission_ok else (err or f"{prefix[0]} exited {rc}")
                except Refused as exc:
                    permission_detail = str(exc)
        print(json.dumps({
            "gateway": "capstone-phone-node",
            "backend": BACKEND,
            "ready": ready and permission_ok,
            "binary": sms_prefix()[0],
            "permission": permission_detail,
            "transports": {
                "phone": ready,
                "pjsip": client is not None,
            },
            "pjsip_detail": fallback_detail,
            "inbound": {"url": args.forward_url, "poll_seconds": args.poll_seconds,
                        "token_set": bool(args.forward_token or args.forward_token_file)},
        }, indent=2))
        return 0 if (ready and permission_ok) else 1

    if not ready and client is None:
        raise SystemExit(
            f"no transport available: {detail}\n"
            "On the phone: pkg install termux-api (plus the Termux:API app).\n"
            "Or configure the PJSIP fallback: PJSIP_SMS_HOST/USER/PASSWORD."
        )

    api_key = load_key(args)
    if len(api_key) < 16:
        raise SystemExit("refusing to start: API key must be at least 16 characters")

    sink = sys.stdout
    if args.log_file:
        path = os.path.expanduser(args.log_file)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        sink = open(path, "a", encoding="utf-8")

    forward_token = args.forward_token
    if not forward_token and args.forward_token_file:
        try:
            with open(os.path.expanduser(args.forward_token_file), encoding="utf-8") as fh:
                forward_token = fh.read().strip()
        except OSError as exc:
            raise SystemExit(f"cannot read inbound token from {args.forward_token_file}: {exc}")

    poller = None
    if args.forward_url and args.poll_seconds > 0:
        if not forward_token:
            raise SystemExit("refusing to start inbound polling without a token "
                             "(--forward-token / --forward-token-file); Capstone's "
                             "/sms-inbound rejects unauthenticated posts")
        poller = InboxPoller(
            args.poll_seconds,
            forward_url=args.forward_url,
            token=forward_token,
            state_file=args.state_file or None,
            forward_backlog=args.forward_backlog,
            list_limit=args.list_limit,
        )
        poller.start()

    srv = build_server(args.bind, args.port, api_key, sink, poller)
    print(f"capstone-phone-node listening on {args.bind}:{args.port}"
          + (f", polling inbound every {args.poll_seconds}s -> {args.forward_url}" if poller else ""),
          file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if poller:
            poller.stop()
        srv.server_close()
        if sink is not sys.stdout:
            sink.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
