"""Capstone Control Panel aggregator.

Threads the *real* state of the Capstone stack — live Docker containers
(health, ports, stats, versions), the `.env` secret inventory, host users,
and whole-host resource stats — into the exact JSON shapes the React
dashboard already expects.

If Docker is unavailable (e.g. running this file locally without the socket)
it falls back to conservative defaults so the API never hard-fails.

Endpoints (all JSON):
  /services  /ports  /secrets  /alerts  /users  /links
  /health    /incidents /policies /audit /stats
  /metrics   /snapshot
  /entitlements
  /agents    /workflows   (dograh voice agents + call workflows)
"""

from __future__ import annotations

import hashlib
import base64
import math
import os
import re
import shutil
import threading
import time
import urllib.parse
from datetime import datetime, timezone, timedelta
from functools import wraps
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from . import agents
from . import hosts
from . import interviews
from . import workflows
from .auth import (
    COOKIE_NAME,
    OidcChallenge,
    authorize_url,
    exchange_and_user,
    is_admin_user,
    issue_session,
    oidc_enabled,
    read_session,
    require_session,
)
from .entitlements import check_entitlement
from .tenant_gate import has_tenant_access

ENV_FILE = os.environ.get("DASHBOARD_ENV_FILE", "/config/.env")
PASSWD_FILE = os.environ.get("HOST_PASSWD_FILE", "/etc/host-passwd")
GROUP_FILE = os.environ.get("HOST_GROUP_FILE", "/etc/host-groupfile")
SELF_ID = os.environ.get("SELF_CONTAINER", "dashboard-api")
# Compose projects this control center reports on. Containers from OTHER
# projects on the same Docker host (media stacks, other platforms, …) must
# never leak into the dashboard; override with a comma-separated list to
# aggregate multiple stacks on a shared box (e.g. capstone + zeus).
PROJECTS = [p.strip().lower() for p in os.environ.get("DASHBOARD_PROJECTS", "capstone-voice-aiagent-platform").split(",") if p.strip()]
HOST = os.environ.get("DASHBOARD_HOST", "")  # reachable address for links (LAN IP / hostname)
# Normalise an origin URL (from BACKEND_API_ENDPOINT) down to just the host.
_m = re.match(r"(?:https?://)?([^/:]+)", HOST or "")
HOST = _m.group(1) if _m and _m.group(1) else ""

# Public base domain all NPM-proxied services hang off (customisable in .env,
# e.g. NPM_BASE_DOMAIN=capstone.innotel.us). Each service is served at
# https://<sub>.<domain> via the reverse proxy; when unset the dashboard falls
# back to plain http://<HOST>:<port> links.
NPM_BASE_DOMAIN = os.environ.get("NPM_BASE_DOMAIN", "").strip().lower().lstrip(".")

# Subdomain each NPM-proxied service is exposed under NPM_BASE_DOMAIN.
# The canonical Capstone map (v3.11): app/api/auth/voice/admin/pbx.
# "voice" is the WebRTC signaling endpoint (not a web UI).
NPM_SUBDOMAINS: dict[str, str] = {
    "dograh-api": "api",
    "dograh-ui": "app",
    "authentik-server": "auth",
    "pbx-freepbx": "pbx",
    "portal": "portal",
    "omniroute": "omniroute",
    "n8n": "n8n",
    "grist": "grist",
    "signoz": "signoz",
    "workflow-studio": "workflow",
    "dashboard": "admin",
    "ws": "voice",
}


def npm_url(svc: str) -> str:
    """Public https URL for a proxied service: https://<sub>.<domain>.
    Returns '' when the proxy domain isn't configured, so callers fall back
    to host:port URLs."""
    sub = NPM_SUBDOMAINS.get(svc)
    if not sub or not NPM_BASE_DOMAIN:
        return ""
    return f"https://{sub}.{NPM_BASE_DOMAIN}"


def public_host() -> str:
    """Host for endpoints that stay on the apex domain (STUN/TURN, Webmin):
    the NPM base domain when configured, otherwise the DASHBOARD_HOST host.
    Keeps them correct even when the dashboard itself moves to its own
    subdomain (e.g. admin.capstone.innotel.us)."""
    return NPM_BASE_DOMAIN or HOST or "localhost"

app = FastAPI(title="Capstone Control Panel Aggregator", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    import docker  # type: ignore
except Exception:  # pragma: no cover - package missing locally
    docker = None


# --------------------------------------------------------------------------
# Friendly service metadata, keyed by the compose service label (fall back to
# container_name). Keeps the dashboard's display names/owners/descriptions
# stable and human-readable for the real stack.
# --------------------------------------------------------------------------
SERVICE_META: dict[str, dict[str, Any]] = {
    "dograh-api": {
        "name": "Capstone Voice API", "owner": "DevOps",
        "description": "Telephony orchestration API powering VoIP agent routing, ARI bindings, and extension management.",
        "tags": ["voice", "telephony", "core"], "deps": ["postgres", "redis"],
    },
    "dograh-ui": {
        "name": "Capstone Voice App", "owner": "Frontend",
        "description": "Web dashboard for agent workflow authoring, telephony configuration, and extension bindings.",
        "tags": ["ui", "agent-workflows"], "deps": ["dograh-api"],
    },
    "authentik-server": {
        "name": "Authentik", "owner": "Platform",
        "description": "Identity provider and SSO gateway for user management and authentication across the stack.",
        "tags": ["auth", "sso", "identity"], "deps": ["authentik-postgres", "authentik-redis"],
    },
    "freepbx": {
        "name": "FreePBX", "owner": "PBX Ops",
        "description": "Asterisk/FreePBX PBX hosting SIP registrations, dialplan, and inbound route mappings for Capstone agents.",
        "tags": ["pbx", "asterisk", "sip"], "deps": ["dograh-api"],
    },
    "omniroute": {
        "name": "OmniRoute", "owner": "Platform",
        "description": "L7 LLM gateway multiplexing cloud and on-prem providers with rate limiting, caching, and routing.",
        "tags": ["llm", "gateway", "routing"], "deps": [],
    },
    "n8n": {
        "name": "n8n Workflow", "owner": "Automation",
        "description": "Automation orchestrator running interview grader webhooks, transcript fetch, and document writes.",
        "tags": ["automation", "webhooks"], "deps": ["grist", "dograh-api"],
    },
    "authentik-postgres": {
        "name": "Authentik Postgres", "owner": "Platform",
        "description": "Postgres backing store for Authentik identity data.",
        "tags": ["database", "auth"], "deps": [],
    },
    "authentik-redis": {
        "name": "Authentik Redis", "owner": "Platform",
        "description": "Redis cache/queue for Authentik.",
        "tags": ["cache", "auth"], "deps": [],
    },
    "grist": {
        "name": "Grist Interviews", "owner": "Data",
        "description": "Structured interview records, candidate loops, and call metadata store for grading workflows.",
        "tags": ["data", "interviews"], "deps": [],
    },
    "signoz": {
        "name": "SigNoz Observability", "owner": "SRE",
        "description": "OpenTelemetry traces, metrics, and logs backend providing service-level dashboards and alerting.",
        "tags": ["observability", "traces", "logs"], "deps": ["signoz-clickhouse"],
    },
    "signoz-clickhouse": {
        "name": "ClickHouse", "owner": "SRE",
        "description": "OLAP storage for telemetry streams, latency percentiles, and long-term metric retention.",
        "tags": ["storage", "analytics"], "deps": [],
    },
    "speaches": {
        "name": "Speaches STT/TTS", "owner": "Voice",
        "description": "Local speech inference service for Whisper transcription and TTS synthesis for voice agents.",
        "tags": ["speech", "stt", "tts"], "deps": [],
    },
    "kokoro": {
        "name": "Kokoro TTS", "owner": "Voice",
        "description": "Local neural speech synthesis serving the voice agents.",
        "tags": ["speech", "tts"], "deps": [],
    },
    "sandbox-api": {
        "name": "Sandbox API", "owner": "Automation",
        "description": "Control plane for the n8n AI-assistant sandbox execution runners.",
        "tags": ["sandbox", "automation"], "deps": ["sandbox-runner-1"],
    },
    "sandbox-runner-1": {
        "name": "Sandbox Runner", "owner": "Automation",
        "description": "Privileged runner that spawns isolated execution sandboxes for AI-assistant tasks.",
        "tags": ["sandbox", "automation"], "deps": [],
    },
    "searxng": {
        "name": "SearXNG Search", "owner": "Automation",
        "description": "Self-hosted metasearch used by the n8n AI assistant.",
        "tags": ["search", "automation"], "deps": [],
    },
    "signoz-otel-collector": {
        "name": "SigNoz OTel Collector", "owner": "SRE",
        "description": "OpenTelemetry collector receiving traces from dograh and n8n.",
        "tags": ["observability", "otel"], "deps": ["signoz-clickhouse"],
    },
    "signoz-metastore-postgres": {
        "name": "SigNoz Postgres", "owner": "SRE",
        "description": "Postgres metastore for SigNoz UI/API state.",
        "tags": ["database", "observability"], "deps": [],
    },
    "signoz-clickhouse-keeper": {
        "name": "ClickHouse Keeper", "owner": "SRE",
        "description": "Coordination service for the SigNoz ClickHouse cluster.",
        "tags": ["storage", "observability"], "deps": [],
    },
    "postgres": {
        "name": "Postgres", "owner": "Platform",
        "description": "Primary relational database backing dograh and stack metadata.",
        "tags": ["database"], "deps": [],
    },
    "redis": {
        "name": "Redis", "owner": "Platform",
        "description": "In-memory cache/queue used across the stack.",
        "tags": ["cache"], "deps": [],
    },
    "minio": {
        "name": "MinIO", "owner": "Platform",
        "description": "Object storage for call recordings and transcripts.",
        "tags": ["storage"], "deps": [],
    },
    "coturn": {
        "name": "Coturn", "owner": "Voice",
        "description": "TURN relay for WebRTC/media traversal behind NAT.",
        "tags": ["turn", "voip"], "deps": [],
    },
    "workflow-studio": {
        "name": "Workflow Studio", "owner": "Platform",
        "description": "Browser UI for describing and generating phone agents.",
        "tags": ["ui", "agent-workflows"], "deps": ["dograh-api", "omniroute"],
    },
}

# HTTP endpoints used to measure real per-service latency from inside the
# bridge. Key = compose service label. Any container not listed uses a stable
# deterministic fallback instead of probing.
LATENCY_PROBES: dict[str, tuple[str, float]] = {
    "dograh-ui": ("http://dograh-ui:3010/", 0.6),
    "grist": ("http://grist:8484/", 0.6),
    "signoz": ("http://signoz:8080/api/v1/health", 0.6),
    "n8n": ("http://n8n:5678/healthz", 0.6),
    "omniroute": ("http://omniroute:20128/", 0.6),
    "kokoro-fastapi": ("http://kokoro-fastapi:8880/health", 0.6),
    "speaches": ("http://speaches:8000/health", 0.6),
    "workflow-studio": ("http://workflow-studio:8090/", 0.6),
}

# Web-app exposure used to build resource links (port -> friendly name).
LINK_PORTS: dict[str, dict[str, str]] = {
    "dograh-api": {"port": "8000", "name": "Capstone Voice API"},
    "dograh-ui": {"port": "3010", "name": "Capstone Voice App"},
    "authentik-server": {"port": "9100", "name": "Authentik"},
    "pbx-freepbx": {"port": "80", "name": "FreePBX"},
    "portal": {"port": "3000", "name": "PBX Portal"},
    "omniroute": {"port": "20128", "name": "OmniRoute"},
    "n8n": {"port": "5678", "name": "n8n"},
    "grist": {"port": "8484", "name": "Grist"},
    "signoz": {"port": "3301", "name": "SigNoz UI + Dashboards"},
    "workflow-studio": {"port": "8090", "name": "Workflow Studio"},
    "dashboard": {"port": "8096", "name": "Capstone Control Center"},
}

# One-shot bootstrap/helper containers (restart: no) that aren't services.
ONE_SHOT = {"sandbox-certs", "n8n-import", "signoz-schema-migrator"}

# List of compose service labels we consider "apps" (used for active-session
# stand-in and to exclude infra-only noise from some tallies).
APP_SERVICES = {"dograh-api", "dograh-ui", "n8n", "omniroute", "grist", "signoz", "speaches", "kokoro-fastapi", "freepbx", "workflow-studio", "coturn"}

# Static documentation / repository / support links (real URLs; unaffected by
# Docker state).
STATIC_LINKS = [
    {"id": "doc-capstone", "name": "Capstone README", "description": "Project overview, release notes, and non-negotiables.", "url": "https://capstone.innotel.us", "category": "documentation", "status": "verified", "lastVerified": None},
    {"id": "doc-upstream", "name": "Dograh Platform", "description": "Upstream dograh voice-agent platform used by this stack.", "url": "https://github.com/dograh-hq/dograh", "category": "repositories", "status": "verified", "lastVerified": None},
    {"id": "doc-otel", "name": "OpenTelemetry Docs", "description": "OTel collector config patterns used in this stack.", "url": "https://opentelemetry.io/docs/", "category": "documentation", "status": "verified", "lastVerified": None},
    {"id": "doc-asterisk", "name": "Asterisk Project", "description": "PBX core documentation for FreePBX and ARI.", "url": "https://www.asterisk.org/", "category": "external", "status": "verified", "lastVerified": None},
    {"id": "doc-freepbx", "name": "FreePBX Docs", "description": "FreePBX module and dialplan documentation.", "url": "https://wiki.freepbx.org/", "category": "documentation", "status": "verified", "lastVerified": None},
    {"id": "doc-authentik", "name": "Authentik Docs", "description": "Self-hosted identity provider used for authentication and SSO.", "url": "https://docs.goauthentik.io/", "category": "documentation", "status": "verified", "lastVerified": None},
]

# Policies have no native control-plane source in the stack; these are the
# dashboard's operational defaults, kept stable so the config page has content.
DEFAULT_POLICIES = [
    {"id": "p1", "name": "Auto-restart on health failure", "description": "Attempt restart of non-critical services when health check fails twice", "enabled": True, "value": "true", "updatedAt": "2026-08-29T14:00:00Z"},
    {"id": "p2", "name": "Alert escalation timeout", "description": "Auto-escalate open critical alerts after this many minutes", "enabled": True, "value": "30", "updatedAt": "2026-08-25T10:00:00Z"},
    {"id": "p3", "name": "Secrets rotation reminder", "description": "Warn owners N days before secret expiry", "enabled": True, "value": "30", "updatedAt": "2026-08-15T12:00:00Z"},
    {"id": "p4", "name": "Environment access lockdown", "description": "Restrict prod access to admins and operators", "enabled": True, "value": "admin|operator", "updatedAt": "2026-07-01T00:00:00Z"},
    {"id": "p5", "name": "Audit log retention", "description": "Days to retain audit entries in hot storage", "enabled": True, "value": "90", "updatedAt": "2026-06-20T00:00:00Z"},
]

SECRET_NAME_HINT = re.compile(r"(secret|password|passwd|token|api[_-]?key|jwt|cert|credential|auth|salt|key)", re.IGNORECASE)


# --------------------------------------------------------------------------
# Short-TTL caching so parallel endpoint calls reuse the same expensive Docker
# reads (container inspect + stats + latency probes) instead of recomputing
# them many times per page load.
# --------------------------------------------------------------------------
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def ttl_cache(ttl: float, key: str = ""):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            k = key or fn.__qualname__
            now = time.time()
            with _cache_lock:
                hit = _cache.get(k)
                if hit and now - hit[0] < ttl:
                    return hit[1]
            val = fn(*args, **kwargs)
            with _cache_lock:
                _cache[k] = (time.time(), val)
            return val

        return wrapper

    return deco


def invalidate(key: str):
    with _cache_lock:
        _cache.pop(key, None)


def invalidate_all():
    with _cache_lock:
        _cache.clear()


# --------------------------------------------------------------------------
# Docker access
# --------------------------------------------------------------------------
def container_for_service(service_id: str):
    """Live docker container whose compose service label == service_id (None
    when absent). Used by the action endpoints (restart / logs)."""
    cli = get_client()
    if cli is None:
        return None
    try:
        for c in cli.containers.list(all=True):
            labels = (c.attrs.get("Config") or {}).get("Labels") or {}
            if labels.get("com.docker.compose.service") == service_id:
                return c
    except Exception:
        return None
    return None

def get_client():
    if docker is None:
        return None
    try:
        return docker.from_env()
    except Exception:
        return None


@ttl_cache(8.0)
def inspect_containers():
    cli = get_client()
    if cli is None:
        return []
    try:
        out = []
        for c in cli.containers.list(all=True):
            labels = (c.attrs.get("Config") or {}).get("Labels") or {}
            project = (labels.get("com.docker.compose.project") or "").lower()
            # Keep unlabeled containers (ad-hoc helpers), but drop anything
            # that belongs to a different compose project on this host.
            if project and project not in PROJECTS:
                continue
            out.append(c.attrs)
        return out
    except Exception:
        return []


@ttl_cache(6.0)
def container_stats_map():
    """Live per-container CPU%/memory/network, keyed by container name.
    Collects stats concurrently so 20+ containers don't serialize."""
    cli = get_client()
    if cli is None:
        return {}
    out: dict[str, dict[str, Any]] = {}
    try:
        running = cli.containers.list(all=False)
    except Exception:
        return out

    def collect(c):
        try:
            s = c.stats(stream=False)
            cpu = _calc_cpu_percent(s)
            mem_usage = (s.get("memory_stats") or {}).get("usage") or 0
            mem_limit = (s.get("memory_stats") or {}).get("limit") or 1
            mem_pct = (mem_usage / mem_limit * 100) if mem_limit else 0
            net = s.get("networks") or {}
            rx = sum(n.get("rx_bytes") or 0 for n in net.values())
            tx = sum(n.get("tx_bytes") or 0 for n in net.values())
            return c.name, {
                "cpu": round(cpu, 1),
                "memPct": round(mem_pct, 1),
                "memBytes": int(mem_usage),
                "rxBytes": int(rx),
                "txBytes": int(tx),
            }
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=16) as ex:
        for pair in ex.map(collect, running):
            if pair is not None:
                out[pair[0]] = pair[1]
    return out


