"""Send an SMS as a SIP MESSAGE over Asterisk pjsip — the backup transport.

The phone's modem is the primary sender, but it can be busy, out of credit, or
with no SIM registered. This is the fallback: a SIP MESSAGE request carried to
Asterisk over UDP, which FreePBX/the trunk can hand to a carrier that speaks
SMS-over-SIP. No third-party library, no pjsua build.

What it implements, and only what a single MESSAGE needs:

  * a well-formed MESSAGE with Via/From/To/Call-ID/CSeq/Max-Forwards
  * MD5 Digest authentication, `qop=auth` and legacy non-qop realms
    (RFC 2617 §3.2.2.1/.2 — what Asterisk's res_pjsip_endpoint_identifier_auth
    and chan_sip both emit)
  * one retransmit on timeout, then a clear error

It does NOT register, keep a socket open, or handle TLS/TCP. That is deliberate:
a fallback that depends on a registration having gone well is not a fallback.

Usage:
    client = SipMessageClient(host="192.168.1.10", username="8000",
                              password="secret", from_uri="sip:8000@192.168.1.10")
    client.send("sip:+15551234567@192.168.1.10", "hello")
"""

import hashlib
import os
import re
import socket
import uuid


class SipError(Exception):
    """The MESSAGE was not accepted by the far end."""


def _md5(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def parse_challenge(header_value):
    """{'realm': ..., 'nonce': ...} from a WWW-Authenticate/Proxy value."""
    head, _, params = header_value.partition(" ")
    if head.strip().lower() != "digest":
        raise SipError(f"unsupported auth scheme: {head.strip() or '(empty)'}")
    out = {}
    for key, quoted, bare in re.findall(r'(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))', params):
        out[key.lower()] = quoted if quoted or not bare else bare
    if "realm" not in out or "nonce" not in out:
        raise SipError("auth challenge without realm/nonce")
    return out


def digest_response(username, password, method, uri, challenge, nc="00000001", cnonce="0a4f113b"):
    """The Authorization/Proxy-Authorization header value for a challenge."""
    realm = challenge["realm"]
    nonce = challenge["nonce"]
    algorithm = (challenge.get("algorithm") or "MD5").upper()
    if algorithm != "MD5":
        raise SipError(f"unsupported digest algorithm: {algorithm} (only MD5)")
    qops = [q.strip() for q in (challenge.get("qop") or "").split(",") if q.strip()]
    ha1 = _md5(f"{username}:{realm}:{password}")
    ha2 = _md5(f"{method}:{uri}")
    if "auth" in qops:
        response = _md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}")
        qop_part = f', qop=auth, nc={nc}, cnonce="{cnonce}"'
    else:
        response = _md5(f"{ha1}:{nonce}:{ha2}")
        qop_part = ""
    opaque = f', opaque="{challenge["opaque"]}"' if challenge.get("opaque") else ""
    return (f'Digest username="{username}", realm="{realm}", nonce="{nonce}", '
            f'uri="{uri}", response="{response}", algorithm=MD5{qop_part}{opaque}')


