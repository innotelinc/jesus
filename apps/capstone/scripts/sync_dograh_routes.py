#!/usr/bin/env python3
"""sync_dograh_routes.py — mirror dograh's phone numbers into FreePBX.

Reads the phone numbers registered on dograh's ARI telephony config (each one
is a workflow↔extension binding created by `scripts/dograh_wire.py` or the
Workflow Studio) and keeps the FreePBX side of each in sync:

  • a Custom Extension  →  registered in customappsreg's `custom_extensions`
                           table, so Applications → Extensions shows each
                           dograh agent as a basic Custom Extension (no
                           voicemail, no call waiting — by design)
  • a Custom Destination  →  dograh-inbound,<exten>,1
  • an Inbound Route      →  DID <exten> → that custom destination (the row
                           is inserted directly; see FreepbxApi.add_route in
                           pbx/bootstrap_dograh_route.py for why not the API)
  • a dialplan include    →  extensions_custom_dograh.conf, so numbers the
                             static pbx/asterisk/extensions_custom.conf does
                             not cover (8008+) are reachable too

...so the FreePBX GUI (Connectivity → Inbound Routes, Applications →
Extensions) can see and adjust them. Idempotent: existing entries are left
alone unless they changed.

Pruning: when a number is removed in dograh, the matching FreePBX entries are
deleted — but ONLY the ones this script created (identified by the
"Dograh Voice Agent" description / "dograh-managed" notes markers). Anything
a user created in the FreePBX GUI is never touched. Pass --no-prune to keep
orphaned entries for manual review.

Usage (from the repo root, with the capstone .env loaded):
    python3 scripts/sync_dograh_routes.py            # create missing + prune removed
    python3 scripts/sync_dograh_routes.py --check    # verify only
    python3 scripts/sync_dograh_routes.py --no-prune # create/update, skip deletion

Environment / args:
    --dograh-endpoint  dograh API base (env DOGRAH_API_ENDPOINT, default http://127.0.0.1:8000)
    --dograh-token     X-API-Key (env DOGRAH_API_TOKEN, required)
    --url              FreePBX base URL (env FREEPBX_URL; default probes 127.0.0.1:80
                       then the compose-published :8083)
    --container        freepbx container (env FREEPBX_CONTAINER, default pbx-freepbx)
    --client-id        OAuth client id (env FREEPBX_CLIENT_ID, default pbxportal-api)
    --client-secret    OAuth client secret (env FREEPBX_CLIENT_SECRET, required)
    --config-name      dograh telephony config name (env DOGRAH_CONFIG_NAME, default 'Asterisk ARI (dograh)')
    --force            update existing entries (default: skip)
    --no-prune         never delete dograh-created entries for removed numbers
    --check            verify only, no writes

    Magnate entitlement gate (RevenueOps — see docs/zeus-integration.md step 8):
    agents are a Magnate add-on SKU, so when MAGNATE_PUBLIC_URL and
    MAGNATE_AGENT_PLAN are configured the sync asks Magnate whether the SKU is
    entitled before writing inbound routes (MAGNATE_AGENT_USER optionally
    narrows the check to a subscriber's active plan). Not entitled → no new
    routes are written and dograh-created ones are un-wired; unreachable →
    fail open (an entitlements outage never blocks routing); 401 → abort.
    Overrides: --magnate-url/--magnate-token/--magnate-plan/--magnate-user
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "pbx"))

from bootstrap_dograh_route import (  # noqa: E402
    FreepbxApi,
    FreepbxError,
    dialplan_has,
    ensure_custom_dest,
    find_dest_id,
    fix_blacklist_destination,
    kvstore_table,
    mysql,
    resolve_container,
    sh,
    validate_custom_destinations,
)

# Extensions the static pbx/asterisk/extensions_custom.conf already defines —
# the sync script only generates dialplan entries for numbers OUTSIDE this set
# (UI/Workflow-Studio-created numbers like 8008+), so Asterisk never sees a
# duplicate exten definition.
STATIC_EXTENSIONS = {f"80{i:02d}" for i in range(0, 8)}  # 8000..8007

# Markers that identify dograh-created FreePBX entries (see module docstring).
DESC_MARKER = "Dograh Voice Agent"
NOTES_MARKER = "dograh-managed"


def _sql(s: str) -> str:
    """Escape a value for use inside a single-quoted SQL literal."""
    return s.replace("\\", "\\\\").replace("'", "\\'")


def _ascii(s: str, maxlen: int) -> str:
    """ASCII-only, length-capped value for FreePBX DB columns.

    The `mysql` CLI connects with a latin1 connection charset, so any
    non-ASCII byte (e.g. the em-dash in "Mock Interview — IT Help Desk")
    is counted as multiple characters and can overflow varchar(40)/varchar(255)
    columns. Transcode to ASCII (single-byte) then cap by length. Instead of
    letting .encode(ascii, "replace") turn punctuation into literal '?',
    transliterate the common typographic characters to clean ASCII first.
    """
    s = (
        s.replace("\u2014", "-")          # em dash —
        .replace("\u2013", "-")           # en dash –
        .replace("\u2018", "'").replace("\u2019", "'")   # curly single quotes
        .replace("\u201c", '"').replace("\u201d", '"')   # curly double quotes
        .replace("\u2026", "...")        # ellipsis …
        .replace("\u00a0", " ")          # non-breaking space
    )
    ascii_only = s.encode("ascii", "replace").decode("ascii")
    return ascii_only[:maxlen]


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def dograh_phone_numbers(endpoint: str, token: str, config_name: str) -> list[dict]:
    """List phone numbers on the ARI telephony config (dograh API)."""
    h = {"X-API-Key": token, "Accept": "application/json"}
    req = urllib.request.Request(f"{endpoint}/api/v1/organizations/telephony-configs", headers=h)
    with urllib.request.urlopen(req, timeout=30) as resp:
        configs = (json.loads(resp.read() or b"{}") or {}).get("configurations", [])
    cfg = next((c for c in configs if c.get("name") == config_name), None)
    if not cfg:
        raise FreepbxError(f"no telephony config named '{config_name}' found in dograh")
    req = urllib.request.Request(
        f"{endpoint}/api/v1/organizations/telephony-configs/{cfg['id']}/phone-numbers",
        headers=h,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return (json.loads(resp.read() or b"{}") or {}).get("phone_numbers", [])


# ── FreePBX custom extensions (customappsreg) ───────────────────────────────
def ensure_custom_ext_table(container: str) -> None:
    """Create customappsreg's custom_extensions table if the module hasn't yet."""
    mysql(
        container,
        "CREATE TABLE IF NOT EXISTS `custom_extensions` ("
        "`custom_exten` varchar(80) NOT NULL default '',"
        "`description` varchar(40) NOT NULL default '',"
        "`notes` varchar(255) NOT NULL default '',"
        "PRIMARY KEY (`custom_exten`))",
    )


def upsert_custom_extension(container: str, ext: str, label: str, workflow_name: str = "") -> None:
    """Register/refresh a dograh agent as a FreePBX Custom Extension.

    Custom Extensions are registry-only (no device): they carry no voicemail
    or call-waiting settings, which is exactly the "basic" behaviour wanted
    for dograh agents. Description is capped at 40 chars by the schema.
    """
    # Description = the agent's workflow name (human-readable purpose), e.g.
    # "Dograh Voice Agent (Business Receptionist)". The label often carries a
    # trailing role such as " - inbound" that is noisier here.
    purpose = workflow_name or label
    desc = _sql(_ascii(f"Dograh Voice Agent ({purpose})", 40))
    notes = _sql(_ascii(f"{NOTES_MARKER}; created by dograh sync - delete in dograh to remove. label={label}", 255))
    sql = (
        f"INSERT INTO `custom_extensions` (`custom_exten`,`description`,`notes`) "
        f"VALUES ('{_sql(ext)}', '{desc}', '{notes}') "
        f"ON DUPLICATE KEY UPDATE `description`=VALUES(`description`), `notes`=VALUES(`notes`)"
    )
    mysql(container, sql)


def dograh_created_extensions(container: str) -> list[dict]:
    rows = mysql(
        container,
        "SELECT `custom_exten`,`description`,`notes` FROM `custom_extensions` "
        f"WHERE `description` LIKE '%{DESC_MARKER}%' OR `notes` LIKE '%{NOTES_MARKER}%'",
    )
    out: list[dict] = []
    for line in rows.splitlines():
        parts = line.split("\t")
        if len(parts) >= 1:
            out.append({"ext": parts[0], "description": parts[1] if len(parts) > 1 else "",
                        "notes": parts[2] if len(parts) > 2 else ""})
    return out


def delete_custom_extension(container: str, ext: str) -> None:
    mysql(container, f"DELETE FROM `custom_extensions` WHERE `custom_exten`='{_sql(ext)}'")


# ── FreePBX inbound routes (the API module writes the `incoming` table) ─────
def refresh_inbound_route_description(container: str, did: str, description: str) -> None:
    """Update the description of a dograh-created inbound route.

    The FreePBX API's addInboundRoute can't update an existing route, so we
    update the `incoming` row directly, guarded by the dograh description
    marker (never touch a user-created route). `description` is expected to be
    SQL-escaped (the loop builds it with _sql()).
    """
    mysql(
        container,
        f"UPDATE `incoming` SET `description`='{description}' "
        f"WHERE `extension`='{_sql(did)}' AND `description` LIKE '%{DESC_MARKER}%'",
    )


def delete_inbound_route(container: str, did: str) -> None:
    """Delete a dograh-created inbound route directly (guarded by description)."""
    mysql(
        container,
        f"DELETE FROM `incoming` WHERE `extension`='{_sql(did)}' "
        f"AND `description` LIKE '%{DESC_MARKER}%'",
    )


def delete_custom_dest(container: str, table: str, target: str) -> None:
    dest_id = find_dest_id(container, table, target)
    if dest_id:
        mysql(container, f"DELETE FROM `{table}` WHERE `id`='dests' AND `key`='{dest_id}'")
        print(f"[freepbx] custom destination dest-{dest_id} → {target} deleted")


# ── dynamic dialplan include (extensions_custom_dograh.conf) ────────────────
def sync_dynamic_dialplan(container: str, numbers: list[dict], stasis_app: str) -> None:
    """Write [dograh-inbound] + [from-internal-custom] entries for dograh
    numbers the static extensions_custom.conf does not already define, and
    wire the #include into extensions_custom.conf (idempotent)."""
    dynamic = sorted(
        str(n.get("address", "")).strip()
        for n in numbers
        if str(n.get("address", "")).strip() not in STATIC_EXTENSIONS
    )
    dest = "/etc/asterisk/extensions_custom_dograh.conf"
    if not dynamic:
        # Nothing dynamic to keep — remove the file + include line.
        sh("docker", "exec", container, "sh", "-c", f"rm -f {dest}")
        _drop_include(container, "extensions_custom_dograh.conf")
        return
    app = stasis_app or "dograh"
    lines = [
        "; Auto-generated by scripts/sync_dograh_routes.py — dograh numbers",
        "; beyond the static 8000-8007 set. Regenerate via the sync script;",
        "; do not edit by hand.",
        "[dograh-inbound]",
    ]
    for ext in dynamic:
        lines += [
            f"exten => {ext},1,NoOp(Dograh voice agent inbound)",
            f" same => n,Stasis({app})",
            " same => n,Hangup()",
        ]
    lines += ["", "[from-internal-custom]"]
    for ext in dynamic:
        lines += [
            f"exten => {ext},1,NoOp(Dialing the dograh agent)",
            f" same => n,Goto(dograh-inbound,{ext},1)",
        ]
    body = "\n".join(lines) + "\n"
    # Write via the container (host has no /etc/asterisk mount).
    tmp = f"/tmp/extensions_custom_dograh.{os.getpid()}.conf"
    Path(tmp).write_text(body)
    try:
        sh("docker", "cp", tmp, f"{container}:{dest}")
        sh("docker", "exec", container, "chown", "asterisk:asterisk", dest)
    finally:
        Path(tmp).unlink(missing_ok=True)
    _ensure_include(container, "extensions_custom_dograh.conf")
    print(f"[freepbx] dynamic dialplan: {len(dynamic)} number(s) wired "
          f"(extensions_custom_dograh.conf, Stasis({app}))")


