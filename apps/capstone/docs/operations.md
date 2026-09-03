# Capstone — Operations Reference

Deep-dive operational material for the Capstone — Voice AI Agent Platform. The
[README](../README.md) is the product landing page (hero, features, quick start,
architecture); this file carries the Control Center, PBX/Asterisk, telephony,
proxy/TLS, troubleshooting, verification, and offline-install material that used
to live there.

## Control Center

The stack ships with an operational dashboard — **Capstone Control Center** — that is part
of the main compose file and starts with everything else:

- **`dashboard`** — built React SPA served by nginx at `http://<host>:8096` (or
  `https://dashboard.<domain>` behind the proxy — see [NPM proxy hosts](#npm-proxy-hosts)).
- **`dashboard-api`** — FastAPI aggregator at `http://<host>:8095` that reads live state
  from the Docker socket (container health, published ports, versions, stats), the `.env`
  secret inventory (names/types only — never values), host users (`/etc/passwd`), and
  whole-host `/proc` resource usage.

The SPA talks to the aggregator same-origin through `/api`, which nginx reverse-proxies to
`dashboard-api:8095` — no CORS or host/port wiring. The base URL can be overridden at
runtime with `window.__DASHBOARD_BASE_URL__` or at build time with
`VITE_DASHBOARD_BASE_URL` (default `/api`).

The dashboard shows: **Services** (live Docker health + latency probes), **Health &
Status**, **Network Ports**, **Alerts**, **Secrets inventory**, **Users**, **Monitoring**
(real CPU/mem/disk/network from the host), **Logs** (recent Docker events), **Links**
(service URLs derived from `PUBLIC_BASE_URL` / `NPM_BASE_DOMAIN` — see
[NPM proxy hosts](#npm-proxy-hosts)), and a **Softphone** — an in-browser WebRTC phone that
registers to the PBX over WSS (`/softphone`, extension 102 by default, STUN/TURN pulled
from coturn via `/api/turnconfig`).

> Note: the Softphone page asks the aggregator (`/api/turnconfig`) for the public WSS
> endpoint and connects to `wss://voice.<NPM_BASE_DOMAIN>/ws` when a proxy domain is
> configured (see [NPM proxy hosts](#npm-proxy-hosts)); otherwise it falls back to the page
> origin — `wss://<host>/ws` over HTTPS, or `wss://<host>:8089/ws` over plain HTTP on the
> LAN. Hitting the PBX directly on `:8089` presents the self-signed integration cert, so a
> browser will ask you to accept it once.

## PBX / Asterisk side

FreePBX exposes Webmin on host TCP port `10000` and Asterisk RTP on UDP ports
`10101–10120`; these ranges are deliberately separate to avoid the Webmin/RTP conflict.
Coturn listens on TCP/UDP `3478` and relays on UDP `49152–49251`, configured by `TURN_*`
variables in `.env`. Setup automatically generates the TURN username/password and uses the
server's public IPv4 for `TURN_EXTERNAL_IP` and `TURN_REALM`, falling back to `127.0.0.1`
when public-IP detection is unavailable. Asterisk HTTP/ARI is exposed on `8088`, with the
Dograh ARI user and inbound dialplan injected during PBX startup.

The PBX is a service in the main compose file, so one command brings up the entire stack:

```bash
docker compose up -d
```

## VoIP.ms trunk (optional, auto-configured)

Put your VoIP.ms SIP credentials in `.env` and the freepbx container configures the trunk on
boot — no FreePBX GUI steps:

```bash
VOIPMS_SIP_USER=100000_sub
VOIPMS_SIP_PASS=your-voipms-password
VOIPMS_SIP_SERVER=newyork1.voip.ms
# Map each DID to the dograh agent extension that should answer it
# (see the agent table in the README). Empty = all inbound calls go to ext 8000.
VOIPMS_DIDS=2125551234:8003,2125551235:8005
```

Then `docker compose up -d freepbx` (or restart the container). On boot the entrypoint:

1. writes `pjsip_custom_voipms.conf` — a pjsip trunk that **registers** to your VoIP.ms
   server (registration, auth, endpoint, AOR, identify);
2. writes `extensions_custom_voipms.conf` — inbound DID routing into the dograh agent
   contexts (`[dograh-inbound]`);
3. includes both files where FreePBX won't overwrite them (`pjsip_custom_post.conf`,
   `extensions_custom.conf`), reloads pjsip + the dialplan, and logs
   `VoIP.ms trunk configured`.

Verify registration from the host: `docker exec pbx-freepbx asterisk -rx "pjsip show
registrations"` (state `Registered`).

The entrypoint also creates the **FreePBX outbound route** (`voipms` trunk, Connectivity →
Outbound Routes) so internal extensions can dial out through the trunk automatically.

### Auto-mapped agents in FreePBX (dograh UI → inbound routes + extensions)

Every phone number registered on dograh (the shipped agents plus anything you add later in
the dograh UI or the Workflow Studio) is automatically mirrored into FreePBX by
`scripts/sync_dograh_routes.py` (idempotent, run by `setup.sh` and re-run every 2 minutes
by the `capstone-pbx-sync.timer` systemd timer):

- **Custom Extensions** — Applications → Extensions lists each dograh agent as a basic
  **Custom Extension** (registry-only: no voicemail, no call waiting, by design).
- **Custom Destination + Inbound Route** — Connectivity → Inbound Routes shows a route per
  agent (DID = the extension) ready for you to map VoIP.ms DIDs onto.
- **Dynamic dialplan** — numbers beyond the static `8000-8007` set (e.g. one created in the
  Workflow Studio) get `[dograh-inbound]` entries from `extensions_custom_dograh.conf`, so
  they're actually reachable.

Remove a number in the dograh UI and the next sync run **deletes** the matching FreePBX
entries — but only the ones this script created (marked "Dograh Voice Agent" /
"dograh-managed"); anything you made by hand in the FreePBX GUI is never touched. Sync
manually any time:

```bash
python3 scripts/sync_dograh_routes.py            # create/update + prune removed
python3 scripts/sync_dograh_routes.py --check    # verify only
python3 scripts/sync_dograh_routes.py --no-prune # keep entries for removed numbers
```

### FreePBX web-UI healthcheck + auto-recovery

The freepbx container's own Docker healthcheck probes **Asterisk**, not the web UI — so a
stale `/var/run/apache2/apache2.pid` kept across a container restart (Docker preserves
`/var/run`) makes `apache2ctl` refuse to start with `httpd (pid N) already running`, the GUI
stays down, and the container still reports healthy. `scripts/freepbx-web-recover.sh` closes
that gap and runs every 2 minutes via the `capstone-freepbx-web.timer` systemd timer:

```bash
./scripts/freepbx-web-recover.sh check     # probe web UI only (exit 1 if down)
./scripts/freepbx-web-recover.sh recover   # probe; clear stale pid + restart Apache if needed
```

It probes `:80` inside the container, and when the UI is down it clears any stale pidfile
and restarts Apache (as `asterisk`, preserving the Apply Config fix). Idempotent — a healthy
UI is a no-op that exits 0.

## TURN / WebRTC configuration

Setup persists these values in `.env` and preserves explicit non-placeholder values on
reruns:

```bash
TURN_USERNAME=<generated username>
TURN_PASSWORD=<generated password>
TURN_REALM=<public IPv4 or 127.0.0.1>
TURN_EXTERNAL_IP=<public IPv4 or 127.0.0.1>
TURN_LISTENING_PORT=3478
TURN_RELAY_PORT_START=49152
TURN_RELAY_PORT_END=49251
```

For clients outside the LAN, forward `3478/tcp`, `3478/udp`, and `49152–49251/udp` from the
router to this host. Replace the localhost fallback with the real public IP before using
TURN across NAT.

## NPM proxy hosts

All public services are exposed through a reverse proxy (Nginx Proxy Manager) under **one
base domain** — each service gets its own subdomain, `<service>.<domain>`, and the domain is
customisable in `.env`:

```bash
NPM_BASE_DOMAIN=capstone.innotel.us
```

When set, the Control Center's Links page and the softphone's `/api/turnconfig` use these
subdomain URLs automatically. When unset, everything falls back to `http://<host>:<port>`
links.

The dashboard itself is served at its **own** subdomain via `DASHBOARD_PUBLIC_URL` (e.g.
`https://admin.capstone.innotel.us`). Keep `PUBLIC_BASE_URL` for dograh's advertised origin
— the two are deliberately separate vars so the dashboard can move without breaking dograh.

Create one NPM proxy host per row (one wildcard Let's Encrypt certificate covers all of them
when `NPM_WILDCARD_CERT=1` + DNS credentials are set; otherwise NPM issues one cert per host
and handles renewal):

| NPM host | Forward to | Notes |
|---|---|---|
| `app.<domain>` | `http://<host>:3010` | Capstone Voice App (dograh web UI) |
| `api.<domain>` | `http://<host>:8000` | Capstone Voice API (host-mode uvicorn) |
| `auth.<domain>` | `http://<host>:9000` | Authentik SSO / user management |
| `voice.<domain>` | `https://<host>:8089` — or `http://<host>:8088` for plain-`ws` upstream | WebRTC signaling, path `/ws`, **Websocket Support ON**; see below |
| `admin.<domain>` | `http://<host>:8096` | Capstone Control Center (`DASHBOARD_PUBLIC_URL`) |
| `pbx.<domain>` | `http://<host>:80` | FreePBX GUI |
| `capstone.innotel.us` (apex) | dograh per its config | dograh's origin (`PUBLIC_BASE_URL` / `BACKEND_API_ENDPOINT`) — the apex is NOT the dashboard |
| `omniroute.<domain>` | `http://<host>:20128` | OmniRoute completions UI/API |
| `n8n.<domain>` | `http://<host>:5678` | n8n workflows (also the dograh webhook target) |
| `grist.<domain>` | `http://<host>:8484` | Grist documents |
| `signoz.<domain>` | `http://<host>:3301` | SigNoz UI + dashboards |
| `workflow.<domain>` | `http://<host>:8090` | Workflow Studio |
| `nocodb.<domain>` | `http://<host>:8080` | NocoDB |
| `portal.<domain>` *(optional)* | `http://<host>:3000` | PBX Customer Portal (Next.js) — enable with `docker compose --profile portal up -d` |
| `turn.<domain>` *(optional)* | `http://<host>:3478` | TCP-only via NPM; UDP STUN/TURN still needs direct NAT forwarding (see TURN section) |

**WebRTC / WSS (`voice.<domain>`)** — this is what the in-browser Softphone uses:

- Scheme **`wss`** (SSL) with **Websocket Support** enabled.
- Forward to `https://<host>:8089/ws` (Asterisk's HTTP-TLS listener). If your NPM validates
  upstream certificates and balks at the PBX's self-signed integration cert, forward to
  `http://<host>:8088/ws` instead — plain-`ws` upstream, same `/ws` signaling handler.
- The browser connects to `wss://voice.<domain>/ws`; no self-signed warning because NPM's
  Let's Encrypt certificate terminates TLS.

### Automate proxy-host creation via the NPM API

`scripts/npm-proxy-hosts.py` creates/updates every row above through NPM's REST API — no UI
clicks. It logs in (`NPM_ADMIN_EMAIL` / `NPM_ADMIN_PASSWORD` or a minted `NPM_API_TOKEN`),
requests Let's Encrypt certificates (`NPM_LETSENCRYPT_EMAIL`; one **wildcard** cert for all
hosts when `NPM_WILDCARD_CERT=1` + DNS credentials are set), and prunes stale `*.<domain>`
hosts. Idempotent: GET-first, writes only when state differs; scoped to the base domain so
unrelated NPM hosts are never touched.

```bash
python3 scripts/npm-proxy-hosts.py --check     # verify only, exit 1 if out of sync
python3 scripts/npm-proxy-hosts.py             # create/update + prune
python3 scripts/npm-proxy-hosts.py --no-prune  # never delete hosts
python3 scripts/npm-proxy-hosts.py --include-optional nocodb,portal
python3 scripts/npm-proxy-hosts.py --ws-scheme http --ws-port 8088  # plain-ws upstream (voice.<domain>)
python3 scripts/npm-proxy-hosts.py --wildcard \
    --dns-provider cloudflare --dns-credentials 3   # one wildcard cert for all hosts
```

**Wildcard certificates (default, recommended)** — with `NPM_WILDCARD_CERT=1` (now the
default in `.env.example`) plus a DNS provider saved in NPM (`NPM_DNS_PROVIDER` = provider
slug, `NPM_DNS_PROVIDER_CREDENTIALS` = credential id), the script issues **one** certificate
covering `*.capstone.innotel.us` **and** the apex via DNS-01 and attaches it to every proxy
host automatically. One cert to renew, zero per-host requests. If the DNS credentials aren't
configured it warns and falls back to per-host HTTP-01 certs.

The `voice.<domain>` host forwards to `https://<host>:8089` with WebSocket support ON by
default — pass `--ws-scheme http --ws-port 8088` if your NPM validates upstream certificates
(self-signed PBX cert). The `turn.<domain>` row stays out of scope: NPM's stream-forwarding
API is separate and UDP STUN/TURN still needs direct NAT forwarding regardless.

## Troubleshooting

### Interview voice cuts off early / sounds truncated

The interviewer's TTS is cut mid-sentence when the mock candidate's next line starts while
it's still speaking (the candidate loop plays continuously and each line interrupts the
agent — `allow_interrupt` is on by design). Check and fix in this order:

1. **Widen the candidate's silence gap** — the gap between candidate lines is the
   interviewer's speaking floor:

   ```bash
   python3 scripts/gen_loops.py --gap 8   # 8s instead of the default 4s
   ```

   Regenerate, then re-place the test call (`scripts/place_call.py`). If the interviewer's
   answers are long, use 10–12s.
2. **Confirm which side cuts** — run the call and watch the SigNoz pipeline latency
   dashboard (`signoz.<domain>`, port `3301`): a TTS latency spike that ends abruptly right
   before the cut means the next candidate line won the interrupt race.
3. **Upstream knobs** (dograh platform): the user-turn stop timeout
   (`user_turn_stop_timeout`, default 5s of silence) and the per-node `allow_interrupt` flag
   govern turn boundaries. These live in the dograh fork, not this repo — patch and re-sync
   via the release workflow if needed.

### Editing an AI-generated agent's topic

The dograh web UI does not expose prompt/topic editing for imported agents — the "topic" you
typed in the Workflow Studio is baked into the workflow's node prompts (the `globalNode`
persona + each `startCall`/`agentNode` prompt), so changing it means regenerating or editing
the workflow itself:

- **Per-call, without editing the agent**: every prompt reads `{{initial_context.*}}`
  variables (`role`, `company`, `student_difficulty`, `focus_topics`, `interviewer_name`,
  `student_name`, …) — pass them when placing a call and the agent adapts without any edit.
- **Shipped agents** (`dograh/*-workflow.json`): edit the prompt text in the JSON, then
  re-import + re-wire:

  ```bash
  python3 scripts/dograh_wire.py --env-file .env   # idempotent re-import
  ```

- **AI-generated agents** (Workflow Studio): either regenerate from a new description in the
  Studio (`workflow.<domain>`, port `8090`) and import as a new agent, or edit the imported
  workflow's JSON in the Studio preview and re-import it — the Studio's import button
  registers the next free extension automatically.

  The dograh UI is intentionally read-only for prompts: it's the telephony configuration
  surface, while the Studio is the authoring surface.

## Verification

```bash
./scripts/smoke-test.sh
./scripts/smoke-e2e.sh --no-boot
```

Checks cover every container's health, the **Dograh API (`:8000`)** and **Dograh UI
(`:3010`)**, Kokoro TTS, Speaches Whisper transcription, OmniRoute completions, n8n, Grist,
SigNoz, OTel ingest, ARI, the Dograh dialplan, the media WebSocket wiring, and — when
`DOGRAH_API_TOKEN` is in `.env` — the Dograh telephony wiring itself: the three agent
workflows imported, the Asterisk ARI configuration present in the dograh UI, and extensions
8000/8001/8002 bound to their agents.

## Live/install USB and offline installation

Release `v2.2` includes an x86_64 live/install ISO that boots on both **legacy BIOS** and
**UEFI** (Secure Boot must be disabled). It boots into an Xfce desktop (autologin as the
live `user` account) with two launchers. Both the **live session** and the finished system
come up with **LAN DHCP automatically enabled** on any connected ethernet interface (`en*` /
`eth*`, via NetworkManager + netplan), so they can reach the network simply by being plugged
in.

- **Download Capstone v2** — fetch the release deployment payload and the offline Docker
  image bundle into `~/capstone-offline-bundle`.
- **Install Capstone v2** — install Capstone. From the live session this installs to a
  **target disk** (partition, format, copy the system, install GRUB, then set up Docker +
  the Capstone service). On an already-installed Linux system it installs into that system
  (`/opt/capstone`).

Installing from the live session destroys all data on the selected target disk; the
installer asks for typed confirmation (`YES`) before doing anything. Booting the live
session alone never touches any disk.

The image bakes in Docker (`docker.io`) so the installed system has a container runtime even
with no internet; the offline bundle supplies the images. The deployment payload is also
baked into the ISO, so an offline install only needs the Docker image bundle from the USB
medium.

Download the verified ISO and checksum from the GitHub releases page for this repository,
then write it to a USB device:

```bash
sha256sum -c capstone-v2-live-amd64.iso.sha256
sudo dd if=capstone-v2-live-amd64.iso of=/dev/sdX bs=16M status=progress conv=fsync
```

Replace `/dev/sdX` with the whole USB device, not a partition. Boot the target computer from
the USB, wait for the desktop, and launch **Install Capstone v2**. For a fully offline
install, also copy the offline bundle (`capstone-v2-deployment.tar.gz`,
`docker-images-v2-part*.tar.gz`, `SHA256SUMS`) to a FAT32 partition of the USB stick — the
installer detects and stages it automatically.

### Persistent live USB (choose the drive + what to do with it)

The plain `dd` write above boots a read-only live session. On a 64 GB stick (or larger) you
can instead run `scripts/make-persistent-usb.sh` **with no arguments** — it lists the
available drives and lets you pick the target, then asks what you want to do with it:

```text
1) Persistent live USB + data drive   live session saves across reboots; ~50 GB data disk
2) Plain live USB                     read-only live session, ISO only
3) Wipe & format a data drive         no ISO — erase the drive as one ext4 volume
```

Option 1 writes the ISO, creates an 8 GiB `persistence` overlay partition so the live
session saves across reboots (packages, config and home survive power-off), and carves the
remaining ~50 GB into a normal ext4 **`CAPSTONE_DATA`** drive for software, downloads, or as
an install target.

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
persistently. The `CAPSTONE_DATA` drive is not part of the overlay — mount it when you want
it: `sudo mount /dev/sdX3 /mnt/data`.

After the install, the **installed system** boots straight into the Capstone stack (systemd
enables Docker + the Capstone service on first boot) with DHCP networking on every ethernet
interface. The login user is **`capstone`** (password **`capstone`** — change it after first
login, or pre-set `CAPSTONE_USER` / `CAPSTONE_PASSWORD` when running
`install-capstone.sh` manually).

### Reset a forgotten / broken login password

If the `capstone` user's password doesn't work after an install (common when the install was
interrupted or the chroot bootstrap didn't complete), reset it from the live USB:

1. Boot the machine from the Capstone live USB again and wait for the desktop.
2. Open a terminal and find the installed root partition:

   ```bash
   lsblk
   ```

3. Mount the installed root (adjust the device if your root is not `/dev/sda2`) and chroot
   into it:

   ```bash
   sudo mount /dev/sda2 /mnt
   sudo mount --bind /dev    /mnt/dev
   sudo mount --bind /dev/pts /mnt/dev/pts
   sudo mount --bind /proc   /mnt/proc
   sudo mount --bind /sys    /mnt/sys

   sudo chroot /mnt /bin/bash
   ```

4. Inside the chroot, create/reset the login user and drop the live-session autologin (it
   points at the live `user` account, which doesn't exist on the installed disk and can
   block a clean greeter):

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

> **Still rejected?** Re-run the chroot steps above and confirm the user really got written
> to disk: `grep capstone /mnt/etc/passwd /mnt/etc/shadow`. If the lines are missing, the
> chroot bootstrap didn't reach the user-creation step during the original install.

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

The builder uses Ubuntu Noble with GRUB 2 (El Torito for CD/BIOS), an added GRUB EFI image
for UEFI, and an isohybrid MBR so the same ISO boots from a USB stick in both firmware
modes.

### Offline bundle

Build the offline bundle (deployment payload + all platform Docker images, split into parts
under 2 GB so they fit GitHub's upload limit):

```bash
./scripts/build-offline-bundle.sh
```

Download the same bundle from the release:

```bash
./scripts/fetch-offline-bundle.sh ~/capstone-offline-bundle
```

This verifies `SHA256SUMS`, unpacks the deployment payload, and reassembles the Docker image
archives into `dist/docker-images-v2/`. Point `install-capstone.sh` at the result
(`CAPSTONE_ASSET_DIR=~/capstone-offline-bundle`) and it loads images locally instead of
pulling from the network. The core images bundled are: Postgres/pgvector, Redis, MinIO,
Coturn, Dograh API, FreePBX/PBX Portal, Kokoro TTS, Speaches STT, OmniRoute, and the
instrumented n8n image.

## Release automation notes

- `.github/workflows/sync-and-release.yml` detects dograh upstream updates, syncs the
  source, and cuts a numbered release — daily and on demand. Every release is **full**: the
  cut includes the deployment payload + source bundle, and two parallel jobs build and
  upload the docker image bundle and the live ISO (each on its own VM). Set the
  **`lightweight`** input for a quick test release that skips those two. The `force` input
  cuts a release even if upstream hasn't moved.
- `.github/workflows/release.yml` is the **tag-based** pipeline: pushing any `v*` tag builds
  the Capstone-built images (n8n+OTel, Workflow Studio, Control Center dashboard + API),
  publishes them to GHCR under the repo's own namespace
  (`ghcr.io/<owner>/<repo>/capstone-*:<tag>` + `:latest`), and attaches the source bundle +
  deployment payload to the GitHub Release for that tag.