class SipMessageClient:
    def __init__(self, host, username, password, from_uri=None, port=5060,
                 local_port=0, timeout=6.0, contact=None):
        if not host or not username or password is None:
            raise SipError("host, username and password are required")
        self.host = host
        self.port = int(port)
        self.username = username
        self.password = password
        self.from_uri = from_uri or f"sip:{username}@{host}"
        self.local_port = int(local_port)
        self.timeout = float(timeout)
        self.contact = contact or f"<sip:{username}@{host}:{self.local_port or 5060}>"

    # -- wire format -------------------------------------------------------
    def _build(self, to_uri, text, call_id, from_tag, branch, cseq, auth=None,
               proxy_auth=None):
        body = text.encode("utf-8")
        lines = [
            f"MESSAGE {to_uri} SIP/2.0",
            f"Via: SIP/2.0/UDP {self.host}:{self.local_port or 5060};branch={branch};rport",
            "Max-Forwards: 70",
            f"From: <{self.from_uri}>;tag={from_tag}",
            f"To: <{to_uri}>",
            f"Call-ID: {call_id}",
            f"CSeq: {cseq} MESSAGE",
            f"Contact: {self.contact}",
            "Content-Type: text/plain; charset=UTF-8",
            f"Content-Length: {len(body)}",
        ]
        if auth:
            lines.append(f"Authorization: {auth}")
        if proxy_auth:
            lines.append(f"Proxy-Authorization: {proxy_auth}")
        head = "\r\n".join(lines) + "\r\n\r\n"
        return head.encode("utf-8") + body

    @staticmethod
    def _status(data):
        first = data.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        m = re.match(r"SIP/2\.0\s+(\d{3})", first)
        if not m:
            raise SipError(f"not a SIP response: {first[:80]!r}")
        return int(m.group(1))

    @staticmethod
    def _header(data, name):
        text = data.decode("latin-1", "replace")
        for line in text.split("\r\n"):
            if line.lower().startswith(name.lower() + ":"):
                return line.split(":", 1)[1].strip()
        return ""

    def _exchange(self, sock, payload):
        """One request, one retransmit (UDP SIP retransmission, RFC 3261 §7.1)."""
        for attempt in (0, 1):
            sock.sendto(payload, (self.host, self.port))
            try:
                data, _ = sock.recvfrom(65535)
                return data
            except ConnectionResetError as exc:
                # Windows turns ICMP port-unreachable into this. Nothing is
                # listening, so a retransmit cannot help.
                raise TimeoutError("port unreachable") from exc
            except socket.timeout:
                if attempt == 1:
                    raise
        raise TimeoutError("no response")

    # -- public ------------------------------------------------------------
    def send(self, to_uri, text):
        """Send one MESSAGE. Raises SipError; returns the final status code."""
        if not str(text).strip():
            raise SipError("empty message body")
        call_id = f"{uuid.uuid4().hex}@{self.host}"
        from_tag = uuid.uuid4().hex[:12]
        branch = f"z9hG4bK{uuid.uuid4().hex[:16]}"
        cseq = 1

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(self.timeout)
        if self.local_port:
            sock.bind(("", self.local_port))
        try:
            try:
                data = self._exchange(sock, self._build(to_uri, text, call_id, from_tag, branch, cseq))
            except socket.timeout:
                raise SipError(f"no response from {self.host}:{self.port} ({self.timeout}s)")

            status = self._status(data)
            if 200 <= status < 300:
                return status

            if status in (401, 407):
                header = ("WWW-Authenticate" if status == 401 else "Proxy-Authenticate")
                challenge = parse_challenge(self._header(data, header))
                value = digest_response(self.username, self.password, "MESSAGE",
                                        to_uri, challenge)
                cseq += 1
                payload = self._build(
                    to_uri, text, call_id, from_tag, f"z9hG4bK{uuid.uuid4().hex[:16]}",
                    cseq,
                    auth=value if status == 401 else None,
                    proxy_auth=value if status == 407 else None,
                )
                try:
                    data = self._exchange(sock, payload)
                except socket.timeout:
                    raise SipError(f"no response to the authenticated MESSAGE ({self.timeout}s)")
                status = self._status(data)
                if 200 <= status < 300:
                    return status
                if status in (401, 407):
                    raise SipError("authentication rejected — check the pjsip username/password")
                raise SipError(f"MESSAGE rejected: SIP {status} {self._header(data, 'Reason')}".strip())

            raise SipError(f"MESSAGE rejected: SIP {status}")
        finally:
            sock.close()


def client_from_env(env=None):
    """Build a client from PJSIP_SMS_* env vars, or None when unconfigured."""
    env = env if env is not None else os.environ
    host = (env.get("PJSIP_SMS_HOST") or "").strip()
    user = (env.get("PJSIP_SMS_USER") or "").strip()
    password = env.get("PJSIP_SMS_PASSWORD") or ""
    if not (host and user and password):
        return None
    return SipMessageClient(
        host=host,
        port=int(env.get("PJSIP_SMS_PORT") or 5060),
        username=user,
        password=password,
        from_uri=(env.get("PJSIP_SMS_FROM") or "").strip() or None,
        timeout=float(env.get("PJSIP_SMS_TIMEOUT") or 6.0),
    )
