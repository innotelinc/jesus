#!/usr/bin/env python3
"""Dry-run harness for sync_dograh_routes.py's Magnate entitlement gate.

Runs the REAL `scripts/sync_dograh_routes.py --check` against stubbed
dograh (phone numbers), FreePBX (OAuth token + GraphQL) and Magnate
(entitlements) HTTP servers, plus a fake `docker` binary on PATH, so every
gate state can be exercised without a PBX:

    python3 scripts/test_dograh_routes_gate.py

Scenarios (each asserts on output + exit code of the sync's --check run):
  standalone   — no MAGNATE_* configured: routes allowed, no gate output
  disabled     — Magnate URL set but no MAGNATE_AGENT_PLAN: gate inactive
  entitled     — Magnate 200 entitled=true: routes allowed
  not_entitled — Magnate 200 entitled=false: per-number "would be un-wired"
  plan_404     — Magnate 404 plan_not_found: authoritative not entitled
  unauthorized — Magnate 401: sync aborts, exit 1
  unreachable  — Magnate down: fail open, routes allowed

Exit code is the number of failed scenarios (0 = all pass).
"""

from __future__ import annotations

import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading

REPO = pathlib.Path(__file__).resolve().parent.parent
SYNC = REPO / "scripts" / "sync_dograh_routes.py"
CONFIG_NAME = "Asterisk ARI (dograh)"
NUMBERS = [
    {"address": "8000", "label": "Receptionist", "inbound_workflow_name": "Business Receptionist"},
    {"address": "8008", "label": "Scheduler", "inbound_workflow_name": "Scheduler"},
]

FAKE_DOCKER = r"""#!/usr/bin/env bash
# Fake `docker` for the harness: enough of `docker inspect / exec / ps` for
# sync_dograh_routes.py --check to run with canned SQL + dialplan answers.
case "$1" in
  inspect) exit 0 ;;
  ps)      exit 0 ;;
  exec)
    shift
    # docker exec <container> mysql -N -B -u root asterisk -e "<sql>"
    if [[ "$*" == *mysql* ]]; then
      if [[ "$*" == *"COUNT(*)"* ]]; then
        echo "1"            # custom extension exists
      fi
      exit 0                # owned-list SELECT and others -> empty
    fi
    # docker exec <container> asterisk -rx "dialplan show <context>"
    if [[ "$*" == *asterisk* ]] && [[ "$*" == *"dialplan show"* ]]; then
      printf '  exten => 8000  NoOp(dograh)\n  exten => 8008  NoOp(dograh)\n'
      exit 0
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
"""


def free_port() -> int:
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class StubHandler(http.server.BaseHTTPRequestHandler):
    """Dispatcher whose behavior is set per scenario via `server.routes`."""

    def log_message(self, *args):  # silence
        pass

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _send(self, code, obj=None):
        body = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        routes = getattr(self.server, "routes", None)
        if routes and callable(routes.get):
            out = routes.get("GET", {}).get(self.path)
            if out is not None:
                self._send(out[0], out[1])
                return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        self._body()
        routes = getattr(self.server, "routes", None)
        if routes and callable(routes.get):
            out = routes.get("POST", {}).get(self.path)
            if out is not None:
                self._send(out[0], out[1])
                return
        self._send(404, {"error": "not found"})


def serve(routes) -> tuple[threading.Thread, int]:
    srv = http.server.HTTPServer(("127.0.0.1", 0), StubHandler)
    srv.routes = routes
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return t, srv.server_address[1]


def dograh_routes(dograh_port: int, stasis: str = "dograh_harness_1") -> dict:
    """Stub dograh. `stasis` is what the config detail reports as
    credentials.stasis_app_name; an empty value means dograh can't report it
    (the detail route 404s), which is the case the sync must refuse to write
    routes on."""
    cfg = f"http://127.0.0.1:{dograh_port}"
    get = {
        "/api/v1/organizations/telephony-configs": (
            200,
            {"configurations": [{"id": "c1", "name": CONFIG_NAME}]},
        ),
        "/api/v1/organizations/telephony-configs/c1/phone-numbers": (
            200,
            {"phone_numbers": NUMBERS},
        ),
    }
    if stasis:
        get["/api/v1/organizations/telephony-configs/c1"] = (
            200,
            {"id": "c1", "name": CONFIG_NAME,
             "credentials": {"stasis_app_name": stasis}},
        )
    return {"GET": get}


def freepbx_routes(freepbx_port: int) -> dict:
    return {
        "POST": {
            "/admin/api/api/token": (200, {"access_token": "harness-token"}),
            "/admin/ajax.php?module=api&command=gql": (
                200,
                {
                    "data": {
                        "allInboundRoutes": {
                            "edges": [
                                {"node": {"id": "1", "extension": "8000", "description": "Dograh Voice Agent (Business Receptionist)"}},
                                {"node": {"id": "2", "extension": "8008", "description": "Dograh Voice Agent (Scheduler)"}},
                            ]
                        }
                    }
                },
            ),
        }
    }


