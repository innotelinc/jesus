#!/usr/bin/env python3
"""regrade_interviews.py — grade interviews dograh delivered but that never landed in Grist.

The grader fails **quietly**. dograh's side only records that n8n accepted its
POST, so `webhook_deliveries` reads `succeeded / 200` while the run itself died
at *Fetch transcript* and Grist stayed empty. Two things break that fetch:

1. **The URL's host no longer runs this stack.** `transcript_url` is rendered
   from `PUBLIC_BASE_URL` at hang-up, so a payload written before a move carries
   the old address (`http://<old-lan-ip>:8000/...`) forever. `--retarget` (the
   default) rewrites those onto `PUBLIC_BASE_URL`; the download token in the
   path is stable, so the same transcript resolves on the new host.
2. **The `/voice-audio` route is wrong at the edge** — see `docs/networking.md`
   → the media prefix. Fix that first (`scripts/npm-proxy-hosts.py --check`
   reports it, `--check` on the route itself is what `npm-smoke-test.py` does),
   or every replay below fails the same way.

This replays the recorded payload — the same body dograh POSTs at hang-up — so
what it exercises is the production path, not a stand-in. Runs that already have
an Interviews row are skipped, so re-running it cannot duplicate a grade.

Usage:
  python3 scripts/regrade-interviews.py --dry-run     # what would be graded
  python3 scripts/regrade-interviews.py               # grade them
  python3 scripts/regrade-interviews.py --no-retarget # keep recorded URLs as-is
  python3 scripts/regrade-interviews.py --delivery 21 # just one delivery

Exit 0 only when every replay landed a row; exit 1 otherwise (CI-friendly).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# dograh's own table of what it POSTed to the grader: the payload is exactly
# what the n8n webhook receives, which is why nothing has to be reconstructed.
DELIVERIES_SQL = "select id, payload::text from webhook_deliveries order by id"

# The public download contract the payloads carry. Anything earlier than /api/
# is a host this stack may have stopped running on.
DOWNLOAD_RE = re.compile(r"^https?://[^/]+(/api/v1/public/download/.*)$")


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def grist_url(env: dict[str, str]) -> str:
    return (f"http://127.0.0.1:8484/api/docs/{env['GRIST_DOC_ID']}"
            f"/tables/Interviews/records")


def graded_run_ids(env: dict[str, str]) -> set[str]:
    """RunIDs that already have an Interviews row."""
    req = urllib.request.Request(grist_url(env), headers={
        "Authorization": f"Bearer {env['GRIST_API_KEY']}"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return {str(r["fields"].get("RunID")) for r in json.load(resp).get("records", [])}


def deliveries(env: dict[str, str]) -> list[tuple[int, dict]]:
    """(delivery id, payload) for everything dograh sent the grader."""
    try:
        out = subprocess.check_output(
            ["docker", "exec", "-e", f"PGPASSWORD={env.get('POSTGRES_PASSWORD', 'postgres')}",
             "capstone-postgres-1", "psql", "-U", "postgres", "-d", "postgres",
             "-Atc", DELIVERIES_SQL],
            text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as e:
        raise SystemExit(f"FAIL could not read webhook_deliveries: {e}") from e
    rows: list[tuple[int, dict]] = []
    for line in out.splitlines():
        ident, _, payload = line.partition("|")
        if payload.strip():
            rows.append((int(ident), json.loads(payload)))
    return rows


def retarget(url: str, base: str) -> str:
    """Re-point a transcript_url at the host the stack runs on now."""
    m = DOWNLOAD_RE.match(url or "")
    return base + m.group(1) if m else url


def replay(payload: dict, webhook: str) -> int:
    req = urllib.request.Request(
        webhook, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env-file", default=str(REPO / ".env"))
    parser.add_argument("--dry-run", action="store_true", help="list, grade nothing")
    parser.add_argument("--delivery", type=int, action="append",
                        help="only this delivery id (repeatable)")
    parser.add_argument("--no-retarget", action="store_true",
                        help="replay recorded transcript_urls verbatim")
    parser.add_argument("--wait", type=int, default=180,
                        help="seconds to wait for each row (default 180)")
    parser.add_argument("--webhook", default="http://127.0.0.1:5678/webhook/interview-graded")
    args = parser.parse_args()

    env = load_env_file(Path(args.env_file))
    base = (env.get("PUBLIC_BASE_URL") or "").rstrip("/")
    if not env.get("GRIST_DOC_ID") or not env.get("GRIST_API_KEY"):
        raise SystemExit(f"FAIL GRIST_DOC_ID / GRIST_API_KEY missing from {args.env_file}")

    done = graded_run_ids(env)
    todo = [(i, p) for i, p in deliveries(env) if str(p.get("run_id")) not in done]
    if args.delivery:
        todo = [(i, p) for i, p in todo if i in set(args.delivery)]

    print(f"already graded in Grist: {sorted(done, key=lambda s: int(s) if s.isdigit() else 0)}")
    if not todo:
        print("PASS nothing to do — every delivered run has a grade")
        return 0
    if args.dry_run:
        for ident, payload in todo:
            url = payload.get("transcript_url") or "<missing>"
            new = url if (args.no_retarget or not base) else retarget(url, base)
            print(f"WOULD grade delivery {ident} run {payload.get('run_id')} "
                  f"track={payload.get('track') or 'it(fallback)'}"
                  + (" (retargeted)" if new != url else "")
                  + f" url={new}")
        print(f"PASS dry run — {len(todo)} delivery/deliveries to grade")
        return 0

    graded = failed = 0
    for ident, payload in todo:
        run_id = str(payload.get("run_id"))
        url = payload.get("transcript_url")
        if base and not args.no_retarget:
            payload["transcript_url"] = retarget(url, base)
        moved = " (retargeted)" if payload.get("transcript_url") != url else ""
        label = (f"delivery {ident} run {run_id} "
                 f"track={payload.get('track') or 'it(fallback)'}{moved}")
        try:
            code = replay(payload, args.webhook)
        except (urllib.error.URLError, OSError) as e:
            print(f"FAIL {label}: webhook {e}", file=sys.stderr)
            failed += 1
            continue
        landed = False
        deadline = time.time() + args.wait
        while time.time() < deadline:
            time.sleep(10)
            if run_id in graded_run_ids(env):
                landed = True
                break
        if landed:
            graded += 1
            print(f"PASS {label}: graded (webhook {code})")
        else:
            failed += 1
            print(f"FAIL {label}: no Interviews row within {args.wait}s "
                  f"(webhook {code}) — check the transcript URL and the "
                  f"/voice-audio route", file=sys.stderr)

    print(f"{'PASS' if not failed else 'FAIL'} graded {graded}, failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
