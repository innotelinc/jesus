# Project Capstone — Your Voice AI Phone Assistant

**v3.6** · Self-hosted, open-source AI Voice Agent that answers and makes phone calls for you, with local speech services, observability, Coturn traversal, and offline-capable installation.

Project Capstone is a completely self-hosted, open-source **Voice AI Agent** that acts as your personal phone assistant. It can answer incoming calls like a business receptionist, and it can make outbound calls on your behalf, such as a telemarketer or an outreach agent — all over Asterisk/FreePBX with local speech (STT + TTS) and an LLM driving the conversation.

**Non-negotiables:** 100% open-source · runs locally in Docker · no paid SaaS (no OpenAI, Cartesia, Vapi, Make.com) · OpenTelemetry observability throughout.

## v3.7 release

Release `v3.7` fixes a regression of the FreePBX Apply Config "Unknown Error"
that had crept back into the PBX boot.

Highlights of v3.7:

- **FreePBX "Unknown Error. Please Run: fwconsole reload --verbose." fixed
  again**: the v3.0 fix ran `fwconsole chown` before reloads, but
  `fix_include_hygiene` and `fix_modules_conf` in `pbx/entrypoint-dograh.sh`
  run *after* that chown and rewrite files as root (`sed -i` temp+rename,
  `touch`), so `modules.conf` and the iax/rtp custom files were root-owned
  again when the GUI's Apply Config regenerated them — which FreePBX reports
  as "Unknown Error. Please Run: fwconsole reload --verbose." Both functions
  now chown their files back to `asterisk:asterisk` right after editing, and
  a final `fwconsole chown` safety net runs after ALL boot writes (post-pjsip/
  voipms) so the hand-off to the stock entrypoint always leaves correct
  ownership. Verified end-to-end: fresh boot leaves zero root-owned files
  under `/etc/asterisk`, and `fwconsole reload` run as the asterisk user (the
  exact Apply Config path) completes with "Reload Complete" and no errors.

## v3.6 release

Release `v3.6` re-cuts the platform through the GitHub release workflow and
fixes two release-gating bugs so the offline artifact actually deploys.

Highlights of v3.6:

- **Docker image bundle is loadable (stream no longer corrupted)**: the
  workflow streamed `docker save | gzip | split` to build
  `docker-images-v2-partNN.tar.gz`, but every `echo` diagnostic and `docker
  pull`/`build` progress line wrote to stdout too, landing mixed into the
gzip stream (the bundle started with `"pg17: Pulling from pgvector…"` instead
  of gzip magic). All diagnostics now go to `>&2`, so `cat *.tar.gz | gzip -t`
  passes and `docker load` reconstructs the images. Verified locally before
  re-running the workflow.
- **Full release via GitHub CI**: the sync-and-release workflow rebuilt the
  source bundle, deployment payload, docker image bundle, and live ISO at
  `v3.6`, with the sync-timer and Apache-recovery systemd units installed
  and running on the box.

## v3.5 release

Release `v3.5` re-cuts the platform through the GitHub release workflow.

Highlights of v3.5 (carries everything below):

