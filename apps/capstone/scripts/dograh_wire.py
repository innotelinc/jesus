#!/usr/bin/env python3
"""dograh_wire.py — wire the dograh half of the capstone telephony integration.

Idempotent; talks to the dograh REST API only (no SDK, no UI clicks). Safe to
re-run: every step GETs first and only writes when state differs.

What it does:

  1. auth        — login (signup on first run), mint a durable X-API-Key and
                   persist it to .env as DOGRAH_API_TOKEN
  2. agents      — import the three interview agent workflows (dograh/*.json)
                   if a workflow with the same name doesn't exist yet
  3. config      — create-or-update the Asterisk ARI telephony configuration,
                   which is what makes the PBX show up in the dograh UI under
                   "Telephony Configurations"
  4. extensions  — register extensions 8000/8001/8002 as phone numbers on that
                   config, each bound to its interview workflow for inbound
                   calls
  5. verify      — print the resulting wiring table

Environment variables (falls back to --env-file, then defaults):

  DOGRAH_API_ENDPOINT     dograh API base URL      (http://127.0.0.1:8000)
  DOGRAH_API_TOKEN        X-API-Key (persisted on first run)
  DOGRAH_ADMIN_EMAIL      dograh UI login email    (ops@capstone.example)
  DOGRAH_ADMIN_PASSWORD   dograh UI login password (required on first run)
  DOGRAH_ADMIN_NAME       display name             (Capstone Ops)
  DOGRAH_ARI_PASSWORD     ARI app password — MUST match pbx/asterisk/ari.conf
  DOGRAH_ARI_ENDPOINT     Asterisk ARI URL         (http://127.0.0.1:8088)
  DOGRAH_ARI_APP_NAME     Stasis app name          (dograh)
  DOGRAH_WS_CLIENT_NAME   media WS client name     (dograh)
  DOGRAH_CONFIG_NAME      telephony config name    (Asterisk ARI (dograh))

Usage (from the repo root):

  python3 scripts/dograh_wire.py                 # wire everything
  python3 scripts/dograh_wire.py --check         # verify only, exit 1 if incomplete
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_ENDPOINT = "http://127.0.0.1:8000"
HEALTH_TIMEOUT_S = 120

# extension → (workflow file, phone-number label in the dograh UI)
# The workflow NAME is read from the JSON itself (authoritative), so re-imports
# that change workflow ids never break routing (looked up by name).
TRACKS: list[tuple[str, str, str]] = [
    ("8000", "interview-workflow.json", "Mock Interview — IT Help Desk"),
    ("8001", "devops-workflow.json", "Mock Interview — DevOps"),
    ("8002", "sql-workflow.json", "Mock Interview — SQL"),
    # Additions: Project Capstone's phone-assistant agents.
    ("8003", "receptionist-workflow.json", "Business Receptionist — inbound"),
    ("8004", "outbound-outreach-workflow.json", "Outbound Outreach — telemarketer"),
    ("8005", "job-interview-workflow.json", "Job Interview — hiring"),
    ("8006", "survey-workflow.json", "Phone Survey"),
    ("8007", "gotv-polling-workflow.json", "Get Out The Vote Poll"),
]


class ApiError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


class Dograh:
    """Minimal dograh REST client (X-API-Key or Bearer auth)."""

    def __init__(self, endpoint: str) -> None:
        self.base = endpoint.rstrip("/")
        self.token: str | None = None  # X-API-Key
        self.jwt: str | None = None  # Authorization: Bearer (login only)

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Accept": "application/json"}
        if self.token:
            h["X-API-Key"] = self.token
        elif self.jwt:
            h["Authorization"] = f"Bearer {self.jwt}"
        return h

    def request(
        self, method: str, path: str, body: Any | None = None
    ) -> Any:
        url = f"{self.base}{path}"
        data = None
        headers = self._headers()
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, e.read().decode(errors="replace")) from e
        except urllib.error.URLError as e:
            raise ApiError(0, f"unreachable {url}: {e.reason}") from e

    # ── health / auth ────────────────────────────────────────────────────────
    def wait_healthy(self, timeout_s: int = HEALTH_TIMEOUT_S) -> None:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                self.request("GET", "/api/v1/health")
                return
            except ApiError:
                time.sleep(3)
        raise ApiError(0, f"dograh API not healthy after {timeout_s}s at {self.base}")

    def login_or_signup(self, email: str, password: str, name: str) -> None:
        """Login; signup on first run; raise a clear error on a wrong password."""
        try:
            res = self.request(
                "POST", "/api/v1/auth/login", {"email": email, "password": password}
            )
        except ApiError as e:
            if e.status != 401:
                raise
            # First run (or the account exists with another password).
            try:
                self.request(
                    "POST",
                    "/api/v1/auth/signup",
                    {"email": email, "password": password, "name": name},
                )
            except ApiError as e2:
                if e2.status != 409:  # 409 = already registered (password mismatch)
                    raise
                raise ApiError(
                    401,
                    f"login failed for {email} and the account already exists — "
                    "DOGRAH_ADMIN_PASSWORD no longer matches the dograh UI password",
                ) from e2
            res = self.request(
                "POST", "/api/v1/auth/login", {"email": email, "password": password}
            )
        self.jwt = (res or {}).get("token")
        if not self.jwt:
            raise ApiError(401, "login response had no token")

    def mint_api_key(self, name: str) -> str:
        res = self.request("POST", "/api/v1/user/api-keys", {"name": name})
        key = (res or {}).get("api_key", "")
        if not key:
            raise ApiError(500, f"api-key response had no key: {res!r}")
        return key

    # ── workflows ────────────────────────────────────────────────────────────
    def list_workflows(self) -> list[dict]:
        res = self.request("GET", "/api/v1/workflow/summary")
        return res if isinstance(res, list) else (res or {}).get("workflows", [])

    def import_workflow(self, name: str, definition: dict) -> int:
        res = self.request(
            "POST",
            "/api/v1/workflow/create/definition",
            {"name": name, "workflow_definition": definition},
        )
        wf_id = (res or {}).get("id")
        if wf_id is None:
            raise ApiError(500, f"workflow create response had no id: {res!r}")
        return int(wf_id)

    # ── telephony ────────────────────────────────────────────────────────────
    def list_configs(self) -> list[dict]:
        res = self.request("GET", "/api/v1/organizations/telephony-configs")
        return (res or {}).get("configurations", [])

    def config_body(self, cfg: dict) -> dict:
        return {
            "name": cfg["name"],
            "is_default_outbound": False,
            "config": {
                "provider": "ari",
                "ari_endpoint": cfg["ari_endpoint"],
                "app_name": cfg["app_name"],
                "app_password": cfg["app_password"],
                "ws_client_name": cfg["ws_client_name"],
                "from_numbers": [],
            },
        }

    def phone_numbers(self, config_id: Any) -> list[dict]:
        res = self.request(
            "GET", f"/api/v1/organizations/telephony-configs/{config_id}/phone-numbers"
        )
        return (res or {}).get("phone_numbers", [])


# ── .env helpers ─────────────────────────────────────────────────────────────
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


def save_env_key(path: Path, key: str, value: str) -> None:
    """Persist KEY=value to .env (replace existing active or commented line)."""
    lines: list[str] = []
    if path.exists():
        lines = path.read_text().splitlines()

    replaced = False
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not replaced and (
            stripped.startswith(f"{key}=") or stripped.startswith(f"# {key}=")
        ):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{key}={value}")
    path.write_text("\n".join(out) + "\n")


def cfg(args: argparse.Namespace, key: str, default: str = "") -> str:
    """Resolve a setting: real env first, then .env file, then default."""
    return os.environ.get(key) or args.env.get(key) or default


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default=None, help="dograh API base URL")
    parser.add_argument(
        "--env-file", default=str(repo / ".env"), help="capstone .env path"
    )
    parser.add_argument(
        "--workflows-dir", default=str(repo / "dograh"), help="interview agent JSONs"
    )
    parser.add_argument(
        "--check", action="store_true", help="verify only — no writes, exit 1 if incomplete"
    )
    parser.add_argument(
        "--health-timeout",
        type=int,
        default=HEALTH_TIMEOUT_S,
        help=f"seconds to wait for the dograh API to come up (default {HEALTH_TIMEOUT_S})",
    )
    args = parser.parse_args()
    args.env = load_env_file(Path(args.env_file))

    endpoint = args.endpoint or cfg(args, "DOGRAH_API_ENDPOINT", DEFAULT_ENDPOINT)
    api_token = cfg(args, "DOGRAH_API_TOKEN", "")
    admin_email = cfg(args, "DOGRAH_ADMIN_EMAIL", "ops@capstone.example")
    admin_password = cfg(args, "DOGRAH_ADMIN_PASSWORD", "")
    admin_name = cfg(args, "DOGRAH_ADMIN_NAME", "Capstone Ops")
    ari_password = cfg(args, "DOGRAH_ARI_PASSWORD", "")
    ari_endpoint = cfg(args, "DOGRAH_ARI_ENDPOINT", "http://127.0.0.1:8088")
    app_name = cfg(args, "DOGRAH_ARI_APP_NAME", "dograh")
    ws_client = cfg(args, "DOGRAH_WS_CLIENT_NAME", "dograh")
    config_name = cfg(args, "DOGRAH_CONFIG_NAME", "Asterisk ARI (dograh)")

    api = Dograh(endpoint)
    problems: list[str] = []

    print(f"── dograh API {endpoint}")
    try:
        api.wait_healthy(args.health_timeout)
    except ApiError as e:
        print(f"FAIL dograh API unreachable: {e}")
        return 1
    print("PASS dograh API healthy")

    # ── 1. auth ──────────────────────────────────────────────────────────────
    if api_token:
        api.token = api_token
        try:
            api.request("GET", "/api/v1/user/api-keys")
            print("PASS DOGRAH_API_TOKEN valid")
        except ApiError:
            print("WARN DOGRAH_API_TOKEN invalid — re-authenticating")
            api.token = None

    if not api.token:
        if not admin_password:
            print(
                "FAIL DOGRAH_ADMIN_PASSWORD required (no valid DOGRAH_API_TOKEN in "
                f"{args.env_file})"
            )
            return 1
        api.login_or_signup(admin_email, admin_password, admin_name)
        api.token = api.mint_api_key("capstone-setup")
        api.jwt = None
        if not args.check:
            save_env_key(Path(args.env_file), "DOGRAH_API_TOKEN", api.token)
            print(f"PASS API key minted → persisted DOGRAH_API_TOKEN in {args.env_file}")
        else:
            print("PASS authenticated (key not persisted in --check mode)")

    # ── 2. agents: import the interview workflows ────────────────────────────
    wf_dir = Path(args.workflows_dir)
    existing = {w.get("name"): w.get("id") for w in api.list_workflows()}
    track_ids: dict[str, int | None] = {}
    for ext, filename, _label in TRACKS:
        path = wf_dir / filename
        try:
            doc = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            problems.append(f"agent workflow file {path}: {e}")
            track_ids[ext] = None
            continue
        wf_name = doc.pop("name", None) or path.stem.replace("-", " ").title()
        definition = doc.get("workflow_definition", doc)
        if wf_name in existing:
            track_ids[ext] = existing[wf_name]
            print(f"PASS agent '{wf_name}' already imported (id {existing[wf_name]})")
        elif args.check:
            track_ids[ext] = None
            problems.append(f"agent workflow '{wf_name}' not imported")
        else:
            track_ids[ext] = api.import_workflow(wf_name, definition)
            existing[wf_name] = track_ids[ext]
            print(f"PASS agent '{wf_name}' imported (id {track_ids[ext]})")

    # ── 3. ARI telephony configuration (shows up in the dograh UI) ───────────
    config = next((c for c in api.list_configs() if c.get("name") == config_name), None)
    if config is not None and not ari_password and not args.check:
        # The PUT below would overwrite the stored app password with empty.
        print("FAIL DOGRAH_ARI_PASSWORD is empty — refusing to reconcile the ARI "
              "config (it would blank the app password that must match ari.conf)")
        return 1
    if config is None:
        if args.check or not ari_password:
            problems.append(f"telephony configuration '{config_name}' missing")
        else:
            config = api.request(
                "POST",
                "/api/v1/organizations/telephony-configs",
                api.config_body(
                    {
                        "name": config_name,
                        "ari_endpoint": ari_endpoint,
                        "app_name": app_name,
                        "app_password": ari_password,
                        "ws_client_name": ws_client,
                    }
                ),
            )
            print(f"PASS ARI telephony config created ({config.get('id')})")
    elif args.check:
        # app_password is masked in responses, so presence is all we can verify.
        print(f"PASS ARI telephony config present ({config['id']})")
    else:
        # The API masks app_password in responses, so PUT every run to
        # reconcile credentials (same approach as ansible/dograh-ari.yml).
        api.request(
            "PUT",
            f"/api/v1/organizations/telephony-configs/{config['id']}",
            api.config_body(
                {
                    "name": config_name,
                    "ari_endpoint": ari_endpoint,
                    "app_name": app_name,
                    "app_password": ari_password,
                    "ws_client_name": ws_client,
                }
            ),
        )
        print(f"PASS ARI telephony config reconciled ({config['id']})")

    if config is None:
        # Can't register extensions without a config — report and bail.
        print("FAIL no telephony configuration — extensions can't be registered")
        for p in problems:
            print(f"  PROBLEM: {p}")
        return 1
    config_id = config.get("id")

    # ── 3b. Stasis app name: dograh generates it (dograh_<hex>) and the PBX
    # dialplan must route calls into THAT name, not the ARI username. Fetch it
    # from the config detail and persist it so the entrypoint can inject it
    # into extensions_custom.conf on every boot (and place_call can originate
    # into it). Stable once created — a re-run preserves it.
    stasis_app_name = ""
    try:
        detail = api.request(
            "GET", f"/api/v1/organizations/telephony-configs/{config_id}"
        )
        stasis_app_name = ((detail or {}).get("credentials") or {}).get(
            "stasis_app_name", ""
        )
    except ApiError:
        stasis_app_name = ""
    if stasis_app_name:
        print(f"PASS Stasis app name: {stasis_app_name}")
        if not args.check:
            save_env_key(Path(args.env_file), "DOGRAH_STASIS_APP_NAME", stasis_app_name)
    elif args.check:
        problems.append("stasis_app_name not found on the telephony config")
    else:
        print("WARN stasis_app_name not exposed by the API — the PBX dialplan "
              "must route into app_name instead")

    # ── 4. extensions 8000/8001/8002 → agents (inbound phone numbers) ────────
    numbers = api.phone_numbers(config_id)
    by_address = {n.get("address"): n for n in numbers}
    for ext, _filename, label in TRACKS:
        wf_id = track_ids.get(ext)
        current = by_address.get(ext)
        if wf_id is None:
            problems.append(
                f"extension {ext}: no imported agent workflow — not registered"
            )
            continue
        if current is None:
            if args.check:
                problems.append(f"extension {ext} not registered as a phone number")
                continue
            api.request(
                "POST",
                f"/api/v1/organizations/telephony-configs/{config_id}/phone-numbers",
                {
                    "address": ext,
                    "label": label,
                    "inbound_workflow_id": wf_id,
                    "is_active": True,
                    "is_default_caller_id": False,
                    "extra_metadata": {},
                },
            )
            print(f"PASS extension {ext} → agent id {wf_id} ({label})")
        elif current.get("inbound_workflow_id") != wf_id:
            if args.check:
                problems.append(
                    f"extension {ext} bound to workflow "
                    f"{current.get('inbound_workflow_id')} instead of {wf_id}"
                )
                continue
            api.request(
                "PUT",
                f"/api/v1/organizations/telephony-configs/{config_id}/phone-numbers/{current['id']}",
                {
                    "label": label,
                    "inbound_workflow_id": wf_id,
                    "is_active": True,
                },
            )
            print(f"PASS extension {ext} re-pointed → agent id {wf_id} ({label})")
        else:
            print(f"PASS extension {ext} → agent id {wf_id} ({label})")

    # ── 5. report ────────────────────────────────────────────────────────────
    print()
    print("  Telephony wiring (dograh side):")
    print(f"    config '{config_name}' → ARI {ari_endpoint} app='{app_name}' "
          f"stasis='{stasis_app_name or app_name}' ws='{ws_client}'")
    for ext, filename, label in TRACKS:
        state = "✓" if track_ids.get(ext) is not None else "✗"
        print(f"    {state} ext {ext} → {label} ({filename})")
    if problems:
        print()
        for p in problems:
            print(f"  PROBLEM: {p}")
        return 1
    print()
    print("  dograh connects to Asterisk ARI on its own (ARI manager polls configs).")
    print('  Verify on the PBX: docker exec pbx-freepbx asterisk -rx "ari show apps"')
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ApiError as e:
        print(f"FAIL dograh API error: {e}", file=sys.stderr)
        raise SystemExit(1)
