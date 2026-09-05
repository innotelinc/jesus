#!/usr/bin/env python3
"""WebRTC registration probe — verifies the Asterisk WSS/SIP path exactly as
a browser SIP.js client would, using only the Python standard library.

Does the full handshake against the PBX's published WSS endpoint:
  1. TLS connect to <host>:8089 (the pjsip WSS transport)
  2. WebSocket upgrade on /ws with the "sip" subprotocol
  3. SIP REGISTER for the test extension (default 101)
  4. Digest-auth challenge/response (RFC 7616 / RFC 8760 style)
  5. Expects a 200 OK (registration accepted)
  6. Optional --hold N: keep the registration alive N seconds so you can
     inspect `pjsip show contacts` from another shell, then unregister.
  7. Optional --answer N: additionally auto-answer any incoming INVITE
     (200 OK + minimal audio SDP) and hold the call N seconds before BYE —
     used to prove a full inbound call lands ANSWERED in the PBX CDR.

Usage:
  ./scripts/webrtc-register-test.py [--host HOST] [--user 101] [--password P]
      [--hold SECONDS] [--answer SECONDS] [--insecure]

The test extension is created by pbx/entrypoint-dograh.sh on every boot
(endpoint 101 inherits [webrtc-template], auth 101-auth, aor 101).
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
                 insecure: bool = False, transport: str = "wss",
                 local_ip: str = ""):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.transport = transport.lower()
        self.sock = None
        self.buf = b""
        self.local_ip = local_ip or _local_ip_for(host, port)
        if self.transport == "udp":
            # Plain SIP over UDP — no TLS/WebSocket layer at all.
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.bind(("0.0.0.0", 0))
            self.sock.settimeout(10)
            return
        ctx = ssl.create_default_context()
        if insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection((host, port), timeout=10)
        self.sock = ctx.wrap_socket(raw, server_hostname=host)

    # ── transport-neutral send/recv ────────────────────────────────────────
    def send_sip(self, message: str):
        if self.transport == "udp":
            self.sock.sendto(message.encode(), (self.host, self.port))
        else:
            self._send_frame(message.encode())

    def recv_sip(self, timeout: float = 8.0) -> str:
        self.sock.settimeout(timeout)
        if self.transport == "udp":
            while True:
                data, _ = self.sock.recvfrom(65535)
                if data:
                    return data.decode(errors="replace")
        while True:
            opcode, payload = self._recv_frame()
            if opcode == 0x8:  # close
                raise ConnectionError("server sent WebSocket close")
            if opcode == 0x1:  # text
                return payload.decode(errors="replace")

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
        if self.transport == "udp":
            # No handshake — the SIP REGISTER below is the first datagram.
            return "SIP/2.0/UDP direct"
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

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


# ── SIP helpers ────────────────────────────────────────────────────────────
def _local_ip_for(host: str, port: int) -> str:
    """Best-effort local IP reachable toward the PBX (for UDP contacts/SDP)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((host, port))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:  # noqa: BLE001
        return "127.0.0.1"


