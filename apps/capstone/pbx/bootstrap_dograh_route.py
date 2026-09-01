#!/usr/bin/env python3
"""Bootstrap the dograh inbound route on FreePBX via the API module — no GUI.

Replaces the FreePBX GUI recipe from pbx/README.md:
  Admin → Custom Destinations → Add Destination (dograh-inbound,8000,1)
  Connectivity → Inbound Routes → Add Inbound Route (DID 8000 → that dest)

How it works (two mechanisms, both scripted):
  1. FreePBX API module (OAuth2 + GraphQL) — `addInboundRoute` mutation.
     The API module does NOT expose custom destinations, so...
  2. customappsreg's kvstore row — the script inserts the Custom Destination
     directly into `kvstore_Customappsreg` (json-arr, exactly what the
     module's own `setConfig()` writes) via `docker exec ... mysql`.

The dialplan context `dograh-inbound` already exists (injected by
pbx/entrypoint-dograh.sh from pbx/asterisk/extensions_custom.conf); this
script only wires the inbound route to it.

Idempotent: if a route for the DID already exists it does nothing (unless
--force). Requires the API module + OAuth client in the image — the
fullstack entrypoint registers the client when FREEPBX_CLIENT_ID and
FREEPBX_CLIENT_SECRET are set (empty allowed_scopes = full schema access).

Usage (from the repo root, with the capstone .env loaded):
    FREEPBX_CLIENT_SECRET=<secret> python3 pbx/bootstrap_dograh_route.py
    python3 pbx/bootstrap_dograh_route.py --check      # verify only
    python3 pbx/bootstrap_dograh_route.py --force      # update existing route

Environment / args:
    --url            FreePBX base URL (default http://127.0.0.1)
    --container      freepbx container name (default pbx-freepbx)
    --client-id      OAuth client id (env FREEPBX_CLIENT_ID, default pbxportal-api)
    --client-secret  OAuth client secret (env FREEPBX_CLIENT_SECRET, required)
    --did            DID number to route (default 8000)
    --context        dialplan context (default dograh-inbound)
    --exten          exten in that context (default 8000)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_DESCRIPTION = "Dograh Voice Agent (mock interview)"

# The Blacklist module's own built-in destination (Connectivity → Blacklist →
# Settings → "Destination for Blacklisted Calls" = Terminate Call). Used as the
# safe reset value when the configured destination dangles on a deleted custom
# destination.
BLACKLIST_MODULE_DEST = "app-blacklist-check,s,1"


class FreepbxError(RuntimeError):
    pass


def sh(*args: str) -> str:
    """Run a command on the host, return stdout (stripped)."""
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as e:
        raise FreepbxError(f"command timed out: {' '.join(args)}") from e
    if out.returncode != 0:
        raise FreepbxError(
            f"{' '.join(args)} -> exit {out.returncode}: {out.stderr.strip()}"
        )
    return out.stdout.strip()


def mysql(container: str, sql: str) -> str:
    """Run SQL inside the freepbx container (root, asterisk DB)."""
    return sh("docker", "exec", container, "mysql", "-N", "-B", "-u", "root", "asterisk", "-e", sql)


class FreepbxApi:
    def __init__(self, base_url: str, client_id: str, client_secret: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self._token: str | None = None

    def _request(self, url: str, data: bytes | None, headers: dict[str, str]) -> Any:
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:400]
            raise FreepbxError(f"HTTP {e.code} from {url}: {body}") from e
        except urllib.error.URLError as e:
            raise FreepbxError(f"unreachable {url}: {e.reason}") from e

    def token(self) -> str:
        if self._token:
            return self._token
        body = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        ).encode()
        data = self._request(
            f"{self.base_url}/admin/api/api/token",
            body,
            {"Content-Type": "application/x-www-form-urlencoded"},
        )
        self._token = data.get("access_token", "")
        if not self._token:
            raise FreepbxError("OAuth token response had no access_token")
        return self._token

    def gql(self, query: str, variables: dict | None = None) -> Any:
        payload = json.dumps({"query": query, "variables": variables or {}}).encode()
        data = self._request(
            f"{self.base_url}/admin/ajax.php?module=api&command=gql",
            payload,
            {
                "Authorization": f"Bearer {self.token()}",
                "Content-Type": "application/json",
            },
        )
        if data and data.get("errors"):
            raise FreepbxError(
                "GraphQL: " + ", ".join(e["message"] for e in data["errors"])
            )
        return (data or {}).get("data")

    def wait_ready(self, timeout: int = 600) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.token()
                return
            except FreepbxError:
                time.sleep(10)
        raise FreepbxError(
            "FreePBX API not ready — is the freepbx container up with "
            "FREEPBX_CLIENT_ID/SECRET set?"
        )

    def find_route(self, did: str) -> dict | None:
        q = """query { allInboundRoutes(first: 500) {
                  edges { node { id extension description } }
                } }"""
        data = self.gql(q) or {}
        for edge in data.get("allInboundRoutes", {}).get("edges", []):
            node = edge.get("node", {})
            if node.get("extension") == did:
                return node
        return None

    def add_route(self, did: str, description: str, destination: str) -> None:
        m = """mutation AddInboundRoute($input: addInboundRouteInput!) {
                 addInboundRoute(input: $input) { status message }
               }"""
        data = self.gql(
            m,
            {
                "input": {
                    "extension": did,
                    "description": description,
                    "destination": destination,
                }
            },
        )
        res = data.get("addInboundRoute", {}) if data else {}
        if res.get("status") is True:
            print(f"[freepbx] inbound route {did} → {destination} created")
        elif res.get("message"):
            print(f"[freepbx] inbound route: {res.get('message')}")
        else:
            raise FreepbxError(f"addInboundRoute returned {res!r}")


# ── customappsreg kvstore helpers ────────────────────────────────────────────
def kvstore_table(container: str) -> str:
    rows = mysql(
        container,
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='asterisk' AND table_name LIKE 'kvstore\\_%ustomappsreg%' "
        "LIMIT 1",
    )
    if not rows:
        raise FreepbxError(
            "kvstore table for customappsreg not found — is the customappsreg "
            "module installed in this FreePBX?"
        )
    return rows.splitlines()[0]


def find_dest_id(container: str, table: str, target: str) -> str | None:
    rows = mysql(
        container,
        f"SELECT `key` FROM `{table}` WHERE `id`='dests' AND `type`='json-arr' "
        f"AND `val` LIKE '%{target}%' ORDER BY CAST(`key` AS UNSIGNED) LIMIT 1",
    )
    return rows.splitlines()[0] if rows else None


def dialplan_has(container: str, context: str, exten: str) -> bool:
    """True when the live Asterisk dialplan has `exten` in `context`.

    FreePBX flags any destination whose context is absent from the running
    dialplan as a "bad destination" (the same check the Blacklist module and
    the dashboard's bad-destinations notice use). Validating against
    `asterisk -rx 'dialplan show'` is the ground truth for that check.
    """
    try:
        out = sh("docker", "exec", container, "asterisk", "-rx", f"dialplan show {context}")
    except FreepbxError:
        return False
    return exten in out


def validate_custom_destinations(container: str, targets: list[str], context: str) -> list[str]:
    """Check every dograh custom-destination target against the live dialplan.

    Returns the list of targets that are NOT present — the ones FreePBX's
    destination validation (Blacklist settings, dashboard bad-destination
    notices) will flag. A non-empty result means the dialplan hasn't picked
    up the injected [context] yet (e.g. a reload is still pending) or the
    include is missing; the caller should surface it instead of leaving a
    silently dangling destination.
    """
    missing = []
    seen: set[str] = set()
    for t in targets:
        if t in seen:
            continue
        seen.add(t)
        parts = t.split(",")
        exten = parts[1] if len(parts) > 1 else ""
        if not exten:
            continue
        if not dialplan_has(container, context, exten):
            missing.append(t)
    return missing


def fix_blacklist_destination(container: str) -> str:
    """Repair the Blacklist module's destination so it can never dangle.

    The Blacklist module stores its "Destination for Blacklisted Calls" in
    kvstore_Blacklist under key `dest`. When the dograh sync prunes a removed
    number it deletes the matching custom destination, and if Blacklist's
    setting referenced that destination (custom-app,dest-<n>,1) FreePBX's
    destination validation — the Blacklist settings page, the dashboard
    "bad destinations" notice, and Apply Config — fails with an invalid
    destination. Reset the setting to the module's own built-in destination
    (Terminate Call) whenever it points at a missing custom destination.
    Idempotent; never raises (a repair failure must not break boot/sync).
    """
    try:
        rows = mysql(
            container,
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='asterisk' AND table_name LIKE 'kvstore\\_%lacklist%' "
            "LIMIT 1",
        )
        if not rows:
            return "blacklist module not installed"
        table = rows.splitlines()[0]
        cur = mysql(container, f"SELECT `val` FROM `{table}` WHERE `key`='dest' LIMIT 1")
        if not cur:
            return "no blacklist destination configured"
        dest = cur.splitlines()[0].strip()
        if not dest.startswith("custom-app,"):
            return "blacklist destination is a built-in (valid)"
        dest_id = dest.split(",")[1] if len(dest.split(",")) > 1 else ""
        if not dest_id or not dest_id.startswith("dest-"):
            return "blacklist destination references a non-custom-app target (valid)"
        num = dest_id[len("dest-"):]
        try:
            cust = kvstore_table(container)
            exists = mysql(
                container,
                f"SELECT COUNT(*) FROM `{cust}` WHERE `id`='dests' AND `key`='{num}'",
            )
            if exists.splitlines() and int(exists.splitlines()[0]) > 0:
                return f"blacklist destination custom-app,{dest_id},1 still resolves"
        except FreepbxError:
            pass
        mysql(container, f"UPDATE `{table}` SET `val`='{BLACKLIST_MODULE_DEST}' WHERE `key`='dest'")
        return f"reset dangling blacklist destination to {BLACKLIST_MODULE_DEST}"
    except FreepbxError:
        return "blacklist repair unavailable (table/module missing)"


def ensure_custom_dest(container: str, table: str, target: str, description: str) -> str:
    existing = find_dest_id(container, table, target)
    if existing:
        # Refresh the destination's description if it differs (e.g. after a
        # label/purpose change) so the GUI title stays accurate.
        row = mysql(
            container,
            f"SELECT `val` FROM `{table}` WHERE `id`='dests' AND `key`='{existing}'",
        )
        if row:
            try:
                d = json.loads(row.splitlines()[0])
            except (ValueError, IndexError):
                d = {}
            if d.get("description") != description:
                d["description"] = description
                val = json.dumps(d)
                mysql(
                    container,
                    f"UPDATE `{table}` SET `val`='{val}' WHERE `id`='dests' AND `key`='{existing}'",
                )
                print(f"[freepbx] custom destination dest-{existing} description refreshed → {description}")
        print(f"[freepbx] custom destination already exists (dest-{existing})")
        return existing

    rows = mysql(
        container,
        f"SELECT COALESCE(MAX(CAST(`key` AS UNSIGNED)),0)+1 FROM `{table}` "
        "WHERE `id`='dests'",
    )
    next_id = rows.splitlines()[0] or "1"

    dest = {
        "destid": int(next_id),
        "target": target,
        "description": description,
        "notes": "",
        # Explicit hangup return — matches what the customappsreg GUI writes
        # and keeps the row well-formed for FreePBX's destination validation.
        "destret": "app-hangup,s,1",
    }
    sql = (
        f"INSERT INTO `{table}` (`key`,`val`,`type`,`id`) VALUES "
        f"('{next_id}', '{json.dumps(dest)}', 'json-arr', 'dests') "
        f"ON DUPLICATE KEY UPDATE `val`=VALUES(`val`), `type`=VALUES(`type`)"
    )
    mysql(container, sql)

    cur = mysql(
        container, f"SELECT `val` FROM `{table}` WHERE `key`='currentid' AND `id`='noid'"
    )
    if not cur or int(cur) <= int(next_id):
        mysql(
            container,
            f"INSERT INTO `{table}` (`key`,`val`,`type`,`id`) VALUES "
            f"('currentid', '{int(next_id)+1}', NULL, 'noid') "
            f"ON DUPLICATE KEY UPDATE `val`=VALUES(`val`)",
        )
    print(f"[freepbx] custom destination created (dest-{next_id} → {target})")
    return next_id


def resolve_container(default: str) -> str:
    """Resolve the freepbx container: exact name first, else the first running
    container whose name contains 'pbx-freepbx' (a daemon hiccup can rename it)."""
    try:
        sh("docker", "inspect", default)
        return default
    except FreepbxError:
        out = sh("docker", "ps", "--format", "{{.Names}}")
        for name in out.splitlines():
            if "pbx-freepbx" in name:
                return name
    return default


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("FREEPBX_URL", "http://127.0.0.1"))
    parser.add_argument("--container", default=os.environ.get("FREEPBX_CONTAINER", "pbx-freepbx"))
    parser.add_argument("--client-id", default=os.environ.get("FREEPBX_CLIENT_ID", "pbxportal-api"))
    parser.add_argument("--client-secret", default=os.environ.get("FREEPBX_CLIENT_SECRET", ""))
    parser.add_argument("--did", default="8000")
    parser.add_argument("--context", default="dograh-inbound")
    parser.add_argument("--exten", default="8000")
    parser.add_argument("--force", action="store_true", help="update an existing route")
    parser.add_argument("--check", action="store_true", help="verify only, no writes")
    args = parser.parse_args()

    if not args.client_secret:
        print("[freepbx] FAIL — FREEPBX_CLIENT_SECRET is required", file=sys.stderr)
        return 1

    args.container = resolve_container(args.container)

    destination = f"{args.context},{args.exten},1"

    try:
        # 0. Container up + API ready
        if args.check:
            sh("docker", "inspect", args.container)
        api = FreepbxApi(args.url, args.client_id, args.client_secret)
        api.wait_ready(timeout=120 if args.check else 600)
        print(f"[freepbx] API ready (OAuth client {args.client_id})")

        # 1. Existing route?
        existing = api.find_route(args.did)
        if existing and not args.force:
            print(
                f"[freepbx] route for DID {args.did} already exists "
                f"({existing.get('description')}) — nothing to do (use --force to update)"
            )
            return 0

        # 2. Custom destination (GUI "Admin → Custom Destinations")
        table = kvstore_table(args.container)
        if not args.check:
            dest_id = ensure_custom_dest(
                args.container, table, destination, DEFAULT_DESCRIPTION
            )
        else:
            dest_id = find_dest_id(args.container, table, destination)

        # 3. Inbound route via the API module
        if not args.check:
            api.add_route(args.did, DEFAULT_DESCRIPTION, destination)
            print("[freepbx] running fwconsole reload...")
            # Our entrypoint edits /etc/asterisk as root; reset ownership first
            # or the reload can die with FreePBX's "Unknown Error. Please Run:
            # fwconsole reload --verbose." on files it can no longer write.
            sh("docker", "exec", args.container, "fwconsole", "chown")
            sh("docker", "exec", args.container, "fwconsole", "reload")
        elif dest_id is None:
            print("[freepbx] FAIL — custom destination missing (run without --check)")
            return 1
    except (FreepbxError, subprocess.SubprocessError) as e:
        print(f"[freepbx] FAIL — {e}", file=sys.stderr)
        return 1

    # 3b. Blacklist destination validation — never leave the Blacklist
    # module's "Destination for Blacklisted Calls" dangling on a deleted
    # custom destination (that trips FreePBX's destination validation and
    # the dashboard's bad-destination notice). Idempotent; skipped in
    # --check mode (verification only, no writes).
    if args.check:
        print("[freepbx] blacklist destination: not checked (--check mode)")
    else:
        print(f"[freepbx] blacklist destination: {fix_blacklist_destination(args.container)}")

    # 4. Verify in the live dialplan
    print("\n[freepbx] verification:")
    ctx = sh(
        "docker", "exec", args.container, "asterisk", "-rx",
        f"dialplan show {args.context}",
    )
    if f"{args.exten}" in ctx and "Stasis(dograh)" in ctx:
        print(f"  ✓ [dograh-inbound] exten {args.exten} → Stasis(dograh)")
    else:
        print(f"  ✗ [dograh-inbound] exten {args.exten} not found in dialplan")
    # Destination validation: the custom destination must resolve in the
    # live dialplan or FreePBX flags it as a bad destination.
    missing = validate_custom_destinations(
        args.container, [destination], args.context
    )
    if missing:
        print(
            f"  ✗ destination {destination} NOT in the live dialplan — "
            "run `fwconsole reload` and re-check (FreePBX will flag it as "
            "a bad destination until the context loads)",
            file=sys.stderr,
        )
    else:
        print(f"  ✓ destination {destination} resolves in the live dialplan")

    # FreePBX puts DID routes in ext-did-0001 (pricid) / ext-did-0002 (normal)
    # — `dialplan show from-trunk` only lists the include chain, so check the
    # context the route actually lands in.
    did_ctx = "ext-did-0002"
    trunk = sh(
        "docker", "exec", args.container, "asterisk", "-rx",
        f"dialplan show {did_ctx}",
    )
    if f"'{args.did}'" in trunk and destination in trunk:
        print(f"  ✓ {did_ctx} routes DID {args.did} → {destination}")
    else:
        print(
            f"  ✗ {did_ctx} has no route for {args.did} — check the inbound "
            f"route (from-trunk → from-pstn → ext-did → {did_ctx})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
