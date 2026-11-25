"""Voice-plane state for the Control Center: the greeting cache and the handsets.

Two questions had no answer anywhere an operator looks. First, is the TTS
shim's prewarmed greeting list still what the routes will render? A cache hit is
~80 ms and a miss ~1.8 s of dead air on the very first thing a caller hears, so
a list that drifts is expensive in exactly the way nobody sees. Second, does a
handset leg actually stop sending RTP — and is that the phone going quiet or the
path eating the packets?

Both are already measured on the host by scripts nobody watches:
`deploy/prewarm-watch.sh` writes its verdict to a status file every five
minutes, and `deploy/rtp-stall-watch.sh` records each captured call, one
`VERDICT:` line per capture, and every 30 s silence in its log. This module
reads those two files, so the state costs a `stat` rather than a `docker exec`
and can be polled by the page.

The `VERDICT:` line is what closes the silence-suppression question without
anyone reading a log: a capture whose handset kept sending throughout is a
handset that does not suppress silence, and the page says so instead of leaving
the reader to interpret it. `voice_notify` carries the same alerts out over SMS.

The API container mounts the host read-only at `/host`; set
`DASHBOARD_HOST_ROOT` to point somewhere else. Alerts are derived, not stored:
an operator's acknowledge/resolve still rides on main.py's in-memory overrides,
keyed by the stable ids below.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import voice_notify

# Where the host filesystem is visible. The compose file mounts it read-only.
HOST_ROOT = os.environ.get("DASHBOARD_HOST_ROOT", "/host")

# Written by deploy/prewarm-watch.sh on every run (in sync, repaired, or failed).
PREWARM_STATUS = os.environ.get("VOICE_PREWARM_STATUS", "/var/lib/capstone-prewarm/status.json")
# The list actually installed in the shim's volume, as shipped.
PREWARM_LIST = os.environ.get("VOICE_PREWARM_LIST", "/var/lib/capstone-prewarm/prewarm.txt")
# deploy/rtp-stall-watch.sh: one line per captured call, a VERDICT line per
# analysed capture, and one STALL line per media silence, in `date -Is` form.
WATCH_LOG = os.environ.get("VOICE_WATCH_LOG", "/var/log/rtp-watch/watch.log")
WATCH_DIR = os.environ.get("VOICE_WATCH_DIR", "/var/log/rtp-watch")

# The watcher runs every 5 minutes; three missed runs means something is wrong
# with the timer, not with a single tick.
PREWARM_STALE_AFTER = timedelta(minutes=int(os.environ.get("VOICE_PREWARM_STALE_MINUTES", "20")))
# A silence older than this is history worth showing, not an open alert.
STALL_ALERT_WINDOW = timedelta(hours=int(os.environ.get("VOICE_STALL_ALERT_HOURS", "24")))

_STAMPED = re.compile(r"^(\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+)\s+(.*)$")
_STALL_PREFIX = "STALL:"
_VERDICT_PREFIX = "VERDICT:"
# `VERDICT: <cause> — <one sentence>`; the em dash is the watcher's, not a typo.
_CAUSE_RE = re.compile(r"^\s*([a-z][a-z-]*)\s*[—-]")
_CAPTURE_RE = re.compile(r"(call-[0-9TZ]+\.pcap)")

# What each cause means for the question that started all this — whether the
# DP750 suppresses silence — written as a conclusion so the page does not ask an
# operator to derive it from a sentence about sequence numbers.
CONCLUSIONS = {
    "sender-silent": (
        "The handset stopped sending while the call was up and came back on its own — "
        "silence suppression (VAD) or a muted mic. With rtp_timeout=0 that no longer "
        "drops the call; nothing else needs fixing."
    ),
    "packet-loss": (
        "The handset kept sending and the packets never arrived — the path dropped them. "
        "Look at the network between the phone and the PBX, not at the phone's settings."
    ),
    "continuous": (
        "The handset sent media throughout the call — it does not suppress silence, so the "
        "2026-11-25 stalls were not VAD and the phone needs no setting change."
    ),
    "single-packet": "One packet only — nothing to conclude from that call.",
    "no-media": "No RTP was captured on that call, so it settles nothing.",
}

# A verdict that answers the question. `no-media` is deliberately not one: a
# ringing call has no media, so its silence proves nothing.
SETTLING_CAUSES = ("sender-silent", "packet-loss", "continuous")


def _host(rel: str) -> Path:
    root = Path(HOST_ROOT)
    return root / rel.lstrip("/") if rel else root


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _lines(path: Path) -> list[str]:
    return [ln.rstrip("\n") for ln in _read_text(path).splitlines()]


def _load_json(path: Path) -> dict[str, Any] | None:
    text = _read_text(path).strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _parse_ts(value: Any) -> datetime | None:
    """An ISO timestamp from the host scripts, or None when it is not one.

    The watchers write `date -Is` (local offset) and the status file writes UTC
    with a `+00:00`; both are ISO 8601, so fromisoformat takes either, and a
    naive stamp is read as UTC rather than silently treated as local time.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def _greeting_lines(path: Path) -> list[str]:
    return [
        ln.strip() for ln in _lines(path)
        if ln.strip() and not ln.lstrip().startswith("#")
    ]


