#!/usr/bin/env python3
"""Harness for the Magnate entitlement gate on the Cantus agent-number sync.

Runs the REAL `pbx/sync_agent_numbers.py` against stubbed dograh (phone
numbers), Magnate (entitlements) and switch (`POST /v1/routes`) servers, so
every gate state can be exercised without a PBX, a switch or a billing account:

    python3 scripts/test_agent_number_gate.py

This replaces `test_dograh_routes_gate.py`, which drove the FreePBX sync
(`sync_dograh_routes.py`) and died with it. The gate itself did not: agents are
still a Magnate add-on SKU, so the sync that merged their numbers into the
routing document has to ask the same question before it writes.

Scenarios (exit code and output of each run, plus the document it left behind):
  standalone    — no MAGNATE_* configured: routes allowed, no gate output
  disabled      — Magnate URL set but no plan: gate inactive
  entitled      — Magnate 200 entitled=true: routes written
  not_entitled  — Magnate 200 entitled=false: owned routes removed, human route kept
  plan_404      — Magnate 404 plan_not_found: authoritative not entitled
  unauthorized  — Magnate 401: sync aborts, writes nothing
  unreachable   — Magnate down: fail open, routes written

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
SYNC = REPO / "pbx" / "sync_agent_numbers.py"

NUMBERS = [{"address": "8000"}, {"address": "8008"}]
HUMAN_ROUTE = {"name": "reception", "when": {"to": "100@*"}, "then": [{"answer": {}}]}
STALE_ROUTE = {
    "name": "agent-number-9999",
    "when": {"to": "9999@*"},
    "then": [{"answer": {}}, {"ari": {"app": "dograh"}}],
}


class StubHandler(http.server.BaseHTTPRequestHandler):
    """Dispatcher whose behavior is set per scenario via `server.routes`."""

    def log_message(self, *args):  # silence
        pass

    def _send(self, code, obj=None):
        body = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _dispatch(self, method):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        routes = getattr(self.server, "routes", {}) or {}
        out = routes.get(method, {}).get(self.path)
        if out is None:
            self._send(404, {"error": "not found"})
            return
        self.server.requests = getattr(self.server, "requests", []) + [(method, self.path, body)]
        self._send(out[0], out[1])

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's spelling
        self._dispatch("GET")

    def do_POST(self):  # noqa: N802
        self._dispatch("POST")


def serve(routes: dict) -> tuple[http.server.HTTPServer, threading.Thread, int]:
    srv = http.server.HTTPServer(("127.0.0.1", 0), StubHandler)
    srv.routes = routes
    srv.requests = []
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv, thread, srv.server_address[1]


def dograh_routes() -> dict:
    return {"GET": {"/api/v1/telephony/phone-numbers": (200, {"phone_numbers": NUMBERS})}}


def write_document(tmp: pathlib.Path) -> pathlib.Path:
    """A document with a human route plus a route the sync owns and must decide on."""
    doc = tmp / "routes.json"
    doc.write_text(json.dumps({"routes": [HUMAN_ROUTE, STALE_ROUTE]}, indent=2) + "\n", encoding="utf-8")
    return doc


def route_names(doc: pathlib.Path) -> list[str]:
    return [route.get("name", "") for route in json.loads(doc.read_text(encoding="utf-8")).get("routes", [])]


def run_sync(
    doc: pathlib.Path,
    magnate_routes: dict | None = None,
    plan: str = "",
    user: str = "",
    apply: bool = False,
    magnate_url: str = "",
) -> tuple[subprocess.CompletedProcess, list]:
    """Run the real sync against the stub fleet; `apply` also stubs the switch."""
    servers = []
    try:
        srv, _, dograh_port = serve(dograh_routes())
        servers.append(srv)
        if magnate_routes is not None:
            srv, _, magnate_port = serve(magnate_routes)
            servers.append(srv)
            magnate_url = f"http://127.0.0.1:{magnate_port}"

        argv = [
            sys.executable, str(SYNC),
            "--dograh", f"http://127.0.0.1:{dograh_port}",
            "--token", "harness-token",
            "--file", str(doc),
        ]
        if magnate_url:
            argv += ["--magnate-url", magnate_url, "--magnate-token", "harness-token"]
        if plan:
            argv += ["--magnate-plan", plan]
        if user:
            argv += ["--magnate-user", user]
        if apply:
            srv, _, switch_port = serve({"POST": {"/v1/routes": (200, {"ok": True})}})
            servers.append(srv)
            argv += ["--switch", f"http://127.0.0.1:{switch_port}"]
        else:
            argv.append("--dry-run")

        # MAGNATE_* in the environment would override an unset flag, so the
        # scenarios that mean "standalone" must not inherit a developer's .env.
        env = {k: v for k, v in os.environ.items()
               if k not in {"MAGNATE_PUBLIC_URL", "MAGNATE_AGENT_PLAN",
                            "MAGNATE_AGENT_USER", "ENTITLEMENTS_API_TOKEN"}}
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=180, env=env, cwd=REPO)
        return proc, [r for srv in servers for r in (getattr(srv, "requests", []) or [])]
    finally:
        for srv in servers:
            srv.shutdown()
            srv.server_close()


def scenario(name: str, proc: subprocess.CompletedProcess, must_exit: int, *must_contain: str) -> bool:
    out = (proc.stdout or "") + (proc.stderr or "")
    missing = [text for text in must_contain if text not in out]
    ok = proc.returncode == must_exit and not missing
    print(f"[{'PASS' if ok else 'FAIL'}] {name} (exit={proc.returncode}, expected {must_exit})")
    if not ok:
        if missing:
            print(f"       missing from output: {missing}")
        print("       --- output ---")
        for line in out.splitlines():
            print(f"       | {line}")
    return ok


def titled(name: str, ok: bool, detail: str = "") -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))
    return ok


def main() -> int:
    results: list[bool] = []
    with tempfile.TemporaryDirectory(prefix="agent-number-gate-") as tmpdir:
        tmp = pathlib.Path(tmpdir)

        # standalone — no Magnate configured at all
        doc = write_document(tmp)
        proc, _ = run_sync(doc)
        results.append(scenario("standalone (no Magnate)", proc, 0, "sync: numbers 2", "+ 8000 -> ari dograh"))
        results.append(titled("standalone says nothing about a gate", "[magnate]" not in (proc.stdout + proc.stderr)))

        # disabled — Magnate URL present, no plan: must not gate
        doc = write_document(tmp)
        proc, _ = run_sync(doc, magnate_routes={"GET": {}}, plan="")
        results.append(scenario("disabled (URL, no plan)", proc, 0,
                                "MAGNATE_AGENT_PLAN not set — gate inactive", "sync: numbers 2"))

        # entitled — routes may be written
        doc = write_document(tmp)
        proc, _ = run_sync(doc, magnate_routes={"GET": {
            "/api/entitlements?plan=agents-pro": (
                200, {"entitled": True, "reason": "ok", "plan": "Agents Pro", "slug": "agents-pro"})}},
            plan="agents-pro")
        results.append(scenario("entitled", proc, 0,
                                "[magnate] gate entitled (ok, plan=Agents Pro)", "sync: numbers 2"))

        # entitled + apply — the routes really land in the document
        doc = write_document(tmp)
        proc, requests = run_sync(doc, magnate_routes={"GET": {
            "/api/entitlements?plan=agents-pro": (200, {"entitled": True, "reason": "ok"})}},
            plan="agents-pro", apply=True)
        names = route_names(doc)
        results.append(scenario("entitled applies the routes", proc, 0, "sync: applied to"))
        results.append(titled("entitled document holds both agent numbers",
                               "agent-number-8000" in names and "agent-number-8008" in names, str(names)))
        results.append(titled("entitled push reached the switch",
                              any(method == "POST" and path == "/v1/routes" for method, path, _ in requests),
                              str([(m, p) for m, p, _ in requests])))

        # not entitled — owned routes removed, human route untouched
        doc = write_document(tmp)
        proc, requests = run_sync(doc, magnate_routes={"GET": {
            "/api/entitlements?plan=agents-pro": (
                200, {"entitled": False, "reason": "subscription_not_active", "status": "canceled"})}},
            plan="agents-pro", apply=True)
        names = route_names(doc)
        results.append(scenario("not entitled un-wires", proc, 0,
                                "[magnate] NOT entitled (subscription_not_active, plan=agents-pro)",
                                "  - agent-number-9999"))
        results.append(titled("not entitled leaves no agent-number route",
                              not [name for name in names if name.startswith("agent-number-")], str(names)))
        results.append(titled("not entitled keeps the human route", "reception" in names, str(names)))

        # not entitled, dry run — reported as a finding, and nothing written
        doc = write_document(tmp)
        before = doc.read_text(encoding="utf-8")
        proc, _ = run_sync(doc, magnate_routes={"GET": {
            "/api/entitlements?plan=agents-pro": (
                200, {"entitled": False, "reason": "subscription_not_active"})}}, plan="agents-pro")
        results.append(scenario("not entitled dry run reports it", proc, 1,
                                "PROBLEM: DID 8000 not entitled (subscription_not_active) — would be un-wired",
                                "PROBLEM: DID 8008 not entitled (subscription_not_active) — would be un-wired"))
        results.append(titled("not entitled dry run writes nothing",
                              doc.read_text(encoding="utf-8") == before))

        # plan not found (404) — authoritative not entitled
        doc = write_document(tmp)
        proc, _ = run_sync(doc, magnate_routes={"GET": {
            "/api/entitlements?plan=agents-pro": (404, {"reason": "plan_not_found"})}}, plan="agents-pro")
        results.append(scenario("plan 404", proc, 1,
                                "[magnate] NOT entitled (plan_not_found, plan=agents-pro)",
                                "PROBLEM: DID 8000 not entitled (plan_not_found) — would be un-wired"))

        # unauthorized — abort, never un-wire on a bad token
        doc = write_document(tmp)
        before = doc.read_text(encoding="utf-8")
        proc, requests = run_sync(doc, magnate_routes={"GET": {
            "/api/entitlements?plan=agents-pro": (401, {"reason": "unauthorized"})}},
            plan="agents-pro", apply=True)
        results.append(scenario("unauthorized aborts", proc, 1,
                                "FAIL Magnate entitlements returned 401 (unauthorized)",
                                "refusing to write routes"))
        results.append(titled("unauthorized writes nothing",
                              doc.read_text(encoding="utf-8") == before
                              and not [r for r in requests if r[0] == "POST"]))

        # unreachable — fail open (routes still written)
        doc = write_document(tmp)
        srv, _, dead_port = serve({})
        srv.shutdown()
        srv.server_close()
        proc, _ = run_sync(doc, magnate_url=f"http://127.0.0.1:{dead_port}", plan="agents-pro", apply=True)
        names = route_names(doc)
        results.append(scenario("unreachable fails open", proc, 0,
                                "[magnate] gate unreachable", "sync: applied to"))
        results.append(titled("unreachable still routes the numbers",
                              "agent-number-8000" in names, str(names)))

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} scenarios passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