- **dograh UI login works from any device**: the backend advertised
  `http://172.17.0.1:8000` (the server's unreachable internal Docker gateway)
as its `backend_api_endpoint`, so browsers were re-pointed to a private
  address and login died at the network layer. `PUBLIC_BASE_URL` /
  `BACKEND_API_ENDPOINT` now advertise the public domain
  (`https://capstone.innotel.us`), and `.env.example` warns installers not to
  use the Docker gateway.
- **All agents 8000–8007 mapped into FreePBX**: only 8000–8002 were registered
  in dograh, so 8003–8007 (receptionist, outreach, interview, survey, GOTV)
  never got FreePBX custom extensions or inbound routes. Ran
  `dograh_wire.py` + `sync_dograh_routes.py` so all 8 numbers appear.
- **FreePBX descriptions cleaned up**: em-dashes were mangled to `?` by the
  ASCII sanitizer; the sync now transliterates them and uses each agent's
  workflow name as the purpose shown in custom extensions / destinations,
  refreshing them on change.

## v3.4 release

Release `v3.4` tags the current `main` with the login + description fixes.

Highlights of v3.4:

- Login fix (public-IP backend endpoint) and FreePBX description cleanup, as
  described under v3.5.

## v3.3 release

Release `v3.3` is a workflow-generated full release cut from upstream
`1.45.0`, building and attaching the source bundle, deployment payload,
docker image bundle, and live ISO.

## v3.2 release

Release `v3.2` re-cuts the platform through the GitHub release workflow (force
run) and ships the tooling for a **persistent live USB** with a data drive.

Highlights of v3.2:

- **Persistent live USB + a data drive**: `scripts/make-persistent-usb.sh` now
lists the available drives and lets you pick the target and what to do with it
(persistent live USB + `CAPSTONE_DATA` drive, plain live USB, or wipe & format
a data drive). A `persistence` overlay partition makes the live session save
packages/config/home across reboots; the remaining ~50 GB of a 64 GB stick
becomes a normal ext4 data drive. The ISO is built with `persistence` on the
kernel cmdline so these USBs boot persistent out of the box.
- **Full release via GitHub CI**: dograh fork synced to upstream `1.45.0` and
Innotel customizations reapplied; deployment payload, source bundle, docker
image bundle, and live ISO all built and uploaded by the workflow.

## v3.1 release

Release `v3.1` re-cuts the platform through the GitHub release workflow (force
run) and fixes live-USB networking so the wired card comes up on DHCP.

Highlights of v3.1 (carries the v3.0 fixes below):

- **Live USB gets DHCP instead of link-local**: the live ISO's netplan used
`renderer: NetworkManager`, which isn't reliably generated at live boot (it
needs netplan's NM dispatcher), so the wired NIC could come up with only a
link-local `169.254` address. Switched to `renderer: networkd` so netplan's
systemd generator writes the DHCP rule for `systemd-networkd` (already enabled
in the image) on any `en*`/`eth*` port.
- **Full release via GitHub CI**: dograh fork synced to upstream `1.45.0` and
Innotel customizations reapplied; deployment payload, source bundle, docker
image bundle, and live ISO all built and uploaded by the workflow.

## v3.0 release

Release `v3.0` cuts a major-version release and fixes two production-grade bugs
in the interview pipeline and the PBX.

Highlights of v3.0:

- **n8n grading-webhook no longer 404s**: n8n 2.x `import:workflow` /
`publish:workflow` / `update:workflow --active=true` only write the DB — the
CLI explicitly warns the running instance won't pick them up — so dograh's
hang-up `POST /webhook/interview-graded` returned 404. The `n8n-import`
one-shot now imports, publishes, activates, **restarts n8n** over the Docker
socket, and probes the webhook until it answers 200 before succeeding.
- **FreePBX "Unknown Error. Please Run: fwconsole reload --verbose." fixed**: root-owned
config rewrites under `/etc/asterisk` left files the reload user couldn't
rewrite, so Apply Config failed. `fwconsole chown` now runs before both reload
paths (PBX boot in `pbx/entrypoint-dograh.sh` and route wiring in
`pbx/bootstrap_dograh_route.py`), and ownership is restored on the pjsip files
the media-address fix touches.
- **pjsip local media address**: the transport's `local_net` is set to the LAN
subnet (in the durable `pjsip.transports_custom.conf`, so Apply Config can't
wipe it) and LAN-only endpoints get a forced `media_address`, so softphones
aren't told to send RTP to a public/docker-bridge IP (which caused one-way
audio).

## v2.6 release

Release `v2.6` rebuilds and re-cuts the platform end-to-end through the GitHub
release workflow, and pins OmniRoute as the prebuilt upstream image.

Highlights of v2.6:

- **Full release rebuilt via GitHub CI**: `sync-and-release.yml` was re-run with
the `force` input, producing a complete v2.6 — deployment payload, source
bundle, docker image bundle (`docker-images-v2-part00–03.tar.gz`), and the
live ISO, with each heavy artifact built and uploaded on its own runner.
- **OmniRoute ships as the prebuilt image** (`diegosouzapw/omniroute:latest`, overridable via `OMNIROUTE_IMAGE`); no vendored source is kept in this repo.
- **`compression_run_telemetry` cleanup fix**: OmniRoute creates that table
*lazily* on first compression telemetry write, so a deployment that never
records one throws `SqliteError: no such table: compression_run_telemetry` in
the 6-hourly cleanup sweep. Create the table once in the compose volume the
container actually mounts — `omniroute_data` in `docker-compose.yml` maps to
`capstone_omniroute_data` on disk — and the error goes away. Do not create it
in the unprefixed `omniroute_data` volume: that is a stale leftover from an
earlier compose project name and the running container never reads it.

## v2.3 release

Release `v2.3` hardens the **PBX boot** against base64 secrets breaking the freepbx container's entrypoint, which crash-looped the stack on fresh installs.

Highlights of v2.3:

- **Freepbx crash-loop fixed**: the stock Innotel `entrypoint.sh` writes `FREEPBX_AMI_SECRET` (base64, so it can contain `/`) into `manager_custom.conf` with an unguarded `s/ / /`-delimited `sed`. When the secret contains `/`, the sed fails with `unknown option to 's'` and, under `set -e`, kills the entrypoint right after `service mariadb start` — so MariaDB was the only service that ever started and the container restarted in a loop. `pbx/entrypoint-dograh.sh` now patches the stock script's sed to a `|` delimiter on every boot (idempotently), the same fix already used for `DOGRAH_ARI_PASSWORD`.
- **Hardened remaining value-injecting seds**: the same `s///` delimiter hazard in the stock entrypoint's `AFDB_PASS` and `ADMIN_EMAIL` lines was also switched to `|`, so any base64/hex/email value (none of which contain `|`) is safe.
- **Verified end-to-end**: the freepbx service boots healthy with zero restarts, Asterisk 22 + the ARI user + `[dograh-inbound]` dialplan come up, and the full smoke test reports all checks passing.

