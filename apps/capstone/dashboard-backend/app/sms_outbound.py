"""Outbound SMS to the phone node — the reply half of the Control Center inbox.

`POST /sms-outbound` is what an operator's reply uses. It deliberately does
**not** honour `SMS_PROVIDER`: a reply goes back the way it arrived, through the
phone that received it. The inbound message carries that SIM's number, so
sending the answer from a Zeus DID instead would split the thread across two
senders and the recipient would see a different number answer them.

The gateway contract is OpenSMS's (`POST /sms/`, Bearer key,
`{"number", "text"}` → `{"stat": true}`), which is also what
`phone-node/opensms_termux_bridge.py` implements. As in
`scripts/opensms_client.py`, HTTP 200 is not success — the app answers 200 even
when the modem refuses, so `stat` is the result and its `error`/`detail` is the
reason.

    OPENSMS_URL          http://<phone-lan-ip>:9292   (root or /sms both work)
    OPENSMS_API_KEY      the gateway's bearer key
    OPENSMS_TIMEOUT_MS   request budget (default 15000)

The key is never returned to the browser: this module only reports whether one
is configured, through `sms_transport.snapshot()`.
"""

from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.request
from typing import Any

from . import sms_inbound, sms_transport

DEFAULT_TIMEOUT_MS = 15000
MAX_BODY_CHARS = 1000

# E.164-ish: a leading '+' and 7–15 digits. Permissive on entry (spaces, dashes
# and brackets are stripped) because operators paste numbers out of a thread.
_PHONE_RE = re.compile(r"^\+?[1-9]\d{6,14}$")


class SmsSendError(Exception):
    """The gateway answered, but not with a delivered message."""


class SmsNotConfigured(SmsSendError):
    """No phone node is configured, so there is nothing to reply through."""


def normalise_number(raw: Any) -> str:
    """Strip formatting, require a plausible number, return E.164-ish digits."""
    text = str(raw or "").strip()
    digits = "+" + re.sub(r"[^\d]", "", text.lstrip("+"))
    if not _PHONE_RE.match(digits):
        raise ValueError(f"not a usable phone number: {text!r}")
    return digits


def endpoint(base_url: str) -> str:
    """Gateway root (or `/sms`) → the `/sms/` route; mirrors the CLI client."""
    trimmed = (base_url or "").strip().rstrip("/")
    if not trimmed.lower().startswith(("http://", "https://")):
        raise SmsNotConfigured(f"OPENSMS_URL must be an http(s) URL (got {base_url!r})")
    if trimmed.lower().endswith("/sms"):
        return trimmed + "/"
    return trimmed + "/sms/"


def configured() -> bool:
    return bool(sms_transport.cfg("OPENSMS_URL").strip()
                and sms_transport.cfg("OPENSMS_API_KEY").strip())


def _timeout() -> float:
    raw = sms_transport.cfg("OPENSMS_TIMEOUT_MS").strip()
    try:
        ms = int(raw) if raw else DEFAULT_TIMEOUT_MS
    except ValueError:
        ms = DEFAULT_TIMEOUT_MS
    return max(ms, 1) / 1000.0


def gateway_response(url: str, key: str, number: str, body: str) -> dict[str, Any]:
    """POST one message. Raises SmsSendError for every failure shape."""
    data = json.dumps({"number": number, "text": body}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=_timeout(),
                                    context=ssl.create_default_context()) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        try:
            detail = json.loads(detail).get("detail") or detail
        except (ValueError, AttributeError):
            pass
        hint = " — check OPENSMS_API_KEY" if exc.code == 401 else ""
        raise SmsSendError(f"the phone node answered HTTP {exc.code}{hint}: {detail}") from exc
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise SmsSendError(
            f"the phone node is unreachable at {url}: {reason} — check its IP, "
            "that the bridge is running, and that this host is on the same network"
        ) from exc

    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError) as exc:
        raise SmsSendError(f"the phone node returned a non-JSON answer: {raw[:300]!r}") from exc

    if not isinstance(payload, dict) or payload.get("stat") is not True:
        detail = ""
        if isinstance(payload, dict):
            detail = str(payload.get("error") or payload.get("detail") or "")
        if not detail:
            detail = raw.decode("utf-8", "replace")[:300] or "stat was not true"
        raise SmsSendError(f"the phone did not send the message: {detail}")
    return payload


def send(to: Any, text: Any) -> dict[str, Any]:
    """Send one reply through the phone node, then log it in the thread.

    Returns the operator-facing result (and echoes the gateway's own transport
    name, so a reply that left over PJSIP is not reported as a modem send).
    Recording lives here rather than in the route so every caller of the SMS
    path keeps the conversation whole; `sms_inbound.record_outbound` is best
    effort, so a cold `/state` cannot turn a delivered reply into an error.
    """
    number = normalise_number(to)
    body = str(text or "").strip()
    if not body:
        raise ValueError("the reply is empty")
    if len(body) > MAX_BODY_CHARS:
        raise ValueError(f"the reply is too long ({len(body)} > {MAX_BODY_CHARS} characters)")
    if not configured():
        raise SmsNotConfigured(
            "the phone node is not configured — set OPENSMS_URL and OPENSMS_API_KEY "
            "on the host, then reply again"
        )

    url = endpoint(sms_transport.cfg("OPENSMS_URL"))
    key = sms_transport.cfg("OPENSMS_API_KEY").strip()
    payload = gateway_response(url, key, number, body)
    transport = str(payload.get("transport") or "opensms")
    recorded = sms_inbound.record_outbound(number, body, transport=transport)
    return {
        "ok": True,
        "to": number,
        "transport": transport,
        "status": "sent",
        "message": str(payload.get("message") or ""),
        "recorded": recorded is not None,
    }
