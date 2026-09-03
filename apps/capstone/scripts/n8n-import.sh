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
#
# First-boot race: n8n's /healthz answers "ok" while its initial DB migrations
# are still running, so `depends_on: service_healthy` can fire this one-shot
# mid-migration. A restart in that window can lose the webhook registration, so
# the restart + verify cycle below RETRIES — migrations finish within a couple
# of attempts and the webhook registers on the next boot.
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
# Post-activation changes don't register the production webhook until n8n restarts.
# Restart n8n via the Docker Engine API over the unix socket (the image has node
# but no docker CLI/curl), then verify the webhook is live. On a fresh boot the
# first restart can land mid-migration and lose the registration, so retry the
# whole restart + verify cycle.
attempt=1
max_attempts=5
while [ "$attempt" -le "$max_attempts" ]; do
  echo "[n8n-import] restarting ${N8N_CONTAINER} (attempt ${attempt}/${max_attempts}) so webhook changes take effect..."
  # shellcheck disable=SC2016  # ${name} is a JS template literal evaluated by node, not bash
  if ! N8N_CONTAINER="$N8N_CONTAINER" SOCK="$SOCK" node -e '
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
  '; then
    echo "[n8n-import] ERROR: restart of ${N8N_CONTAINER} failed" >&2
    exit 1
  fi

  # Wait for n8n to come back, then confirm the production webhook registers.
  # NB: right after a restart n8n answers on :5678 but returns 404 for the
  # webhook for several seconds (it registers active workflows as part of a
  # later startup phase) — that 404 is retryable, NOT terminal. Only give up
  # when the per-attempt deadline passes.
  echo "[n8n-import] waiting for n8n + verifying webhook (attempt ${attempt}/${max_attempts})..."
  if PROBE_URL="$PROBE_URL" node -e '
    const http = require("http");
    const u = new URL(process.env.PROBE_URL);
    const deadline = Date.now() + 60000;   // 60s window per attempt
    function tryOnce() {
      if (Date.now() > deadline) process.exit(1);
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname,
        method: "POST", headers: { "Content-Type": "application/json" }, timeout: 15000 },
        (res) => {
          // 2xx = webhook live. 4xx/5xx while n8n boots (webhook not yet
          // registered) is retryable — keep polling until the deadline.
          if (res.statusCode >= 200 && res.statusCode < 300) process.exit(0);
          setTimeout(tryOnce, 2000);
        });
      // On timeout destroy the request so it errors and we retry (n8n may
      // accept the socket mid-boot but not yet serve; connection-refused
      // while it is down also retries).
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => setTimeout(tryOnce, 2000));
      req.end("{}");
    }
    tryOnce();
  ' 2>/dev/null; then
    echo "[n8n-import] OK: ${PROBE_URL} -> HTTP 200"
    exit 0
  fi
  attempt=$((attempt + 1))
done

echo "[n8n-import] ERROR: webhook still not registered after ${max_attempts} restart attempts" >&2
exit 1