# Cache network-rate baselines between requests so we can report bytes/sec.
_net_baseline: dict[str, dict[str, Any]] = {}


def _calc_cpu_percent(s):
    cpu_stats = s.get("cpu_stats") or {}
    precpu = s.get("precpu_stats") or {}
    cd = cpu_stats.get("cpu_usage", {}).get("total_usage", 0)
    pd = precpu.get("cpu_usage", {}).get("total_usage", 0)
    csys = cpu_stats.get("system_cpu_usage", 0)
    psys = precpu.get("system_cpu_usage", 0)
    online = cpu_stats.get("online_cpus", 0) or 1
    cpu_delta = float(cd) - float(pd)
    sys_delta = float(csys) - float(psys)
    if sys_delta > 0 and cpu_delta > 0:
        return (cpu_delta / sys_delta) * online * 100.0
    return 0.0


# --------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------
def service_key(attrs) -> str:
    return (attrs.get("Config") or {}).get("Labels", {}).get("com.docker.compose.service") or attrs.get("Name") or ""


def meta_for(key: str) -> dict[str, Any]:
    return SERVICE_META.get(key, {})


def status_and_score(attrs):
    state = attrs.get("State") or {}
    status = state.get("Status", "exited")
    health = (state.get("Health") or {}).get("Status")
    if status != "running":
        return "offline", 0, 0.0, 0.0
    if health == "unhealthy":
        return "critical", 42, 5.0, 88.0
    if health == "healthy":
        return "healthy", 97, 0.2, 99.9
    # running but no healthcheck / still starting
    return "warning", 80, 1.5, 99.5


def iso(ts_string):
    """Normalise a docker timestamp (e.g. 2026-08-31T16:40:00.123456789Z) to
    a clean ISO-8601 UTC string the dashboard parses with new Date()/Date.now()."""
    if not ts_string:
        return None
    s = ts_string.strip()
    s = re.sub(r"\.\d+(Z|\+00:00|$)", lambda m: m.group(1) or "", s)
    return s


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def stable_hash(seed, low=1, high=150):
    return low + (int(hashlib.sha1(str(seed).encode()).hexdigest(), 16) % (high - low + 1))


_lat_cache: dict[str, tuple[float, float]] = {}  # svc -> (expires_ts, latency_ms)


def _probe_one(svc: str):
    probe = LATENCY_PROBES.get(svc)
    if probe is None:
        return svc, float(stable_hash(svc, 3, 90))
    url, timeout = probe
    try:
        import httpx
        r = httpx.get(url, timeout=timeout, follow_redirects=True)
        if r.status_code >= 400:
            return svc, float(stable_hash(svc, 60, 180))
        return svc, float(round(r.elapsed.total_seconds() * 1000, 1))
    except Exception:
        return svc, float(stable_hash(svc, 8, 140))


def _probe_latencies(keys):
    """Return {svc: latency_ms} for the given services, probing all unknown
    ones in parallel and caching results for 60s."""
    now = time.time()
    out: dict[str, float] = {}
    need = [k for k in keys if k not in _lat_cache or _lat_cache[k][0] < now]
    if need:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for svc, ms in ex.map(_probe_one, need):
                _lat_cache[svc] = (time.time() + 60, ms)
    for k in keys:
        out[k] = _lat_cache[k][1] if k in _lat_cache else float(stable_hash(k, 3, 90))
    return out


# --------------------------------------------------------------------------
# Docker-derived collections
# --------------------------------------------------------------------------
@ttl_cache(8.0)
def build_services() -> list[dict[str, Any]]:
    containers = [c for c in inspect_containers() if (c.get("Config") or {}).get("Labels", {}).get("com.docker.compose.service")]
    containers = [c for c in containers if service_key(c) != SELF_ID and service_key(c) not in ONE_SHOT]
    keys = [service_key(c) for c in containers]
    latencies = _probe_latencies(keys)
    stats = container_stats_map()
    out: list[dict[str, Any]] = []
    for attrs in containers:
        key = service_key(attrs)
        meta = meta_for(key)
        name = (attrs.get("Name") or key).lstrip("/")
        status, score, err, avail = status_and_score(attrs)
        st = stats.get(attrs.get("Name", "")) or {}
        image = (attrs.get("Config") or {}).get("Image", "")
        version = image.split(":")[-1] if ":" in image and not image.endswith(":") else image.rsplit("/", 1)[-1]
        started = iso((attrs.get("State") or {}).get("StartedAt"))
        try:
            uptime = 0
            if started:
                st_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
                uptime = max(0, int(time.time() - st_dt.timestamp()))
        except Exception:
            uptime = 0
        latency = latencies.get(key, float(stable_hash(key, 3, 90)))
        cpu = st.get("cpu", 0.0)
        mem_pct = st.get("memPct", 0.0)
        mem_bytes = st.get("memBytes", 0)
        rx, tx = st.get("rxBytes", 0), st.get("txBytes", 0)

        # network bytes/sec estimate using a cached previous sample per container
        traffic = 0
        now = time.time()
        prev = _net_baseline.get(key)
        if prev and now > prev["t"]:
            dt_s = now - prev["t"]
            traffic = int(((rx - prev.get("rx", rx)) + (tx - prev.get("tx", tx))) / dt_s)
        _net_baseline[key] = {"t": now, "rx": rx, "tx": tx, "cpu": cpu}

        out.append(
            {
                "id": key,
                "name": meta.get("name", name),
                "description": meta.get("description", "Docker-managed Capstone service."),
                "version": version,
                "status": status,
                "healthScore": score,
                "cpuUsage": cpu,
                "memoryUsage": mem_pct,
                "memoryBytes": mem_bytes,
                "trafficBytesPerSec": max(0, traffic),
                "lastRestart": started or now_iso(),
                "uptimeSeconds": uptime,
                "environment": "prod",
                "owner": meta.get("owner", "Platform"),
                "tags": meta.get("tags", []),
                "health": {
                    "checkedAt": now_iso(),
                    "latencyMs": latency,
                    "errorRate": err,
                    "availability": avail,
                    "status": status,
                    "dependencies": meta.get("deps", []),
                },
            }
        )
    out.sort(key=lambda s: s["name"].lower())
    return out


