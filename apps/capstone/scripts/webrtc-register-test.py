#!/usr/bin/env python3
"""WebRTC registration probe — verifies the Asterisk WSS/SIP path exactly as
a browser SIP.js client would, using only the Python standard library.

Does the full handshake against the PBX's published WSS endpoint:
  1. TLS connect to <host>:8089 (the pjsip WSS transport)
  2. WebSocket upgrade on /ws with the "sip" subprotocol
  3. SIP REGISTER for the test extension (default 102)
  4. Digest-auth challenge/response (RFC 7616 / RFC 8760 style)
  5. Expects a 200 OK (registration accepted)
  6. Optional --hold N: keep the registration alive N seconds so you can
     inspect `pjsip show contacts` from another shell, then unregister.

Usage:
  ./scripts/webrtc-register-test.py [--host HOST] [--user 102] [--password P]
      [--hold SECONDS] [--insecure]

The test extension is created by pbx/entrypoint-dograh.sh on every boot
(endpoint 102 inherits [webrtc-template], auth 102-auth, aor 102).
"""

import argparse
import base64
import hashlib
import os
import socket
import ssl
import struct
import sys
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WSSClient:
    def __init__(self, host: str, port: int, user: str, password: str,
                 insecure: bool = False):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.sock = None
        self.buf = b""

        ctx = ssl.create_default_context()
        if insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection((host, port), timeout=10)
        self.sock = ctx.wrap_socket(raw, server_hostname=host)

    # ── WebSocket framing (client frames are masked per RFC 6455) ──────────
    def _send_frame(self, payload: bytes, opcode: int = 0x1):
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def _recv_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("connection closed mid-frame")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _recv_frame(self) -> tuple[int, bytes]:
        hdr = self._recv_exact(2)
        opcode = hdr[0] & 0x0F
        length = hdr[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        if hdr[1] & 0x80:  # server frames are never masked
            self._recv_exact(4)
        return opcode, self._recv_exact(length)

    # ── WebSocket handshake ────────────────────────────────────────────────
    def connect(self) -> str:
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Protocol: sip\r\n"
            f"\r\n"
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.sock.recv(4096)
        head, _, _ = resp.partition(b"\r\n\r\n")
        self.buf = resp[len(head) + 4:]
        lines = head.decode(errors="replace").split("\r\n")
        status = lines[0]
        expect = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if "101" not in status:
            raise RuntimeError("WebSocket upgrade failed: " + status)
        for ln in lines[1:]:
            if ln.lower().startswith("sec-websocket-accept:") and expect in ln:
                return status
        raise RuntimeError("WebSocket accept mismatch (expected " + expect + ")")

    def send_sip(self, message: str):
        self._send_frame(message.encode())

    def recv_sip(self, timeout: float = 8.0) -> str:
        self.sock.settimeout(timeout)
        while True:
            opcode, payload = self._recv_frame()
            if opcode == 0x8:  # close
                raise ConnectionError("server sent WebSocket close")
            if opcode == 0x1:  # text
                return payload.decode(errors="replace")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


# ── SIP helpers ────────────────────────────────────────────────────────────
def sip_register(user: str, host: str, port: int, branch: str, call_id: str,
                 tag: str, expires: int = 300, auth=None, extra: str = "") -> str:
    via_branch = "z9hG4bK-" + branch
    contact = "<sip:" + user + "@" + host + ":" + str(port) + ";transport=wss>"
    msg = (
        "REGISTER sip:" + host + " SIP/2.0\r\n"
        "Via: SIP/2.0/WSS " + host + ":" + str(port) + ";branch=" + via_branch + ";rport\r\n"
        "Max-Forwards: 70\r\n"
        "From: <sip:" + user + "@" + host + ">;tag=" + tag + "\r\n"
        "To: <sip:" + user + "@" + host + ">\r\n"
        "Call-ID: " + call_id + "\r\n"
        "CSeq: 1 REGISTER\r\n"
        "Contact: " + contact + ";+sip.instance=\"<urn:uuid:00000000-0000-0000-0000-" + branch + ">\"\r\n"
        "User-Agent: webrtc-register-test\r\n"
    )
    if auth:
        msg += "Authorization: " + auth + "\r\n"
    msg += "Expires: " + str(expires) + "\r\n" + extra + "Content-Length: 0\r\n\r\n"
    return msg


def digest_response(www_auth: str, method: str, uri: str, user: str,
                    password: str) -> str:
    """Compute the Authorization header from a WWW-Authenticate challenge."""
    params = {}
    # The challenge starts with "Digest " — strip the scheme so the first
    # "realm=" param isn't parsed as key "digest realm".
    body = www_auth
    if body.lower().startswith("digest "):
        body = body[len("digest "):]
    for part in body.split(","):
        part = part.strip()
        if "=" in part:
            k, _, v = part.partition("=")
            params[k.strip().lower()] = v.strip().strip('"')
    realm = params.get("realm", "")
    nonce = params.get("nonce", "")
    qop = params.get("qop", "")
    algorithm = params.get("algorithm", "MD5").upper()
    ha1 = hashlib.md5((user + ":" + realm + ":" + password).encode()).hexdigest()
    if algorithm == "MD5-SESS":
        ha1 = hashlib.md5((ha1 + ":" + nonce + ":" + ha1).encode()).hexdigest()
    ha2 = hashlib.md5((method + ":" + uri).encode()).hexdigest()
    if qop:
        nc = "00000001"
        cnonce = hashlib.md5(os.urandom(8)).hexdigest()[:16]
        resp = hashlib.md5(
            (ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2).encode()
        ).hexdigest()
        return (
            'Digest username="' + user + '", realm="' + realm + '", nonce="' + nonce + '", '
            'uri="' + uri + '", algorithm=' + algorithm + ', response="' + resp + '", '
            'qop=' + qop + ', nc=' + nc + ', cnonce="' + cnonce + '"'
        )
    resp = hashlib.md5((ha1 + ":" + nonce + ":" + ha2).encode()).hexdigest()
    return (
        'Digest username="' + user + '", realm="' + realm + '", nonce="' + nonce + '", '
        'uri="' + uri + '", algorithm=' + algorithm + ', response="' + resp + '"'
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="WSS SIP REGISTER probe (Asterisk WebRTC)")
    ap.add_argument("--host", default=os.environ.get("WEBRTC_TEST_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=8089)
    ap.add_argument("--user", default="102")
    ap.add_argument("--password", default=os.environ.get("WEBRTC_TEST_PASSWORD", "webrtc-test-102"))
    ap.add_argument("--hold", type=float, default=0.0,
                    help="keep the registration alive this many seconds before unregistering")
    ap.add_argument("--insecure", action="store_true",
                    help="skip TLS verification (self-signed test cert)")
    args = ap.parse_args()

    client = WSSClient(args.host, args.port, args.user, args.password, args.insecure)
    try:
        status = client.connect()
        print("[OK]   WSS upgrade 101 (sip subprotocol): " + status)

        branch = hashlib.md5(os.urandom(16)).hexdigest()[:8]
        call_id = hashlib.md5(os.urandom(16)).hexdigest()[:20] + "@" + args.host
        tag = hashlib.md5(os.urandom(16)).hexdigest()[:10]
        uri = "sip:" + args.host

        # 1. Unauthenticated REGISTER → expect 401 with a Digest challenge.
        client.send_sip(sip_register(args.user, args.host, args.port, branch, call_id, tag))
        resp = client.recv_sip()
        status_line = resp.split("\r\n", 1)[0]
        print("[...]  REGISTER #1 -> " + status_line)
        if "401" not in status_line:
            print("[FAIL] expected 401 challenge, got:\n" + resp[:500])
            return 1
        www = ""
        for ln in resp.split("\r\n"):
            if ln.lower().startswith("www-authenticate:"):
                www = ln.split(":", 1)[1].strip()
        if not www:
            print("[FAIL] no WWW-Authenticate header in 401")
            return 1
        realm_part = next((p for p in www.split(",") if "realm" in p), "")
        realm = realm_part.split("=", 1)[1].strip().strip('"') if realm_part else "?"
        print("[OK]   received Digest challenge: realm=" + realm)

        # 2. Authenticated REGISTER → expect 200 OK (accepted).
        auth = digest_response(www, "REGISTER", uri, args.user, args.password)
        client.send_sip(
            sip_register(args.user, args.host, args.port, branch, call_id, tag,
                         auth=auth, extra="")
        )
        resp = client.recv_sip()
        status_line = resp.split("\r\n", 1)[0]
        print("[...]  REGISTER #2 (authenticated) -> " + status_line)
        if "200 OK" not in status_line:
            print("[FAIL] registration rejected:\n" + resp[:600])
            return 1
        print("[OK]   200 OK — extension " + args.user +
              " registered over WSS (user-agent webrtc-register-test)")

        # 3. Optional hold window (inspect pjsip show contacts meanwhile).
        if args.hold > 0:
            print("[...]  holding registration " + str(args.hold) + "s — run "
                  "`docker exec pbx-freepbx asterisk -rx 'pjsip show contacts'` now")
            time.sleep(args.hold)

        # 4. Unregister (Expires: 0) so the test leaves no stale contact.
        branch2 = hashlib.md5(os.urandom(16)).hexdigest()[:8]
        tag2 = hashlib.md5(os.urandom(16)).hexdigest()[:10]
        client.send_sip(
            sip_register(args.user, args.host, args.port, branch2, call_id, tag2,
                         expires=0, auth=digest_response(www, "REGISTER", uri,
                                                         args.user, args.password))
        )
        resp = client.recv_sip()
        if "200 OK" in resp.split("\r\n", 1)[0]:
            print("[OK]   unregistered (Expires: 0) — no stale contact left")
        else:
            print("[WARN] unregister response: " + resp.split("\r\n", 1)[0])

        print("\nRESULT: PASS — WSS registration verified end-to-end")
        return 0
    except Exception as e:  # noqa: BLE001
        print("\nRESULT: FAIL — " + str(e))
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