def parse_verdict(text: str) -> dict[str, Any] | None:
    """`VERDICT: <cause> — <sentence>` (without the prefix) → its parts."""
    match = _CAUSE_RE.match(text)
    if not match:
        return None
    cause = match.group(1)
    capture = _CAPTURE_RE.search(text)
    return {
        "cause": cause,
        "conclusion": CONCLUSIONS.get(cause, "The probe recorded a call; its cause is not one this rule names."),
        "text": text,
        "capture": capture.group(1) if capture else None,
    }


def prewarm_state(now: datetime | None = None) -> dict[str, Any]:
    """The installed greeting list and the last drift check.

    `installed: false` means this host has neither file — the watcher is not
    deployed here — which is why no alert is raised for it: a stack without the
    watcher should not page anyone, it should just say so.
    """
    now = now or datetime.now(timezone.utc)
    status_path = _host(PREWARM_STATUS)
    list_path = _host(PREWARM_LIST)
    lines = _greeting_lines(list_path)
    state: dict[str, Any] = {
        "installed": status_path.exists() or list_path.exists(),
        "greetings": len(lines),
        "lines": lines,
        "checkedAt": None,
        "inSync": None,
        "drift": None,
        "applied": False,
        "error": None,
        "stale": False,
        "ageSeconds": None,
    }
    if not state["installed"]:
        return state

    payload = _load_json(status_path)
    if payload is None:
        state["error"] = f"prewarm status is missing or unreadable at {PREWARM_STATUS}"
        state["stale"] = True
        return state

    state.update({
        "checkedAt": payload.get("checkedAt"),
        "inSync": payload.get("inSync"),
        "drift": payload.get("drift"),
        "applied": bool(payload.get("applied")),
        "error": payload.get("error"),
    })
    if isinstance(payload.get("greetings"), int):
        state["greetings"] = int(payload["greetings"])

    checked = _parse_ts(payload.get("checkedAt"))
    if checked is None:
        state["stale"] = True
    else:
        age = (now - checked).total_seconds()
        state["ageSeconds"] = int(age)
        state["stale"] = age > PREWARM_STALE_AFTER.total_seconds()
    return state