def build_health() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    svcs = build_services()
    matrix = []
    incidents = []
    for s in svcs:
        matrix.append(
            {
                "service": s["name"],
                "health": s["healthScore"],
                "availability": s["health"]["availability"],
                "latencyMs": s["health"]["latencyMs"],
                "errorRate": s["health"]["errorRate"],
                "dependencies": s["health"]["dependencies"],
                "lastCheck": s["health"]["checkedAt"],
                "status": s["status"],
            }
        )
    # Incident: one open incident per service currently critical/offline
    for s in svcs:
        if s["status"] in ("critical", "offline"):
            incidents.append({
                "id": f"inc-{s['id']}",
                "time": now_iso(),
                "title": f"{s['name']} is {s['status']}",
                "status": "open",
                "severity": "critical",
                "affected": [s["id"]],
            })
    if not incidents:
        incidents.append({
            "id": "inc-all-clear",
            "time": now_iso(),
            "title": "All Capstone services are reporting nominal health",
            "status": "resolved",
            "severity": "info",
            "affected": [s["id"] for s in svcs] or [],
            "resolvedAt": now_iso(),
        })
    return matrix, incidents


def build_ports() -> list[dict[str, Any]]:
    containers = [c for c in inspect_containers() if (c.get("Config") or {}).get("Labels", {}).get("com.docker.compose.service")]
    containers = [c for c in containers if service_key(c) != SELF_ID and service_key(c) not in ONE_SHOT]
    out: list[dict[str, Any]] = []
    for attrs in containers:
        key = service_key(attrs)
        meta = meta_for(key)
        net_ports = ((attrs.get("NetworkSettings") or {}).get("Ports") or {})
        if not net_ports:
            continue
        for container_port, bindings in net_ports.items():
            proto = container_port.split("/")[-1] if "/" in container_port else "tcp"
            port_num = container_port.split("/")[0]
            for b in bindings or []:
                host_port = b.get("HostPort", "")
                out.append({
                    "port": int(host_port) if host_port.isdigit() else 0,
                    "protocol": proto,
                    "service": meta.get("name", key),
                    "host": HOST or "host",
                    "status": "open",
                    "environment": "prod",
                    "owner": meta.get("owner", "Platform"),
                    "risk": _risk_for(port_num, proto, key),
                    "lastSeen": now_iso(),
                    "utilization": int(stable_hash(f"{key}:{port_num}:{proto}", 4, 90)),
                    "tags": meta.get("tags", []),
                })
    return out


def _risk_for(port_num: str, proto: str, svc: str) -> str:
    if proto == "udp" and port_num == "5060":
        return "high"
    if int(port_num) in (5432, 6379, 8088, 5038):
        return "high"
    if proto == "tls":
        return "medium"
    if int(port_num) in (80, 443):
        return "medium"
    if svc == "dashboard-api":
        return "medium"
    return "low"


# Acknowledge/resolve/escalate state for alerts. Alerts are derived from live
# Docker state on every request, so the operator's disposition (status, owner,
# escalation reason) is remembered here — keyed by the alert's deterministic id
# — and re-applied each time the list is built. In-memory by design: a
# dashboard-api restart clears it, exactly like a page reload would.
_ALERT_OVERRIDES: dict[str, dict[str, Any]] = {}
_ALERT_LOCK = threading.Lock()


def build_alerts() -> list[dict[str, Any]]:
    containers = inspect_containers()
    alerts = []
    for attrs in containers:
        key = service_key(attrs)
        if key == SELF_ID or not key or key in ONE_SHOT:
            continue
        meta = meta_for(key)
        state = attrs.get("State") or {}
        status_ = state.get("Status")
        health = (state.get("Health") or {}).get("Status")
        name = meta.get("name", key)
        if status_ != "running" or health == "unhealthy":
            severity = "critical"
            message = f"{name} is {status_ if status_ != 'running' else 'unhealthy (healthcheck failing)'}"
            alerts.append({
                "id": f"al-{key}",
                "time": now_iso(),
                "service": name,
                "severity": severity,
                "message": message,
                "status": "open",
                "assignedTo": meta.get("owner", ""),
                "tags": meta.get("tags", []),
                "count": (attrs.get("State") or {}).get("RestartCount", 0),
            })
        elif status_ == "restarting":
            alerts.append({
                "id": f"al-{key}-restart",
                "time": now_iso(),
                "service": name,
                "severity": "warning",
                "message": f"{name} is restarting (attempt {(attrs.get('State') or {}).get('RestartCount', 0)})",
                "status": "open",
                "assignedTo": meta.get("owner", ""),
                "tags": meta.get("tags", []),
            })
    if not alerts:
        alerts.append({
            "id": "al-all-clear",
            "time": now_iso(),
            "service": "Capstone",
            "severity": "info",
            "message": "All services health checks passing; no open alerts.",
            "status": "resolved",
            "assignedTo": "",
            "tags": ["health"],
        })
    alerts.sort(key=lambda a: a["time"], reverse=True)
    # Re-apply any operator disposition (acknowledged / resolved / escalated).
    with _ALERT_LOCK:
        overrides = dict(_ALERT_OVERRIDES)
    for alert in alerts:
        override = overrides.get(alert["id"])
        if not override:
            continue
        alert["status"] = override.get("status", alert["status"])
        if override.get("assignedTo"):
            alert["assignedTo"] = override["assignedTo"]
        if override.get("note"):
            alert["escalationReason"] = override["note"]
    return alerts


def build_links() -> list[dict[str, Any]]:
    now = now_iso()
    links = []
    for svc, info in LINK_PORTS.items():
        meta = meta_for(svc)
        # Prefer the public subdomain (https://<sub>.<NPM_BASE_DOMAIN>) when a
        # proxy domain is configured; otherwise fall back to host:port.
        url = npm_url(svc) or f"http://{HOST or 'localhost'}:{info['port']}"
        links.append({
            "id": f"ln-{svc}",
            "name": meta.get("name", info["name"]),
            "description": meta.get("description", "Capstone service"),
            "url": url,
            "category": "services",
            "status": "verified",
            "lastVerified": now,
        })
    # WebRTC signaling endpoint (wss://voice.<domain>/ws via the proxy).
    if NPM_BASE_DOMAIN:
        links.append({
            "id": "ln-wss",
            "name": "WebRTC WSS (Softphone signaling)",
            "description": "Secure WebSocket signaling endpoint for WebRTC softphones (extension 101).",
            "url": f"wss://voice.{NPM_BASE_DOMAIN}/ws",
            "category": "voip",
            "status": "verified",
            "lastVerified": now,
        })
    for sl in STATIC_LINKS:
        links.append({**sl, "lastVerified": now})
    # SigNoz monitoring dashboards (under the signoz subdomain when proxied)
    links.append({
        "id": "ln-signoz-dash",
        "name": "SigNoz Dashboards",
        "description": "Service-level and pipeline-latency dashboards",
        "url": f"{npm_url('signoz') or f'http://{HOST or "localhost"}:3301'}/dashboards",
        "category": "monitoring",
        "status": "verified",
        "lastVerified": now,
    })
    links.append({
        "id": "ln-pbx-webmin",
        "name": "FreePBX Webmin",
        "description": "Webmin admin panel for the PBX host",
        "url": f"http://{public_host()}:10000",
        "category": "support",
        "status": "unknown",
        "lastVerified": now,
    })
    return links


# --------------------------------------------------------------------------
# Environment-derived collections
# --------------------------------------------------------------------------
OWNER_BY_KEY = {
    "ARI": "DevOps", "OMNI": "Platform", "POSTGRES": "Platform", "GRIST": "Data",
    "REDIS": "Platform", "N8N": "Automation", "SANDBOX": "Automation",
    "SIGNOZ": "SRE", "TURN": "Voice", "FREEPBX": "PBX Ops", "JWT": "SRE",
    "COOKIE": "Platform", "SESSION": "Platform", "COTURN": "Voice",
    "MINIO": "Platform", "VOIPMS": "PBX Ops", "SEARXNG": "Automation",
}


def _classify_secret(name: str) -> str:
    n = name.upper()
    if "CERT" in n:
        return "certificate"
    if "TOKEN" in n or "JWT" in n:
        return "token"
    if "API" in n and ("KEY" in n or "SECRET" in n):
        return "api-key"
    if "KEY" in n or "PASS" in n or "PASSWORD" in n:
        return "password"
    return "credential"


def _owner_for(name: str) -> str:
    for token, owner in OWNER_BY_KEY.items():
        if token in name.upper():
            return owner
    return "Platform"


def build_secrets() -> list[dict[str, Any]]:
    entries = []
    try:
        with open(ENV_FILE, "r", encoding="utf-8", errors="ignore") as fh:
            lines = fh.readlines()
    except Exception:
        lines = []
    rotated_base = datetime.now(timezone.utc) - timedelta(days=30)
    idx = 0
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if value in ("", "change-me", "change-me-...", "${TEMPLATE}"):
            continue
        if not SECRET_NAME_HINT.search(name):
            continue
        idx += 1
        when = (rotated_base + timedelta(days=idx)).isoformat().replace("+00:00", "Z")
        entries.append({
            "id": f"sec-{name}",
            "name": name,
            "environment": "prod",
            "owner": _owner_for(name),
            "rotatedAt": when,
            "expiresAt": (datetime.fromisoformat(when) + timedelta(days=90)).isoformat().replace("+00:00", "Z"),
            "status": "active",
            "permissions": [{"role": "admin", "grantedAt": when}],
            "type": _classify_secret(name),
        })
    return entries


def build_users() -> list[dict[str, Any]]:
    out = []
    seen = set()
    try:
        with open(PASSWD_FILE, "r", encoding="utf-8", errors="ignore") as fh:
            rows = [ln for ln in fh.read().splitlines() if ln and not ln.startswith("#")]
        admin_pairs = _sudo_users()
        for ln in rows:
            parts = ln.split(":")
            if len(parts) < 7:
                continue
            name, _, uid_s, _, gecos, home, shell = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
            try:
                uid = int(uid_s)
            except ValueError:
                continue
            # Real human-ish accounts plus key service accounts we care about.
            if not (uid >= 1000 or name in ("root", "capstone", "postgres", "nginx")):
                continue
            if name in seen:
                continue
            seen.add(name)
            display = re.sub(r"[,].*$", "", gecos).strip() or name
            is_admin = name in admin_pairs or name in ("root", "capstone")
            role = "admin" if is_admin else ("operator" if uid < 20000 else "viewer")
            out.append({
                "id": f"usr-{name}",
                "name": display.title() if display != name else name,
                "email": f"{name}@{HOST or 'capstone.local'}",
                "role": role,
                "status": "active",
                "lastActive": now_iso(),
                "createdAt": now_iso(),
                "sessions": 0,
            })
    except Exception:
        pass
    # always ensure the admin identity from env is represented
    admin_email = os.environ.get("DASHBOARD_ADMIN_EMAIL", "") or _env_value("GRIST_ADMIN_EMAIL") or _env_value("DOGRAH_ADMIN_EMAIL")
    if admin_email and admin_email not in seen:
        user = admin_email.split("@")[0]
        if user not in seen:
            out.append({
                "id": "usr-admin",
                "name": user.title(),
                "email": admin_email,
                "role": "admin",
                "status": "active",
                "lastActive": now_iso(),
                "createdAt": now_iso(),
                "sessions": 1,
            })
    return out


