#!/usr/bin/env python3
"""voice_check.py — fail loudly when the voice watchers are installed but dead.

A cron that stopped, a status file nothing rewrites any more, an SMS push that
is configured but erroring: from the outside each of those looks exactly like a
quiet, healthy estate. The Control Center says the same thing either way
("in sync", "no stall"), because "not working" and "nothing to report" are the
same picture until you check the clock.

So this is the check a deploy runs and the one smoke-test calls: it asserts the
things that must be *alive*, not just present.

It also guards the one property that a running watcher cannot show: AMI is
reachable from the box's own loopback and nowhere else, and the account that was
retired to get it there stays retired. Both live in the configuration the
container reads off the host volume, so this reads that copy rather than asking
the daemon.

  voice-check.py                    # the host this runs on, plus the Control Center
  voice-check.py --root /tmp/fixture # check another host root (tests)
  voice-check.py --api ""            # skip the Control Center probe
  voice-check.py --quiet             # only failures and the summary

Exit codes: 0 everything configured is working; 1 at least one failure;
2 nothing is installed at all, so there was nothing to check.

Environment overrides exist for the same reason the dashboard has them — the
tests point the whole thing at a temporary tree:

    VOICE_CHECK_ROOT              prefix for every host path (default /)
    VOICE_PREWARM_STALE_MINUTES   a status older than this is dead (default 20)
    VOICE_ALERT_SMS_TO            the SMS push recipient, if it is meant to be on
    VOICE_ASTERISK_CONFIG         the PBX's /etc/asterisk on this host, if not the
                                  <project>_asterisk-config volume under /var/lib/docker
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WATCH_SCRIPT = "/usr/local/sbin/rtp-stall-watch.sh"
WATCH_CRON = "/etc/cron.d/rtp-stall-watch"
WATCH_LOG = "/var/log/rtp-watch/watch.log"
PREWARM_SCRIPT = "/usr/local/sbin/prewarm-watch.sh"
PREWARM_CRON = "/etc/cron.d/prewarm-watch"
PREWARM_STATUS = "/var/lib/capstone-prewarm/status.json"
DEFAULT_API = "http://127.0.0.1:8095"
ASTERISK_VOLUMES = "var/lib/docker/volumes/*_asterisk-config/_data"

# Accounts retired on purpose. `didtest` was the inbound DID harness's AMI login
# until 2026-11-25: it held a LAN permit, so it was the last way in from off-box.
# Nothing may quietly create it again.
RETIRED_AMI_ACCOUNTS = ("didtest",)

# The only permits that count as "loopback". Anything else is a way in from the LAN.
LOOPBACK_PERMITS = frozenset({
    "127.0.0.1/255.255.255.255",
    "127.0.0.1/255.255.255.0",
    "127.0.0.1/255.0.0.0",
})


class Check:
    """One assertion, and the reason it failed in words an operator can act on."""

    def __init__(self, label: str, state: str, detail: str = "") -> None:
        self.label = label
        self.state = state          # pass | fail | warn | skip
        self.detail = detail

    def line(self) -> str:
        tag = {"pass": "PASS", "fail": "FAIL", "warn": "WARN", "skip": "SKIP"}[self.state]
        return f"[{tag}] {self.label}" + (f" — {self.detail}" if self.detail else "")


def _root_path(raw: str, root: Path) -> Path:
    return root / raw.lstrip("/")


def _stale_minutes() -> int:
    try:
        return int(os.environ.get("VOICE_PREWARM_STALE_MINUTES") or "20")
    except ValueError:
        return 20


def _parse_ts(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def check_watcher(root: Path) -> list[Check]:
    """The stall watcher: installed, scheduled, and still writing."""
    out: list[Check] = []
    script = _root_path(WATCH_SCRIPT, root)
    cron = _root_path(WATCH_CRON, root)
    log = _root_path(WATCH_LOG, root)

    if not script.exists():
        return [Check("stall watcher", "skip", f"not installed at {WATCH_SCRIPT}")]

    out.append(Check("stall watcher installed", "pass"))
    if not cron.exists():
        out.append(Check("stall watcher scheduled", "fail",
                         f"{WATCH_CRON} is missing — the script is installed but nothing runs it"))
    else:
        out.append(Check("stall watcher scheduled", "pass", WATCH_CRON))

    if not log.exists():
        out.append(Check("stall watcher has written its log", "fail",
                         f"{WATCH_LOG} does not exist — installed but never ran"))
        return out

    try:
        with log.open("a"):
            pass
    except OSError as exc:
        out.append(Check("stall watcher log writable", "fail", f"{WATCH_LOG}: {exc}"))
    else:
        out.append(Check("stall watcher log writable", "pass"))

    verdicts = 0
    stalls = 0
    try:
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            if " VERDICT:" in line:
                verdicts += 1
            elif " STALL:" in line:
                stalls += 1
    except OSError as exc:
        out.append(Check("stall watcher log readable", "fail", str(exc)))
    else:
        out.append(Check("calls analysed", "pass" if verdicts else "warn",
                         f"{verdicts} verdict(s), {stalls} stall(s) on record"))
    return out


def check_prewarm(root: Path) -> list[Check]:
    """The greeting watcher: a status file that is being rewritten."""
    script = _root_path(PREWARM_SCRIPT, root)
    status = _root_path(PREWARM_STATUS, root)
    stale_after = _stale_minutes() * 60

    if not script.exists() and not status.exists():
        return [Check("prewarm watcher", "skip", "not installed")]

    out: list[Check] = [Check("prewarm watcher installed", "pass")]
    cron = _root_path(PREWARM_CRON, root)
    if not cron.exists():
        out.append(Check("prewarm watcher scheduled", "fail",
                         f"{PREWARM_CRON} is missing — the status file will go stale silently"))

    if not status.exists():
        out.append(Check("prewarm status written", "fail",
                         f"{PREWARM_STATUS} does not exist — the watcher has not completed a run"))
        return out

    try:
        payload = json.loads(status.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        out.append(Check("prewarm status readable", "fail", f"{PREWARM_STATUS}: {exc}"))
        return out

    if not isinstance(payload, dict):
        out.append(Check("prewarm status readable", "fail", "the status file is not an object"))
        return out

    if payload.get("error"):
        out.append(Check("prewarm run succeeded", "fail", str(payload["error"])))
    elif payload.get("inSync") is False:
        out.append(Check("prewarm list in sync", "fail",
                         f"drifted: {payload.get('drift') or 'see /var/log/prewarm-watch.log'}"))
    else:
        out.append(Check("prewarm list in sync", "pass",
                         f"{payload.get('greetings', '?')} greeting(s)"))

    checked = _parse_ts(payload.get("checkedAt"))
    if checked is None:
        out.append(Check("prewarm check is recent", "fail", "no usable checkedAt in the status"))
    else:
        age = (datetime.now(timezone.utc) - checked).total_seconds()
        check = Check(
            "prewarm check is recent",
            "pass" if age <= stale_after else "fail",
            f"last checked {int(age)}s ago (limit {stale_after}s)",
        )
        out.append(check)
    return out


def _asterisk_config(root: Path) -> Path | None:
    """The PBX's /etc/asterisk as this host can see it, or None off the PBX.

    The container's `asterisk-config` volume is the same directory the daemon
    reads, so this is the live file and not a copy of a template.
    """
    override = (os.environ.get("VOICE_ASTERISK_CONFIG") or "").strip()
    if override:
        return _root_path(override, root)
    matches = sorted(root.glob(ASTERISK_VOLUMES))
    return matches[0] if len(matches) == 1 else None


def _ami_sections(path: Path) -> list[tuple[str, dict[str, list[str]]]]:
    """Parse `[user]` blocks into their lowercase keys, dropping `;` comments."""
    sections: list[tuple[str, dict[str, list[str]]]] = []
    name: str | None = None
    fields: dict[str, list[str]] = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.split(";", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            if name is not None:
                sections.append((name, fields))
            name, fields = line[1:-1].strip(), {}
            continue
        if name is None:
            continue
        key, _, value = line.partition("=")
        fields.setdefault(key.strip().lower(), []).append(value.strip())
    if name is not None:
        sections.append((name, fields))
    return sections


def check_ami(root: Path) -> list[Check]:
    """AMI answers on loopback only, and the accounts retired for that stay retired."""
    base = _asterisk_config(root)
    if base is None:
        return [Check("AMI configuration", "skip", "no asterisk-config volume on this host")]

    manager = base / "manager.conf"
    if not manager.exists():
        return [Check("AMI configuration", "fail",
                      f"{manager} is missing — the volume is not the PBX's config")]

    out: list[Check] = []
    bind: str | None = None
    for name, fields in _ami_sections(manager):
        if name == "general" and fields.get("bindaddr"):
            bind = fields["bindaddr"][-1]
    if bind == "127.0.0.1":
        out.append(Check("AMI bound to loopback", "pass", "bindaddr = 127.0.0.1"))
    else:
        out.append(Check("AMI bound to loopback", "fail",
                         f"bindaddr = {bind or 'unset'} in {manager} — "
                         "`0.0.0.0` answers on the LAN, whatever the ACL says"))

    accounts: list[tuple[str, str, dict[str, list[str]]]] = []
    for path in (manager, base / "manager_custom.conf"):
        if not path.exists():
            continue
        for name, fields in _ami_sections(path):
            if name != "general":
                accounts.append((name, path.name, fields))

    revived = sorted({(name, where) for name, where, _ in accounts
                      if name in RETIRED_AMI_ACCOUNTS})
    if revived:
        out.append(Check(
            "retired AMI accounts stayed retired", "fail",
            "; ".join(f"[{name}] is back in {where}" for name, where in revived)
            + " — nothing may recreate it; delete the block and run `asterisk -rx 'manager reload'`",
        ))
    else:
        out.append(Check("retired AMI accounts stayed retired", "pass",
                         f"none of {', '.join(RETIRED_AMI_ACCOUNTS)} is configured"))

    loose = []
    for name, where, fields in accounts:
        permits = fields.get("permit") or []
        if not permits:
            loose.append(f"[{name}] in {where} has no permit line, so it accepts any address")
            continue
        off = [p for p in permits if p not in LOOPBACK_PERMITS]
        if off:
            loose.append(f"[{name}] in {where} permits {', '.join(off)}")
    out.append(Check(
        "every AMI account is loopback-only",
        "fail" if loose else "pass",
        "; ".join(loose) if loose else f"{len(accounts)} account(s), all on 127.0.0.1",
    ))
    return out


def check_api(api: str) -> list[Check]:
    """What the Control Center reports, cross-checked against the SMS config."""
    if not api:
        return [Check("Control Center /voice", "skip", "not probed")]

    url = api.rstrip("/") + "/voice"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            payload = json.loads(resp.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return [Check("Control Center /voice", "fail", f"{url}: {exc}")]

    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return [Check("Control Center sees the host files", "fail",
                      f"{url} answered ok={payload.get('ok') if isinstance(payload, dict) else '?'} "
                      "— check the /host mounts on dashboard-api")]

    out: list[Check] = [Check("Control Center sees the host files", "pass")]

    media = payload.get("media") or {}
    cause = (media.get("lastVerdict") or {}).get("cause")
    out.append(Check(
        "handset question",
        "pass" if media.get("question") == "settled" else "warn",
        f"{media.get('question') or 'unknown'}"
        + (f", last verdict {cause}" if cause else ", no analysed call yet"),
    ))

    push = payload.get("push") or {}
    provider = push.get("provider") or "?"
    # Name the setting the *selected* transport actually needs: a zeus push is
    # waiting on a portal session, not on a phone node.
    hint = ("ZEUS_API_URL/ZEUS_SESSION_TOKEN" if provider == "zeus"
            else "OPENSMS_URL/OPENSMS_API_KEY")
    recipient = (os.environ.get("VOICE_ALERT_SMS_TO") or "").strip()
    if recipient and not push.get("configured"):
        out.append(Check("SMS push", "fail",
                         f"VOICE_ALERT_SMS_TO is set but the push is not configured "
                         f"(provider {provider}) — set {hint}"))
    elif push.get("configured") and push.get("lastError"):
        out.append(Check("SMS push", "fail", f"configured but failing: {push['lastError']}"))
    elif push.get("configured"):
        out.append(Check("SMS push", "pass",
                         f"to {push.get('to')} via {push.get('gateway')}, "
                         f"{push.get('sent', 0)} sent"))
    else:
        out.append(Check("SMS push", "warn",
                         f"off — set VOICE_ALERT_SMS_TO and {hint} to be paged"))
    return out


def run(root: Path, api: str) -> tuple[list[Check], int]:
    # "Nothing installed" is about the watchers, so that a PBX host which lost
    # them still says so; a failing AMI check outranks it either way.
    watchers = check_watcher(root) + check_prewarm(root)
    checks = watchers + check_ami(root) + check_api(api)
    if any(c.state == "fail" for c in checks):
        return checks, 1
    return checks, (2 if all(c.state == "skip" for c in watchers) else 0)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.environ.get("VOICE_CHECK_ROOT") or "/",
                    help="host root to check (default /)")
    ap.add_argument("--api", default=os.environ.get("VOICE_API_URL", DEFAULT_API),
                    help="dashboard-api base URL; empty skips the Control Center probe")
    ap.add_argument("--quiet", action="store_true", help="only failures and the summary")
    args = ap.parse_args(argv)

    checks, code = run(Path(args.root), args.api)
    for check in checks:
        if args.quiet and check.state in ("pass", "skip"):
            continue
        print(check.line())

    failures = sum(1 for c in checks if c.state == "fail")
    if code == 2:
        print("voice: nothing installed — the watchers were never deployed here")
    elif failures:
        print(f"voice: {failures} check(s) failed — a voice watcher is installed but not working")
    else:
        print("voice: every installed watcher is alive")
    return code


if __name__ == "__main__":
    sys.exit(main())
