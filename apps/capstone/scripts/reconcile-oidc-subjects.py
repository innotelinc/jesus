#!/usr/bin/env python3
"""reconcile-oidc-subjects.py — re-point stored OIDC subjects after the
identity provider's change.

WHY THIS EXISTS. A local row is keyed on the provider subject
(`oidc_<uid>`), and Authentik derives that uid as
`sha256("{user_id}-{install_id}")` — so it is a function of the user's numeric
id *and* the instance's install id. Rebuild Authentik, restore it from a
different instance, or delete and recreate a single account, and every affected
subject changes while `users.provider_id` keeps the old value.

dograh/patches/0004 makes that survivable: the person signs in, and the callback
refuses only the address instead of aborting. But they land on a **new** row, so
their account id — and the workflows, agents and settings hanging off it — stay
behind on the old one. This script closes that gap deliberately, on the host,
where an operator can see what it is about to do.

It only ever moves a subject when the two sides agree on the **address**:

  * a row whose stored subject is already current                  -> keep
  * a row with no address to match on (blank, or a local-auth
    `oss_*` row, which is a different auth path entirely)          -> keep
  * no identity has that address at the provider                   -> no-match
  * more than one identity does (or the local address is not
    unique)                                                        -> ambiguous
  * another local row already holds the current subject            -> conflict
  * exactly one identity has it, and no other row claims it        -> repoint

Only `repoint` writes. Everything else is reported, and `--apply` still leaves
`no-match`, `ambiguous` and `conflict` for a human — those are the cases where
guessing would hand one person's account to another.

    python3 scripts/reconcile-oidc-subjects.py              # report only
    python3 scripts/reconcile-oidc-subjects.py --apply      # write, with a backup

Exit codes: 0 = nothing to do or applied cleanly, 1 = rows need attention or a
write failed, 2 = cannot run (no token, no reachable database).
"""
from __future__ import annotations

import argparse
import datetime
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("verify_sso", HERE / "verify-sso.py")
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)

DEFAULT_DB_CONTAINER = os.environ.get("RECONCILE_DB_CONTAINER", "capstone-postgres-1")
DEFAULT_DB_USER = os.environ.get("RECONCILE_DB_USER", "postgres")
DEFAULT_DB_NAME = os.environ.get("RECONCILE_DB_NAME", "postgres")
BACKUP_DIR = pathlib.Path(os.environ.get("RECONCILE_BACKUP_DIR", "/root/oidc-reconcile"))

KEEP, REPOINT = "keep", "repoint"
NO_MATCH, AMBIGUOUS, CONFLICT = "no-match", "ambiguous", "conflict"
PROBLEM = (NO_MATCH, AMBIGUOUS, CONFLICT)


def decision(row_id, email, stored, current, action, reason):
    return {
        "id": row_id, "email": email, "stored": stored,
        "current": current, "action": action, "reason": reason,
    }


def plan(local_rows, idp_users):
    """Decide what to do with every local row. Pure, so it can be tested.

    `local_rows`: [{"id", "email", "provider_id"}] from the local database.
    `idp_users`:  [{"uid", "email"}] as the provider reports them right now.
    """
    by_email: dict[str, list] = {}
    for user in idp_users:
        address = (user.get("email") or "").strip().lower()
        if address:
            by_email.setdefault(address, []).append(user)

    holders = {}  # subject -> local row id
    for row in local_rows:
        subject = (row.get("provider_id") or "").strip()
        if subject:
            holders.setdefault(subject, row["id"])

    decisions = []
    for row in local_rows:
        row_id = row["id"]
        address = (row.get("email") or "").strip().lower()
        stored = (row.get("provider_id") or "").strip()

        if not stored.startswith("oidc_"):
            # A local-auth row (`oss_*`) or a subject-less legacy account: the
            # provider has no claim on it, so it is not this script's business.
            decisions.append(decision(row_id, address, stored, "", KEEP,
                                      "not an OIDC subject"))
            continue
        if not address:
            decisions.append(decision(row_id, "", stored, "", KEEP,
                                      "no address to match on"))
            continue

        matches = by_email.get(address, [])
        if not matches:
            decisions.append(decision(row_id, address, stored, "", NO_MATCH,
                                      "no identity at the provider has this address"))
            continue
        if len(matches) > 1:
            decisions.append(decision(row_id, address, stored, "", AMBIGUOUS,
                                      f"{len(matches)} identities share this address"))
            continue

        current = "oidc_" + matches[0]["uid"]
        if current == stored:
            decisions.append(decision(row_id, address, stored, current, KEEP,
                                      "already current"))
            continue

        holder = holders.get(current)
        if holder is not None and holder != row_id:
            # Writing this would collide on the unique subject index and, worse,
            # would mean two rows claim one identity — a human's call.
            decisions.append(decision(row_id, address, stored, current, CONFLICT,
                                      f"subject already held by row {holder}"))
            continue

        decisions.append(decision(row_id, address, stored, current, REPOINT,
                                  "address matches exactly one identity"))
    return decisions