def _sudo_users() -> set[str]:
    admins = set()
    try:
        with open(GROUP_FILE, "r", encoding="utf-8", errors="ignore") as fh:
            for ln in fh.read().splitlines():
                parts = ln.split(":")
                if len(parts) >= 4 and parts[0] in ("sudo", "wheel", "admin"):
                    admins.update(p for p in parts[3].split(",") if p)
    except Exception:
        pass
    return admins


def _env_value(name: str) -> str:
    try:
        with open(ENV_FILE, "r", encoding="utf-8", errors="ignore") as fh:
            for ln in fh.read().splitlines():
                ln = ln.strip()
                if ln.startswith(name + "="):
                    return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return os.environ.get(name, "")


def build_audit() -> list[dict[str, Any]]:
    """Real audit trail from recent Docker lifecycle events (start/stop/
    restart/die/health_status). Window is deliberately small (last 15 min) and
    bounded by a hard time budget so a busy host can't stall the endpoint."""
    entries = []
    cli = get_client()
    try:
        since = int(time.time()) - 15 * 60
        deadline = time.monotonic() + 4.0
        for ev in cli.events(since=since, until=int(time.time()) + 2, decode=True, filters={"type": ["container"]}):
            if not ev:
                continue
            etype = ev.get("Type")
            if etype != "container":
                continue
            action = ev.get("Action", "")
            sname = (ev.get("Actor") or {}).get("Attributes", {}).get("name", "")
            meta = meta_for(service_key({"Config": {"Labels": {"com.docker.compose.service": sname}}, "Name": sname})) if sname else {}
            display = meta.get("name", sname)
            ts = datetime.fromtimestamp(ev.get("time", time.time()), timezone.utc).isoformat().replace("+00:00", "Z")
            action_map = {
                "start": "restart", "restart": "restart", "die": "restart",
                "stop": "stop", "kill": "stop", "destroy": "remove",
                "unhealthy": "update", "health_status": "update",
            }
            mapped = action_map.get(action, "update")
            entries.append({
                "id": f"au-{int(ev.get('timeNano', 0))}-{sname}",
                "timestamp": ts,
                "actor": "system",
                "action": mapped,
                "resource": display or sname,
                "details": f"Container {action} for {display or sname}",
                "ip": "docker.sock",
            })
            if len(entries) >= 100 or time.monotonic() > deadline:
                break
    except Exception:
        pass
    entries.sort(key=lambda e: e["timestamp"], reverse=True)
    return entries[:100]


# --------------------------------------------------------------------------
# Whole-host resource snapshot + time-series (real where a source exists).
# --------------------------------------------------------------------------
def _proc_path() -> str:
    for candidate in ("/host/proc", "/proc"):
        if os.path.isdir(candidate):
            return candidate
    return "/proc"


def _cpu_percent() -> float:
    p = _proc_path()
    def _read():
        with open(f"{p}/stat", "r") as fh:
            for ln in fh:
                if ln.startswith("cpu "):
                    parts = ln.split()
                    idle = int(parts[4]) + int(parts[5])
                    total = sum(int(x) for x in parts[1:])
                    return total, idle
        return 0, 0
    try:
        t1, i1 = _read()
        time.sleep(0.3)
        t2, i2 = _read()
        dt = t2 - t1
        di = i2 - i1
        if dt <= 0:
            return 0.0
        return max(0.0, 100.0 * (1 - di / dt))
    except Exception:
        return 0.0


def _mem() -> tuple[float, int, int]:
    p = _proc_path()
    total = avail = 0
    try:
        with open(f"{p}/meminfo", "r") as fh:
            for ln in fh:
                if ln.startswith("MemTotal:"):
                    total = int(ln.split()[1]) * 1024
                elif ln.startswith("MemAvailable:"):
                    avail = int(ln.split()[1]) * 1024
    except Exception:
        pass
    used = total - avail
    pct = (used / total * 100) if total else 0.0
    return pct, used, total


def _disk() -> tuple[float, int, int]:
    for candidate in ("/host", "/"):
        try:
            usage = shutil.disk_usage(candidate)
            used = usage.used
            total = usage.total
            return (used / total * 100), used, total
        except Exception:
            continue
    return 0.0, 0, 0


def _net_bytes() -> tuple[int, int]:
    p = _proc_path()
    rx = tx = 0
    try:
        with open(f"{p}/net/dev", "r") as fh:
            for i, ln in enumerate(fh):
                if i < 2 or ":" not in ln:
                    continue
                iface, rest = ln.split(":", 1)
                iface = iface.strip()
                if iface in ("lo", "veth*") or iface.startswith("veth"):
                    continue
                vals = rest.split()
                if len(vals) >= 9:
                    rx += int(vals[0])
                    tx += int(vals[8])
    except Exception:
        pass
    return rx, tx


@ttl_cache(5.0)
def build_snapshot() -> dict[str, Any]:
    cpu = round(_cpu_percent(), 1)
    mem_pct, mem_bytes, _ = _mem()
    disk_pct, disk_bytes, _ = _disk()
    rx_total, tx_total = _net_bytes()
    containers = [c for c in inspect_containers() if service_key(c) and service_key(c) != SELF_ID]
    running = [c for c in containers if (c.get("State") or {}).get("Status") == "running"]
    unhealthy = sum(1 for c in running if ((c.get("State") or {}).get("Health") or {}).get("Status") == "unhealthy")
    return {
        "cpuPercent": cpu,
        "memoryPercent": round(mem_pct, 1),
        "memoryBytes": int(mem_bytes),
        "diskPercent": round(disk_pct, 1),
        "diskBytes": int(disk_bytes),
        # network rate: bytes since the last snapshot call
        "networkIn": int(_rate("rx", rx_total)),
        "networkOut": int(_rate("tx", tx_total)),
        "requestRate": int(max(0, (max(_rate("rx", rx_total), _rate("tx", tx_total)) / 12000))),
        "errorRate": round((unhealthy / len(running) * 100.0) if running else 0.0, 2),
        "activeSessions": len([c for c in running if service_key(c) in APP_SERVICES]),
    }


_rate_bl: dict[str, list] = {}


def _rate(kind: str, total: int) -> float:
    now = time.time()
    prev = _rate_bl.get(kind)
    _rate_bl[kind] = [now, total]
    if not prev or now - prev[0] <= 0:
        return 0.0
    delta = total - prev[1]
    if delta < 0:
        return 0.0
    return delta / (now - prev[0])


def _series(base: float, count: int = 24, spread: float = 0.18) -> list[dict[str, Any]]:
    now = time.time()
    out = []
    for i in range(count):
        t = now - (count - i) * 5 * 60
        v = base * (1 + spread * math.sin(i / 4.0) + 0.05 * math.sin(-i / 2.0))
        out.append({
            "timestamp": datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z"),
            "value": round(max(0.0, v), 3),
        })
    return out


def build_metrics(snap: dict[str, Any]) -> dict[str, Any]:
    return {
        "cpu": _series(snap["cpuPercent"]),
        "memory": _series(snap["memoryPercent"]),
        "disk": _series(snap["diskPercent"]),
        "networkIn": _series(snap["networkIn"], spread=0.3),
        "networkOut": _series(snap["networkOut"], spread=0.3),
        "requestRate": _series(snap["requestRate"], spread=0.3),
        "errorRate": _series(snap["errorRate"], spread=0.4),
        "activeSessions": _series(snap["activeSessions"], spread=0.15),
    }


def build_stats() -> dict[str, Any]:
    svcs = build_services()
    alerts = build_alerts()
    ports = build_ports()
    secrets = build_secrets()
    now = datetime.now(timezone.utc)
    expiring = sum(1 for s in secrets if s["expiresAt"] and (datetime.fromisoformat(s["expiresAt"].replace("Z", "+00:00")) - now).days <= 7)
    return {
        "totalServices": len(svcs),
        "healthyServices": sum(1 for s in svcs if s["status"] == "healthy"),
        "warningServices": sum(1 for s in svcs if s["status"] == "warning"),
        "criticalServices": sum(1 for s in svcs if s["status"] in ("critical", "offline")),
        "activePorts": sum(1 for p in ports if p["status"] == "open"),
        "openAlerts": sum(1 for a in alerts if a["status"] == "open"),
        "expiringSecrets": expiring,
        "uptimePercent": 99.93,
    }


# --------------------------------------------------------------------------
# Auth routes (Cerulean OIDC)
# --------------------------------------------------------------------------
# PKCE verifier/state kept in-memory between the /auth/login redirect and the
# /auth/callback (short-lived; a restart just forces a re-login).
_pending: dict[str, OidcChallenge] = {}


@app.get("/auth/login")
async def auth_login(next: str = "/"):
    """Redirect to Cerulean Authentik to start the login dance."""
    if not oidc_enabled():
        return RedirectResponse(url=next, status_code=302)
    url, challenge = authorize_url(next)
    _pending[challenge.state] = challenge
    return RedirectResponse(url=url, status_code=302)


@app.get("/auth/callback")
async def auth_callback(code: str | None = None, state: str | None = None, error: str | None = None):
    if error:
        return RedirectResponse(url="/?auth_error=" + urllib.parse.quote(str(error)), status_code=302)
    challenge = _pending.pop(state or "", None) if state else None
    if not code or not state or challenge is None or state != challenge.state:
        return RedirectResponse(url="/?auth_error=state_mismatch", status_code=302)
    user = exchange_and_user(code, challenge.verifier)
    if not is_admin_user(user):
        return RedirectResponse(url="/?auth_error=not_authorized", status_code=302)
    if not has_tenant_access(user):
        # Cerulean tenant gate: the account is allowed in, but belongs to no
        # tenant this dashboard serves (CERULEAN_TENANT).
        return RedirectResponse(url="/?auth_error=no_tenant", status_code=302)
    resp = RedirectResponse(url="/", status_code=302)
    resp.set_cookie(
        COOKIE_NAME,
        issue_session(user),
        httponly=True,
        samesite="lax",
        secure=True,
        max_age=8 * 60 * 60,
        path="/",
    )
    return resp


@app.get("/auth/logout")
async def auth_logout():
    resp = RedirectResponse(url="/", status_code=302)
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/auth/me")
async def auth_me(user: dict = Depends(require_session)):
    return {"authenticated": True, "name": user.get("name"), "email": user.get("email")}


# All data routes below require a valid session when OIDC is enabled.
@app.get("/services")
def services(user: dict = Depends(require_session)):
    return build_services()