def _ensure_include(container: str, fname: str) -> None:
    inc = "/etc/asterisk/extensions_custom.conf"
    sh("docker", "exec", container, "sh", "-c",
       f"grep -q '#include {fname}' {inc} 2>/dev/null || "
       f"printf '\\n#include {fname}\\n' >> {inc}")


def _drop_include(container: str, fname: str) -> None:
    inc = "/etc/asterisk/extensions_custom.conf"
    sh("docker", "exec", container, "sh", "-c",
       f"sed -i '/#include {fname}/d' {inc}")


# ── Magnate entitlement gate (RevenueOps) ────────────────────────────────────
MAGNATE_TIMEOUT_SECONDS = 10


def magnate_entitlement(url: str, token: str, plan: str, user: str) -> dict[str, Any]:
    """Ask Magnate's v2.1 entitlement API whether the agent add-on SKU may route.

    Returns a dict whose ``mode`` the route writer acts on:

      entitled      — 200 with entitled=true: routes may be (re)created.
      not_entitled  — authoritative no (200 entitled=false or 404): the sync
                      must not create inbound routes and should un-wire the
                      dograh-created ones.
      unauthorized  — 401: token mismatch. The caller aborts rather than
                      silently un-wiring routes on a config error.
      unreachable   — network/HTTP failure: fail open per Capstone policy (an
                      entitlements outage never blocks agent routing).
    """
    params = {"plan": plan}
    if user:
        params["user"] = user
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"{url}/api/entitlements?{qs}", headers={"Accept": "application/json"}
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=MAGNATE_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read() or b"{}")
        if data.get("entitled") is True:
            return {"mode": "entitled", "reason": data.get("reason") or "ok",
                    "plan": data.get("plan"), "slug": data.get("slug"),
                    "status": data.get("status"), "expires_at": data.get("expires_at"),
                    "http": resp.status}
        return {"mode": "not_entitled", "reason": data.get("reason") or "denied",
                "plan": data.get("plan"), "slug": data.get("slug"),
                "status": data.get("status"), "expires_at": data.get("expires_at"),
                "http": resp.status}
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read() or b"{}")
        except Exception:  # noqa: BLE001 — body may not be JSON
            data = {}
        if e.code == 401:
            return {"mode": "unauthorized", "reason": data.get("reason", "unauthorized"),
                    "http": e.code}
        if e.code == 404:
            return {"mode": "not_entitled", "reason": data.get("reason", "plan_not_found"),
                    "http": e.code}
        return {"mode": "unreachable", "reason": f"HTTP {e.code}", "http": e.code}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"mode": "unreachable", "reason": f"{e.__class__.__name__}: {e}", "http": None}