# ── the local database ─────────────────────────────────────────────────────


def psql(sql, db_container, db_user, db_name):
    """Run one statement through the stack's own postgres container."""
    cmd = ["docker", "exec", db_container, "psql", "-U", db_user, "-d", db_name,
           "--no-align", "--tuples-only", "-F", "\t", "-c", sql]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except FileNotFoundError as err:
        raise v.CannotRun(f"cannot reach the database: {err}") from err
    except subprocess.CalledProcessError as err:
        raise v.CannotRun(
            f"psql failed in {db_container}: {(err.stderr or '').strip()[:300]}"
        ) from err
    return out.stdout


def read_local_rows(db_container, db_user, db_name):
    sql = ("SELECT id, coalesce(email, ''), coalesce(provider_id, '') "
           "FROM users ORDER BY id;")
    rows = []
    for line in psql(sql, db_container, db_user, db_name).splitlines():
        if not line.strip():
            continue
        row_id, email, provider = (line.split("\t") + ["", ""])[:3]
        rows.append({"id": int(row_id), "email": email, "provider_id": provider})
    return rows


def read_idp_users(api):
    """Every identity the provider will present, with its current uid."""
    users, page = [], 1
    while True:
        query = urllib.parse.urlencode({"page_size": 200, "page": page})
        data = api.call("GET", f"/core/users/?{query}")
        if isinstance(data, dict):
            users.extend(data.get("results") or [])
            if not data.get("pagination", {}).get("next"):
                return users
            page += 1
        else:  # a provider that answers with a bare list
            return list(data or [])


# ── reporting ──────────────────────────────────────────────────────────────


def report(decisions):
    width = max([len(d["email"]) for d in decisions] + [5])
    print(f"  {'row':>4}  {'address':<{width}}  {'action':<9}  reason")
    for d in decisions:
        print(f"  {d['id']:>4}  {d['email'] or '-':<{width}}  {d['action']:<9}  {d['reason']}")
    movers = [d for d in decisions if d["action"] == REPOINT]
    problems = [d for d in decisions if d["action"] in PROBLEM]
    print(f"\n  {len(movers)} to re-point, {len(problems)} needing a decision, "
          f"{len(decisions)} row(s) examined")


def apply_repoints(decisions, db_container, db_user, db_name):
    movers = [d for d in decisions if d["action"] == REPOINT]
    if not movers:
        return 0

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_DIR / f"subjects.{stamp}.json"
    backup.write_text(json.dumps(movers, indent=2) + "\n")
    print(f"\n  backup: {backup}")

    failed = 0
    for d in movers:
        # Interpolated values are a hex subject and an integer id; the
        # comparison on the OLD subject makes the write a no-op if the row
        # moved since the report was printed.
        current = d["current"].replace("'", "''")
        stored = d["stored"].replace("'", "''")
        sql = (f"UPDATE users SET provider_id = '{current}' "
               f"WHERE id = {int(d['id'])} AND provider_id = '{stored}';")
        try:
            psql(sql, db_container, db_user, db_name)
            print(f"  row {d['id']}  {d['email']}  -> {d['current'][:20]}...")
        except v.CannotRun as err:
            print(f"  row {d['id']}  FAILED: {err}", file=sys.stderr)
            failed += 1
    return failed


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true",
                        help="write the re-points (default: report only)")
    parser.add_argument("--db-container", default=DEFAULT_DB_CONTAINER)
    parser.add_argument("--db-user", default=DEFAULT_DB_USER)
    parser.add_argument("--db-name", default=DEFAULT_DB_NAME)
    args = parser.parse_args()

    try:
        cfg = v.Config(type("Args", (), {"base": None, "host_ip": None, "verbose": False})())
        api = v.AuthApi(cfg)

        print("reading the identity provider ...")
        idp_users = read_idp_users(api)
        print(f"  {len(idp_users)} identity/identities")
        print("reading the local rows ...")
        local_rows = read_local_rows(args.db_container, args.db_user, args.db_name)
        print(f"  {len(local_rows)} row(s)\n")

        decisions = plan(local_rows, idp_users)
        report(decisions)

        if not args.apply:
            if any(d["action"] == REPOINT for d in decisions):
                print("\n  re-run with --apply to write these")
            return 1 if any(d["action"] in PROBLEM for d in decisions) else 0

        failed = apply_repoints(decisions, args.db_container, args.db_user, args.db_name)
        if failed:
            print(f"\n  {failed} write(s) failed", file=sys.stderr)
            return 1
        return 1 if any(d["action"] in PROBLEM for d in decisions) else 0
    except v.CannotRun as err:
        print(f"cannot run: {err}", file=sys.stderr)
        return 2
    except v.CheckFailed as err:
        print(f"failed: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
