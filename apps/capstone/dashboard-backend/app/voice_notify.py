"""Push a voice alert out to a phone — the one channel that leaves the box.

The Alerts page is the durable record, but it assumes somebody is looking at it.
A handset leg that went silent at 03:00 is precisely the thing nobody is looking
at, so the voice alerts are also sent as one SMS, through whichever transport
`SMS_PROVIDER` selects: the Zeus portal (`ZEUS_API_URL` +
`ZEUS_SESSION_TOKEN`) or a local OpenSMS gateway (`OPENSMS_URL` +
`OPENSMS_API_KEY`). A nudge must not be the one message that ignores the
operator's transport choice.

    VOICE_ALERT_SMS_TO         E.164 recipient; unset disables the push
    VOICE_ALERT_PUSH_STATE     JSON bookkeeping (default /state/voice-alert-push.json)
    VOICE_ALERT_PUSH_SECONDS   how often the loop looks (default 60)
    VOICE_ALERT_RESEND_HOURS   age after which an unchanged alert is sent again (12)

Deduplication is by (alert id, message digest), not by time alone: an open
condition pages once instead of every minute, while a *changed* message — a
second stall, a different drift — is a new fact and pages again. The bookkeeping
lives in a file rather than memory so a container restart does not re-page an
operator about the same stall.

Every failure is recorded and swallowed. The Alerts page is the record; an SMS
that could not leave must not turn a read of `/voice` into an error, and must
not be retried in a tight loop against a gateway that is down.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import sms_outbound, sms_transport, zeus_sms

TO_ENV = "VOICE_ALERT_SMS_TO"
STATE_ENV = "VOICE_ALERT_PUSH_STATE"
DEFAULT_STATE = "/state/voice-alert-push.json"
INTERVAL_ENV = "VOICE_ALERT_PUSH_SECONDS"
RESEND_ENV = "VOICE_ALERT_RESEND_HOURS"

# The gateway's own limit is 1000; a nudge is a nudge, and a long alert clipped
# to one screen still tells an operator to open the page.
MAX_BODY_CHARS = 320
ALERT_PREFIX = "al-voice-"


def recipient() -> str:
    return (os.environ.get(TO_ENV) or "").strip()


def mask(number: str) -> str:
    """The last four digits — enough to recognise, not enough to leak."""
    digits = "".join(ch for ch in (number or "") if ch.isdigit())
    return f"…{digits[-4:]}" if len(digits) >= 4 else ""


def transport() -> str:
    """Which sender carries the message: the Zeus portal, or the phone node.

    `SMS_PROVIDER` decides it in one place (Control Center → Settings records
    the same choice). `auto` keeps `scripts/send_sms.py`'s precedence: the
    local gateway when it is configured, the portal otherwise.
    """
    provider = sms_transport.effective()[0]
    if provider == "auto":
        return "opensms" if sms_outbound.configured() else "zeus"
    return provider


def sender_configured() -> bool:
    return zeus_sms.configured() if transport() == "zeus" else sms_outbound.configured()


def missing_setting() -> str:
    """The next thing that has to be set on the host, for the current transport."""
    if not recipient():
        return TO_ENV
    if transport() == "zeus":
        return "ZEUS_API_URL/ZEUS_SESSION_TOKEN"
    return "OPENSMS_URL/OPENSMS_API_KEY"


def enabled() -> bool:
    """A recipient *and* a sender. Either missing means nothing is sent."""
    return bool(recipient()) and sender_configured()


def _send(number: str, body: str) -> dict[str, Any]:
    if transport() == "zeus":
        return zeus_sms.send(number, body)
    return sms_outbound.send(number, body)


def interval() -> float:
    raw = (os.environ.get(INTERVAL_ENV) or "").strip()
    try:
        seconds = float(raw) if raw else 60.0
    except ValueError:
        seconds = 60.0
    return max(seconds, 15.0)


def resend_after() -> timedelta:
    raw = (os.environ.get(RESEND_ENV) or "").strip()
    try:
        hours = float(raw) if raw else 12.0
    except ValueError:
        hours = 12.0
    return timedelta(hours=max(hours, 1.0))


def state_path() -> Path:
    return Path(os.environ.get(STATE_ENV) or DEFAULT_STATE)


def _load() -> dict[str, Any]:
    try:
        payload = json.loads(state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _save(book: dict[str, Any]) -> None:
    """Atomic write; a full disk must not take the alert loop down with it."""
    path = state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(path.parent), delete=False
        ) as fh:
            json.dump(book, fh, indent=2, sort_keys=True)
            tmp = fh.name
        os.replace(tmp, path)
    except OSError:
        pass


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def _digest(message: str) -> str:
    return hashlib.sha256(message.encode("utf-8")).hexdigest()[:16]


def state(now: datetime | None = None) -> dict[str, Any]:
    """What /voice reports about the SMS push — and nothing secret."""
    book = _load()
    provider, source = sms_transport.effective()
    number = recipient()
    return {
        "configured": enabled(),
        "to": mask(number),
        "provider": provider,
        "providerSource": source,
        "gateway": transport(),
        "lastSentAt": book.get("lastSentAt"),
        "lastAttemptAt": book.get("lastAttemptAt"),
        "lastError": book.get("lastError"),
        "sent": len(book.get("alerts") or {}),
        "intervalSeconds": int(interval()),
    }


def dispatch(alerts: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    """Send the voice alerts that are new (or new enough) as one SMS each.

    Returns what happened rather than raising: the loop that calls this treats a
    dead gateway as a condition to report, not as a crash.
    """
    now = now or datetime.now(timezone.utc)
    voices = [a for a in alerts if str(a.get("id") or "").startswith(ALERT_PREFIX)]
    result: dict[str, Any] = {
        "considered": len(voices), "sent": [], "skipped": [], "error": None,
    }
    if not voices:
        return result
    if not enabled():
        result["error"] = f"not configured — set {missing_setting()}"
        return result

    book = _load()
    entries: dict[str, Any] = book.setdefault("alerts", {})
    window = resend_after()

    for alert in voices:
        key = str(alert["id"])
        message = str(alert.get("message") or "")
        digest = _digest(f"{alert.get('severity')}|{message}")
        previous = entries.get(key) or {}
        sent_at = _parse(previous.get("sentAt"))
        if previous.get("digest") == digest and sent_at and (now - sent_at) < window:
            result["skipped"].append(key)
            continue

        body = (
            f"Capstone {alert.get('severity', 'alert')}: "
            f"{alert.get('service', '')} — {message}"
        )[:MAX_BODY_CHARS]
        try:
            reply = _send(recipient(), body)
        except Exception as exc:  # noqa: BLE001 - a nudge must never crash the loop
            text = str(exc) or exc.__class__.__name__
            entries[key] = {
                **previous, "error": text, "attemptedAt": now.isoformat(timespec="seconds"),
            }
            book["lastError"] = text
            book["lastAttemptAt"] = now.isoformat(timespec="seconds")
            _save(book)
            result["error"] = text
            # One failure is the gateway's, not this alert's: stop rather than
            # burn the timeout budget on every remaining alert in the same tick.
            break

        entries[key] = {
            "digest": digest,
            "sentAt": now.isoformat(timespec="seconds"),
            "to": reply.get("to"),
            "transport": reply.get("transport"),
        }
        result["sent"].append(key)
        book["lastSentAt"] = now.isoformat(timespec="seconds")
        book["lastError"] = None
        book["lastAttemptAt"] = now.isoformat(timespec="seconds")

    _save(book)
    return result