## v2.2 release

Release `v2.2` fixes the **installed-system bootstrap** so the live/install ISO actually leaves a working, running platform instead of a wiped `/opt/capstone`.

Highlights of v2.2:

- **Installer root-path fix**: on the installed disk the installer runs flat at `/opt/capstone/install-capstone.sh`, but `ROOT` was computed with a repo-only `dirname $0/..` that resolved to `/opt`. That made the in-chroot install treat `ASSET_DIR != TARGET` and run `rsync -a --delete /opt/ /opt/capstone/`, recursively creating a stray `/opt/capstone/capstone` and deleting the real payload (no compose files, no scripts, no systemd unit — so nothing ever started). `ROOT` is now derived by probing for the payload markers (`docker-compose.yml`, `capstone-v2-deployment.tar.gz`, `scripts/install-capstone.sh`) in the script's own dir or its parent, so all three layouts (repo in-place, deployed flat, live-ISO session) resolve correctly and the destructive rsync is skipped.

Release `v2.1` hardens **first-boot reliability** on the live/install ISO and on fresh systems, and folds the PBX/Asterisk stack into a single compose file so the whole platform starts with one command.

Highlights of v2.1:

- **Single compose file**: `docker-compose.asterisk.yml` was merged into `docker-compose.yml` — the FreePBX/Asterisk side (and the optional PBX portal) is now a service in the main file, so `docker compose up -d` brings up the entire stack at once.
- **Live/install first boot fixed**: the installed system now boots straight into the stack with DHCP on every ethernet port, a real login user (`capstone` / `capstone`, overridable via `CAPSTONE_USER`/`CAPSTONE_PASSWORD`), and the Capstone systemd service enabled from inside the installer chroot (`systemctl --root`).
- **FreePBX container boot cleaned up**: PHP `memory_limit` raised to 512M; `odbc.ini` pointed at the MariaDB driver + socket so CDR/CEL connect; the `#include iax_fax_custom.conf` moved to `iax_custom_post.conf` and the `rtp_custom.conf` include deduplicated (editing the symlinked core-module templates in place so the fix survives `fwconsole reload`); `rtp_custom.conf` canonicalized to `[general] stunaddr = stun.l.google.com:19302 / icesupport = yes / rtpstart=10101 / rtpend=10120`.
- **Quieter Asterisk boot**: `chan_local.so` preload (absent from the image), HEP, and the SQLite CDR/CEL custom backends are `noload`'d so a clean boot logs no loader errors; the `minimum_size` stasis option and the stray `cel_sqlite3_custom.conf` values line are corrected.

Release `v2.0` synced the **Innotel fork** of Dograh (`innotelinc/dograh`) to the latest `dograh-hq/dograh` main and re-published the platform on the refreshed codebase.

Highlights of v2.0:

