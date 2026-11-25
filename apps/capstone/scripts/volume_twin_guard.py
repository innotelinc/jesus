#!/usr/bin/env python3
"""Fail loudly when the live copy of a stateful volume came up empty.

Coolify names every service volume twice — `<uuid>_<name>` and
`<uuid>_<uuid>-<name>` — and a re-render can move a service from one twin to the
other between deploys. The empty twin does not announce itself: the container
starts, the healthcheck passes, and the only symptom is missing data (zero
devices in FreePBX, no model configuration in dograh, a TTS cache that silently
re-synthesises every greeting).

This compares each pair by apparent size and shouts when the live twin (the dash
form, the one the running stack mounts) is a fraction of its sibling. It only
reads: the repair is a copy, documented in docs/operations.md.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

DEFAULT_UUID = "qvifit87vftfxd9ejsch2vxy"
DEFAULT_ROOT = "/var/lib/docker/volumes"
# A twin under 1 MiB is "empty" for our purposes; below that the comparison is
# noise (an 8 KiB redis volume next to a 4 KiB one is not a lost database).
MIN_INTERESTING = 1024 * 1024
# Volumes whose size says nothing about state: rotated logs, and the git
# checkout (the live one is a --depth 1 clone, so it is legitimately smaller
# than a full-history sibling — flagging that would teach everyone to ignore
# this check).
CHURN = ("-logs", "-repo")
# Volumes where a difference is worth printing but not worth failing on: the
# spool (voicemail) legitimately drains, and the question "did we lose mail?"
# is answered by listening to it, not by a byte count.
SOFT = ("-spool",)

# `<uuid>_<uuid>-anything` is the dash twin, and the only self-describing
# signature of the pattern; it also tells us the uuid without being configured.
TWIN = re.compile(r"^(?P<uuid>[0-9a-zA-Z]{8,40})_(?P=uuid)-")


def tree_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                st = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            total += st.st_size
    return total


def twins(root: str, uuid: str) -> dict[str, dict[str, str]]:
    """Group volume directories by base name: {"mariadb-data": {"live": …, "old": …}}."""
    grouped: dict[str, dict[str, str]] = {}
    try:
        names = os.listdir(root)
    except OSError as e:
        raise SystemExit(f"cannot read {root}: {e}")
    for entry in names:
        if not entry.startswith(uuid + "_"):
            continue
        rest = entry[len(uuid) + 1 :]
        if rest.startswith(uuid + "-"):
            base, kind = rest[len(uuid) + 1 :], "live"
        else:
            base, kind = rest, "old"
        grouped.setdefault(base, {})[kind] = os.path.join(root, entry, "_data")
    return grouped


def discover(root: str) -> list[str]:
    """Every service uuid on this host that has at least one dash twin."""
    try:
        names = os.listdir(root)
    except OSError as e:
        raise SystemExit(f"cannot read {root}: {e}")
    uuids = set()
    for entry in names:
        m = TWIN.match(entry)
        if m:
            uuids.add(m.group("uuid"))
    return sorted(uuids)


def inspect(root: str, uuid: str, ratio: float, min_bytes: int, label: str) -> list[dict]:
    findings = []
    grouped = twins(root, uuid)
    for base in sorted(grouped):
        vols = grouped[base]
        live, old = vols.get("live"), vols.get("old")
        if any(base.endswith(suffix) for suffix in CHURN):
            continue
        live_size = tree_size(live) if live else 0
        old_size = tree_size(old) if old else 0
        state = "pair"
        if live is None or old is None:
            state = "unpaired"
        elif max(live_size, old_size) < min_bytes:
            state = "empty-both"
        elif old_size >= min_bytes and live_size < old_size * ratio:
            state = "LIVE-LOOKS-EMPTY"
        elif live_size >= min_bytes and old_size < live_size * ratio:
            state = "old-looks-stale"
        findings.append(
            {
                "service": label,
                "volume": base,
                "live_bytes": live_size,
                "old_bytes": old_size,
                "state": state,
            }
        )
    return findings


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--uuid", default=DEFAULT_UUID, help="Coolify service uuid")
    p.add_argument(
        "--all",
        action="store_true",
        help="every service on this host that has dash twins (ignores --uuid)",
    )
    p.add_argument("--volumes-root", default=DEFAULT_ROOT, help="docker volumes dir")
    p.add_argument(
        "--ratio",
        type=float,
        default=0.5,
        help="shout when the live twin is below this fraction of its sibling",
    )
    p.add_argument(
        "--min-bytes",
        type=int,
        default=MIN_INTERESTING,
        help="ignore pairs where neither twin reaches this size",
    )
    p.add_argument("--json", action="store_true", help="machine-readable output")
    args = p.parse_args()

    if args.all:
        found = discover(args.volumes_root)
        if not found:
            print(
                f"no volume twins under {args.volumes_root} — "
                "nothing on this host uses the doubled naming"
            )
            return 0
        uuids = found
    else:
        uuids = [args.uuid]

    findings: list[dict] = []
    for uuid in uuids:
        label = uuid if args.all else ""
        findings.extend(
            inspect(args.volumes_root, uuid, args.ratio, args.min_bytes, label)
        )

    bad = [
        f
        for f in findings
        if f["state"] == "LIVE-LOOKS-EMPTY"
        and not any(f["volume"].endswith(suffix) for suffix in SOFT)
    ]
    if args.json:
        print(json.dumps({"findings": findings}, indent=1))
    else:
        for f in findings:
            live_mb = f["live_bytes"] / 1048576
            old_mb = f["old_bytes"] / 1048576
            soft = any(f["volume"].endswith(suffix) for suffix in SOFT)
            if f["state"] == "LIVE-LOOKS-EMPTY":
                mark = "warn" if soft else "CRITICAL"
            else:
                mark = "ok"
            prefix = f"{f['service'][:12]:<12} " if args.all else ""
            print(
                f"{mark:9} {prefix}{f['volume']:<16} live={live_mb:8.1f}M "
                f"sibling={old_mb:8.1f}M  {f['state']}"
            )
    if bad:
        detail = ", ".join(f"{f['volume']} ({f['service'][:12]})" for f in bad)
        print(
            f"CRITICAL: {len(bad)} live volume(s) look empty next to their sibling "
            f"[{detail}] — the stack is probably running on the wrong twin; see "
            "docs/operations.md → Repairing a stateful volume from its twin",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
