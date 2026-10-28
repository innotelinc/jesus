"""Inbound SMS from the phone node — the return half of the SMS path.

Outbound goes host -> phone (`OPENSMS_URL`, `POST /sms/`). Replies come back
through this module: the phone's poller POSTs each new inbox message to
`/sms-inbound`, this stores it as JSONL under `/state`, and agents/the Control
Center read it back with `GET /sms-inbound`.

Deliberately shaped like `sms_transport.py`:

  * **A file, not a database.** The transport choice already lives in `/state`;
    inbound replies are an append-only log, so a database would add a migration
    for no query the dashboard needs.
  * **A shared secret, not a session.** The phone is not an Authentik user and
    cannot complete an OIDC login, so the route authenticates with
    `CAPSTONE_SMS_INBOUND_TOKEN` compared in constant time. Unset means the
    route refuses to exist (503), never "open".
  * **The token never leaves the server.** Snapshots report whether one is set.

Deduplication is by the phone's `id`, which it derives from number+date+body, so
a retry after a failed forward cannot double-post a reply.

Outbound replies (`direction: "out"`) are appended to the same log by the
Control Center's sender, so the inbox renders one conversation instead of half
of it. They are recorded after the phone accepts the message and are never the
reason a send is reported as failed — a full disk must not turn a delivered SMS
into an error.

    CAPSTONE_SMS_INBOUND_TOKEN   shared secret; the phone sends it as
                                 `X-Capstone-SMS-Token` (and as a bearer token)
    CAPSTONE_SMS_INBOUND_STATE   JSONL path (default /state/sms-inbound.jsonl)
"""

import hmac
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

TOKEN_ENV = "CAPSTONE_SMS_INBOUND_TOKEN"
STATE_ENV = "CAPSTONE_SMS_INBOUND_STATE"
DEFAULT_STATE = "/state/sms-inbound.jsonl"

MAX_MESSAGES = 5000
MAX_BODY_CHARS = 4096
MAX_FIELD_CHARS = 128

_lock = threading.Lock()


def token() -> str:
    return (os.environ.get(TOKEN_ENV) or "").strip()


def enabled() -> bool:
    """Inbound is opt-in: an unset token must not create an open endpoint."""
    return bool(token())


def authorised(presented: str | None) -> bool:
    expected = token()
    if not expected:
        return False
    return hmac.compare_digest((presented or "").strip(), expected)


def state_path() -> Path:
    return Path(os.environ.get(STATE_ENV) or DEFAULT_STATE)


def _clean(message: dict) -> dict | None:
    if not isinstance(message, dict):
        return None
    body = str(message.get("body") or "").strip()
    sender = str(message.get("from") or message.get("number") or "").strip()
    if not body or not sender:
        return None
    return {
        "id": str(message.get("id") or "")[:MAX_FIELD_CHARS],
        "direction": "in",
        "from": sender[:MAX_FIELD_CHARS],
        "body": body[:MAX_BODY_CHARS],
        "received_at": str(message.get("received_at") or "")[:MAX_FIELD_CHARS],
        "sim": message.get("sim", 0) if isinstance(message.get("sim", 0), int) else 0,
        "received_by": "phone-node",
    }


def _read() -> list[dict]:
    out: list[dict] = []
    try:
        with state_path().open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    out.append(row)
    except OSError:
        return []
    return out


def _append(cleaned: dict, *, dedupe: bool = False) -> bool:
    """Write one row under the lock, keeping the log bounded.

    Returns False when `dedupe` found this id already present. The check and
    the write share the lock on purpose: two retries arriving together must
    not both pass the check and double-post the reply.
    """
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        existing = _read()
        if dedupe and cleaned.get("id") and any(
                row.get("id") == cleaned["id"] for row in existing):
            return False
        rows = existing[-(MAX_MESSAGES - 1):] + [cleaned]
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row) + "\n")
        os.replace(tmp, path)
    return True


def store(message: dict) -> dict:
    """Append one inbound message. Idempotent on `id`.

    Returns {"ok", "stored", "id", "duplicate"} — `stored` is False when the
    id was already present, which is the normal answer to a retry.
    """
    cleaned = _clean(message)
    if cleaned is None:
        raise ValueError("inbound SMS needs a sender and a body")

    if not _append(cleaned, dedupe=True):
        return {"ok": True, "stored": False, "duplicate": True, "id": cleaned["id"]}
    return {"ok": True, "stored": True, "duplicate": False, "id": cleaned["id"]}


def record_outbound(to: str, body: str, *, transport: str = "opensms",
                    status: str = "sent") -> dict | None:
    """Log a reply the Control Center sent, so the thread renders both halves.

    Best effort: the phone already accepted the message, so a read-only or full
    `/state` returns None instead of raising and turning a delivered SMS into a
    failed reply.
    """
    row = {
        "id": "out-" + uuid.uuid4().hex,
        "direction": "out",
        "to": str(to or "")[:MAX_FIELD_CHARS],
        "body": str(body or "")[:MAX_BODY_CHARS],
        "sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "transport": str(transport or "opensms")[:MAX_FIELD_CHARS],
        "status": str(status or "sent")[:MAX_FIELD_CHARS],
        "sent_by": "control-center",
    }
    if not row["to"] or not row["body"]:
        return None
    try:
        _append(row)
    except OSError:
        return None
    return row


def recent(limit: int = 50) -> list[dict]:
    try:
        limit = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        limit = 50
    return _read()[-limit:]


def peer(row: dict) -> str:
    """The other party in a row — the sender inbound, the recipient outbound."""
    return str(row.get("to") if row.get("direction") == "out" else row.get("from") or "")


def snapshot(limit: int = 50) -> dict:
    messages = recent(limit)
    return {
        "enabled": enabled(),
        "token_set": bool(token()),
        "count": len(messages),
        "messages": messages,
    }
