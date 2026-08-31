#!/bin/sh
# Durable n8n Interview Grader import (used by the `n8n-import` one-shot service).
#
# n8n 2.x gotcha: `import`/`publish`/`update:workflow --active=true` only write the
# DB — the CLI explicitly warns "changes will not take effect if n8n is running.
# Please restart n8n." A bare one-shot that exits after import leaves the workflow
# active in the DB but WITHOUT a registered production webhook, so dograh's hang-up
# POST /webhook/interview-graded 404s.
#
# This script does the full sequence AND restarts the n8n container over the Docker
# socket before failing loudly if the webhook still isn't live:
#   import -> publish -> activate -> restart n8n -> verify POST /webhook returns 200
set -u

N8N_CONTAINER="${N8N_CONTAINER:-n8n}"
SOCK="${DOCKER_HOST_SOCK:-/var/run/docker.sock}"
# Probe host is the n8n *service* on the compose network (this one-shot runs in
# its own container, where localhost is not n8n). WEBHOOK_URL is the public/Host
# URL used by dograh and is unrelated to the in-container probe target.
# NB: build with exactly one separator — N8N_PROBE_URL usually ENDS in "/", so
# plain concatenation (or `%/`) yields a doubled/missing slash that makes the
# URL invalid and the probe fail forever.
N8N_PROBE_URL="${N8N_PROBE_URL:-http://n8n:5678/}"
PROBE_URL="${N8N_PROBE_URL%/}/webhook/interview-graded"

# n8n CLI operations; any failure aborts immediately.
echo "[n8n-import] importing workflow..."
n8n import:workflow --input=/workflows/n8n-grader-workflow.json || exit 1

echo "[n8n-import] publishing + activating..."
n8n publish:workflow --id=interview-grader-workflow || exit 1
n8n update:workflow --id=interview-grader-workflow --active=true || exit 1

# Post-activation changes don't register the production webhook until n8n restarts.
# Restart the n8n container via the Docker Engine API over the unix socket (the
# image has node but no docker CLI/curl).
echo "[n8n-import] restarting ${N8N_CONTAINER} so webhook changes take effect..."
N8N_CONTAINER="$N8N_CONTAINER" SOCK="$SOCK" node -e '
  const http = require("http");
  const sock = process.env.SOCK;
  const name = process.env.N8N_CONTAINER;
  const req = http.request({ socketPath: sock, method: "POST",
    path: `/containers/${name}/restart`, timeout: 120000 }, (res) => {
    let body = "";
    res.on("data", (c) => body += c);
    res.on("end", () => {
      if (res.statusCode >= 400) {
        console.error("restart failed:", res.statusCode, body);
        process.exit(1);
      }
      console.log("restart ok:", res.statusCode);
    });
  });
  req.on("error", (e) => { console.error("restart error:", e.message); process.exit(1); });
  req.end();
' || exit 1

# Wait for n8n to come back, then confirm the production webhook actually registers.
echo "[n8n-import] waiting for n8n + verifying webhook..."
for i in $(seq 1 90); do
  if PROBE_URL="$PROBE_URL" node -e '
    const http = require("http");
    const u = new URL(process.env.PROBE_URL);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname,
      method: "POST", headers: { "Content-Type": "application/json" }, timeout: 15000 },
      (res) => { if (res.statusCode >= 400) process.exit(1); process.exit(0); });
    // On timeout destroy the request so it errors and the loop retries (n8n is
    // mid-boot right after a restart and may accept the socket but not yet serve).
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => process.exit(1));
    req.end("\x7B\x7D");                 # {}
  ' 2>/dev/null; then
    echo "[n8n-import] OK: ${PROBE_URL} -> HTTP 200"
    exit 0
  fi
  sleep 2
done

echo "[n8n-import] ERROR: webhook still not registered after restart" >&2
exit 1