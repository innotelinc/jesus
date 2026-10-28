"""SMS transport selection for the Control Center.

One choice decides where agent and script SMS leaves from:

  zeus      the Zeus portal API (``POST /api/messages/send``) — the add-on path
  opensms   a local OpenSMS Android gateway, called directly (outbound only)
  auto      OpenSMS when configured, falling back to Zeus on a gateway failure

The Settings card writes this module's state file; ``scripts/opensms_client.py``
reads the same file, so a choice made in the browser reaches the dograh `sms`
tool and ``scripts/send_sms.py`` without a container recreate. ``.env`` still
seeds the default (``SMS_PROVIDER``), exactly like ``CAPSTONE_DEPLOY_MODE``:
the saved choice overrides the file, and a value in the *real* environment is
an explicit operator override that wins over both.

The OpenSMS key is never returned: availability reports only whether a key and
URL are present, and the URL (which is not a secret). The source of truth for
config is the process environment first, then the host ``.env`` already mounted
at ``/config/.env`` — the same file the secrets inventory reads.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

STATE_ENV = "CAPSTONE_SMS_TRANSPORT_STATE"
DEFAULT_STATE = "/state/sms-transport"
ENV_FILE_ENV = "CAPSTONE_ENV_FILE"
DEFAULT_ENV_FILE = "/config/.env"

PROVIDERS = ("zeus", "opensms", "auto")

# The operator-facing vocabulary (Settings card, CLI, tool payload). Native
# names stay accepted so `SMS_PROVIDER` and the scripts share one language.
TRANSPORT_ALIASES = {
    "provider": "zeus",
    "zeus": "zeus",
    "local": "opensms",
    "opensms": "opensms",
    "auto": "auto",
}


def normalize(value: Any) -> str:
    """Map 'local'/'provider'/'auto' (or a native name) to a provider, else ''."""
    return TRANSPORT_ALIASES.get(str(value or "").strip().lower(), "")


def dotenv() -> dict[str, str]:
    """The host `.env` (read-only mount), best effort. Never raises."""
    env: dict[str, str] = {}
    path = os.environ.get(ENV_FILE_ENV) or DEFAULT_ENV_FILE
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                env[key.strip()] = val.strip().strip("'\"")
    except OSError:
        pass
    return env


def cfg(name: str, default: str = "") -> str:
    """Real environment first, then `.env` — the scripts' own precedence."""
    value = os.environ.get(name)
    if value:
        return value
    return dotenv().get(name) or default


def state_path() -> Path:
    return Path(os.environ.get(STATE_ENV) or DEFAULT_STATE)


def stored() -> str:
    """The saved choice, or '' when the card has never recorded one."""
    try:
        saved = state_path().read_text(encoding="utf-8").strip().lower()
    except OSError:
        return ""
    return saved if saved in PROVIDERS else ""


def effective() -> tuple[str, str]:
    """(provider, source) where source is env | state | dotenv | default."""
    explicit = (os.environ.get("SMS_PROVIDER") or "").strip()
    canonical = normalize(explicit)
    if canonical:
        return canonical, "env"

    saved = stored()
    if saved:
        return saved, "state"

    seeded = normalize(dotenv().get("SMS_PROVIDER"))
    if seeded:
        return seeded, "dotenv"

    return "zeus", "default"


# --------------------------------------------------------------------------
# gateway health
# --------------------------------------------------------------------------
# The gateway's own `GET /health` (no auth) distinguishes "configured" from
# "ready": a URL and key say nothing about whether a SIM is in the modem. The
# Settings card asks for it separately so a dead gateway never slows the page
# down, and the answer is cached briefly — the card polls, the modem does not.
HEALTH_TIMEOUT_S = 2.0
HEALTH_TTL_S = 5.0

_health_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def gateway_health(url: str | None = None, timeout: float = HEALTH_TIMEOUT_S,
                   ttl: float = HEALTH_TTL_S) -> dict[str, Any]:
    """The gateway's health, or a reason it could not be read. Never raises."""
    base = (url if url is not None else cfg("OPENSMS_URL")).strip().rstrip("/")
    if not base:
        return {"ok": False, "backend": None, "detail": "OPENSMS_URL is not set"}

    now = time.monotonic()
    cached = _health_cache.get(base)
    if cached and now - cached[0] < ttl:
        return cached[1]

    def remember(result: dict[str, Any]) -> dict[str, Any]:
        _health_cache[base] = (now, result)
        return result

    try:
        with urllib.request.urlopen(f"{base}/health", timeout=timeout) as resp:
            payload = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        # 503 is the documented "no modem yet" answer and still carries a body.
        try:
            payload = json.loads(exc.read() or b"{}")
        except (ValueError, OSError):
            payload = {}
        detail = str(payload.get("detail") or f"HTTP {exc.code}")
        return remember({"ok": False, "backend": payload.get("backend"), "detail": detail})
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        return remember({"ok": False, "backend": None, "detail": f"unreachable: {reason}"})
    except ValueError as exc:  # a non-JSON answer from something else on the port
        return remember({"ok": False, "backend": None, "detail": f"not an SMS gateway: {exc}"})

    if not isinstance(payload, dict):
        return remember({"ok": False, "backend": None, "detail": "unexpected health payload"})
    return remember({
        "ok": payload.get("ok") is True,
        "backend": payload.get("backend"),
        "detail": str(payload.get("detail") or ""),
        "signal": payload.get("signal"),
        "operator": payload.get("operator"),
    })


def snapshot() -> dict[str, Any]:
    """Everything the Settings card renders — and nothing secret."""
    provider, source = effective()
    opensms_url = cfg("OPENSMS_URL").strip()
    opensms_key = cfg("OPENSMS_API_KEY").strip()
    zeus_url = (cfg("ZEUS_API_URL") or "https://api.zeus.innotel.us").strip()
    zeus_token = bool(cfg("ZEUS_SESSION_TOKEN").strip() or cfg("ZEUS_BEARER").strip())
    return {
        "transport": provider,
        "source": source,
        "statePath": str(state_path()),
        "choices": list(PROVIDERS),
        "opensms": {
            "configured": bool(opensms_url and opensms_key),
            "url": opensms_url,
        },
        "zeus": {
            "configured": bool(zeus_url and zeus_token),
            "url": zeus_url,
        },
    }


def save(choice: Any) -> dict[str, Any]:
    """Record a choice and return the new snapshot.

    Raises ValueError for anything outside provider/local/auto so the route can
    answer 422 instead of writing a value no sender understands.
    """
    provider = normalize(choice)
    if not provider:
        raise ValueError("transport must be 'provider', 'local' or 'auto'")

    path = state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(provider + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(path)
    except OSError as exc:
        raise ValueError(f"could not record the choice at {path}: {exc}") from exc

    return {**snapshot(), "saved": True}