def media_state(now: datetime | None = None) -> dict[str, Any]:
    """Captured handset calls, every verdict, and every recorded media silence."""
    now = now or datetime.now(timezone.utc)
    log_path = _host(WATCH_LOG)
    stalls: list[dict[str, Any]] = []
    verdicts: list[dict[str, Any]] = []
    captures = 0
    for line in _lines(log_path):
        match = _STAMPED.match(line)
        stamp, text = (match.group(1), match.group(2)) if match else (None, line)
        if text.startswith("capture started"):
            captures += 1
        elif text.startswith(_STALL_PREFIX):
            stalls.append({"at": stamp, "text": text[len(_STALL_PREFIX):].strip()})
        elif text.startswith(_VERDICT_PREFIX):
            parsed = parse_verdict(text[len(_VERDICT_PREFIX):].strip())
            if parsed is not None:
                verdicts.append({"at": stamp, **parsed})

    kept: list[Path]
    try:
        kept = sorted(
            _host(WATCH_DIR).glob("call-*.pcap"),
            key=lambda p: p.stat().st_mtime,
        )
    except OSError:
        kept = []

    window = STALL_ALERT_WINDOW.total_seconds()
    recent = [
        s for s in stalls
        if (stamp := _parse_ts(s["at"])) is not None and (now - stamp).total_seconds() <= window
    ]

    last_capture: dict[str, Any] | None = None
    if kept:
        newest = kept[-1]
        try:
            stat = newest.stat()
        except OSError:
            stat = None
        last_capture = {
            "name": newest.name,
            "sizeBytes": int(stat.st_size) if stat else 0,
            "at": (
                datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds")
                if stat else None
            ),
        }

    last_verdict = verdicts[-1] if verdicts else None
    return {
        "watcherSeen": log_path.exists(),
        "captures": captures,
        "stalls": len(stalls),
        "stallsInWindow": len(recent),
        "windowHours": int(window // 3600),
        "lastStall": stalls[-1] if stalls else None,
        "lastStallRecent": recent[-1] if recent else None,
        "capturesKept": len(kept),
        "lastCapture": last_capture,
        "verdicts": len(verdicts),
        "lastVerdict": last_verdict,
        # `settled` is the page's whole point: one answered call with media is
        # enough to say whether the handset suppresses silence.
        "question": (
            "settled"
            if last_verdict and last_verdict["cause"] in SETTLING_CAUSES
            else "pending"
        ),
    }


def build_voice_status(now: datetime | None = None) -> dict[str, Any]:
    """Everything the Voice panel shows, in one payload."""
    now = now or datetime.now(timezone.utc)
    root = _host("")
    return {
        "ok": root.exists() and os.access(str(root), os.R_OK),
        "generatedAt": now.isoformat(timespec="seconds"),
        "hostRoot": str(root),
        "prewarm": prewarm_state(now),
        "media": media_state(now),
        "push": voice_notify.state(now),
    }


def build_voice_alerts(now: datetime | None = None) -> list[dict[str, Any]]:
    """Alerts derived from the two host watchers' state.

    Stable ids (`al-voice-*`) so the Alerts page's acknowledge/resolve workflow
    sticks to the condition rather than to a timestamp. A host that never had
    the watchers deployed raises nothing at all.
    """
    now = now or datetime.now(timezone.utc)
    out: list[dict[str, Any]] = []

    prewarm = prewarm_state(now)
    if prewarm["installed"]:
        if prewarm["error"]:
            out.append({
                "id": "al-voice-prewarm-error",
                "time": now.isoformat(timespec="seconds"),
                "service": "TTS shim",
                "severity": "warning",
                "message": (
                    f"Greeting prewarm state is unreadable: {prewarm['error']} — the "
                    "first caller of each route pays ~1.8 s of dead air until it is fixed."
                ),
                "status": "open",
                "assignedTo": "Voice",
                "tags": ["voice", "tts", "prewarm"],
            })
        elif prewarm["stale"]:
            waited = (
                f"{prewarm['ageSeconds'] // 60} min ago" if prewarm["ageSeconds"] is not None
                else "never"
            )
            out.append({
                "id": "al-voice-prewarm-stale",
                "time": prewarm["checkedAt"] or now.isoformat(timespec="seconds"),
                "service": "TTS shim",
                "severity": "warning",
                "message": (
                    f"The greeting prewarm watcher last checked {waited} (it runs every "
                    "5 min) — a drifted list would now go unnoticed and every change "
                    "costs the first caller ~1.8 s of silence."
                ),
                "status": "open",
                "assignedTo": "Voice",
                "tags": ["voice", "tts", "prewarm"],
            })
        elif prewarm["inSync"] is False:
            out.append({
                "id": "al-voice-prewarm-drift",
                "time": prewarm["checkedAt"] or now.isoformat(timespec="seconds"),
                "service": "TTS shim",
                "severity": "warning",
                "message": (
                    "The prewarmed greeting list does not match what the routes render: "
                    f"{prewarm['drift'] or 'see /var/log/prewarm-watch.log'}"
                ),
                "status": "open",
                "assignedTo": "Voice",
                "tags": ["voice", "tts", "prewarm"],
            })

    media = media_state(now)
    stall = media["lastStallRecent"]
    if stall:
        out.append({
            "id": "al-voice-rtp-stall",
            "time": stall["at"] or now.isoformat(timespec="seconds"),
            "service": "FreePBX",
            "severity": "warning",
            "message": (
                f"A handset leg went silent for 30 s or more within the last "
                f"{media['windowHours']} h: {stall['text']}"
            ),
            "status": "open",
            "assignedTo": "Voice",
            "tags": ["voice", "rtp", "pbx"],
        })
    return out