- **Dograh fork resynced to upstream**: `innotelinc/dograh` was rebased onto the current `dograh-hq/dograh` main (Tuner simulation, telephony-provider updates, `LANGFUSE_TRACES_PUBLIC`, and everything upstream shipped since the fork's last sync). All Innotel customizations were reapplied on top — the self-hosted interview stack (SigNoz/OTel, Kokoro, Speaches, n8n grading), the Asterisk/FreePBX ARI wiring, NPM-fronted hostnames, systemd autostart, and nightly DB backup — keeping each change only where upstream hadn't already fixed it.
- **Rebuilt GHCR images**: `ghcr.io/innotelinc/dograh-api` and `ghcr.io/innotelinc/dograh-ui` rebuilt from the synced fork source and re-published.
- **Dograh web UI (`dograh-ui`)**: the Next.js frontend runs on host port `3010`; the API on its native port `8000`. The UI talks to the API via `host.docker.internal:8000`; the browser reaches it at `http://<host-LAN-IP>:8000`.
- **Innotel fork images**: compose defaults to `ghcr.io/innotelinc/dograh-api` and `ghcr.io/innotelinc/dograh-ui`. If those can't be pulled, `docker-compose.dograh-build.yml` builds **both** api and ui from the innotelinc/dograh fork source.
- **Hardened env handling**: setup.sh and smoke-test.sh load `.env` explicitly so a stray exported shell variable can no longer pin `PUBLIC_BASE_URL`/`BACKEND_API_ENDPOINT` to a stale value.

Download the verified artifacts from the [GitHub v2.2 release](https://github.com/innotelinc/capstone/releases/tag/v2.2).

The recommended installation from a cloned source tree is:

```bash
git clone https://github.com/innotelinc/capstone.git
cd capstone
./scripts/setup.sh
```

The setup is idempotent and automatically:

- generates and preserves local secrets in `.env`
- clones the Dograh platform source ([innotelinc/dograh](https://github.com/innotelinc/dograh)) into `dograh/upstream` for reference and optional build-from-source
- creates the shared Docker network and PBX volumes
- starts Dograh, FreePBX/Asterisk, n8n, Grist, OmniRoute, Kokoro, Speaches, SigNoz, and dependencies
- creates the Grist interview document
- mints and persists an OmniRoute API key
- downloads the configured Whisper model into the persistent Speaches cache
- imports the three interview **agent workflows** (IT Help Desk, DevOps, SQL — see `dograh/`)
- creates the **Asterisk ARI telephony configuration** in Dograh (shows up in the dograh UI — `http://<host>:3010` — under Telephony Configurations) and binds SIP extensions **8000 / 8001 / 8002** to their agents
- wires the FreePBX half: dialplan + inbound routes DID 8000/8001/8002 → Dograh
- configures Coturn with generated credentials, the detected public IP (or localhost fallback), TURN port `3478`, and relay ports `49152–49251`
- refreshes n8n and runs the smoke checks

For automatic startup after host reboots, install `systemd/capstone.service` as described below.

## Architecture

| Layer | Component | Role |
|---|---|---|
| Telephony | Asterisk / FreePBX 17 (via `pbx-portal`) + ARI | PBX, call routing, media |
| WebRTC traversal | Coturn | TURN relay for clients behind NAT |
| Voice Agent | Dograh (Pipecat) — [innotelinc/dograh](https://github.com/innotelinc/dograh) | Real-time voice pipeline + agent workflows |
| Dograh web UI | `dograh-ui` (Next.js, Innotel fork build) — host `3010` | Agents + Asterisk ARI telephony configuration UI |
| Orchestrator | dograh (Python/FastAPI) — `network_mode: host` | Matches Asterisk networking; binds ARI media sockets |
| Local TTS | Kokoro-82M via `kokoro-fastapi` | On-prem speech generation (port 8880) |
| Local STT | Speaches (faster-whisper) | On-prem transcription (port 8001) |
| LLM Router | OmniRoute on port 20128 | OpenAI-compatible gateway to local/free models |
| Workflow | n8n (Community Edition) | Session webhooks on call hang-up → grading |
| Dashboard | Grist (default; NocoDB opt-in) | Student names, phone numbers, transcripts, scores |
| Observability | OpenTelemetry → SigNoz (ClickHouse) | Pipeline latency (STT → LLM → TTS) tracking |
| Control Center | `dashboard` (React/nginx) + `dashboard-api` (FastAPI) | Live ops UI: services, health, ports, alerts, secrets, users, monitoring |

## Repo layout

```
├── docker-compose.yml                # ALL services (dograh, PBX/FreePBX, TTS/STT, n8n, SigNoz)
├── dashboard/                        # Control Center SPA (React + Vite, nginx, host :8096)
├── dashboard-backend/                # Control Center aggregator API (FastAPI, host :8095)
├── docker-compose.dograh.yml         # dograh-api standalone (hybrid boxes)
├── docker-compose.dograh-build.yml   # OPTIONAL: build dograh-api + dograh-ui from the innotelinc/dograh fork
├── pbx/                              # ARI configs + entrypoint wrapper + PBX runbook
├── dograh/                           # interview workflow JSON + SDK import script
│   └── upstream/                     # shallow clone of github.com/innotelinc/dograh (gitignored; setup.sh)
├── scripts/setup.sh                  # one-command bootstrap (secrets, boot, wire)
├── scripts/dograh_wire.py            # imports agents, creates ARI config, binds extensions 8000-8002
├── scripts/grist_bootstrap.py        # creates Grist doc + Interviews table
├── scripts/gen_loops.py              # generates candidate answer loops via Kokoro TTS
├── scripts/place_call.py             # places a mock-interview call via ARI
├── scripts/smoke-e2e.sh              # boots both composes + verifies ARI, dialplan, media WS
├── scripts/smoke-test.sh             # verifies a running stack (no boot)
├── scripts/build-live-usb.sh         # builds the BIOS+UEFI live/install ISO
├── scripts/build-offline-bundle.sh   # builds deployment payload + docker image bundle
├── scripts/build-source-bundle.sh    # builds the clean source release bundle
├── scripts/fetch-offline-bundle.sh   # downloads + verifies the offline bundle from GitHub
├── scripts/install-capstone.sh       # live-USB->disk or in-place installer
├── scripts/offline-images.txt        # docker images included in the offline bundle
├── .env.example                      # every compose variable + secret hints
├── n8n-grader-workflow.json          # verified n8n Interview Grader workflow (auto-imported)
├── n8n-interview-grader.md           # node-by-node spec + IT Help Desk Tier 1 rubric prompt
├── n8n.Dockerfile / n8n-otel/        # n8n + OpenTelemetry auto-instrumentation
├── otel-collector-config.yaml        # SigNoz collector → ClickHouse
├── clickhouse-config.yaml            # SigNoz ClickHouse (single-node cluster)
├── clickhouse-keeper.yaml            # ClickHouse Keeper (coordination)
├── searxng-settings.yml              # SearXNG JSON API for n8n AI assistant
├── systemd/capstone.service           # systemd unit: auto-start the stack on boot
└── signoz-pipeline-latency-dashboard.json  # importable SigNoz dashboard
```

## Quick start

```bash
./scripts/setup.sh
```

When setup finishes, the three interview agents are live and wired:

| Extension | Agent |
|---|---|
| `8000` | IT Help Desk (Tier 1) mock interview |
| `8001` | DevOps mock interview |
| `8002` | SQL mock interview |
| `8003` | Business Receptionist (answers inbound calls) |
| `8004` | Outbound Outreach (makes outbound calls) |
| `8005` | Job Interview (hiring) |
| `8006` | Phone Survey |
| `8007` | Get Out The Vote Poll |

Create your own phone agent by describing what you want — in the **browser**
via the Workflow Studio (port `8090`, the `workflow-studio` compose service:
type a description → AI generates the workflow → preview the JSON → import it
and register the next free extension in one click) or from the terminal with
`scripts/generate_dograh_workflow.py` (same two modes: free-form via the
local OmniRoute LLM, or a guided template). The mock interviews are
customizable per call via `initial_context` (interviewer name, company,
role, difficulty, focus topics).

Dial one of them from a SIP softphone registered to the PBX, call in via the
trunk (DID routes are created automatically), or place a scripted test call
after verifying with `./scripts/smoke-test.sh`:

```bash
python3 scripts/gen_loops.py
python3 scripts/place_call.py 8000 candidate-it
python3 scripts/place_call.py 8001 candidate-devops
python3 scripts/place_call.py 8002 candidate-sql
```

### Automatic startup on boot

```bash
sudo cp systemd/capstone.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now capstone.service
```

Dograh uses host networking and is started by Compose with `restart: unless-stopped`; the bootstrap also explicitly starts it after configuration refresh.

## Control Center

The stack ships with an operational dashboard — **Capstone Control Center** —
that is part of the main compose file and starts with everything else:

- **`dashboard`** — built React SPA served by nginx at `http://<host>:8096`.
- **`dashboard-api`** — FastAPI aggregator at `http://<host>:8095` that reads
  live state from the Docker socket (container health, published ports,
  versions, stats), the `.env` secret inventory (names/types only — never
  values), host users (`/etc/passwd`), and whole-host `/proc` resource usage.

The SPA talks to the aggregator same-origin through `/api`, which nginx
reverse-proxies to `dashboard-api:8095` — no CORS or host/port wiring. The
base URL can be overridden at runtime with `window.__DASHBOARD_BASE_URL__` or
at build time with `VITE_DASHBOARD_BASE_URL` (default `/api`).

The dashboard shows: Services (live Docker health + latency probes), Health &
Status, Network Ports, Alerts, Secrets inventory, Users, Monitoring (real
CPU/mem/disk/network from the host), Logs (recent Docker events), Links
(service URLs derived from `PUBLIC_BASE_URL`), and a **Softphone** — an
in-browser WebRTC phone that registers to the PBX over WSS (`/softphone`,
extension 102 by default, STUN/TURN pulled from coturn via `/api/turnconfig`).

> Note: the Softphone page connects straight to the PBX's WSS endpoint
> (`wss://<host>:8089`), not through nginx. The PBX presents the FreePBX
> integration certificate, so a browser may ask you to accept it once before
> the WebSocket connects.

## PBX / Asterisk side

FreePBX exposes Webmin on host TCP port `10000` and Asterisk RTP on UDP ports `10101–10120`; these ranges are deliberately separate to avoid the Webmin/RTP conflict. Coturn listens on TCP/UDP `3478` and relays on UDP `49152–49251`, configured by `TURN_*` variables in `.env`. Setup automatically generates the TURN username/password and uses the server’s public IPv4 for `TURN_EXTERNAL_IP` and `TURN_REALM`, falling back to `127.0.0.1` when public-IP detection is unavailable. Asterisk HTTP/ARI is exposed on `8088`, with the Dograh ARI user and inbound dialplan injected during PBX startup.

The PBX is a service in the main compose file, so one command brings up the
entire stack:

```bash
docker compose up -d
```

## VoIP.ms trunk (optional, auto-configured)

Put your VoIP.ms SIP credentials in `.env` and the freepbx container configures the trunk on boot — no FreePBX GUI steps:

```bash
VOIPMS_SIP_USER=100000_sub
VOIPMS_SIP_PASS=your-voipms-password
VOIPMS_SIP_SERVER=newyork1.voip.ms
# Map each DID to the dograh agent extension that should answer it
# (see the agent table above). Empty = all inbound calls go to ext 8000.
VOIPMS_DIDS=2125551234:8003,2125551235:8005
```

Then `docker compose up -d freepbx` (or restart the container). On boot the entrypoint:

1. writes `pjsip_custom_voipms.conf` — a pjsip trunk that **registers** to your VoIP.ms server (registration, auth, endpoint, AOR, identify);
2. writes `extensions_custom_voipms.conf` — inbound DID routing into the dograh agent contexts (`[dograh-inbound]`);
3. includes both files where FreePBX won't overwrite them (`pjsip_custom_post.conf`, `extensions_custom.conf`), reloads pjsip + the dialplan, and logs `VoIP.ms trunk configured`.

Verify registration from the host: `docker exec pbx-freepbx asterisk -rx "pjsip show registrations"` (state `Registered`).

The entrypoint also creates the **FreePBX outbound route** (`voipms` trunk,
Connectivity → Outbound Routes) so internal extensions can dial out through
the trunk automatically.

### Auto-mapped agents in FreePBX (dograh UI → inbound routes + extensions)

Every phone number registered on dograh (the shipped agents plus anything you
add later in the dograh UI or the Workflow Studio) is automatically mirrored
into FreePBX by `scripts/sync_dograh_routes.py` (idempotent, run by
`setup.sh` and re-run every 2 minutes by the `capstone-pbx-sync.timer`
systemd timer):

- **Custom Extensions** — Applications → Extensions lists each dograh agent
  as a basic **Custom Extension** (registry-only: no voicemail, no call
  waiting, by design).
- **Custom Destination + Inbound Route** — Connectivity → Inbound Routes
  shows a route per agent (DID = the extension) ready for you to map
  VoIP.ms DIDs onto.
- **Dynamic dialplan** — numbers beyond the static `8000-8007` set (e.g.
  one created in the Workflow Studio) get `[dograh-inbound]` entries from
  `extensions_custom_dograh.conf`, so they're actually reachable.

Remove a number in the dograh UI and the next sync run **deletes** the
matching FreePBX entries — but only the ones this script created (marked
"Dograh Voice Agent" / "dograh-managed"); anything you made by hand in the
FreePBX GUI is never touched. Sync manually any time:

```bash
python3 scripts/sync_dograh_routes.py          # create/update + prune removed
python3 scripts/sync_dograh_routes.py --check  # verify only
python3 scripts/sync_dograh_routes.py --no-prune  # keep entries for removed numbers
```

### FreePBX web-UI healthcheck + auto-recovery

The freepbx container's own Docker healthcheck probes **Asterisk**, not the
web UI — so a stale `/var/run/apache2/apache2.pid` kept across a container
restart (Docker preserves `/var/run`) makes `apache2ctl` refuse to start with
`httpd (pid N) already running`, the GUI stays down, and the container still
reports healthy. `scripts/freepbx-web-recover.sh` closes that gap and runs
every 2 minutes via the `capstone-freepbx-web.timer` systemd timer:

```bash
./scripts/freepbx-web-recover.sh check     # probe web UI only (exit 1 if down)
./scripts/freepbx-web-recover.sh recover   # probe; clear stale pid + restart Apache if needed
```

It probes `:80` inside the container, and when the UI is down it clears any
stale pidfile and restarts Apache (as `asterisk`, preserving the Apply Config
fix). Idempotent — a healthy UI is a no-op that exits 0.

## TURN / WebRTC configuration

Setup persists these values in `.env` and preserves explicit non-placeholder values on reruns:

```bash
TURN_USERNAME=<generated username>
TURN_PASSWORD=<generated password>
TURN_REALM=<public IPv4 or 127.0.0.1>
TURN_EXTERNAL_IP=<public IPv4 or 127.0.0.1>
TURN_LISTENING_PORT=3478
TURN_RELAY_PORT_START=49152
TURN_RELAY_PORT_END=49251
```

For clients outside the LAN, forward `3478/tcp`, `3478/udp`, and `49152–49251/udp` from the router to this host. Replace the localhost fallback with the real public IP before using TURN across NAT.

## Verification

```bash
./scripts/smoke-test.sh
./scripts/smoke-e2e.sh --no-boot
```

Checks cover every container's health, the **Dograh API (`:8000`)** and **Dograh UI (`:3010`)**, Kokoro TTS, Speaches Whisper transcription, OmniRoute completions, n8n, Grist, SigNoz, OTel ingest, ARI, the Dograh dialplan, the media WebSocket wiring, and — when `DOGRAH_API_TOKEN` is in `.env` — the Dograh telephony wiring itself: the three agent workflows imported, the Asterisk ARI configuration present in the dograh UI, and extensions 8000/8001/8002 bound to their agents.

## Live/install USB and offline installation

Release `v2.2` includes an x86_64 live/install ISO that boots on both **legacy BIOS** and **UEFI** (Secure Boot must be disabled). It boots into an Xfce desktop (autologin as the live `user` account) with two launchers. Both the **live session** and the finished system come up with **LAN DHCP automatically enabled** on any connected ethernet interface (`en*` / `eth*`, via NetworkManager + netplan), so they can reach the network simply by being plugged in.

- **Download Capstone v2** — fetch the release deployment payload and the offline Docker image bundle into `~/capstone-offline-bundle`.
- **Install Capstone v2** — install Capstone. From the live session this installs to a **target disk** (partition, format, copy the system, install GRUB, then set up Docker + the Capstone service). On an already-installed Linux system it installs into that system (`/opt/capstone`).

Installing from the live session destroys all data on the selected target disk; the installer asks for typed confirmation (`YES`) before doing anything. Booting the live session alone never touches any disk.

The image bakes in Docker (`docker.io`) so the installed system has a container runtime even with no internet; the offline bundle supplies the images. The deployment payload is also baked into the ISO, so an offline install only needs the Docker image bundle from the USB medium.

Download the verified ISO and checksum from the [v2.2 release](https://github.com/innotelinc/capstone/releases/tag/v2.2), then write it to a USB device:

```bash
sha256sum -c capstone-v2-live-amd64.iso.sha256
sudo dd if=capstone-v2-live-amd64.iso of=/dev/sdX bs=16M status=progress conv=fsync
```

Replace `/dev/sdX` with the whole USB device, not a partition. Boot the target computer from the USB, wait for the desktop, and launch **Install Capstone v2**. For a fully offline install, also copy the offline bundle (`capstone-v2-deployment.tar.gz`, `docker-images-v2-part*.tar.gz`, `SHA256SUMS`) to a FAT32 partition of the USB stick — the installer detects and stages it automatically.

### Persistent live USB (choose the drive + what to do with it)

The plain `dd` write above boots a read-only live session. On a 64 GB stick
(or larger) you can instead run `scripts/make-persistent-usb.sh` **with no
arguments** — it lists the available drives and lets you pick the target,
then asks what you want to do with it:

```text
1) Persistent live USB + data drive   live session saves across reboots; ~50 GB data disk
2) Plain live USB                     read-only live session, ISO only
3) Wipe & format a data drive         no ISO — erase the drive as one ext4 volume
```

Option 1 writes the ISO, creates an 8 GiB `persistence` overlay partition so
the live session saves across reboots (packages, config and home survive
power-off), and carves the remaining ~50 GB into a normal ext4
**`CAPSTONE_DATA`** drive for software, downloads, or as an install target.

```bash
sudo scripts/make-persistent-usb.sh               # interactively pick drive + action
sudo scripts/make-persistent-usb.sh /dev/sdX       # non-interactive: persistent + data
sudo ACTION=plain  scripts/…/make-persistent-usb.sh /dev/sdX   # ISO only
sudo ACTION=data   scripts/…/make-persistent-usb.sh /dev/sdX   # wipe & format a data drive
# env overrides:  PERSIST_MB=16384  DATA_LABEL=DATA  ISO=/path/capstone.iso
```

Resulting layout (option 1):

| partition | label | size | purpose |
|---|---|---|---|
| 1 | (ISO) | ~4 GB | read-only live boot medium |
| 2 | `persistence` | 8 GiB (default) | live-session overlay — saves across reboots |
| 3 | `CAPSTONE_DATA` | rest (~50 GB) | normal ext4 data drive |

The ISO is built with `persistence` on the kernel cmdline (see
`scripts/build-live-usb.sh`), so any Capstone ISO written by this helper boots
persistently. The `CAPSTONE_DATA` drive is not part of the overlay — mount it
when you want it: `sudo mount /dev/sdX3 /mnt/data`.

After the install, the **installed system** boots straight into the Capstone stack (systemd enables Docker + the Capstone service on first boot) with DHCP networking on every ethernet interface. The login user is **`capstone`** (password **`capstone`** — change it after first login, or pre-set `CAPSTONE_USER` / `CAPSTONE_PASSWORD` when running `install-capstone.sh` manually).

### Reset a forgotten / broken login password

If the `capstone` user's password doesn't work after an install (common when the install was interrupted or the chroot bootstrap didn't complete), reset it from the live USB:

1. Boot the machine from the Capstone live USB again and wait for the desktop.
2. Open a terminal and find the installed root partition:

   ```bash
   lsblk
   ```

3. Mount the installed root (adjust the device if your root is not `/dev/sda2`) and chroot into it:

   ```bash
   sudo mount /dev/sda2 /mnt
   sudo mount --bind /dev    /mnt/dev
   sudo mount --bind /dev/pts /mnt/dev/pts
   sudo mount --bind /proc   /mnt/proc
   sudo mount --bind /sys    /mnt/sys

   sudo chroot /mnt /bin/bash
   ```

4. Inside the chroot, create/reset the login user and drop the live-session autologin (it points at the live `user` account, which doesn't exist on the installed disk and can block a clean greeter):

   ```bash
   useradd -m -s /bin/bash -G sudo,docker capstone 2>/dev/null || true
   echo 'capstone:capstone' | chpasswd
   rm -f /etc/lightdm/lightdm.conf.d/50-capstone-autologin.conf

   exit
   ```

5. Unmount everything, then reboot into the installed system (without the USB):

   ```bash
   sudo umount /mnt/dev/pts 2>/dev/null; sudo umount /mnt/dev 2>/dev/null
   sudo umount /mnt/proc; sudo umount /mnt/sys; sudo umount /mnt
   sudo reboot
   ```

6. Log in as `capstone` / `capstone` and change the password right away with `passwd`.

> **Still rejected?** Re-run the chroot steps above and confirm the user really got written to disk:
> `grep capstone /mnt/etc/passwd /mnt/etc/shadow`. If the lines are missing, the chroot bootstrap didn't reach the user-creation step during the original install.

### Build the ISO

On an Ubuntu 24.04 (Noble) build host:

```bash
sudo apt-get install -y live-build xorriso mtools genisoimage \
  grub-efi-amd64-bin grub-pc-bin isolinux syslinux-common
./scripts/build-offline-bundle.sh --deployment-only   # bakes the payload into the ISO
./scripts/build-live-usb.sh
```

Output:

```text
dist/live-usb/capstone-v2-live-amd64.iso
dist/live-usb/capstone-v2-live-amd64.iso.sha256
```

The builder uses Ubuntu Noble with GRUB 2 (El Torito for CD/BIOS), an added GRUB EFI image for UEFI, and an isohybrid MBR so the same ISO boots from a USB stick in both firmware modes.

### Offline bundle

Build the offline bundle (deployment payload + all platform Docker images, split into parts under 2 GB so they fit GitHub's upload limit):

```bash
./scripts/build-offline-bundle.sh
```

Download the same bundle from the release:

```bash
./scripts/fetch-offline-bundle.sh ~/capstone-offline-bundle
```

This verifies `SHA256SUMS`, unpacks the deployment payload, and reassembles the Docker image archives into `dist/docker-images-v2/`. Point `install-capstone.sh` at the result (`CAPSTONE_ASSET_DIR=~/capstone-offline-bundle`) and it loads images locally instead of pulling from the network. The core images bundled are: Postgres/pgvector, Redis, MinIO, Coturn, Dograh API, FreePBX/PBX Portal, Kokoro TTS, Speaches STT, OmniRoute, and the instrumented n8n image.

## Packaging v2.2

The v2.2 release includes:

1. **Live/install ISO** — `capstone-v2-live-amd64.iso` plus checksum (BIOS + UEFI bootable, desktop live session, disk installer).
2. **Source bundle** — `capstone-source-bundle.tar.gz` plus checksum.
3. **Deployment payload** — `capstone-v2-deployment.tar.gz` (Compose files, scripts, PBX assets, Dockerfiles, systemd unit, documentation) plus checksum.
4. **Docker image bundle** — `docker-images-v2-partNN.tar.gz` archives of the core platform images for offline install, plus checksums in `SHA256SUMS`.
5. **GitHub Release** — immutable release assets at the v2.2 release page.

Build scripts: `scripts/build-source-bundle.sh`, `scripts/build-offline-bundle.sh`, `scripts/build-live-usb.sh`, `scripts/fetch-offline-bundle.sh`.

`.github/workflows/sync-and-release.yml` detects dograh upstream updates, syncs the fork, and cuts a numbered release — daily and on demand. Every release is **full**: the cut includes the deployment payload + source bundle, and two parallel jobs build and upload the docker image bundle and the live ISO (each on its own VM). Set the **`lightweight`** input for a quick test release that skips those two. The `force` input cuts a release even if upstream hasn't moved.

Never include `.env`, API keys, database volumes, model caches, or call recordings in a release archive. The repository’s generated `dist/` and `.live-build/` directories remain ignored and should be regenerated when needed.

## Status

✅ v3.7 — the FreePBX Apply Config "Unknown Error" regression is fixed (the
boot's post-chown root edits — `modules.conf`, iax/rtp custom files — are now
chowned back to `asterisk:asterisk`, with a final `fwconsole chown` safety net
after all writes; verified on the live container with the exact GUI reload
path). Carries all v3.6 fixes.

✅ v3.6 release — the dograh→FreePBX sync timer and Apache web-recovery units are now installed and running (every 2 min) on the install; the docker image bundle is no longer corrupted (stream diagnostics moved to stderr) so the offline artifact loads; the dograh UI logs in from any device (backend advertises the public domain, not the Docker gateway); all agents 8000–8007 are mapped into FreePBX custom extensions, destinations, and inbound routes with clean workflow-name descriptions; and the pjsip media-address (`local_net`) survives Apply Config because it now lives in `pjsip.transports_custom.conf`. Carries the v2.x fixes (n8n grading-webhook 404 via n8n restart; FreePBX Apply Config "Unknown Error" via `fwconsole chown`; persistent live-USB tooling; live-USB DHCP).
