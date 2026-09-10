"""Capstone Agents — dograh AI voice agents wired into FreePBX.

An *agent* is a dograh telephony phone number (extension ↔ workflow) that is
also provisioned on FreePBX as a custom extension + inbound route, so calls to
its number are answered by the dograh AI pipeline instead of a human.

Deployment modes (``CAPSTONE_DEPLOY_MODE``):

  standalone (default)
      Capstone's bundled FreePBX container runs on this host. The dashboard
      provisions custom extensions / inbound routes directly (docker exec
      into the PBX container — see the route handlers in ``main.py`` that
      execute the SQL this module builds).

  addon
      Capstone runs as a Zeus add-on on a shared FreePBX/Asterisk. The
      dashboard only manages the dograh side (the source of truth); the
      shared box's reconcile/sync applies the ``*_custom.conf`` moniker —
      ``extensions_custom_dograh.conf`` converged with ``--owner capstone``
      (see ``pbx/asterisk_converge.py``) — so local provisioning is never
      attempted and agents report a "pending-sync" PBX status.

Mirrors ``scripts/sync_dograh_routes.py`` and ``pbx/bootstrap_dograh_route.py``
so the dashboard and the sync tool stay byte-consistent on the FreePBX side.
Kept dependency-free (urllib only) so it unit-tests without the stack.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Agent extensions the static pbx/asterisk/extensions_custom.conf defines.
# Numbers outside this set need a dynamic [dograh-inbound] include, written to
# extensions_custom_dograh.conf — the *_custom.conf moniker both modes share.
STATIC_EXTENSIONS = {f"80{i:02d}" for i in range(0, 8)}  # 8000..8007

DEFAULT_ENDPOINT = "http://127.0.0.1:8000"
DEFAULT_CONFIG_NAME = "Asterisk ARI (dograh)"

# FreePBX markers so dograh-managed rows are never confused with user rows
# (mirrors scripts/sync_dograh_routes.py).
DESC_MARKER = "Dograh Voice Agent"
NOTES_MARKER = "dograh-managed"

DIALPLAN_CONF = "extensions_custom_dograh.conf"
DIALPLAN_PATH = f"/etc/asterisk/{DIALPLAN_CONF}"


def deploy_mode() -> str:
    """'standalone' (bundled FreePBX) or 'addon' (Zeus shared PBX)."""
    raw = (os.environ.get("CAPSTONE_DEPLOY_MODE") or "").strip().lower()
    if raw in {"addon", "add-on", "zeus", "shared"}:
        return "addon"
    return "standalone"


def extension_from_address(address: str) -> str:
    """Digits of a phone-number address ('8003' -> '8003', '+12125551234' -> '12125551234')."""
    return re.sub(r"\D", "", address or "")


def _ascii(value: str, maxlen: int) -> str:
    ascii_only = value.encode("ascii", "replace").decode("ascii")
    return ascii_only[:maxlen]


def _sql(value: str) -> str:
    """SQL-escape a literal (single-quote doubling)."""
    return value.replace("'", "''")


def agent_description(label: str, workflow_name: str = "") -> str:
    """FreePBX description for a dograh agent row (schema caps at 40 chars)."""
    purpose = workflow_name or label or "agent"
    return _ascii(f"{DESC_MARKER} ({purpose})", 40)


# ── dograh API client ─────────────────────────────────────────────────────


class DograhError(RuntimeError):
    pass


class DograhClient:
    """Thin client for the dograh REST API (X-API-Key auth).

    Endpoints mirror ``scripts/dograh_wire.py`` and the dograh upstream API
    (``api/routes/organization.py`` — /telephony-configs/{id}/phone-numbers).
    """

    def __init__(
        self,
        endpoint: str | None = None,
        token: str | None = None,
        config_name: str | None = None,
    ) -> None:
        self.endpoint = (endpoint or os.environ.get("DOGRAH_API_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/")
        self.token = token if token is not None else os.environ.get("DOGRAH_API_TOKEN", "")
        self.config_name = config_name or os.environ.get("DOGRAH_CONFIG_NAME") or DEFAULT_CONFIG_NAME
        self._config_id: int | None = None

    def configured(self) -> bool:
        return bool(self.token)

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        headers = {"Accept": "application/json", "X-API-Key": self.token}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{self.endpoint}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - configured endpoint
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:300]
            raise DograhError(f"dograh {method} {path} failed (HTTP {err.code}): {detail}") from err
        except urllib.error.URLError as err:
            raise DograhError(f"dograh unreachable at {self.endpoint}: {err.reason}") from err

    def config_id(self) -> int:
        if self._config_id is not None:
            return self._config_id
        data = self._request("GET", "/api/v1/organizations/telephony-configs")
        configs = (data or {}).get("configurations", []) or []
        cfg = next((c for c in configs if c.get("name") == self.config_name), None)
        if cfg is None:
            raise DograhError(f"no telephony config named '{self.config_name}' in dograh")
        self._config_id = int(cfg["id"])
        return self._config_id

    def _phone_path(self) -> str:
        return f"/api/v1/organizations/telephony-configs/{self.config_id()}/phone-numbers"

    def list_agents(self) -> list[dict[str, Any]]:
        data = self._request("GET", self._phone_path())
        return [normalize_agent(p) for p in (data or {}).get("phone_numbers", []) or []]

    def list_workflows(self) -> list[dict[str, Any]]:
        # GET /api/v1/workflow/fetch returns a bare WorkflowListResponse array
        # (id/name/status/created_at/total_runs) — no envelope.
        data = self._request("GET", "/api/v1/workflow/fetch")
        rows = data if isinstance(data, list) else ((data or {}).get("workflows") or (data or {}).get("results") or [])
        out: list[dict[str, Any]] = []
        for w in rows if isinstance(rows, list) else []:
            wid = w.get("id") if isinstance(w, dict) else None
            if wid is None:
                continue
            name = str(w.get("name") or w.get("title") or wid)
            out.append({"id": int(wid), "name": name})
        return out

    def create_agent(
        self,
        *,
        address: str,
        label: str,
        workflow_id: int | None = None,
        country_code: str | None = None,
        is_active: bool = True,
    ) -> dict[str, Any]:
        """Create a phone number. ``country_code`` is only for PSTN numbers
        (extension-style addresses like 8008 omit it — mirroring
        scripts/generate_ui.py's import path)."""
        body: dict[str, Any] = {
            "address": address,
            "label": label,
            "is_active": is_active,
        }
        if country_code:
            body["country_code"] = country_code
        if workflow_id is not None:
            body["inbound_workflow_id"] = int(workflow_id)
        return normalize_agent(self._request("POST", self._phone_path(), body))

    def update_agent(
        self,
        phone_id: int,
        *,
        label: str | None = None,
        workflow_id: int | None = None,
        clear_workflow: bool = False,
        is_active: bool | None = None,
    ) -> dict[str, Any]:
        """PUT a phone-number update. ``address`` is immutable in dograh — to
        renumber an agent, delete it and create a new one. ``workflow_id=None``
        with ``clear_workflow=True`` unbinds the inbound workflow
        (``inbound_workflow_id: null`` alone means "no change")."""
        body: dict[str, Any] = {}
        if label is not None:
            body["label"] = label
        if clear_workflow:
            body["clear_inbound_workflow"] = True
        elif workflow_id is not None:
            body["inbound_workflow_id"] = int(workflow_id)
        if is_active is not None:
            body["is_active"] = bool(is_active)
        return normalize_agent(self._request("PUT", f"{self._phone_path()}/{int(phone_id)}", body))

    def delete_agent(self, phone_id: int) -> None:
        self._request("DELETE", f"{self._phone_path()}/{int(phone_id)}")


def normalize_agent(p: dict[str, Any]) -> dict[str, Any]:
    """Map a dograh phone-number row to the dashboard Agent shape."""
    address = str(p.get("address") or "")
    ext = extension_from_address(address)
    workflow = p.get("workflow") if isinstance(p.get("workflow"), dict) else None
    wf_name = (
        p.get("inbound_workflow_name")
        or p.get("workflow_name")
        or (workflow or {}).get("name")
        or (workflow or {}).get("title")
        or ""
    )
    return {
        "id": p.get("id"),
        "extension": ext,
        "address": address,
        "label": str(p.get("label") or (f"Agent {ext}" if ext else "")),
        "workflowId": p.get("inbound_workflow_id"),
        "workflowName": str(wf_name or ""),
        "active": bool(p.get("is_active", True)),
    }


# ── FreePBX wiring builders (pure SQL / conf — executed by main.py) ──────


def upsert_custom_extension_sql(ext: str, label: str, workflow_name: str = "") -> str:
    """customappsreg custom extension (registry-only, no device/voicemail)."""
    desc = _sql(agent_description(label, workflow_name))
    notes = _sql(_ascii(f"{NOTES_MARKER}; created by the Agents page - delete there to remove. label={label}", 255))
    return (
        f"INSERT INTO `custom_extensions` (`custom_exten`,`description`,`notes`) "
        f"VALUES ('{_sql(ext)}', '{desc}', '{notes}') "
        f"ON DUPLICATE KEY UPDATE `description`=VALUES(`description`), `notes`=VALUES(`notes`)"
    )


def delete_custom_extension_sql(ext: str) -> str:
    return f"DELETE FROM `custom_extensions` WHERE `custom_exten`='{_sql(ext)}'"


def custom_dest_json(dest_id: int, target: str, description: str) -> dict[str, Any]:
    """kvstore custom-destination row (customappsreg FreePBX 17 shape)."""
    return {
        "destid": int(dest_id),
        "target": target,
        "description": description,
        "notes": "",
        # Keep destret empty — see pbx/bootstrap_dograh_route.py: a truthy
        # destret crashes `fwconsole reload` (missing 'dest' key).
        "destret": "",
    }


def insert_custom_dest_sql(table: str, dest_id: int, dest: dict[str, Any]) -> str:
    return (
        f"INSERT INTO `{table}` (`key`,`val`,`type`,`id`) VALUES "
        f"('{dest_id}', '{json.dumps(dest)}', 'json-arr', 'dests') "
        f"ON DUPLICATE KEY UPDATE `val`=VALUES(`val`), `type`=VALUES(`type`)"
    )


def bump_dest_currentid_sql(table: str, next_id: int) -> str:
    return (
        f"INSERT INTO `{table}` (`key`,`val`,`type`,`id`) VALUES "
        f"('currentid', '{int(next_id)}', NULL, 'noid') "
        f"ON DUPLICATE KEY UPDATE `val`=VALUES(`val`)"
    )


def insert_inbound_route_sql(did: str, description: str, target: str) -> str:
    return (
        "INSERT INTO `incoming` (`extension`,`description`,`destination`,"
        "`cidnum`,`grppre`,`pricid`,`delay_answer`,`mohclass`,"
        "`indication_zone`,`rvolume`) VALUES "
        f"('{_sql(did)}','{_sql(description)}','{_sql(target)}','','','',0,'default','default','')"
    )


def refresh_inbound_route_description_sql(did: str, description: str) -> str:
    """Update a dograh-created inbound route's description (the FreePBX API
    can't update routes, so the row is edited directly, guarded by the
    dograh marker — a user-created route is never touched)."""
    return (
        f"UPDATE `incoming` SET `description`='{_sql(description)}' "
        f"WHERE `extension`='{_sql(did)}' AND `description` LIKE '%{DESC_MARKER}%'"
    )


def refresh_custom_dest_description_sql(table: str, dest_id: str, description: str) -> str:
    """Update a custom destination's description in the kvstore row."""
    return (
        f"UPDATE `{table}` SET `val`=JSON_SET(CAST(`val` AS JSON),'$.description','{_sql(description)}') "
        f"WHERE `id`='dests' AND `key`='{_sql(dest_id)}'"
    )


def delete_inbound_route_sql(did: str) -> str:
    return (
        f"DELETE FROM `incoming` WHERE `extension`='{_sql(did)}' "
        f"AND `description` LIKE '%{DESC_MARKER}%'"
    )


def delete_custom_dest_sql(table: str, dest_id: str) -> str:
    return f"DELETE FROM `{table}` WHERE `id`='dests' AND `key`='{_sql(dest_id)}'"


def count_custom_extension_sql(ext: str) -> str:
    return (
        f"SELECT COUNT(*) FROM `custom_extensions` WHERE `custom_exten`='{_sql(ext)}' "
        f"AND (`description` LIKE '%{DESC_MARKER}%' OR `notes` LIKE '%{NOTES_MARKER}%')"
    )


def count_inbound_route_sql(did: str) -> str:
    return (
        f"SELECT COUNT(*) FROM `incoming` WHERE `extension`='{_sql(did)}' "
        f"AND `description` LIKE '%{DESC_MARKER}%'"
    )


def find_custom_dest_sql(table: str, target: str) -> str:
    return (
        f"SELECT `key` FROM `{table}` WHERE `id`='dests' AND `type`='json-arr' "
        f"AND `val` LIKE '%{_sql(target)}%' ORDER BY CAST(`key` AS UNSIGNED) LIMIT 1"
    )


def dialplan_body(numbers: list[str], stasis_app: str | None = None) -> str:
    """The extensions_custom_dograh.conf moniker for numbers outside the
    static 8000-8007 set: [dograh-inbound] Stasis entries plus a
    [from-internal-custom] leg so the numbers are dialable internally too."""
    dynamic = sorted(
        {
            str(n).strip()
            for n in numbers
            if str(n).strip() and extension_from_address(str(n)) not in STATIC_EXTENSIONS
        }
    )
    if not dynamic:
        return ""
    app = stasis_app or "dograh"
    lines = [
        "; Auto-generated by the Capstone Agents page — dograh numbers",
        f"; beyond the static 8000-8007 set ({DIALPLAN_CONF}).",
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
    return "\n".join(lines) + "\n"