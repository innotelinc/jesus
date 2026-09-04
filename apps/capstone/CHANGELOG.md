# Capstone Changelog

Release history for the Capstone — Voice AI Agent Platform. The README is the
product landing page; this file keeps the per-release detail.

## v3.14 — Shared-PBX gaps resolved + hardened networking

Release `v3.14` closes the two remaining shared-PBX design gaps with Zeus,
quiets SearXNG, and locks in the LAN-IP-first networking rules with CI guards.

Highlights of v3.14:

- **G3 — transfer resolution source (RESOLVED)**: dograh's transfer-tool
  `destination_source: dynamic` resolver contract now has its Zeus-side
  endpoint — `POST /api/agent/transfer-resolve` — which resolves a person's
  name against the account's contacts (external E.164 phone) or extensions
  (`PJSIP/<ext>`). Auth via the Authentik session cookie or the same signed
  token as a Bearer header for machine-to-machine resolver calls.
- **G4 — voicemail vs agent per number (RESOLVED)**: per-number `answer_mode`
  stays owned by the agent config; agent numbers now fall back to
  `VoiceMail(<mailbox>@default,u)` when the Stasis app returns without
  completing the call (pipeline failure, crash, no config). Gated on a
  provisioned `DOGRAH_VM_MAILBOX`, so the standalone box behaves exactly as
  before until a Zeus mailbox is provisioned on the shared box.
