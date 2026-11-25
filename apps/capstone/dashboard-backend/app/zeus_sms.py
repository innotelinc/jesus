"""Outbound SMS through the Zeus portal — the selected-transport path.

`voice_notify` pages an operator when a handset leg goes silent. Which sender
carries that message is `SMS_PROVIDER`'s choice (see `sms_transport`): the
Zeus portal, or a local OpenSMS gateway. This module is the portal half, so
the alert leaves the same way the operator's other SMS does instead of being
pinned to one gateway.

The contract is the one `scripts/zeus_client.py` implements from the Zeus
repo's `docs/portal-api.md` §1: every request carries the account session as
the `pbx_session` cookie value.

    ZEUS_API_URL         portal origin (default https://api.zeus.innotel.us)
    ZEUS_SESSION_TOKEN   the account's pbx_session cookie value
    ZEUS_SMS_DID         optional from_did_id — the DID the message leaves from

The token is never returned to the browser: `configured()` only reports whether
one exists.
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from typing import Any

from . import sms_transport

DEFAULT_BASE_URL = "https://api.zeus.innotel.us"
DEFAULT_TIMEOUT_MS = 15000
SEND_PATH = "/api/messages/send"


class ZeusSendError(Exception):
    """The portal answered, but not with a queued message."""


class ZeusNotConfigured(ZeusSendError):
    """No portal origin or no session, so there is nothing to authenticate with."""


def base_url() -> str:
    return (sms_transport.cfg("ZEUS_API_URL") or DEFAULT_BASE_URL).strip().rstrip("/")


def token() -> str:
    return sms_transport.cfg("ZEUS_SESSION_TOKEN").strip()


def from_did() -> str:
    """The DID to send from. Empty lets the portal pick the account's default."""
    return sms_transport.cfg("ZEUS_SMS_DID").strip()


def configured() -> bool:
    return bool(base_url() and token())


def _timeout() -> float:
    raw = sms_transport.cfg("ZEUS_SMS_TIMEOUT_MS").strip()
    try:
        ms = int(raw) if raw else DEFAULT_TIMEOUT_MS
    except ValueError:
        ms = DEFAULT_TIMEOUT_MS
    return max(ms, 1) / 1000.0


def send(to: Any, text: Any) -> dict[str, Any]:
    """Send one message. Raises ZeusSendError for every failure shape."""
    number = str(to or "").strip()
    body = str(text or "").strip()
    if not number:
        raise ValueError("the recipient is empty")
    if not body:
        raise ValueError("the message is empty")
    if not configured():
        raise ZeusNotConfigured(
            "the Zeus portal is not configured — set ZEUS_API_URL and "
            "ZEUS_SESSION_TOKEN on the host"
        )

    url = base_url() + SEND_PATH
    data = json.dumps(
        {"to_number": number, "from_did_id": from_did(), "body": body}
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            # docs/portal-api.md §1: the account session, not a Bearer.
            "Cookie": f"pbx_session={token()}",
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=_timeout(), context=ssl.create_default_context()
        ) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        try:
            detail = json.loads(detail).get("error") or detail
        except (ValueError, AttributeError):
            pass
        hint = " — the session token is stale" if exc.code in (401, 403) else ""
        raise ZeusSendError(f"the Zeus portal answered HTTP {exc.code}{hint}: {detail}") from exc
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise ZeusSendError(
            f"the Zeus portal is unreachable at {url}: {reason} — check ZEUS_API_URL "
            "and that this host can reach the portal"
        ) from exc

    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError) as exc:
        raise ZeusSendError(
            f"the Zeus portal returned a non-JSON answer: {raw[:300]!r}"
        ) from exc

    if isinstance(payload, dict) and payload.get("ok") is False:
        raise ZeusSendError(
            f"the Zeus portal did not send the message: "
            f"{payload.get('error') or payload.get('detail') or 'ok was false'}"
        )
    return {
        "ok": True,
        "to": number,
        "transport": "zeus",
        "status": str(payload.get("status") or "queued") if isinstance(payload, dict) else "queued",
        "message_id": payload.get("message_id") if isinstance(payload, dict) else None,
    }
