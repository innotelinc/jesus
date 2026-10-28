#!/usr/bin/env python3
"""Zeus portal API client for Capstone (add-on mode — Phase 2).

Implements the machine contract published in the Zeus repo's
`docs/portal-api.md` so Capstone agents and operator scripts can drive the
telephony Zeus owns: SMS, fax, voicemail intelligence, and the dograh
transfer resolver. No third-party dependencies — stdlib only, mirroring the
converge-tool convention.

Auth (docs/portal-api.md §1): every request carries the account session as
the `pbx_session` cookie value in ZEUS_SESSION_TOKEN. `resolve` also accepts
a Bearer token (ZEUS_BEARER / --bearer); when one is given for that call it
is used instead of the cookie.

Config (.env at the repo root, or real environment):

    ZEUS_API_URL         Zeus portal origin   (default https://api.zeus.innotel.us)
    ZEUS_SESSION_TOKEN   the Zeus account's pbx_session cookie value
    ZEUS_BEARER          optional Bearer for the transfer resolver

Usage:

    python3 scripts/zeus_client.py conversations
    python3 scripts/zeus_client.py thread <conversation_id>
    python3 scripts/zeus_client.py sms --to +13025551002 --from <did_id> --body "…"
    python3 scripts/zeus_client.py fax --to +13025551002 --from <did_id> \
        [--subject "Cover"] [--body "text-only fax"] [--file path.pdf] [--scheduled-at 2026-09-07T10:00:00Z]
    python3 scripts/zeus_client.py faxes [--limit 20] [--offset 0]
    python3 scripts/zeus_client.py fax-download <fax_id> [--out path.pdf]
    python3 scripts/zeus_client.py voicemail [--limit 20] [--offset 0]
    python3 scripts/zeus_client.py vm-summary <voicemail_id>
    python3 scripts/zeus_client.py vm-listened <voicemail_id>
    python3 scripts/zeus_client.py resolve "Ada" [--bearer <token>]
"""

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BASE_URL = "https://api.zeus.innotel.us"


# --------------------------------------------------------------------------
# config — real environment first, then the repo .env
# --------------------------------------------------------------------------


def load_dotenv(path):
    env = {}
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip("'\"")
                env[key] = val
    except FileNotFoundError:
        pass
    return env


_ENV = load_dotenv(os.path.join(REPO, ".env"))


def cfg(name, default=""):
    if name in os.environ and os.environ[name]:
        return os.environ[name]
    return _ENV.get(name) or default


class ZeusError(Exception):
    """Raised when the Zeus portal API answers with a non-2xx status."""