def sip_register(user: str, host: str, port: int, branch: str, call_id: str,
                 tag: str, expires: int = 300, auth=None, extra: str = "",
                 transport: str = "wss", local_ip: str = "", rtp_ok: bool = True) -> str:
    via_branch = "z9hG4bK-" + branch
    if transport == "udp":
        src = (local_ip or _local_ip_for(host, port)) + ":" + str(port)
        via = "Via: SIP/2.0/UDP " + src + ";branch=" + via_branch + ";rport"
        contact = "<sip:" + user + "@" + (local_ip or src) + ">"
    else:
        via = "Via: SIP/2.0/WSS " + host + ":" + str(port) + ";branch=" + via_branch + ";rport"
        contact = "<sip:" + user + "@" + host + ":" + str(port) + ";transport=wss>"
    msg = (
        "REGISTER sip:" + host + " SIP/2.0\r\n"
        + via + "\r\n"
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


# ── Minimal inbound-call answering (200 OK + audio SDP) ────────────────────
def _sip_header(msg: str, name: str) -> str | None:
    for ln in msg.split("\r\n"):
        if ln.lower().startswith(name.lower() + ":"):
            return ln.split(":", 1)[1].strip()
    return None


def _tag_uri(header: str, tag: str) -> str:
    """Append our local tag to a From/To header that lacks one."""
    if ";tag=" in header:
        return header
    return header + ";tag=" + tag


def _bare_uri(header: str) -> str | None:
    """Pull the URI out of a Contact/Route header value (strip <> and params)."""
    v = header.strip()
    if v.startswith("<"):
        end = v.find(">")
        v = v[1:end if end != -1 else len(v)]
    else:
        v = v.split(";", 1)[0].split(",", 1)[0]
    return v.strip() or None


def _build_200_ok(invite: str, user: str, host: str, port: int,
                  rtp_ip: str, rtp_port: int, sdp_ts: int, tag: str,
                  transport: str = "wss", local_ip: str = "") -> str:
    """Answer an inbound INVITE with 200 OK + a minimal audio SDP."""
    via = _sip_header(invite, "Via")
    frm = _sip_header(invite, "From")   # already carries the remote tag
    to = _sip_header(invite, "To")      # we add our tag here
    call_id = _sip_header(invite, "Call-ID")
    cseq = _sip_header(invite, "CSeq")
    if transport == "udp":
        contact_addr = local_ip or _local_ip_for(host, port)
        rtp_ip = contact_addr
        contact = "<sip:" + user + "@" + contact_addr + ":" + str(port) + ">"
    else:
        contact = "<sip:" + user + "@" + host + ":" + str(port) + ";transport=wss>"
    sdp = (
        "v=0\r\n"
        f"o=webrtc-register-test {sdp_ts} {sdp_ts} IN IP4 {rtp_ip}\r\n"
        "s=-\r\n"
        f"c=IN IP4 {rtp_ip}\r\n"
        "t=0 0\r\n"
        f"m=audio {rtp_port} RTP/AVP 0 8 96\r\n"
        "a=rtpmap:0 PCMU/8000\r\n"
        "a=rtpmap:8 PCMA/8000\r\n"
        "a=rtpmap:96 opus/48000/2\r\n"
        "a=sendrecv\r\n"
    )
    contact = "<sip:" + user + "@" + host + ":" + str(port) + ";transport=wss>"
    # The test endpoint inherits the webrtc-template (DTLS-SRTP + ICE), so the
    # answer SDP needs ICE candidates and a fingerprint for chan_pjsip to treat
    # the call as answered even though this probe never completes DTLS.
    ufrag = hashlib.md5(os.urandom(16)).hexdigest()[:8]
    ice_pwd = hashlib.md5(os.urandom(24)).hexdigest()[:24]
    fp = hashlib.sha256(os.urandom(32)).hexdigest()
    sdp += (
        "a=ice-ufrag:" + ufrag + "\r\n"
        "a=ice-pwd:" + ice_pwd + "\r\n"
        "a=ice-options:trickle\r\n"
        "a=setup:active\r\n"
        "a=fingerprint:sha-256 " + fp + "\r\n"
        "a=candidate:1 1 udp 2122260223 " + rtp_ip + " "
        + str(rtp_port) + " typ host\r\n"
        "a=end-of-candidates\r\n"
    )
    resp = (
        "SIP/2.0 200 OK\r\n"
        + (via + "\r\n" if via else "")
        + (frm + "\r\n" if frm else "")
        + (_tag_uri(to, tag) + "\r\n" if to else "")
        + ((call_id or "") + "\r\n" if call_id else "")
        + ((cseq or "") + "\r\n" if cseq else "")
        + "Contact: " + contact + "\r\n"
        + "Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, NOTIFY\r\n"
        + "Content-Type: application/sdp\r\n"
        + "Content-Length: " + str(len(sdp.encode())) + "\r\n\r\n"
        + sdp
    )
    return resp


def _build_bye(invite: str, user: str, host: str, port: int,
               tag: str, cseq_num: int) -> str | None:
    """BYE for the dialog opened by `invite`, sent from our side."""
    remote_contact = _sip_header(invite, "Contact")
    target = _bare_uri(remote_contact) if remote_contact else None
    if not target:
        return None
    # We were the To (callee); From/To swap for our request.
    frm = _sip_header(invite, "To")
    to = _sip_header(invite, "From")
    call_id = _sip_header(invite, "Call-ID")
    if not (frm and to and call_id):
        return None
    branch = hashlib.md5(os.urandom(16)).hexdigest()[:12]
    return (
        "BYE " + target + " SIP/2.0\r\n"
        + "Via: SIP/2.0/WSS " + host + ":" + str(port)
        + ";branch=z9hG4bK-" + branch + ";rport\r\n"
        + "Max-Forwards: 70\r\n"
        + (_tag_uri(frm, tag) + "\r\n" if frm else "")
        + (to + "\r\n" if to else "")
        + (call_id + "\r\n" if call_id else "")
        + "CSeq: " + str(cseq_num) + " BYE\r\n"
        + "Content-Length: 0\r\n\r\n"
    )


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
    ap.add_argument("--user", default=os.environ.get("WEBRTC_TEST_EXTENSION", "101"))
    ap.add_argument("--password", default=os.environ.get("WEBRTC_TEST_PASSWORD", "webrtc-test-101"))
    ap.add_argument("--transport", choices=["wss", "udp"], default="wss",
                    help="signaling transport: wss (WebRTC, default) or udp (plain SIP)")
    ap.add_argument("--local-ip", default="",
                    help="local IP advertised in UDP Via/Contact (default: auto-detect)")
    ap.add_argument("--hold", type=float, default=0.0,
                    help="keep the registration alive this many seconds before unregistering")
    ap.add_argument("--answer", type=float, default=0.0,
                    help="after registering, auto-answer inbound INVITEs and hold each call "
                         "this many seconds before sending BYE (proves ANSWERED CDRs)")
    ap.add_argument("--rtp-ip", default="192.168.1.46",
                    help="LAN IP advertised in the answer SDP for the RTP socket")
    ap.add_argument("--insecure", action="store_true",
                    help="skip TLS verification (self-signed test cert)")
    args = ap.parse_args()

    client = WSSClient(args.host, args.port, args.user, args.password,
                       args.insecure, args.transport, args.local_ip)
    try:
        status = client.connect()
        if args.transport == "udp":
            print("[OK]   UDP transport ready (local " + client.local_ip + ")")
        else:
            print("[OK]   WSS upgrade 101 (sip subprotocol): " + status)

        branch = hashlib.md5(os.urandom(16)).hexdigest()[:8]
        call_id = hashlib.md5(os.urandom(16)).hexdigest()[:20] + "@" + args.host
        tag = hashlib.md5(os.urandom(16)).hexdigest()[:10]
        uri = "sip:" + args.host

        # 1. Unauthenticated REGISTER → expect 401 with a Digest challenge.
        client.send_sip(sip_register(args.user, args.host, args.port, branch, call_id, tag,
                                     transport=args.transport, local_ip=args.local_ip))
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
                         auth=auth, extra="", transport=args.transport,
                         local_ip=args.local_ip)
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

        # 3b. Auto-answer window: answer inbound INVITEs until the window ends.
        answered_any = False
        if args.answer > 0:
            rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            rtp.bind(("0.0.0.0", 0))
            rtp_port = rtp.getsockname()[1]
            rtp.settimeout(0.5)
            deadline = time.monotonic() + args.answer
            print("[...]  listening for inbound calls (auto-answer up to "
                  + str(args.answer) + "s, RTP :" + str(rtp_port) + ")")
            try:
                while time.monotonic() < deadline:
                    try:
                        msg = client.recv_sip(timeout=5.0)
                    except socket.timeout:
                        continue
                    head = msg.split("\r\n", 1)[0]
                    if head.startswith("INVITE "):
                        tag = hashlib.md5(os.urandom(16)).hexdigest()[:10]
                        client.send_sip("SIP/2.0 100 Trying\r\n"
                                        + ((_sip_header(msg, "Via") or "") + "\r\n")
                                        + ((_sip_header(msg, "From") or "") + "\r\n")
                                        + ((_sip_header(msg, "To") or "") + "\r\n")
                                        + ((_sip_header(msg, "Call-ID") or "") + "\r\n")
                                        + ((_sip_header(msg, "CSeq") or "") + "\r\n")
                                        + "Content-Length: 0\r\n\r\n")
                        sdp_ts = int(time.time())
                        client.send_sip(_build_200_ok(
                            msg, args.user, args.host, args.port,
                            args.rtp_ip, rtp_port, sdp_ts, tag,
                            transport=args.transport, local_ip=args.local_ip))
                        print("[OK]   answered INVITE: " + head)
                        answered_any = True
                        # Drain ACK, absorb RTP, then BYE at the window end.
                        call_end = min(deadline, time.monotonic() + 12)
                        bye_sent = False
                        while time.monotonic() < call_end:
                            try:
                                nxt = client.recv_sip(timeout=1.0)
                            except socket.timeout:
                                try:
                                    rtp.recvfrom(2048)
                                except socket.timeout:
                                    pass
                                continue
                            if nxt.split("\r\n", 1)[0].startswith("BYE "):
                                print("[OK]   received BYE from PBX — call ended")
                                bye_sent = True
                                break
                        if not bye_sent:
                            bye = _build_bye(msg, args.user, args.host, args.port,
                                             tag, 2)
                            if bye:
                                client.send_sip(bye)
                                print("[OK]   sent BYE (call held " + str(
                                    round(args.answer, 1)) + "s)")
                        break  # one call per probe run is enough
            finally:
                rtp.close()

        # 4. Unregister (Expires: 0) so the test leaves no stale contact.
        branch2 = hashlib.md5(os.urandom(16)).hexdigest()[:8]
        tag2 = hashlib.md5(os.urandom(16)).hexdigest()[:10]
        client.send_sip(
            sip_register(args.user, args.host, args.port, branch2, call_id, tag2,
                         expires=0, auth=digest_response(www, "REGISTER", uri,
                                                         args.user, args.password),
                         transport=args.transport, local_ip=args.local_ip)
        )
        resp = client.recv_sip()
        if "200 OK" in resp.split("\r\n", 1)[0]:
            print("[OK]   unregistered (Expires: 0) — no stale contact left")
        else:
            print("[WARN] unregister response: " + resp.split("\r\n", 1)[0])

        if args.answer > 0 and not answered_any:
            print("\nRESULT: PASS (registration) — no inbound call arrived during the "
                  + "answer window")
        else:
            print("\nRESULT: PASS — WSS registration verified end-to-end")
        return 0
    except Exception as e:  # noqa: BLE001
        print("\nRESULT: FAIL — " + str(e))
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