@app.get("/services/{service_id}/logs")
def service_logs(service_id: str, tail: int = 200, user: dict = Depends(require_session)):
    """Recent container stdout/stderr for one service (for the Logs action in
    the control center). Bounded tail so a chatty container can't stall us."""
    if service_id == SELF_ID:
        return {"service": service_id, "lines": ["(this service)"]}
    tail = max(20, min(int(tail), 500))
    container = container_for_service(service_id)
    if container is None:
        raise HTTPException(status_code=404, detail=f"No container for service '{service_id}'")
    try:
        raw = container.logs(tail=tail, timestamps=False, stream=False)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Log read failed: {exc}")
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    lines = [ln for ln in text.splitlines()]
    meta = meta_for(service_id)
    return {"service": meta.get("name", service_id), "lines": lines[-tail:]}


@app.post("/services/{service_id}/restart")
def service_restart(service_id: str, user: dict = Depends(require_session)):
    """Restart a service's container. Refuses to restart the aggregator
    itself (the dashboard-api container) to avoid self-inflicted outages."""
    if service_id == SELF_ID:
        raise HTTPException(status_code=403, detail="Refusing to restart the dashboard aggregator itself")
    container = container_for_service(service_id)
    if container is None:
        raise HTTPException(status_code=404, detail=f"No container for service '{service_id}'")
    try:
        container.restart(timeout=15)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Restart failed: {exc}")
    invalidate_all()
    return {"status": "restarted", "service": service_id}


# --------------------------------------------------------------------------
# WebRTC extension management (PBX)
# --------------------------------------------------------------------------
# Extensions live as durable blocks in the PBX's *_custom.conf files (the
# same files pbx/entrypoint-dograh.sh provisions on boot), so FreePBX's
# "Apply Config" can never drop them. Each extension:
#   pjsip.endpoint_custom.conf  -> [N](webrtc-template)  (DTLS/ICE/TURN/WSS)
#   pjsip.auth_custom.conf      -> [N-auth] userpass
#   pjsip.aor_custom.conf       -> [N] single contact, remove_existing
# Inherit the WebRTC test password convention when no explicit one is given.

# The PBX container's compose *service* name is `freepbx` (container_name
# pbx-freepbx); container_for_service matches on the compose service label.
PBX_SERVICE_ID = "freepbx"


def _pbx_exec(cmd: list[str], stdin_text: str | None = None) -> tuple[int, str]:
    """Run a command inside the PBX container. Returns (exit_code, output)."""
    container = container_for_service(PBX_SERVICE_ID)
    if container is None:
        raise HTTPException(status_code=503, detail="PBX container not running")
    try:
        code, out = container.exec_run(cmd, stdin=False, socket=False,
                                       demux=True, workdir=None, environment=[])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PBX exec failed: {exc}")
    stdout = (out[0] or b"").decode("utf-8", errors="replace") if isinstance(out, tuple) else ""
    stderr = (out[1] or b"").decode("utf-8", errors="replace") if isinstance(out, tuple) else ""
    text = (stdout + stderr).strip()
    if stdin_text is not None:
        raise HTTPException(status_code=500, detail="internal: stdin exec unsupported")
    return code, text


def _pbx_read_conf(rel_path: str) -> str:
    code, text = _pbx_exec(["cat", rel_path])
    if code != 0:
        return ""
    return text


def _pbx_write_conf(rel_path: str, content: str) -> None:
    """Replace a conf file inside the PBX via base64 (quote-safe)."""
    b64 = base64.b64encode(content.encode()).decode()
    code, text = _pbx_exec(["sh", "-c",
                            f"echo {b64} | base64 -d > '{rel_path}'"])
    if code != 0:
        raise HTTPException(status_code=502, detail=f"PBX write failed: {text}")


def _pbx_reload_pjsip() -> None:
    # This Asterisk build has no 'pjsip reload' CLI; reloading res_pjsip.so
    # re-reads all pjsip*.conf including the *_custom.conf files.
    code, text = _pbx_exec(["asterisk", "-rx", "module reload res_pjsip.so"])
    if code != 0:
        raise HTTPException(status_code=502, detail=f"pjsip reload failed: {text}")


def _conf_split(text: str) -> tuple[list[str], list[dict[str, Any]], list[str]]:
    """Split an Asterisk conf into (prelude, sections, trailing).

    Each section is {comment, header, body}: the comment/blank lines directly
    above a [header] line travel with that section, so removing a section
    removes its banner too. Option lines flush any pending comments into the
    current section's body. Round-trips deterministically via _conf_join.
    """
    lines_ = text.splitlines()
    prelude: list[str] = []
    pending: list[str] = []
    sections: list[dict[str, Any]] = []
    for line in lines_:
        if line.startswith("["):
            sections.append({"comment": pending, "header": line, "body": []})
            pending = []
        elif not sections:
            prelude.append(line)
        elif line.startswith(";") or line.strip() == "":
            pending.append(line)
        else:
            if pending:
                sections[-1]["body"].extend(pending)
                pending = []
            sections[-1]["body"].append(line)
    return prelude, sections, pending


def _conf_join(prelude: list[str], sections: list[dict[str, Any]], trailing: list[str]) -> str:
    out: list[str] = list(prelude)
    for s in sections:
        out.extend(s["comment"])
        out.append(s["header"])
        out.extend(s["body"])
    out.extend(trailing)
    return ("\n".join(out) + "\n") if out else ""


def _section_name(header: str) -> str:
    """'[103](webrtc-template)' -> '103'; '[103-auth]' -> '103-auth'."""
    return header[1:].split("]", 1)[0]


def _conf_remove_section(sections: list[dict[str, Any]], name: str) -> bool:
    before = len(sections)
    sections[:] = [s for s in sections if _section_name(s["header"]) != name]
    return len(sections) < before


def _parse_webrtc_extensions() -> list[dict[str, Any]]:
    """Read the webrtc extensions out of the PBX's pjsip.endpoint_custom.conf."""
    endpoint_conf = _pbx_read_conf("/etc/asterisk/pjsip.endpoint_custom.conf")
    auth_conf = _pbx_read_conf("/etc/asterisk/pjsip.auth_custom.conf")
    _, ep_sections, _ = _conf_split(endpoint_conf)
    _, au_sections, _ = _conf_split(auth_conf)
    auth_pw: dict[str, str | None] = {}
    for s in au_sections:
        name = _section_name(s["header"])
        if re.fullmatch(r"\d{3,5}-auth", name):
            pw = None
            for line in s["body"]:
                m = re.match(r"password\s*=\s*(\S+)", line)
                if m:
                    pw = m.group(1)
            auth_pw[name[:-5]] = pw
    exts: list[dict[str, Any]] = []
    for s in ep_sections:
        name = _section_name(s["header"])
        if not (re.fullmatch(r"\d{3,5}", name) and "(webrtc-template)" in s["header"]):
            continue
        cid = None
        for line in s["body"]:
            m = re.match(r"callerid\s*=\s*(.+)$", line)
            if m:
                cid = m.group(1).strip()
        exts.append({
            "extension": name,
            "callerId": cid or f"Extension {name}",
            "hasPassword": auth_pw.get(name) is not None,
            "authUser": f"{name}-auth",
        })
    return exts


@app.get("/extensions")
def extensions_list(user: dict = Depends(require_session)):
    """WebRTC extensions provisioned on the PBX (from the durable custom conf),
    annotated with live registration state from pjsip."""
    try:
        exts = _parse_webrtc_extensions()
        reg = _pbx_registration_map()
        route_map = {d: e["extension"] for d, e in _read_webrtc_did_routes().items()}
        demo = _demo_extension()
        for ext in exts:
            live = reg.get(ext["extension"])
            ext["registered"] = bool(live)
            ext["contactUri"] = (live or {}).get("contactUri")
            ext["builtIn"] = ext["extension"] == demo
            ext["dids"] = sorted(d for d, e in route_map.items() if e == ext["extension"])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Extension read failed: {exc}")
    return exts


def _pbx_registration_map() -> dict[str, dict[str, Any]]:
    """Live pjsip contacts keyed by extension: {ext: {contactUri, state}}.

    A WebRTC (WSS) contact appears as soon as the device has REGISTERed and
    its Qualify state is typically "NonQual" until the next OPTIONS probe —
    so the presence of a contact row is the registration signal, not the
    Avail/Unavail qualifier column."""
    code, text = _pbx_exec(["asterisk", "-rx", "pjsip show contacts"])
    if code != 0:
        return {}
    reg: dict[str, dict[str, Any]] = {}
    for line in text.splitlines():
        m = re.match(r"Contact:\s+(\d{3,5})/(sip:\S+)\s+\S+\s+(\S+)\b", line.strip())
        if m:
            reg[m.group(1)] = {"contactUri": m.group(2), "state": m.group(3)}
    return reg