class ZeusClient:
    def __init__(self, base_url=None, session_token=None, bearer=None,
                 verify=True, timeout=90):
        self.base = (base_url or cfg("ZEUS_API_URL", DEFAULT_BASE_URL)).rstrip("/")
        self.session_token = session_token if session_token is not None else cfg("ZEUS_SESSION_TOKEN")
        self.bearer = bearer if bearer is not None else cfg("ZEUS_BEARER")
        self.timeout = timeout
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.ctx = ctx

    def _request(self, method, path, body=None, ctype="application/json",
                 use_bearer=None):
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        headers = {}
        if use_bearer:
            headers["Authorization"] = f"Bearer {use_bearer}"
        elif self.bearer and path == "/api/agent/transfer-resolve":
            headers["Authorization"] = f"Bearer {self.bearer}"
        if not headers.get("Authorization") and self.session_token:
            headers["Cookie"] = f"pbx_session={self.session_token}"
        if ctype:
            headers["Content-Type"] = ctype
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as resp:
                raw = resp.read()
                if not raw:
                    return resp.status, {}
                try:
                    return resp.status, json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    return resp.status, raw
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else {}
            except (ValueError, UnicodeDecodeError):
                payload = {"error": raw.decode("utf-8", "replace")[:300]}
            raise ZeusError(f"Zeus API {method} {path} -> HTTP {e.code}: {payload}")

    # ---- Messages (SMS) ---------------------------------------------------
    def conversations(self):
        """GET /api/messages — the account's SMS conversations."""
        return self._request("GET", "/api/messages")

    def thread(self, conversation_id):
        """GET /api/messages/:conversationId — one conversation + its messages."""
        return self._request("GET", f"/api/messages/{urllib.parse.quote(conversation_id, safe='')}")

    def send_sms(self, to_number, from_did_id, body):
        """POST /api/messages/send — send an SMS from one of the account's DIDs."""
        return self._request("POST", "/api/messages/send", {
            "to_number": to_number,
            "from_did_id": from_did_id,
            "body": body,
        })

    # ---- Fax --------------------------------------------------------------
    def send_fax(self, to_number, from_did_id, subject=None, body=None,
                 pdf_path=None, scheduled_at=None):
        """POST /api/fax/send — multipart; a PDF file or a text body (or both
        file preferred when both given) and an optional future scheduled_at."""
        if not pdf_path and not body:
            raise ValueError("Provide --file (PDF) or --body for the fax")
        boundary = "----capstoneZeus" + uuid.uuid4().hex

        def field(k, v):
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n'
                f"{v}\r\n".encode("utf-8")
            )

        parts = []
        field("to_number", str(to_number))
        field("from_did_id", str(from_did_id))
        if subject:
            field("subject", subject)
        if scheduled_at:
            field("scheduled_at", scheduled_at)
        if pdf_path:
            with open(pdf_path, "rb") as fh:
                pdf_bytes = fh.read()
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                f'filename="fax.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode("utf-8")
            )
            parts.append(pdf_bytes)
            parts.append(b"\r\n")
        else:
            field("body", body)
        parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        return self._request(
            "POST", "/api/fax/send", b"".join(parts),
            ctype=f"multipart/form-data; boundary={boundary}",
        )

    def faxes(self, limit=20, offset=0):
        """GET /api/fax/send — paginated fax history."""
        return self._request(
            "GET", f"/api/fax/send?limit={int(limit)}&offset={int(offset)}")

    def fax_download(self, fax_id):
        """GET /api/fax/download?id=… — the fax PDF as raw bytes."""
        return self._request(
            "GET", f"/api/fax/download?id={urllib.parse.quote(fax_id, safe='')}")

    # ---- Voicemail --------------------------------------------------------
    def voicemails(self, limit=20, offset=0):
        """GET /api/voicemail — paginated voicemail list (transcripts/summaries)."""
        return self._request(
            "GET", f"/api/voicemail?limit={int(limit)}&offset={int(offset)}")

    def voicemail_summary(self, voicemail_id):
        """POST /api/voicemail/summary — generate/persist the AI summary."""
        return self._request("POST", "/api/voicemail/summary",
                             {"voicemail_id": voicemail_id})

    def voicemail_listened(self, voicemail_id):
        """POST /api/voicemail/listened — mark a voicemail handled."""
        return self._request("POST", "/api/voicemail/listened",
                             {"voicemail_id": voicemail_id})

    # ---- Agent surface ----------------------------------------------------
    def resolve(self, query, bearer=None):
        """POST /api/agent/transfer-resolve — person → destination
        (contact phone or PJSIP/<ext>), per the dograh resolver contract."""
        return self._request("POST", "/api/agent/transfer-resolve",
                             {"query": query}, use_bearer=bearer or self.bearer)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _print(payload):
    if isinstance(payload, bytes):
        sys.stdout.buffer.write(payload)
        return
    print(json.dumps(payload, indent=2, default=str))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api-url", help=f"overrides ZEUS_API_URL (default {DEFAULT_BASE_URL})")
    ap.add_argument("--token", help="overrides ZEUS_SESSION_TOKEN")
    ap.add_argument("--insecure", action="store_true", help="disable TLS verification")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("conversations", help="list SMS conversations")
    p_thread = sub.add_parser("thread", help="one conversation + messages")
    p_thread.add_argument("conversation_id")

    p_sms = sub.add_parser("sms", help="send an SMS")
    p_sms.add_argument("--to", required=True, dest="to_number")
    p_sms.add_argument("--from", required=True, dest="from_did_id")
    p_sms.add_argument("--body", required=True)

    p_fax = sub.add_parser("fax", help="send a fax (PDF file or text body)")
    p_fax.add_argument("--to", required=True, dest="to_number")
    p_fax.add_argument("--from", required=True, dest="from_did_id")
    p_fax.add_argument("--subject")
    p_fax.add_argument("--body")
    p_fax.add_argument("--file", dest="pdf_path")
    p_fax.add_argument("--scheduled-at", dest="scheduled_at")

    p_faxes = sub.add_parser("faxes", help="fax history")
    p_faxes.add_argument("--limit", type=int, default=20)
    p_faxes.add_argument("--offset", type=int, default=0)

    p_dl = sub.add_parser("fax-download", help="download a fax PDF")
    p_dl.add_argument("fax_id")
    p_dl.add_argument("--out", dest="out_path")

    p_vm = sub.add_parser("voicemail", help="voicemail list")
    p_vm.add_argument("--limit", type=int, default=20)
    p_vm.add_argument("--offset", type=int, default=0)

    p_sum = sub.add_parser("vm-summary", help="generate a voicemail AI summary")
    p_sum.add_argument("voicemail_id")
    p_list = sub.add_parser("vm-listened", help="mark voicemail listened")
    p_list.add_argument("voicemail_id")

    p_res = sub.add_parser("resolve", help="resolve a person to a transfer destination")
    p_res.add_argument("query")
    p_res.add_argument("--bearer", help="overrides ZEUS_BEARER for this call")

    args = ap.parse_args(argv)

    client = ZeusClient(base_url=args.api_url, session_token=args.token,
                        verify=not args.insecure)
    try:
        if args.cmd == "conversations":
            _print(client.conversations()[1])
        elif args.cmd == "thread":
            _print(client.thread(args.conversation_id)[1])
        elif args.cmd == "sms":
            _print(client.send_sms(args.to_number, args.from_did_id, args.body)[1])
        elif args.cmd == "fax":
            _print(client.send_fax(args.to_number, args.from_did_id,
                                   subject=args.subject, body=args.body,
                                   pdf_path=args.pdf_path,
                                   scheduled_at=args.scheduled_at)[1])
        elif args.cmd == "faxes":
            _print(client.faxes(args.limit, args.offset)[1])
        elif args.cmd == "fax-download":
            status, pdf = client.fax_download(args.fax_id)
            if args.out_path:
                with open(args.out_path, "wb") as fh:
                    fh.write(pdf)
                print(f"saved {len(pdf)} bytes -> {args.out_path}")
            else:
                _print(pdf)
        elif args.cmd == "voicemail":
            _print(client.voicemails(args.limit, args.offset)[1])
        elif args.cmd == "vm-summary":
            _print(client.voicemail_summary(args.voicemail_id)[1])
        elif args.cmd == "vm-listened":
            _print(client.voicemail_listened(args.voicemail_id)[1])
        elif args.cmd == "resolve":
            _print(client.resolve(args.query, bearer=args.bearer)[1])
    except ZeusError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
