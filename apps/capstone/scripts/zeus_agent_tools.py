#!/usr/bin/env python3
"""zeus_agent_tools.py — dograh agent tools backed by the Zeus portal API.

The glue layer for docs/zeus-integration.md §Phase 2 "Agent-side SMS/fax/
voicemail actions via Zeus portal API": dograh's dynamic tools POST to these
endpoints, which call scripts/zeus_client.py against the Zeus portal.

What each tool does (contract = zeus repo docs/portal-api.md):

  resolve     transfer tool `destination_source: dynamic` resolver —
              resolves "who do you need" → {transfer_context:{destination,
              custom_message?}} (POST /api/agent/transfer-resolve)
  sms         send an SMS through the account's Zeus DIDs
              (POST /api/messages/send)
  fax         send a fax (POST /api/fax/send)
  voicemails  list the account's voicemails + AI summaries
              (GET /api/voicemail) — agents read them for personal-assistant
              answers

Running as a tool server (dograh points its dynamic tools at these URLs):

    python3 scripts/zeus_agent_tools.py serve --port 8025
    # then in the dograh tool config:
    #   resolver.url = https://voice.capstone.innotel.us:8025/resolve  (or LAN)
    #   sms tool     = POST http://<host>:8025/sms      {to, did_id, body}
    #   fax tool     = POST http://<host>:8025/fax      {to, did_id, ...}
    #   voicemail    = GET  http://<host>:8025/voicemails

The server is stdlib-only (http.server) and stateless: every request
re-reads ZEUS_* config from the environment/.env, so tokens rotate without a
restart. In zeus add-on mode the same host also serves the transfer resolver
the dograh tool config expects (§G3).

Environment (see .env.example §Zeus):
    ZEUS_API_URL          Zeus portal origin (default https://api.zeus.innotel.us)
    ZEUS_SESSION_TOKEN    the account's pbx_session cookie value
    ZEUS_BEARER           optional Bearer for the transfer resolver

Only stdlib — run with:  python3 scripts/zeus_agent_tools.py --help
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zeus_client  # noqa: E402  (same dir)


def _client() -> "zeus_client.ZeusClient":
    """A client built from the current env — stateless by design."""
    insecure = os.environ.get("ZEUS_INSECURE", "").lower() in ("1", "true", "yes")
    return zeus_client.ZeusClient(verify=not insecure)


# ---- tool implementations ---------------------------------------------------

def tool_resolve(payload: dict) -> dict:
    """Transfer resolver: person/query → {transfer_context:{...}}.

    Mirrors the shape dograh's `destination_source: dynamic` tool expects
    (§G3): any non-2xx from Zeus becomes a 404-style "couldn't find a valid
    destination" answer so the agent speaks the fallback line.
    """
    query = str(payload.get("query") or payload.get("name") or "").strip()
    if not query:
        return {"error": "missing 'query' (the person or destination to resolve)"}
    try:
        status, data = _client().resolve(query)
    except zeus_client.ZeusError as e:
        return {"error": f"could not resolve destination: {e}"}
    if status != 200:
        return {"error": f"could not resolve destination (HTTP {status})"}
    # Pass Zeus's response through: {transfer_context:{destination, custom_message?}}
    return data if isinstance(data, dict) else {"transfer_context": data}


def tool_send_sms(payload: dict) -> dict:
    to = str(payload.get("to") or payload.get("to_number") or "").strip()
    did = str(payload.get("did_id") or payload.get("from_did_id") or "").strip()
    body = str(payload.get("body") or payload.get("message") or "").strip()
    if not (to and did and body):
        return {"error": "sms needs 'to', 'did_id' and 'body'"}
    try:
        status, data = _client().send_sms(to, did, body)
    except zeus_client.ZeusError as e:
        return {"error": f"SMS send failed: {e}"}
    return {"sent": status in (200, 201, 202), "response": data}


def tool_send_fax(payload: dict) -> dict:
    to = str(payload.get("to") or payload.get("to_number") or "").strip()
    did = str(payload.get("did_id") or payload.get("from_did_id") or "").strip()
    if not (to and did):
        return {"error": "fax needs 'to' and 'did_id'"}
    kwargs = {
        "subject": payload.get("subject"),
        "body": payload.get("body"),
        "files": payload.get("files"),
    }
    try:
        status, data = _client().send_fax(to, did, **kwargs)
    except zeus_client.ZeusError as e:
        return {"error": f"fax send failed: {e}"}
    return {"sent": status in (200, 201, 202), "response": data}


def tool_voicemails(payload: dict) -> dict:
    """List voicemails; with summarize=True attach each AI summary."""
    try:
        limit = int(payload.get("limit") or 20)
    except (TypeError, ValueError):
        limit = 20
    try:
        status, data = _client().voicemails(limit=limit)
    except zeus_client.ZeusError as e:
        return {"error": f"voicemail list failed: {e}"}
    items = data if isinstance(data, list) else (data or {}).get("voicemails", [])
    if payload.get("summarize"):
        client = _client()
        for item in items:
            vid = item.get("id") if isinstance(item, dict) else None
            if not vid:
                continue
            try:
                _, summary = client.voicemail_summary(vid)
                item["summary"] = summary
            except zeus_client.ZeusError:
                item["summary"] = None  # summary is best-effort
    return {"voicemails": items}


TOOLS = {
    "resolve": tool_resolve,
    "sms": tool_send_sms,
    "fax": tool_send_fax,
    "voicemails": tool_voicemails,
}


# ---- HTTP surface for dograh dynamic tools ----------------------------------

class ToolHandler(BaseHTTPRequestHandler):
    server_version = "zeus-agent-tools/1.0"

    def _reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _payload(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            parsed = json.loads(self.rfile.read(length).decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {"_raw": parsed}
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        name = self.path.strip("/").split("?")[0]
        if name in ("health", "healthz"):
            self._reply(200, {"ok": True, "tools": sorted(TOOLS)})
            return
        if name == "voicemails":
            self._reply(200, tool_voicemails(self._payload()))
            return
        self._reply(404, {"error": f"unknown tool '{name}'"})

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        name = self.path.strip("/").split("?")[0]
        tool = TOOLS.get(name)
        if tool is None:
            self._reply(404, {"error": f"unknown tool '{name}'"})
            return
        result = tool(self._payload())
        status = 400 if isinstance(result, dict) and result.get("error") else 200
        self._reply(status, result)

    def log_message(self, fmt: str, *args) -> None:  # keep stderr quiet-ish
        if os.environ.get("ZEUS_TOOLS_DEBUG"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def serve(port: int, bind: str) -> int:
    httpd = ThreadingHTTPServer((bind, port), ToolHandler)
    print(f"zeus agent tools listening on http://{bind}:{port} — tools: {', '.join(sorted(TOOLS))}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd")

    for name, tool in TOOLS.items():
        p = sub.add_parser(name, help=f"call the {name} tool once (JSON on stdin or --json)")
        p.add_argument("--json", help="tool arguments as a JSON string (else stdin)")

    p = sub.add_parser("serve", help="run the tool HTTP server for dograh dynamic tools")
    p.add_argument("--port", type=int, default=int(os.environ.get("ZEUS_TOOLS_PORT", "8025")))
    p.add_argument("--bind", default=os.environ.get("ZEUS_TOOLS_BIND", "0.0.0.0"))

    args = ap.parse_args(argv)
    if args.cmd == "serve":
        return serve(args.port, args.bind)
    if args.cmd in TOOLS:
        raw = args.json if getattr(args, "json", None) else sys.stdin.read()
        try:
            payload = json.loads(raw) if (raw or "").strip() else {}
        except ValueError as e:
            print(f"invalid JSON: {e}", file=sys.stderr)
            return 2
        result = TOOLS[args.cmd](payload)
        print(json.dumps(result, indent=2))
        return 1 if isinstance(result, dict) and result.get("error") else 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