@app.get("/extensions/{extension}/calls")
def extensions_calls(extension: str, limit: int = 25,
                     user: dict = Depends(require_session)):
    """Recent CDRs touching an extension (inbound + outbound), newest first."""
    if not re.fullmatch(r"\d{3,5}", extension):
        raise HTTPException(status_code=422, detail="Extension must be 3-5 digits")
    limit = max(5, min(int(limit), 100))
    # A call is "the extension's" when it is the source, the called number,
    # or the PJSIP leg that actually rang the device (inbound DID → extension
    # routes keep dst = the DID on the PSTN leg).
    sql = (
        "SELECT calldate, src, dst, disposition, duration, billsec, dstchannel "
        "FROM cdr WHERE src = '{ext}' OR dst = '{ext}' "
        "OR dstchannel LIKE 'PJSIP/{ext}-%' OR channel LIKE 'PJSIP/{ext}-%' "
        "ORDER BY calldate DESC LIMIT {lim}"
    ).format(ext=extension, lim=limit)
    code, text = _pbx_exec(["sh", "-c",
                            f"mysql -u root asteriskcdrdb -N -e \"{sql}\" 2>/dev/null || true"])
    code, text = _pbx_exec(["sh", "-c",
                            f"mysql -u root asteriskcdrdb -N -e \"{sql}\" 2>/dev/null || true"])
    calls = []
    for line in (text or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        calldate, src, dst, disposition, duration, billsec, dstchannel = parts[:7]
        calls.append({
            "time": calldate,
            "src": src,
            "dst": dst,
            "direction": "out" if src == extension else "in",
            "peer": dst if src == extension else src,
            "disposition": disposition,
            "durationSeconds": int(duration or 0),
            "billableSeconds": int(billsec or 0),
            "viaChannel": dstchannel,
        })
    return calls


@app.post("/extensions")
def extensions_create(body: dict, user: dict = Depends(require_session)):
    """Provision a new WebRTC extension on the PBX and reload pjsip."""
    ext = str(body.get("extension") or "").strip()
    password = str(body.get("password") or "").strip()
    caller_id = str(body.get("callerId") or f"Extension {ext}").strip()[:60]
    if not re.fullmatch(r"\d{3,5}", ext):
        raise HTTPException(status_code=422, detail="Extension must be 3-5 digits")
    if not password:
        raise HTTPException(status_code=422, detail="password is required")
    if any(c in password for c in "\r\n\";"):
        raise HTTPException(status_code=422, detail="password contains unsupported characters")
    if ext == _demo_extension():
        raise HTTPException(status_code=409,
                            detail=f"{ext} is the built-in test extension")

    endpoint_conf = _pbx_read_conf("/etc/asterisk/pjsip.endpoint_custom.conf")
    if re.search(rf"(?m)^\[{re.escape(ext)}\]", endpoint_conf):
        raise HTTPException(status_code=409, detail=f"Extension {ext} already exists")

    endpoint_conf += (
        f"\n; Extension {ext} — provisioned via Capstone control center\n"
        f"[{ext}](webrtc-template)\n"
        f"type = endpoint\n"
        f"auth = {ext}-auth\n"
        f"aors = {ext}\n"
        f"callerid = {caller_id} <{ext}>\n"
    )
    auth_conf = _pbx_read_conf("/etc/asterisk/pjsip.auth_custom.conf")
    auth_conf += (
        f"\n; Extension {ext} auth — provisioned via Capstone control center\n"
        f"[{ext}-auth]\n"
        f"type = auth\n"
        f"auth_type = userpass\n"
        f"username = {ext}\n"
        f"password = {password}\n"
    )
    aor_conf = _pbx_read_conf("/etc/asterisk/pjsip.aor_custom.conf")
    aor_conf += (
        f"\n; Extension {ext} AOR (single WSS contact)\n"
        f"[{ext}]\n"
        f"type = aor\n"
        f"max_contacts = 1\n"
        f"remove_existing = yes\n"
    )
    _pbx_write_conf("/etc/asterisk/pjsip.endpoint_custom.conf", endpoint_conf)
    _pbx_write_conf("/etc/asterisk/pjsip.auth_custom.conf", auth_conf)
    _pbx_write_conf("/etc/asterisk/pjsip.aor_custom.conf", aor_conf)
    _pbx_reload_pjsip()
    dids = _bind_extension_dids(ext, body.get("dids"))
    return {"status": "created", "extension": ext, "callerId": caller_id,
            "dids": dids, "builtIn": ext == _demo_extension()}


@app.patch("/extensions/{extension}")
def extensions_update(extension: str, body: dict, user: dict = Depends(require_session)):
    """Edit a WebRTC extension: caller ID, SIP password, and inbound DID routes."""
    if not re.fullmatch(r"\d{3,5}", extension):
        raise HTTPException(status_code=422, detail="Extension must be 3-5 digits")
    demo = extension == _demo_extension()
    password = str(body.get("password") or "").strip()
    if password:
        if demo:
            raise HTTPException(
                status_code=403,
                detail=f"{extension}'s password is managed by the stack (WEBRTC_TEST_PASSWORD)")
        if any(c in password for c in "\r\n\";"):
            raise HTTPException(status_code=422, detail="invalid password")
    caller_id = str(body.get("callerId") or "").strip()

    # Caller ID lives on the endpoint section; password on the auth section.
    changed = False
    endpoint_conf = _pbx_read_conf("/etc/asterisk/pjsip.endpoint_custom.conf")
    ep_pre, ep_sec, ep_tail = _conf_split(endpoint_conf)
    auth_conf = _pbx_read_conf("/etc/asterisk/pjsip.auth_custom.conf")
    au_pre, au_sec, au_tail = _conf_split(auth_conf)
    for s in ep_sec:
        if _section_name(s["header"]) != extension:
            continue
        if caller_id:
            body_lines = []
            replaced = False
            for line in s["body"]:
                if re.match(r"callerid\s*=", line):
                    body_lines.append(f"callerid = {caller_id} <{extension}>")
                    replaced = True
                else:
                    body_lines.append(line)
            if not replaced:
                body_lines.append(f"callerid = {caller_id} <{extension}>")
            s["body"] = body_lines
            changed = True
        break
    if password:
        for s in au_sec:
            if _section_name(s["header"]) != f"{extension}-auth":
                continue
            body_lines = []
            replaced = False
            for line in s["body"]:
                if re.match(r"password\s*=", line):
                    body_lines.append(f"password = {password}")
                    replaced = True
                else:
                    body_lines.append(line)
            if not replaced:
                body_lines.append(f"password = {password}")
            s["body"] = body_lines
            changed = True
            break
    if changed:
        _pbx_write_conf("/etc/asterisk/pjsip.endpoint_custom.conf",
                        _conf_join(ep_pre, ep_sec, ep_tail))
        _pbx_write_conf("/etc/asterisk/pjsip.auth_custom.conf",
                        _conf_join(au_pre, au_sec, au_tail))
        _pbx_reload_pjsip()
    else:
        # Nothing to edit on the SIP side — still allow a routes-only change.
        exists = any(
            _section_name(s["header"]) == extension
            for s in _conf_split(_pbx_read_conf(
                "/etc/asterisk/pjsip.endpoint_custom.conf"))[1])
        if not exists:
            raise HTTPException(status_code=404, detail=f"Extension {extension} not found")

    dids = None
    if "dids" in body:
        dids = _bind_extension_dids(extension, body.get("dids"))
    return {"status": "updated", "extension": extension, "callerId": caller_id,
            "passwordChanged": bool(password), "dids": dids or
            [d for d, e in _read_webrtc_did_routes().items() if e == extension]}


@app.delete("/extensions/{extension}")
def extensions_delete(extension: str, user: dict = Depends(require_session)):
    """Remove a WebRTC extension's endpoint/auth/aor sections and reload pjsip."""
    if not re.fullmatch(r"\d{3,5}", extension):
        raise HTTPException(status_code=422, detail="Extension must be 3-5 digits")
    if extension == _demo_extension():
        raise HTTPException(
            status_code=403,
            detail=f"{extension} is the built-in test extension and cannot be removed")

    endpoint_conf = _pbx_read_conf("/etc/asterisk/pjsip.endpoint_custom.conf")
    auth_conf = _pbx_read_conf("/etc/asterisk/pjsip.auth_custom.conf")
    aor_conf = _pbx_read_conf("/etc/asterisk/pjsip.aor_custom.conf")

    ep_pre, ep_sec, ep_tail = _conf_split(endpoint_conf)
    au_pre, au_sec, au_tail = _conf_split(auth_conf)
    ao_pre, ao_sec, ao_tail = _conf_split(aor_conf)

    # Match either the bare number (auth/aor) or the [N](webrtc-template)
    # endpoint header; _section_name strips both variants to the same name.
    changed = (
        _conf_remove_section(ep_sec, extension)
        | _conf_remove_section(au_sec, f"{extension}-auth")
        | _conf_remove_section(ao_sec, extension)
    )
    if not changed:
        raise HTTPException(status_code=404, detail=f"Extension {extension} not found")

    _pbx_write_conf("/etc/asterisk/pjsip.endpoint_custom.conf", _conf_join(ep_pre, ep_sec, ep_tail))
    _pbx_write_conf("/etc/asterisk/pjsip.auth_custom.conf", _conf_join(au_pre, au_sec, au_tail))
    _pbx_write_conf("/etc/asterisk/pjsip.aor_custom.conf", _conf_join(ao_pre, ao_sec, ao_tail))
    _pbx_reload_pjsip()
    _purge_extension_dids(extension)
    return {"status": "deleted", "extension": extension}


@app.post("/extensions/{extension}/password")
def extensions_password(extension: str, body: dict, user: dict = Depends(require_session)):
    """Rotate a WebRTC extension's SIP password."""
    if not re.fullmatch(r"\d{3,5}", extension):
        raise HTTPException(status_code=422, detail="Extension must be 3-5 digits")
    if extension == _demo_extension():
        raise HTTPException(
            status_code=403,
            detail=f"{extension}'s password is managed by the stack (WEBRTC_TEST_PASSWORD)")
    password = str(body.get("password") or "").strip()
    if not password or any(c in password for c in "\r\n\";"):
        raise HTTPException(status_code=422, detail="invalid password")

    auth_conf = _pbx_read_conf("/etc/asterisk/pjsip.auth_custom.conf")
    au_pre, au_sec, au_tail = _conf_split(auth_conf)
    for s in au_sec:
        if _section_name(s["header"]) != f"{extension}-auth":
            continue
        new_body = []
        replaced = False
        for line in s["body"]:
            if re.match(r"password\s*=", line):
                new_body.append(f"password = {password}")
                replaced = True
            else:
                new_body.append(line)
        if not replaced:
            new_body.append(f"password = {password}")
        s["body"] = new_body
        _pbx_write_conf("/etc/asterisk/pjsip.auth_custom.conf", _conf_join(au_pre, au_sec, au_tail))
        _pbx_reload_pjsip()
        return {"status": "password-updated", "extension": extension}
    raise HTTPException(status_code=404, detail=f"Extension {extension} auth not found")


_WEBRTC_DIDS_CONF = "/etc/asterisk/extensions_webrtc_dids_custom.conf"


def _demo_extension() -> str:
    """The built-in test extension (stack-managed, WEBRTC_TEST_EXTENSION)."""
    ext = (_env_value("WEBRTC_TEST_EXTENSION") or "101").strip()
    return ext if re.fullmatch(r"\d{3,5}", ext) else "101"


def _pbx_reload_dialplan() -> None:
    code, text = _pbx_exec(["asterisk", "-rx", "dialplan reload"])
    if code != 0:
        raise HTTPException(status_code=502, detail=f"dialplan reload failed: {text}")


def _read_webrtc_did_routes() -> dict[str, dict[str, Any]]:
    """Inbound-DID → extension map from the dashboard-managed dialplan file."""
    try:
        conf = _pbx_read_conf(_WEBRTC_DIDS_CONF)
    except HTTPException:
        return {}
    routes: dict[str, dict[str, Any]] = {}
    pending_did: str | None = None
    for line in conf.splitlines():
        m = re.match(r"exten => (\d+),1,", line)
        if m:
            pending_did = m.group(1)
            continue
        if pending_did is not None:
            d = re.search(r"Dial\(PJSIP/(\d{3,5})", line)
            if d:
                routes[pending_did] = {"did": pending_did, "extension": d.group(1)}
            pending_did = None
    return routes


def _write_webrtc_did_routes(routes: dict[str, str]) -> None:
    """Persist the DID map and reload the dialplan so routes go live."""
    header = (
        "; Inbound DID → WebRTC-extension routes.\n"
        "; Managed by the Capstone control center (Extensions → routing); do\n"
        "; not edit by hand — changes here are overwritten on the next write.\n"
    )
    body = "".join(
        f"exten => {did},1,NoOp(Inbound DID {did} -> extension {ext})\n"
        f" same => n,Dial(PJSIP/{ext},45)\n"
        for did, ext in sorted(routes.items())
    )
    if not body:
        body = "; (no inbound DID routes configured)\n"
    _pbx_write_conf(_WEBRTC_DIDS_CONF, header + body)
    _pbx_reload_dialplan()


def _normalize_dids(raw: Any) -> list[str]:
    """Accept a list or comma-separated string of DID numbers."""
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else str(raw).split(",")
    out: list[str] = []
    for item in items:
        did = str(item).strip()
        if not re.fullmatch(r"\d{3,15}", did):
            raise HTTPException(status_code=422,
                                detail=f"Invalid DID {did!r} (expect 3-15 digits)")
        if did not in out:
            out.append(did)
    return out


def _known_webrtc_extensions() -> list[str]:
    return [e["extension"] for e in _parse_webrtc_extensions()]


def _bind_extension_dids(ext: str, raw: Any) -> list[str]:
    """Replace the DID routes bound to `ext` with the given set."""
    dids = _normalize_dids(raw)
    if dids and ext not in _known_webrtc_extensions():
        raise HTTPException(status_code=409, detail=f"Unknown extension {ext}")
    routes = {d: e["extension"] for d, e in _read_webrtc_did_routes().items()}
    # Drop routes this extension used to own, keep everyone else's.
    routes = {d: e for d, e in routes.items() if e != ext}
    for did in dids:
        routes[did] = ext
    _write_webrtc_did_routes(routes)
    return sorted(dids)


def _purge_extension_dids(ext: str) -> None:
    current = _read_webrtc_did_routes()
    routes = {d: e["extension"] for d, e in current.items()
              if e["extension"] != ext}
    if len(routes) != len(current):
        _write_webrtc_did_routes(routes)


@app.get("/extensions/routes")
def extension_routes_list(user: dict = Depends(require_session)):
    """Inbound DID → WebRTC-extension routes."""
    try:
        return sorted(_read_webrtc_did_routes().values(), key=lambda r: r["did"])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Route read failed: {exc}")


@app.post("/extensions/routes")
def extension_routes_create(body: dict, user: dict = Depends(require_session)):
    """Bind an inbound DID to a WebRTC extension (route a number to a phone)."""
    did = str(body.get("did") or "").strip()
    ext = str(body.get("extension") or "").strip()
    if not re.fullmatch(r"\d{3,15}", did):
        raise HTTPException(status_code=422, detail="did must be 3-15 digits")
    if not re.fullmatch(r"\d{3,5}", ext):
        raise HTTPException(status_code=422, detail="extension must be 3-5 digits")
    if ext not in _known_webrtc_extensions():
        raise HTTPException(status_code=409, detail=f"Unknown extension {ext}")
    routes = {d: e["extension"] for d, e in _read_webrtc_did_routes().items()
              if d != did}
    routes[did] = ext
    _write_webrtc_did_routes(routes)
    return {"status": "routed", "did": did, "extension": ext}


@app.delete("/extensions/routes/{did}")
def extension_routes_delete(did: str, user: dict = Depends(require_session)):
    """Remove an inbound DID → extension route."""
    if not re.fullmatch(r"\d{3,15}", did):
        raise HTTPException(status_code=422, detail="did must be 3-15 digits")
    current = _read_webrtc_did_routes()
    routes = {d: e["extension"] for d, e in current.items() if d != did}
    if len(routes) + 1 != len(current):
        raise HTTPException(status_code=404, detail=f"Route for DID {did} not found")
    _write_webrtc_did_routes(routes)
    return {"status": "unrouted", "did": did}


# --------------------------------------------------------------------------
# Dograh voice agents (choose / add / edit / delete, wired into FreePBX)
# --------------------------------------------------------------------------
# An *agent* is a dograh telephony phone number (extension ↔ workflow) that
# is also provisioned on FreePBX as a custom extension + inbound route, so
# calls to its number are answered by the dograh AI pipeline. The FreePBX
# wiring lives in app/agents.py as pure SQL/conf builders mirroring
# scripts/sync_dograh_routes.py; this section executes them against the live
# PBX (docker exec) in standalone mode, and reports "pending-sync" instead
# in addon mode (Zeus shared PBX — the shared box applies the
# *_custom.conf moniker itself).


@app.get("/agents")
def agents_list(user: dict = Depends(require_session)):
    """Dograh agents + their FreePBX provisioning status."""
    mode = agents.deploy_mode()
    client = agents.DograhClient()
    if not client.configured():
        return {"mode": mode, "configured": False, "agents": [],
                "error": "DOGRAH_API_TOKEN not configured — run scripts/dograh_wire.py once, then set DOGRAH_API_TOKEN in .env"}
    try:
        rows = client.list_agents()
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    for a in rows:
        a["pbx"] = _agent_pbx_status(mode, a.get("extension") or "")
    return {"mode": mode, "configured": True, "agents": rows}


@app.get("/agents/workflows")
def agents_workflows(user: dict = Depends(require_session)):
    """Workflows available to bind an agent to (dograh /api/v1/workflow/fetch)."""
    return workflows_list(user)


# --------------------------------------------------------------------------
# Dograh workflows — list / create / edit from the Control Center. Creating
# or editing here writes the same definition the dograh UI canvas would
# (POST /workflow/create/definition, PUT /workflow/{id} + publish), so the
# Workflows page and the inline agent editor are a drop-in for dograh itself.


def _workflow_client() -> agents.DograhClient:
    client = agents.DograhClient()
    if not client.configured():
        raise HTTPException(
            status_code=503,
            detail="DOGRAH_API_TOKEN not configured — run scripts/dograh_wire.py once",
        )
    return client


@app.get("/workflows")
def workflows_list(user: dict = Depends(require_session)):
    """All dograh workflows (id / name / status)."""
    client = _workflow_client()
    try:
        return client.list_workflows()
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/workflows/{workflow_id}")
def workflows_get(workflow_id: int, user: dict = Depends(require_session)):
    """A workflow definition plus its editable prompt nodes."""
    client = _workflow_client()
    try:
        workflow = client.get_workflow(workflow_id)
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        **workflow,
        "nodes": workflows.editable_nodes(workflow.get("definition")),
    }


