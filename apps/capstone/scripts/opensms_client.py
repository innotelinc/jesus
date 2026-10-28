#!/usr/bin/env python3
"""OpenSMS gateway client for Capstone.

[OpenSMS](https://github.com/daslearning-org/OpenSMS) turns an Android phone
into an SMS API server: it listens on `:9292` and sends through its own SIM.
This client is the direct path to that gateway for the cases where Capstone
does not go through the Zeus portal — a standalone box, or a deployment whose
SMS is deliberately carried by a local phone.

The gateway answers `POST /sms/` with a Bearer key and
`{"number": "...", "text": "..."}`; a send is only successful when the answer
is `{"stat": true}` (the app returns 200 either way). OpenSMS has no inbound
surface and no read API — replies still arrive through Zeus's VoIP.ms webhook.

Config (.env at the repo root, or real environment):

    SMS_PROVIDER        zeus (default) | opensms | auto
    OPENSMS_URL         http://<phone-lan-ip>:9292
    OPENSMS_API_KEY     the key generated in the app
    OPENSMS_TIMEOUT_MS  request budget (default 15000)

`auto` means OpenSMS first, Zeus on a gateway failure. The transport choice
itself lives in the callers (`send_sms.py`, `zeus_agent_tools.py`); this module
only exposes `provider()`, `configured()` and the client.

Usage:

    python3 scripts/opensms_client.py --to +15551234567 --body "hello"
    python3 scripts/opensms_client.py --check
"""

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TIMEOUT_MS = 15000
PROVIDERS = ("zeus", "opensms", "auto")

# The operator-facing vocabulary shared by the CLI, the dograh tool and the
# Control Center's Settings card. Native names stay accepted everywhere, so a
# `SMS_PROVIDER` value and a saved choice mean the same thing.
TRANSPORT_ALIASES = {
    "provider": "zeus",
    "zeus": "zeus",
    "local": "opensms",
    "opensms": "opensms",
    "auto": "auto",
}

# Where the Control Center records its choice. The dashboard-api writes the
# same file through a compose-mounted /state volume; a host script reads it
# here, and `.env` only seeds the default (like CAPSTONE_DEPLOY_MODE).
STATE_ENV = "CAPSTONE_SMS_TRANSPORT_STATE"
DEFAULT_STATE = os.path.join(REPO, "data", "capstone", "sms-transport")


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
                env[key.strip()] = val.strip().strip("'\"")
    except FileNotFoundError:
        pass
    return env


_ENV = load_dotenv(os.path.join(REPO, ".env"))


def cfg(name, default=""):
    if name in os.environ and os.environ[name]:
        return os.environ[name]
    return _ENV.get(name) or default


def normalize_choice(value):
    """Map 'local'/'provider'/'auto' (or a native name) to a provider, else ''."""
    return TRANSPORT_ALIASES.get(str(value or "").strip().lower(), "")


def state_path():
    """The file the Control Center writes its saved choice to."""
    return os.environ.get(STATE_ENV) or DEFAULT_STATE


def stored_provider():
    """The saved choice, or '' when the Control Center has not recorded one."""
    try:
        with open(state_path()) as fh:
            saved = fh.read().strip().lower()
    except OSError:
        return ""
    return saved if saved in PROVIDERS else ""


def provider():
    """The transport in force: real env, then the saved choice, then .env.

    `.env` seeds the default exactly like `CAPSTONE_DEPLOY_MODE`; the Control
    Center's saved choice overrides it without a container recreate. A value in
    the *real* environment is an explicit operator override and wins over both.
    """
    explicit = (os.environ.get("SMS_PROVIDER") or "").strip()
    if explicit:
        canonical = normalize_choice(explicit)
        if canonical:
            return canonical
        print(f"warning: unknown SMS_PROVIDER {explicit!r}; using the saved choice", file=sys.stderr)

    saved = stored_provider()
    if saved:
        return saved

    seeded = (cfg("SMS_PROVIDER") or "").strip()
    if seeded:
        canonical = normalize_choice(seeded)
        if canonical:
            return canonical
        print(f"warning: unknown SMS_PROVIDER {seeded!r}; using 'zeus'", file=sys.stderr)
    return "zeus"


def configured():
    """True when both the gateway URL and its API key are set."""
    return bool(cfg("OPENSMS_URL").strip() and cfg("OPENSMS_API_KEY").strip())