- **Deployment modes documented**: `docs/zeus-integration.md` now states the
  standalone-vs-Zeus-add-on decision explicitly — same fragments and tooling,
  different pointer (which Asterisk dograh's ARI/WS target).
- **SearXNG log cleanup**: limiter/bot-detection off (internal-only instance,
  no proxy headers by design) and the wikidata engine disabled — its recurring
  403 init traceback no longer spams the log. n8n web search unaffected.
- **LAN-IP-first everywhere**: dashboard fallback/placeholder data now derives
  hosts from where the dashboard is actually served (NPM subdomain or LAN IP)
  instead of localhost / docker-subnet IPs; the trusted-proxy default no
  longer trusts the docker overlay.
- **CI regression guard**: a new `config-guard` job fails on docker-bridge IPs
  or localhost links in dashboard fallback data, landing pages, and
  non-comment env-template values — the 172.17.0.1 leak class can't come
  back silently.

## v3.11 — Capstone Voice AI Agent Platform

Release `v3.11` rebrands the platform as **Capstone — Voice AI Agent Platform**, adds
Authentik SSO, canonicalizes the public subdomains, and dockerizes/publishes the
Capstone-built images through a dedicated release pipeline.

Highlights of v3.11:

- **Branding — everything is Capstone now**: all product naming, docs, and dashboard
  content use the Capstone identity (the voice agent platform and Control Center), with no
  third-party authorship attributed anywhere in the project.
- **Authentik SSO (`auth.<domain>`)**: the self-hosted identity provider is now part of the
  compose stack (server + worker + own Postgres/Redis), exposed at
  `https://auth.capstone.innotel.us`, with the bootstrap superuser created from
  `AUTHENTIK_BOOTSTRAP_EMAIL` / `AUTHENTIK_BOOTSTRAP_PASSWORD`.
- **Canonical subdomains**: `app.capstone.innotel.us` (voice app), `api.capstone.innotel.us`
  (voice API), `auth.capstone.innotel.us` (Authentik), `voice.capstone.innotel.us` (WebRTC
  WSS / softphone), `admin.capstone.innotel.us` (Control Center), `pbx.capstone.innotel.us`
  (FreePBX) — the old `dograh`/`dograh-ui`/`dashboard`/`ws` host names are pruned
  automatically by the NPM sync.
- **Wildcard SSL by default**: `NPM_WILDCARD_CERT=1` is on in `.env.example` — with
  `NPM_DNS_PROVIDER` / `NPM_DNS_PROVIDER_CREDENTIALS` set, one DNS-01 Let's Encrypt
  certificate covers `*.capstone.innotel.us` + the apex and is auto-attached to every proxy
  host.
- **Release pipeline**: `.github/workflows/release.yml` fires on every `v*` tag, builds the
  Capstone Docker images (n8n+OTel, Workflow Studio, dashboard, dashboard API), publishes
  them to GHCR under the repo's own namespace, and attaches the source bundle + deployment
  payload to the GitHub Release.
- **FreePBX blacklist destination validation fixed**: dograh destinations are written before
  route creation, re-validated against the live dialplan after reload, and the Blacklist
  module's dangling destination is repaired automatically (see pbx/README.md).

## v3.10 — wildcard certificates + voice-cutoff diagnostics

Release `v3.10` adds wildcard-certificate automation to the NPM proxy layer and ships the
diagnostics for the mock-interview voice cutoff.

- **One wildcard certificate for every subdomain**: `npm-proxy-hosts.py --wildcard` (or
  `NPM_WILDCARD_CERT=1`) issues a single Let's Encrypt cert covering `*.capstone.innotel.us`
  + the apex via **DNS-01** and auto-attaches it to every proxy host — no per-host cert
  requests, no renewal churn. Requires the DNS provider's credentials saved in NPM
  (`NPM_DNS_PROVIDER` / `NPM_DNS_PROVIDER_CREDENTIALS`); falls back to per-host HTTP-01
  certs when they're absent.
- **Mock-interview voice cutoff diagnostics**: `scripts/gen_loops.py --gap` now makes the
  silence between candidate answers configurable (default 4s). If the interviewer's voice
  cuts off mid-sentence, the next candidate line is interrupting it — widen the gap and see
  the Troubleshooting section in docs/operations.md.
- **Editing an AI-generated agent's topic documented**: the topic lives in the workflow's
  node prompts + `initial_context`; see docs/operations.md for how to change it (the dograh
  UI doesn't expose prompt editing).

## v3.9 — NPM proxy hosts automated

Release `v3.9` automates the last manual setup step — the Nginx Proxy Manager front-end — so
a fresh host goes from `git clone` to fully-proxied HTTPS subdomains with zero UI clicks.

- **NPM proxy hosts are now API-automated**: `scripts/npm-proxy-hosts.py` creates/updates
  every host through NPM's REST API — login (`NPM_ADMIN_EMAIL` / `NPM_ADMIN_PASSWORD` or a
  minted `NPM_API_TOKEN`), a Let's Encrypt certificate per subdomain, force-HTTPS,
  WebSocket upgrades, and pruning of stale `*.<domain>` hosts. Idempotent and scoped to the
  base domain; `--check` verifies without writing.
- **setup.sh provisions NPM on fresh installs**: when NPM is reachable and credentials are
  in `.env`, the bootstrap runs the proxy-host sync automatically (step 7b) once the stack
  is up — LAN-only hosts without NPM are skipped with a hint, and re-running `setup.sh`
  after pointing NPM at the host provisions everything.
- **`portal.<domain>` subdomain**: the optional PBX Customer Portal gets its own proxy host
  (upstream `:3000`), and the Control Center's Links page and proxy map know about it.
- **Full release via the sync-and-release GitHub workflow** (docker image bundle + live
  ISO), as before.

## v3.7 — FreePBX Apply Config regression fixed

- **FreePBX "Unknown Error. Please Run: fwconsole reload --verbose." fixed again**: the
  v3.0 fix ran `fwconsole chown` before reloads, but `fix_include_hygiene` and
  `fix_modules_conf` in `pbx/entrypoint-dograh.sh` run *after* that chown and rewrite files
  as root (`sed -i` temp+rename, `touch`), so `modules.conf` and the iax/rtp custom files
  were root-owned again when the GUI's Apply Config regenerated them — which FreePBX reports
  as "Unknown Error. Please Run: fwconsole reload --verbose." Both functions now chown their
  files back to `asterisk:asterisk` right after editing, and a final `fwconsole chown`
  safety net runs after ALL boot writes (post-pjsip/voipms) so the hand-off to the stock
  entrypoint always leaves correct ownership. Verified end-to-end: fresh boot leaves zero
  root-owned files under `/etc/asterisk`, and `fwconsole reload` run as the asterisk user
  completes with "Reload Complete" and no errors.

## v3.6 — loadable image bundle + dograh login fix

Release `v3.6` re-cuts the platform through the GitHub release workflow and fixes two
release-gating bugs so the offline artifact actually deploys.

- **Docker image bundle is loadable (stream no longer corrupted)**: the workflow streamed
  `docker save | gzip | split` to build `docker-images-v2-partNN.tar.gz`, but every `echo`
  diagnostic and `docker pull`/`build` progress line wrote to stdout too, landing mixed into
  the gzip stream. All diagnostics now go to `>&2`, so `cat *.tar.gz | gzip -t` passes and
  `docker load` reconstructs the images.
- **Full release via GitHub CI**: the sync-and-release workflow rebuilt the source bundle,
  deployment payload, docker image bundle, and live ISO at `v3.6`, with the sync-timer and
  Apache-recovery systemd units installed and running on the box.
- **dograh UI login works from any device**: the backend advertised
  `http://172.17.0.1:8000` (the server's unreachable internal Docker gateway) as its
  `backend_api_endpoint`, so browsers were re-pointed to a private address and login died at
  the network layer. `PUBLIC_BASE_URL` / `BACKEND_API_ENDPOINT` now advertise the public
  domain (`https://capstone.innotel.us`).
- **All agents 8000–8007 mapped into FreePBX**: only 8000–8002 were registered in dograh,
  so 8003–8007 (receptionist, outreach, interview, survey, GOTV) never got FreePBX custom
  extensions or inbound routes. `dograh_wire.py` + `sync_dograh_routes.py` now register all
  8 numbers.
- **FreePBX descriptions cleaned up**: em-dashes were mangled to `?` by the ASCII
  sanitizer; the sync now transliterates them and uses each agent's workflow name as the
  purpose shown in custom extensions / destinations.

## v3.5 — pjsip media-address + extension mapping

- **pjsip local media address**: the transport's `local_net` is set to the LAN subnet (in
  the durable `pjsip.transports_custom.conf`, so Apply Config can't wipe it) and LAN-only
  endpoints get a forced `media_address`, so softphones aren't told to send RTP to a
  public/docker-bridge IP (which caused one-way audio).

## v3.4 — tag of v3.5 fixes

Release `v3.4` tags the current `main` with the login + description fixes (described under
v3.5/v3.6).

## v3.3 — workflow-generated full release

Release `v3.3` is a workflow-generated full release cut from upstream `1.45.0`, building and
attaching the source bundle, deployment payload, docker image bundle, and live ISO.

## v3.2 — persistent live USB + data drive

- **Persistent live USB + a data drive**: `scripts/make-persistent-usb.sh` now lists the
  available drives and lets you pick the target and what to do with it (persistent live USB
  + `CAPSTONE_DATA` drive, plain live USB, or wipe & format a data drive). A `persistence`
  overlay partition makes the live session save packages/config/home across reboots; the
  remaining ~50 GB of a 64 GB stick becomes a normal ext4 data drive. The ISO is built with
  `persistence` on the kernel cmdline so these USBs boot persistent out of the box.
- **Full release via GitHub CI**: dograh fork synced to upstream `1.45.0` and Capstone
  customizations reapplied; all four artifacts built and uploaded by the workflow.

## v3.1 — live-USB DHCP

- **Live USB gets DHCP instead of link-local**: the live ISO's netplan used
  `renderer: NetworkManager`, which isn't reliably generated at live boot (it needs
  netplan's NM dispatcher), so the wired NIC could come up with only a link-local
  `169.254` address. Switched to `renderer: networkd` so netplan's systemd generator writes
  the DHCP rule for `systemd-networkd` on any `en*`/`eth*` port.

## v3.0 — grading webhook + PBX reload fixes

- **n8n grading-webhook no longer 404s**: n8n 2.x `import:workflow` / `publish:workflow` /
  `update:workflow --active=true` only write the DB — the CLI explicitly warns the running
  instance won't pick them up — so dograh's hang-up `POST /webhook/interview-graded`
  returned 404. The `n8n-import` one-shot now imports, publishes, activates, **restarts
  n8n** over the Docker socket, and probes the webhook until it answers 200.
- **FreePBX "Unknown Error. Please Run: fwconsole reload --verbose." fixed**: root-owned
  config rewrites under `/etc/asterisk` left files the reload user couldn't rewrite, so
  Apply Config failed. `fwconsole chown` now runs before both reload paths (PBX boot in
  `pbx/entrypoint-dograh.sh` and route wiring in `pbx/bootstrap_dograh_route.py`).

## v2.6 — full rebuild via GitHub CI + OmniRoute pinned

- **Full release rebuilt via GitHub CI**: `sync-and-release.yml` was re-run with the `force`
  input, producing a complete v2.6 — deployment payload, source bundle, docker image bundle
  (`docker-images-v2-part00–03.tar.gz`), and the live ISO, each heavy artifact built and
  uploaded on its own runner.
- **OmniRoute ships as the prebuilt image** (`diegosouzapw/omniroute:latest`, overridable
  via `OMNIROUTE_IMAGE`); no vendored source is kept in this repo.
- **`compression_run_telemetry` cleanup fix**: OmniRoute creates that table *lazily* on
  first compression telemetry write, so a deployment that never records one throws
  `SqliteError: no such table: compression_run_telemetry` in the 6-hourly cleanup sweep.
  Create the table once in the compose volume the container actually mounts —
  `omniroute_data` in `docker-compose.yml` maps to `capstone_omniroute_data` on disk. Do not
  create it in the unprefixed `omniroute_data` volume: that is a stale leftover from an
  earlier compose project name.

## v2.3 — PBX boot hardened against base64 secrets

- **Freepbx crash-loop fixed**: the stock `entrypoint.sh` writes `FREEPBX_AMI_SECRET`
  (base64, so it can contain `/`) into `manager_custom.conf` with an unguarded `s/ / /`-
  delimited `sed`. When the secret contains `/`, the sed fails and, under `set -e`, kills
  the entrypoint right after `service mariadb start`. `pbx/entrypoint-dograh.sh` now patches
  the stock script's sed to a `|` delimiter on every boot (idempotently), the same fix
  already used for `DOGRAH_ARI_PASSWORD`.
- **Hardened remaining value-injecting seds**: the same `s///` delimiter hazard in the stock
  entrypoint's `AFDB_PASS` and `ADMIN_EMAIL` lines was also switched to `|`.
- **Verified end-to-end**: the freepbx service boots healthy with zero restarts, Asterisk 22
  + the ARI user + `[dograh-inbound]` dialplan come up, and the full smoke test passes.

## v2.2 — installed-system bootstrap fixed

- **Installer root-path fix**: on the installed disk the installer runs flat at
  `/opt/capstone/install-capstone.sh`, but `ROOT` was computed with a repo-only
  `dirname $0/..` that resolved to `/opt`. That made the in-chroot install treat
  `ASSET_DIR != TARGET` and run `rsync -a --delete /opt/ /opt/capstone/`, recursively
  creating a stray `/opt/capstone/capstone` and deleting the real payload. `ROOT` is now
  derived by probing for the payload markers (`docker-compose.yml`,
  `capstone-v2-deployment.tar.gz`, `scripts/install-capstone.sh`) in the script's own dir or
  its parent, so all three layouts (repo in-place, deployed flat, live-ISO session) resolve
  correctly and the destructive rsync is skipped.

## v2.1 — single compose file + first-boot reliability

- **Single compose file**: `docker-compose.asterisk.yml` was merged into
  `docker-compose.yml` — the FreePBX/Asterisk side (and the optional PBX portal) is now a
  service in the main file, so `docker compose up -d` brings up the entire stack at once.
- **Live/install first boot fixed**: the installed system now boots straight into the stack
  with DHCP on every ethernet port, a real login user (`capstone` / `capstone`, overridable
  via `CAPSTONE_USER`/`CAPSTONE_PASSWORD`), and the Capstone systemd service enabled from
  inside the installer chroot (`systemctl --root`).
- **FreePBX container boot cleaned up**: PHP `memory_limit` raised to 512M; `odbc.ini`
  pointed at the MariaDB driver + socket so CDR/CEL connect; the `#include
  iax_fax_custom.conf` moved to `iax_custom_post.conf` and the `rtp_custom.conf` include
  deduplicated; `rtp_custom.conf` canonicalized to `[general] stunaddr =
  stun.l.google.com:19302 / icesupport = yes / rtpstart=10101 / rtpend=10120`.
- **Quieter Asterisk boot**: `chan_local.so` preload (absent from the image), HEP, and the
  SQLite CDR/CEL custom backends are `noload`'d so a clean boot logs no loader errors.

## v2.0 — dograh source resync

- **Dograh platform resynced to upstream**: the dograh source was rebased onto the current
  `dograh-hq/dograh` main and Capstone customizations reapplied on top — the self-hosted
  interview stack (SigNoz/OTel, Kokoro, Speaches, n8n grading), the Asterisk/FreePBX ARI
  wiring, NPM-fronted hostnames, systemd autostart, and nightly DB backup.
- **Rebuilt GHCR images**: `ghcr.io/innotelinc/dograh-api` and
  `ghcr.io/innotelinc/dograh-ui` rebuilt from the synced source and re-published.
- **Dograh web UI (`dograh-ui`)**: the Next.js frontend runs on host port `3010`; the API on
  its native port `8000`. If the prebuilt images can't be pulled,
  `docker-compose.dograh-build.yml` builds both from the dograh source.
- **Hardened env handling**: setup.sh and smoke-test.sh load `.env` explicitly so a stray
  exported shell variable can no longer pin `PUBLIC_BASE_URL`/`BACKEND_API_ENDPOINT` to a
  stale value.

## Packaging v2.2

The v2.2 release includes:

1. **Live/install ISO** — `capstone-v2-live-amd64.iso` plus checksum (BIOS + UEFI bootable,
   desktop live session, disk installer).
2. **Source bundle** — `capstone-source-bundle.tar.gz` plus checksum.
3. **Deployment payload** — `capstone-v2-deployment.tar.gz` (Compose files, scripts, PBX
   assets, Dockerfiles, systemd unit, documentation) plus checksum.
4. **Docker image bundle** — `docker-images-v2-partNN.tar.gz` archives of the core platform
   images for offline install, plus checksums in `SHA256SUMS`.
5. **GitHub Release** — immutable release assets at the release page.

Build scripts: `scripts/build-source-bundle.sh`, `scripts/build-offline-bundle.sh`,
`scripts/build-live-usb.sh`, `scripts/fetch-offline-bundle.sh`.