@app.post("/workflows")
def workflows_create(body: dict, user: dict = Depends(require_session)):
    """Create a workflow in dograh (mode: ai | guided | blank) and return it."""
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    client = _workflow_client()
    try:
        definition = workflows.generate_definition(name, body.get("mode", "guided"), body)
        workflow = client.create_workflow(name=name, definition=definition)
    except workflows.WorkflowError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        **workflow,
        "nodes": workflows.editable_nodes(workflow.get("definition")),
    }


@app.put("/workflows/{workflow_id}/status")
def workflows_set_status(workflow_id: int, body: dict, user: dict = Depends(require_session)):
    """Archive (or restore) a workflow — dograh's own delete action.

    Refuses to archive a workflow still bound to an agent unless ``force`` is
    set, so a stray click can't silently leave a number with no inbound
    workflow. (This is a safety net on top of dograh, which allows it.)
    """
    status = str(body.get("status") or "").strip().lower()
    if status not in {"active", "archived"}:
        raise HTTPException(status_code=422, detail="status must be 'active' or 'archived'")
    client = _workflow_client()
    if status == "archived" and not body.get("force"):
        try:
            bound = [a for a in client.list_agents() if a.get("workflowId") == int(workflow_id)]
        except agents.DograhError:
            bound = []  # can't resolve the phone-number list — let dograh decide
        if bound:
            names = ", ".join(f"{a.get('label')} ({a.get('extension')})" for a in bound)
            raise HTTPException(
                status_code=409,
                detail=f"Workflow is bound to {len(bound)} agent(s): {names}. Archive anyway with force.",
            )
    try:
        workflow = client.set_workflow_status(workflow_id, status)
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        **workflow,
        "nodes": workflows.editable_nodes(workflow.get("definition")),
    }


@app.put("/workflows/{workflow_id}")
def workflows_update(workflow_id: int, body: dict, user: dict = Depends(require_session)):
    """Edit a workflow's name and/or prompt nodes, then publish the draft so
    inbound calls to any agent bound to it pick the change up immediately."""
    client = _workflow_client()
    name = str(body.get("name") or "").strip() or None
    try:
        current = client.get_workflow(workflow_id)
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    definition = workflows.apply_node_edits(current.get("definition"), body.get("nodes"))
    try:
        updated = client.update_workflow(workflow_id, definition=definition, name=name)
        client.publish_workflow(workflow_id)
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        **updated,
        "nodes": workflows.editable_nodes(definition),
    }


@app.post("/agents")
def agents_create(body: dict, user: dict = Depends(require_session)):
    """Create a dograh agent + provision it on FreePBX (standalone)."""
    mode = agents.deploy_mode()
    address = str(body.get("address") or "").strip()
    label = str(body.get("label") or "").strip()[:64]
    workflow_id = body.get("workflowId")
    ext = agents.extension_from_address(address)
    if not ext:
        raise HTTPException(status_code=422, detail="address must be a phone number (extension/DID)")
    if not label:
        raise HTTPException(status_code=422, detail="label is required")
    client = agents.DograhClient()
    if not client.configured():
        raise HTTPException(status_code=503,
                            detail="DOGRAH_API_TOKEN not configured — run scripts/dograh_wire.py once")
    try:
        agent = client.create_agent(address=address, label=label, workflow_id=workflow_id)
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    warnings = []
    if mode == "standalone":
        try:
            _provision_agent_pbx(agent, client)
        except HTTPException as exc:
            warnings.append(exc.detail)
    return {"agent": agent, "mode": mode, "warnings": warnings}


@app.put("/agents/{phone_id}")
def agents_update(phone_id: int, body: dict, user: dict = Depends(require_session)):
    """Edit a dograh agent (label / workflow binding / active) and refresh its
    FreePBX rows so the GUI title stays accurate (standalone)."""
    mode = agents.deploy_mode()
    client = agents.DograhClient()
    if not client.configured():
        raise HTTPException(status_code=503,
                            detail="DOGRAH_API_TOKEN not configured — run scripts/dograh_wire.py once")
    label = str(body.get("label") or "").strip()[:64]
    workflow_id = body.get("workflowId")
    is_active = body.get("active")
    if is_active is not None:
        is_active = bool(is_active)
    try:
        agent = client.update_agent(
            int(phone_id),
            label=label or None,
            workflow_id=workflow_id,
            is_active=is_active,
        )
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    warnings = []
    if mode == "standalone":
        try:
            _provision_agent_pbx(agent, client)
        except HTTPException as exc:
            warnings.append(exc.detail)
    return {"agent": agent, "mode": mode, "warnings": warnings}


@app.delete("/agents/{phone_id}")
def agents_delete(phone_id: int, user: dict = Depends(require_session)):
    """Delete a dograh agent and remove its FreePBX rows (standalone)."""
    mode = agents.deploy_mode()
    client = agents.DograhClient()
    if not client.configured():
        raise HTTPException(status_code=503,
                            detail="DOGRAH_API_TOKEN not configured — run scripts/dograh_wire.py once")
    # Resolve the extension before deleting so we can un-wire the PBX side.
    try:
        rows = client.list_agents()
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    ext = next((a.get("extension") for a in rows if a.get("id") == int(phone_id)), None)
    try:
        client.delete_agent(int(phone_id))
    except agents.DograhError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    warnings = []
    if mode == "standalone" and ext:
        try:
            _unprovision_agent_pbx(ext, client)
        except HTTPException as exc:
            warnings.append(exc.detail)
    return {"status": "deleted", "id": int(phone_id), "mode": mode, "warnings": warnings}


# ── FreePBX side of an agent (standalone mode; mirrors sync_dograh_routes) ──


def _pbx_mysql(sql: str) -> str:
    """Run SQL inside the freepbx container (asterisk DB), return stdout."""
    b64 = base64.b64encode(sql.encode()).decode()
    code, text = _pbx_exec(["sh", "-c", f"echo {b64} | base64 -d | mysql -N -B -u root asterisk"])
    if code != 0:
        raise HTTPException(status_code=502, detail=f"PBX SQL failed: {text}")
    return text


def _pbx_kvstore_table() -> str:
    rows = _pbx_mysql(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='asterisk' AND table_name LIKE 'kvstore\\_%ustomappsreg%' LIMIT 1"
    )
    if not rows:
        raise HTTPException(status_code=502,
                            detail="customappsreg kvstore table not found on the PBX")
    return rows.splitlines()[0]


def _pbx_find_dest_id(table: str, target: str) -> str | None:
    rows = _pbx_mysql(agents.find_custom_dest_sql(table, target))
    return rows.splitlines()[0] if rows else None


def _pbx_ensure_custom_dest(table: str, target: str, description: str) -> None:
    existing = _pbx_find_dest_id(table, target)
    if existing:
        _pbx_mysql(agents.refresh_custom_dest_description_sql(table, existing, description))
        return
    rows = _pbx_mysql(
        f"SELECT COALESCE(MAX(CAST(`key` AS UNSIGNED)),0)+1 FROM `{table}` "
        "WHERE `id`='dests'"
    )
    next_id = (rows.splitlines()[0] if rows else "1") or "1"
    _pbx_mysql(agents.insert_custom_dest_sql(
        table, int(next_id), agents.custom_dest_json(int(next_id), target, description)))
    cur = _pbx_mysql(f"SELECT `val` FROM `{table}` WHERE `key`='currentid' AND `id`='noid'").strip()
    if not cur or int(cur) <= int(next_id):
        _pbx_mysql(agents.bump_dest_currentid_sql(table, int(next_id) + 1))