# ── main ────────────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(REPO / ".env"))
    parser.add_argument("--dograh-endpoint",
                        default=os.environ.get("DOGRAH_API_ENDPOINT", "http://127.0.0.1:8000"))
    parser.add_argument("--dograh-token", default=os.environ.get("DOGRAH_API_TOKEN", ""))
    parser.add_argument("--url", default=os.environ.get("FREEPBX_URL", "http://127.0.0.1"))
    parser.add_argument("--container", default=os.environ.get("FREEPBX_CONTAINER", "pbx-freepbx"))
    parser.add_argument("--client-id", default=os.environ.get("FREEPBX_CLIENT_ID", "pbxportal-api"))
    parser.add_argument("--client-secret", default=os.environ.get("FREEPBX_CLIENT_SECRET", ""))
    parser.add_argument("--config-name",
                        default=os.environ.get("DOGRAH_CONFIG_NAME", "Asterisk ARI (dograh)"))
    parser.add_argument("--magnate-url", default=os.environ.get("MAGNATE_PUBLIC_URL", ""),
                        help="Magnate storefront base URL (env MAGNATE_PUBLIC_URL); "
                             "empty = standalone, no entitlement gate")
    parser.add_argument("--magnate-token", default=os.environ.get("ENTITLEMENTS_API_TOKEN", ""),
                        help="bearer token for Magnate's entitlements API (env ENTITLEMENTS_API_TOKEN)")
    parser.add_argument("--magnate-plan", default=os.environ.get("MAGNATE_AGENT_PLAN", ""),
                        help="agent add-on SKU slug/id on Magnate (env MAGNATE_AGENT_PLAN)")
    parser.add_argument("--magnate-user", default=os.environ.get("MAGNATE_AGENT_USER", ""),
                        help="optional subscriber (username/email) whose active plan "
                             "carries the SKU (env MAGNATE_AGENT_USER)")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-prune", action="store_true",
                        help="don't delete dograh-created entries for numbers removed in dograh")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    args.env = load_env_file(Path(args.env_file))
    token = args.dograh_token or args.env.get("DOGRAH_API_TOKEN", "")
    secret = args.client_secret or args.env.get("FREEPBX_CLIENT_SECRET", "")
    endpoint = args.dograh_endpoint or args.env.get("DOGRAH_API_ENDPOINT", "http://127.0.0.1:8000")
    stasis_app = args.env.get("DOGRAH_STASIS_APP_NAME", "")
    magnate_url = (args.magnate_url or args.env.get("MAGNATE_PUBLIC_URL", "")).strip().rstrip("/")
    magnate_token = args.magnate_token or args.env.get("ENTITLEMENTS_API_TOKEN", "")
    magnate_plan = (args.magnate_plan or args.env.get("MAGNATE_AGENT_PLAN", "")).strip()
    magnate_user = (args.magnate_user or args.env.get("MAGNATE_AGENT_USER", "")).strip()

    if not token:
        print("FAIL DOGRAH_API_TOKEN required (run scripts/dograh_wire.py once)", file=sys.stderr)
        return 1
    if not secret:
        print("FAIL FREEPBX_CLIENT_SECRET required", file=sys.stderr)
        return 1

    container = resolve_container(args.container)
    problems: list[str] = []

    try:
        numbers = dograh_phone_numbers(endpoint, token, args.config_name)
    except (urllib.error.URLError, urllib.error.HTTPError, FreepbxError, KeyError) as e:
        print(f"FAIL could not read dograh phone numbers: {e}", file=sys.stderr)
        return 1

    current = {str(n.get("address", "")).strip() for n in numbers if str(n.get("address", "")).strip()}
    changed = False

    # ── Magnate entitlement gate (RevenueOps) ────────────────────────────────
    # Agents are a Magnate add-on SKU; when MAGNATE_PUBLIC_URL + MAGNATE_AGENT_PLAN
    # are configured the sync must not (re)create inbound routes unless Magnate
    # says the SKU is entitled. Unreachable → fail open (an entitlements outage
    # never blocks routing); 401 → abort (a config error — never silently
    # un-wire routes on a bad token). Unset plan with Magnate configured → the
    # gate stays inactive so existing deployments keep working unchanged.
    gate: dict[str, Any] = {"mode": "standalone", "reason": "standalone_no_billing"}
    if magnate_url:
        if not magnate_plan:
            gate = {"mode": "disabled", "reason": "MAGNATE_AGENT_PLAN not set — gate inactive"}
            print(f"[magnate] {gate['reason']} (MAGNATE_PUBLIC_URL={magnate_url})")
        else:
            gate = magnate_entitlement(magnate_url, magnate_token, magnate_plan, magnate_user)
            if gate["mode"] == "unauthorized":
                print(f"FAIL Magnate entitlements returned 401 ({gate['reason']}) — "
                      "check ENTITLEMENTS_API_TOKEN; refusing to write routes", file=sys.stderr)
                return 1
            if gate["mode"] == "not_entitled":
                print(f"[magnate] NOT entitled ({gate['reason']}, plan={magnate_plan}) — "
                      "un-wiring dograh inbound routes")
            else:
                print(f"[magnate] gate {gate['mode']} ({gate['reason']}, "
                      f"plan={gate.get('plan') or magnate_plan})")
    closed = gate["mode"] == "not_entitled"
    eff_numbers = [] if closed else numbers
    if closed:
        if args.check:
            for n in numbers:
                ext = str(n.get("address", "")).strip()
                if ext:
                    problems.append(f"DID {ext} not entitled ({gate['reason']}) — would be un-wired")
        elif args.no_prune:
            print("[magnate] --no-prune set — existing routes kept for manual review "
                  "(gate is closed; no new routes will be written)")

    table = None
    if not args.check:
        table = kvstore_table(container)
        ensure_custom_ext_table(container)

    # FreePBX API base URL: --url > FREEPBX_URL (environment, then the .env
    # file) > a quick port probe (80, then the compose-published 8083). The
    # fallbacks keep the bare invocation (systemd timer, setup.sh) working on
    # hosts where FreePBX is not published on port 80 — and fail fast with a
    # hint instead of stalling in wait_ready() for 5 minutes.
    freepbx_url = args.url
    env_url = (os.environ.get("FREEPBX_URL") or args.env.get("FREEPBX_URL", "")).strip()
    if env_url:
        freepbx_url = env_url
    elif freepbx_url == parser.get_default("url"):
        open_port = None
        for port in (80, 8083):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    open_port = port
                    break
            except OSError:
                continue
        if open_port is None:
            print("FAIL FreePBX API not reachable on 127.0.0.1:80 or :8083 — "
                  "set FREEPBX_URL in .env or pass --url", file=sys.stderr)
            return 1
        freepbx_url = f"http://127.0.0.1:{open_port}"

    api = FreepbxApi(freepbx_url, args.client_id, secret)
    try:
        api.wait_ready(timeout=300)
    except FreepbxError as e:
        print(f"FAIL FreePBX API not ready: {e}", file=sys.stderr)
        return 1

    print(f"[sync] {len(numbers)} dograh phone number(s) → FreePBX "
          f"(custom extensions + inbound routes)")

    # ── dialplan first ───────────────────────────────────────────────────────
    # Write the dynamic dialplan include BEFORE creating custom destinations
    # so every destination's target context exists by the time FreePBX's
    # destination validation (Blacklist settings / bad-destination checks)
    # runs — a destination whose context is missing is flagged as "bad".
    if not args.check:
        sync_dynamic_dialplan(container, eff_numbers, stasis_app)

    # ── create/update ────────────────────────────────────────────────────────
    for num in eff_numbers:
        ext = str(num.get("address", "")).strip()
        label = num.get("label") or f"dograh ext {ext}"
        workflow_name = num.get("inbound_workflow_name") or label
        if not ext:
            continue
        target = f"dograh-inbound,{ext},1"
        desc = _sql(_ascii(f"Dograh Voice Agent ({workflow_name})", 40))
        try:
            # 1. Custom extension (Applications → Extensions, basic by design).
            if args.check:
                rows = mysql(
                    container,
                    f"SELECT COUNT(*) FROM `custom_extensions` WHERE `custom_exten`='{_sql(ext)}'",
                )
                if rows.splitlines() and int(rows.splitlines()[0]) > 0:
                    print(f"PASS custom extension {ext} present")
                else:
                    problems.append(f"custom extension {ext} missing")
            else:
                upsert_custom_extension(container, ext, label, workflow_name)
                print(f"PASS custom extension {ext} → {desc}")
            # 2. Custom destination (the API module can't create those).
            if not args.check:
                ensure_custom_dest(container, table, target, desc)
            # 3. Inbound route row (direct SQL via FreepbxApi.add_route —
            #    the API module's addInboundRoute mutation can't bootstrap a
            #    fresh destination; see its docstring in bootstrap_dograh_route.py).
            existing = api.find_route(ext)
            if existing and not args.force:
                if not args.check:
                    # addInboundRoute can't update an existing route, so refresh
                    # its description directly so the GUI title tracks the agent.
                    refresh_inbound_route_description(container, ext, desc)
                print(f"PASS inbound route DID {ext} already exists ({existing.get('description')})")
                continue
            if args.check:
                if existing:
                    print(f"PASS inbound route DID {ext} present")
                else:
                    problems.append(f"inbound route DID {ext} missing")
                continue
            api.add_route(ext, desc, target)
            changed = True
            print(f"PASS inbound route DID {ext} → {target}")
        except (FreepbxError, OSError) as e:
            problems.append(f"DID {ext}: {e}")

    # ── prune removed numbers (dograh-created entries only) ──────────────────
    if not args.no_prune:
        try:
            owned = dograh_created_extensions(container)
        except FreepbxError as e:
            problems.append(f"could not list custom extensions: {e}")
            owned = []
        for row in owned:
            ext = row["ext"]
            if ext in current:
                continue
            target = f"dograh-inbound,{ext},1"
            try:
                if args.check:
                    problems.append(f"stale dograh custom extension {ext} would be deleted")
                    continue
                delete_custom_extension(container, ext)
                delete_inbound_route(container, ext)
                if table:
                    delete_custom_dest(container, table, target)
                changed = True
                print(f"PASS removed from dograh — deleted FreePBX entries for {ext}")
            except (FreepbxError, OSError) as e:
                problems.append(f"prune {ext}: {e}")
        # Entitlement gate closed → also un-wire numbers still present in
        # dograh (they were routed before the SKU lapsed). Only dograh-created
        # entries are ever deleted; user GUI routes are never touched.
        if closed and not args.check:
            for row in owned:
                ext = row["ext"]
                if ext not in current:
                    continue
                target = f"dograh-inbound,{ext},1"
                try:
                    delete_custom_extension(container, ext)
                    delete_inbound_route(container, ext)
                    if table:
                        delete_custom_dest(container, table, target)
                    changed = True
                    print(f"PASS gate closed — deleted FreePBX entries for {ext}")
                except (FreepbxError, OSError) as e:
                    problems.append(f"un-wire {ext}: {e}")

    if changed and not args.check:
        print("[freepbx] running fwconsole reload (dialplan + registry)...")
        sh("docker", "exec", container, "fwconsole", "chown")
        sh("docker", "exec", container, "fwconsole", "reload")

    # ── destination validation + blacklist repair ────────────────────────────
    # After the reload, every custom destination's target must resolve in the
    # live dialplan, or FreePBX's destination validation flags it as a bad
    # destination (Blacklist settings page, dashboard notice, Apply Config).
    # Report missing ones as problems; repair the Blacklist module's own
    # destination so it never dangles on a deleted custom destination.
    targets = [
        f"dograh-inbound,{str(n.get('address', '')).strip()},1"
        for n in eff_numbers
        if str(n.get("address", "")).strip()
    ]
    if not args.check:
        result = fix_blacklist_destination(container)
        print(f"[freepbx] blacklist destination: {result}")
        missing = validate_custom_destinations(container, targets, "dograh-inbound")
        for t in missing:
            problems.append(f"destination {t} not in the live dialplan "
                            "(run `fwconsole reload` and re-sync)")
        if missing:
            print(f"[freepbx] WARN {len(missing)} destination(s) flagged by "
                  "FreePBX destination validation (bad destinations)")
    else:
        # --check: verify destinations resolve too (no writes).
        for t in targets:
            if not dialplan_has(container, "dograh-inbound", t.split(",")[1]):
                problems.append(f"destination {t} not in the live dialplan")

    if problems:
        print()
        for p in problems:
            print(f"  PROBLEM: {p}")
        return 1
    print("\n[sync] done — open FreePBX → Connectivity → Inbound Routes / "
          "Applications → Extensions to review/map DIDs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