# --------------------------------------------------------------------------
# client
# --------------------------------------------------------------------------

class OpenSMSError(Exception):
    """Raised when the gateway is unreachable, refuses the key, or fails a send."""


def endpoint(base_url):
    """Normalize the gateway root to the `/sms/` route the app serves.

    Accepting the root and the `/sms` suffix keeps either `.env` shape
    working; the trailing slash is part of the route.
    """
    trimmed = (base_url or "").strip().rstrip("/")
    if not trimmed.lower().startswith(("http://", "https://")):
        raise OpenSMSError(f"OPENSMS_URL must be an http(s) URL (got {base_url!r})")
    if trimmed.lower().endswith("/sms"):
        return trimmed + "/"
    return trimmed + "/sms/"


class OpenSMSClient:
    def __init__(self, base_url=None, api_key=None, timeout_ms=None, verify=True):
        self.base_url = base_url if base_url is not None else cfg("OPENSMS_URL")
        self.api_key = api_key if api_key is not None else cfg("OPENSMS_API_KEY")
        if not self.base_url or not self.api_key:
            raise OpenSMSError("OpenSMS is not configured — set OPENSMS_URL and OPENSMS_API_KEY")
        try:
            configured_ms = int(timeout_ms if timeout_ms is not None else cfg("OPENSMS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS))
        except (TypeError, ValueError):
            configured_ms = DEFAULT_TIMEOUT_MS
        self.timeout = max(configured_ms, 1) / 1000.0
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.ctx = ctx

    @property
    def url(self):
        return endpoint(self.base_url)

    def send_sms(self, number, text):
        """Send one SMS; returns the gateway payload ({"stat": true})."""
        number = str(number or "").strip()
        text = str(text or "")
        if not number:
            raise ValueError("SMS recipient number must not be empty")
        if not text:
            raise ValueError("SMS body must not be empty")

        url = self.url
        data = json.dumps({"number": number, "text": text}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                detail = json.loads(body.decode("utf-8")).get("detail") or body.decode("utf-8", "replace")
            except (ValueError, UnicodeDecodeError):
                detail = body.decode("utf-8", "replace")[:300]
            hint = " — check OPENSMS_API_KEY" if e.code == 401 else ""
            raise OpenSMSError(f"OpenSMS POST /sms/ -> HTTP {e.code}{hint}: {detail}")
        except (urllib.error.URLError, OSError) as e:
            raise OpenSMSError(f"OpenSMS gateway unreachable at {url}: {e}")

        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            raise OpenSMSError(f"OpenSMS returned a non-JSON answer: {raw[:300]!r}")

        # The app answers 200 even when the phone refused to hand the message
        # to the carrier, so `stat` is the actual result. The Linux gateway
        # (and the Android app on some failures) names the reason in `error`;
        # carry it rather than guessing at the cause.
        if not isinstance(payload, dict) or payload.get("stat") is not True:
            detail = payload.get("error") if isinstance(payload, dict) else None
            if not detail and isinstance(payload, dict):
                detail = payload.get("detail")
            if not detail and raw:
                detail = raw.decode("utf-8", "replace")[:300]
            if detail:
                raise OpenSMSError(f"OpenSMS reported the message was not sent: {detail}")
            raise OpenSMSError(
                "OpenSMS reported the message was not sent (stat is not true) — "
                "check the phone's SMS permission and signal"
            )
        return payload


def send_sms(number, text):
    """Send through the configured gateway with a client built from env."""
    return OpenSMSClient().send_sms(number, text)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--to", dest="number", help="recipient phone number")
    ap.add_argument("--body", dest="text", help="SMS body")
    ap.add_argument("--check", action="store_true",
                    help="print the resolved config without sending")
    ap.add_argument("--insecure", action="store_true", help="disable TLS verification")
    args = ap.parse_args(argv)

    if args.check:
        info = {"provider": provider(), "configured": configured()}
        if cfg("OPENSMS_URL"):
            try:
                info["endpoint"] = endpoint(cfg("OPENSMS_URL"))
            except OpenSMSError as e:
                info["error"] = str(e)
        print(json.dumps(info, indent=2))
        return 0

    if not args.number or not args.text:
        ap.error("usage: opensms_client.py --to <number> --body <text> [--check]")

    try:
        payload = OpenSMSClient(verify=not args.insecure).send_sms(args.number, args.text)
    except OpenSMSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