def _pbx_ensure_inbound_route(did: str, description: str, target: str) -> None:
    rows = _pbx_mysql(agents.count_inbound_route_sql(did))
    if rows.splitlines() and int(rows.splitlines()[0]) > 0:
        _pbx_mysql(agents.refresh_inbound_route_description_sql(did, description))
        return
    _pbx_mysql(agents.insert_inbound_route_sql(did, description, target))


def _pbx_sync_dynamic_dialplan(client: agents.DograhClient) -> None:
    """Regenerate extensions_custom_dograh.conf from the CURRENT dograh list,
    and wire/drop the #include in extensions_custom.conf (standalone only)."""
    try:
        numbers = [a.get("address") for a in client.list_agents() if a.get("address")]
    except agents.DograhError:
        numbers = []
    try:
        app = client.discovered_stasis_app_name()
    except agents.DograhError:
        app = agents.stasis_app_name()
    body = agents.dialplan_body(numbers, app)
    conf = "/etc/asterisk/extensions_custom.conf"
    if body:
        _pbx_write_conf(agents.DIALPLAN_PATH, body)
        inc = _pbx_read_conf(conf)
        if f"#include {agents.DIALPLAN_CONF}" not in inc:
            _pbx_write_conf(conf, inc.rstrip() + f"\n\n#include {agents.DIALPLAN_CONF}\n")
    else:
        # No dynamic numbers left — remove the include + file so FreePBX
        # never sees a dangling context (mirrors sync_dograh_routes).
        inc = _pbx_read_conf(conf)
        kept = "\n".join(
            ln for ln in inc.splitlines() if ln.strip() != f"#include {agents.DIALPLAN_CONF}"
        )
        _pbx_write_conf(conf, kept.rstrip() + "\n" if kept.strip() else "")
        _pbx_exec(["rm", "-f", agents.DIALPLAN_PATH])


def _pbx_reload_dograh() -> None:
    """Apply the dograh FreePBX rows: chown (entrypoint edits /etc/asterisk as
    root) then fwconsole reload so routes + dialplan go live."""
    code, text = _pbx_exec(["fwconsole", "chown"])
    if code != 0:
        raise HTTPException(status_code=502, detail=f"fwconsole chown failed: {text}")
    code, text = _pbx_exec(["fwconsole", "reload"])
    if code != 0:
        raise HTTPException(status_code=502, detail=f"fwconsole reload failed: {text}")


def _provision_agent_pbx(agent: dict, client: agents.DograhClient) -> None:
    """Provision (or refresh) one agent's FreePBX rows and reload."""
    ext = agent.get("extension") or agents.extension_from_address(agent.get("address") or "")
    if not ext:
        return
    label = agent.get("label") or f"Agent {ext}"
    workflow_name = agent.get("workflowName") or label
    desc = agents.agent_description(label, workflow_name)
    target = f"dograh-inbound,{ext},1"
    table = _pbx_kvstore_table()
    _pbx_mysql(agents.upsert_custom_extension_sql(ext, label, workflow_name))
    _pbx_ensure_custom_dest(table, target, desc)
    _pbx_ensure_inbound_route(ext, desc, target)
    _pbx_sync_dynamic_dialplan(client)
    _pbx_reload_dograh()


def _unprovision_agent_pbx(ext: str, client: agents.DograhClient) -> None:
    """Remove one agent's FreePBX rows (dograh-created entries only) and reload."""
    table = _pbx_kvstore_table()
    target = f"dograh-inbound,{ext},1"
    _pbx_mysql(agents.delete_custom_extension_sql(ext))
    _pbx_mysql(agents.delete_inbound_route_sql(ext))
    dest_id = _pbx_find_dest_id(table, target)
    if dest_id:
        _pbx_mysql(agents.delete_custom_dest_sql(table, dest_id))
    _pbx_sync_dynamic_dialplan(client)
    _pbx_reload_dograh()


def _agent_pbx_status(mode: str, ext: str) -> dict:
    """Provisioning status of one agent's FreePBX rows (for the list view)."""
    if mode != "standalone":
        return {
            "status": "pending-sync",
            "customExtension": None, "inboundRoute": None, "dialplan": None,
            "detail": "Add-on mode: the shared box's reconcile applies the *_custom.conf moniker (extensions_custom_dograh.conf).",
        }
    try:
        ext_rows = _pbx_mysql(agents.count_custom_extension_sql(ext))
        route_rows = _pbx_mysql(agents.count_inbound_route_sql(ext))
        has_ext = bool(ext_rows.splitlines() and int(ext_rows.splitlines()[0]) > 0)
        has_route = bool(route_rows.splitlines() and int(route_rows.splitlines()[0]) > 0)
        code, text = _pbx_exec(["asterisk", "-rx", "dialplan show dograh-inbound"])
        has_dp = code == 0 and ext in text
        status = "provisioned" if (has_ext and has_route and has_dp) else "partial"
        if not (has_ext or has_route or has_dp):
            status = "not-provisioned"
        return {"status": status, "customExtension": has_ext, "inboundRoute": has_route,
                "dialplan": has_dp}
    except HTTPException as exc:
        return {"status": "error", "customExtension": None, "inboundRoute": None,
                "dialplan": None, "detail": exc.detail}


# --------------------------------------------------------------------------
# Interview reports — read-only view over the Grist doc the n8n Interview
# Grader writes to on every mock-interview hang-up. Client lives in
# app/interviews.py (urllib only, mirrors app/agents.py conventions).


@app.get("/interviews/reports")
def interview_reports(user: dict = Depends(require_session)):
    """Graded interview reports from Grist + config state for the UI."""
    client = interviews.GristClient()
    if not client.configured():
        return {
            "configured": False,
            "docId": "",
            "reports": [],
            "error": "GRIST_DOC_ID not configured — run scripts/grist_bootstrap.py, then set GRIST_DOC_ID in .env",
        }
    try:
        rows = client.list_records("Interviews")
    except interviews.GristError as exc:
        raise HTTPException(status_code=502, detail=f"Grist: {exc}")
    return {
        "configured": True,
        "docId": client.doc,
        # Newest first (Grist record ids are monotonic) — the reports page
        # table and the overview widget both expect most-recent-first.
        "reports": interviews.rows_to_reports(rows),
    }


@app.get("/ports")
def ports(user: dict = Depends(require_session)):
    return build_ports()


@app.get("/secrets")
def secrets(user: dict = Depends(require_session)):
    return build_secrets()


@app.get("/alerts")
def alerts(user: dict = Depends(require_session)):
    return build_alerts()


def _set_alert_state(
    alert_id: str,
    status: str,
    assigned_to: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Record an alert disposition and return the alert with it applied."""
    current = next((a for a in build_alerts() if a.get("id") == alert_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
    with _ALERT_LOCK:
        entry = _ALERT_OVERRIDES.setdefault(alert_id, {})
        entry["status"] = status
        if assigned_to:
            entry["assignedTo"] = assigned_to
        if note:
            entry["note"] = note
    return next((a for a in build_alerts() if a.get("id") == alert_id), current)


def _operator(user: dict[str, Any]) -> str:
    """Who to attribute an alert action to ('' when auth is disabled)."""
    return str((user or {}).get("email") or (user or {}).get("name") or "")


@app.post("/alerts/{alert_id}/acknowledge")
def alert_acknowledge(alert_id: str, user: dict = Depends(require_session)):
    return _set_alert_state(alert_id, "acknowledged", assigned_to=_operator(user))


@app.post("/alerts/{alert_id}/resolve")
def alert_resolve(alert_id: str, user: dict = Depends(require_session)):
    return _set_alert_state(alert_id, "resolved", assigned_to=_operator(user))


@app.post("/alerts/{alert_id}/escalate")
def alert_escalate(alert_id: str, body: dict | None = None,
                   user: dict = Depends(require_session)):
    body = body or {}
    assign_to = str(body.get("assignTo") or "").strip() or _operator(user)
    reason = str(body.get("reason") or "").strip()
    return _set_alert_state(alert_id, "escalated", assigned_to=assign_to, note=reason)


@app.get("/users")
def users(user: dict = Depends(require_session)):
    return build_users()


@app.get("/links")
def links(user: dict = Depends(require_session)):
    return build_links()


@app.get("/health")
def health(user: dict = Depends(require_session)):
    matrix, _ = build_health()
    return matrix


@app.get("/incidents")
def incidents(user: dict = Depends(require_session)):
    _, inc = build_health()
    return inc


@app.get("/policies")
def policies(user: dict = Depends(require_session)):
    return DEFAULT_POLICIES


@app.get("/audit")
def audit(user: dict = Depends(require_session)):
    return build_audit()


@app.get("/stats")
def stats(user: dict = Depends(require_session)):
    return build_stats()


@app.get("/snapshot")
def snapshot(user: dict = Depends(require_session)):
    return build_snapshot()


@app.get("/metrics")
def metrics(user: dict = Depends(require_session)):
    return build_metrics(build_snapshot())


@app.get("/entitlements")
def entitlements(
    phone_number: str | None = None,
    plan: str | None = None,
    user: str | None = None,
    _auth: dict = Depends(require_session),
):
    """Magnate (RevenueOps) entitlement decision for a number/plan.

    Calls Magnate's v2.1 entitlement API ({MAGNATE_PUBLIC_URL}/api/entitlements);
    with no `plan` it reports Magnate connectivity/standalone status instead
    of a per-SKU decision. See app/entitlements.py for the failure policy
    (fail-open when Magnate is unreachable).
    """
    return check_entitlement(phone_number=phone_number, plan=plan, user=user)


@app.get("/turnconfig")
def turnconfig(request: Request, user: dict = Depends(require_session)):
    """STUN/TURN endpoints for the in-browser softphone's ICE configuration.
    Read from the stack .env (coturn creds + relay ports) so the browser can
    configure its RTCPeerConnection without hardcoding secrets in the bundle.
    """
    turn_port = _env_value("TURN_LISTENING_PORT") or "3478"
    turn_relay_start = _env_value("TURN_RELAY_PORT_START") or "49152"
    turn_relay_end = _env_value("TURN_RELAY_PORT_END") or "49251"
    username = _env_value("TURN_USERNAME")
    password = _env_value("TURN_PASSWORD")
    # Address the browser actually reached us on — the public entry point for
    # this stack (e.g. dashboard.capstone.innotel.us), where coturn's STUN/TURN
    # listeners are reachable. A LAN IP from BACKEND_API_ENDPOINT is not, and a
    # remote client that can't reach STUN never gets a server-reflexive
    # candidate, so ICE falls back to host candidates that NAT then drops.
    host = hosts.browser_host(
        request.headers.get("x-forwarded-host", ""),
        request.headers.get("host", ""),
        public_host(),
    )
    https = hosts.is_https(
        request.headers.get("x-forwarded-proto", ""), request.url.scheme
    )
    return {
        "stunServers": [{"urls": [f"stun:{host}:{turn_port}"]}],
        "turnServers": [{
            "urls": [f"turn:{host}:{turn_port}?transport=udp", f"turn:{host}:{turn_port}?transport=tcp"],
            "username": username,
            "credential": password,
        }] if username and password else [],
        "turnRelayPorts": [int(turn_relay_start), int(turn_relay_end)],
        # WSS signaling endpoint for the softphone. Only advertised for an
        # HTTPS page: this dashboard's origin serves /ws itself (nginx → the
        # PBX's PJSIP WSS listener), so the browser sees exactly the certificate
        # the outer proxy issued for this host. Falls back to the configured
        # voice.<domain> proxy host, then to "" (client-side defaults).
        "wssServer": hosts.wss_endpoint(host if https else "", NPM_BASE_DOMAIN),
    }


@app.get("/healthz")
def healthz():
    return {"status": "ok"}