def run_sync(tmp: pathlib.Path, magnate_url: str | None, plan: str,
             user: str = "", stasis: str = "dograh_harness_1") -> subprocess.CompletedProcess:
    """Run the real sync in --check mode against the stub fleet."""
    fakebin = tmp / "bin"
    fakebin.mkdir(parents=True, exist_ok=True)
    docker_bin = fakebin / "docker"
    docker_bin.write_text(FAKE_DOCKER)
    docker_bin.chmod(0o755)

    dograh_t, dograh_port = serve(dograh_routes(0, stasis))
    freepbx_t, freepbx_port = serve(freepbx_routes(0))
    magnate_t = None
    try:
        env = dict(os.environ)
        env["PATH"] = str(fakebin) + os.pathsep + env.get("PATH", "")
        argv = [
            sys.executable, str(SYNC), "--check",
            "--env-file", os.devnull,
            "--dograh-endpoint", f"http://127.0.0.1:{dograh_port}",
            "--dograh-token", "harness-token",
            "--url", f"http://127.0.0.1:{freepbx_port}",
            "--client-secret", "harness-secret",
            "--container", "pbx-freepbx",
            "--config-name", CONFIG_NAME,
        ]
        if magnate_url:
            argv += ["--magnate-url", magnate_url]
        if plan:
            argv += ["--magnate-plan", plan]
        if user:
            argv += ["--magnate-user", user]
        return subprocess.run(argv, capture_output=True, text=True, timeout=180, env=env, cwd=REPO)
    finally:
        dograh_t.join(timeout=1)
        freepbx_t.join(timeout=1)
        if magnate_t:
            magnate_t.join(timeout=1)


def scenario(name: str, proc: subprocess.CompletedProcess, must_exit: int, *must_contain: str) -> bool:
    out = (proc.stdout or "") + (proc.stderr or "")
    missing = [m for m in must_contain if m not in out]
    ok = proc.returncode == must_exit and not missing
    print(f"[{'PASS' if ok else 'FAIL'}] {name} (exit={proc.returncode}, expected {must_exit})")
    if not ok:
        if missing:
            print(f"       missing from output: {missing}")
        print("       --- output ---")
        for line in out.splitlines():
            print(f"       | {line}")
    return ok


def main() -> int:
    results: list[bool] = []
    with tempfile.TemporaryDirectory(prefix="dograh-gate-") as tmpdir:
        tmp = pathlib.Path(tmpdir)

        # standalone — no Magnate configured
        p = run_sync(tmp, None, "")
        results.append(scenario("standalone (no Magnate)", p, 0,
                                "PASS custom extension 8000 present",
                                "PASS inbound route DID 8000",
                                "PASS Stasis app name from dograh: dograh_harness_1"))

        # dograh can't report its ARI app — writing routes would leave the
        # dialplan calling an app nothing registered, so the sync must refuse
        p = run_sync(tmp, None, "", stasis="")
        results.append(scenario("dograh app unknown aborts", p, 1,
                                "PROBLEM: Stasis app name unknown"))

        # disabled — Magnate URL present, no plan (must not gate)
        magnate_t, mp = serve({"GET": {}})
        p = run_sync(tmp, f"http://127.0.0.1:{mp}", "")
        magnate_t.join(timeout=1)
        results.append(scenario("disabled (URL, no plan)", p, 0,
                                "MAGNATE_AGENT_PLAN not set — gate inactive"))

        # entitled
        magnate_t, mp = serve({"GET": {
            "/api/entitlements?plan=agents-pro": (
                200,
                {"entitled": True, "reason": "ok", "plan": "Agents Pro", "slug": "agents-pro"},
            ),
        }})
        p = run_sync(tmp, f"http://127.0.0.1:{mp}", "agents-pro")
        magnate_t.join(timeout=1)
        results.append(scenario("entitled", p, 0,
                                "[magnate] gate entitled (ok, plan=Agents Pro)",
                                "PASS custom extension 8000 present",
                                "PASS inbound route DID 8008"))

        # not entitled
        magnate_t, mp = serve({"GET": {
            "/api/entitlements?plan=agents-pro": (
                200,
                {"entitled": False, "reason": "subscription_not_active", "status": "canceled"},
            ),
        }})
        p = run_sync(tmp, f"http://127.0.0.1:{mp}", "agents-pro")
        magnate_t.join(timeout=1)
        results.append(scenario("not entitled", p, 1,
                                "[magnate] NOT entitled (subscription_not_active, plan=agents-pro)",
                                "PROBLEM: DID 8000 not entitled (subscription_not_active) — would be un-wired",
                                "PROBLEM: DID 8008 not entitled (subscription_not_active) — would be un-wired"))

        # plan not found (404) — authoritative not entitled
        magnate_t, mp = serve({"GET": {
            "/api/entitlements?plan=agents-pro": (404, {"reason": "plan_not_found"}),
        }})
        p = run_sync(tmp, f"http://127.0.0.1:{mp}", "agents-pro")
        magnate_t.join(timeout=1)
        results.append(scenario("plan 404", p, 1,
                                "[magnate] NOT entitled (plan_not_found, plan=agents-pro)",
                                "PROBLEM: DID 8000 not entitled (plan_not_found) — would be un-wired"))

        # unauthorized — abort, never un-wire on a bad token
        magnate_t, mp = serve({"GET": {
            "/api/entitlements?plan=agents-pro": (401, {"reason": "unauthorized"}),
        }})
        p = run_sync(tmp, f"http://127.0.0.1:{mp}", "agents-pro")
        magnate_t.join(timeout=1)
        results.append(scenario("unauthorized aborts", p, 1,
                                "FAIL Magnate entitlements returned 401 (unauthorized)",
                                "refusing to write routes"))

        # unreachable — fail open (routes still checked, exit 0)
        dead_port = free_port()  # nothing listens here
        p = run_sync(tmp, f"http://127.0.0.1:{dead_port}", "agents-pro")
        results.append(scenario("unreachable fails open", p, 0,
                                "[magnate] gate unreachable",
                                "PASS custom extension 8000 present"))

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} scenarios passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
