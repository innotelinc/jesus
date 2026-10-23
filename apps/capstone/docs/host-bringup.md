# Host bring-up: from bare x86 box to a working Capstone + phone node

This is the operator path for a fresh Linux host: check the box, prepare it,
install the stack, wire the phone, and prove it end to end. Every number here
comes from this repository (see [arm64.md](arm64.md) for the device audit and
[phone-node.md](phone-node.md) for the phone side).

## Minimum hardware

| Resource | Floor | Recommended | Why |
|---|---|---|---|
| Arch | x86_64 | x86_64 | Images and the live ISO are amd64; only 17/25 images publish arm64. |
| RAM | 8 GiB | **12–16 GiB** | Capstone alone measures 5.84 GiB (`docs/host-move.md`); the reference host is 13.1 GiB. Rebuilds spike. |
| CPU | 2 vCPU | **4–8 vCPU** | 58 services plus STT/TTS. A 2-vCPU host is documented as the weak case. |
| Disk | 50 GiB | **100 GiB+ SSD** | ~9 GiB of unpacked images, plus Postgres, MariaDB, MinIO call recordings, Grist, n8n. |
| Swap | — | 8 GiB | Keeps a rebuild from OOM-killing containers. |
| Net | Static LAN IP | Static + DNS | Asterisk, coturn and the phone all address the host by IP. |

Ask the preflight instead of trusting a spec sheet — including for a host you
have not bought yet:

```sh
./deploy/preflight-host.sh                                  # this machine
CAPSTONE_OS=Linux CAPSTONE_ARCH=x86_64 CAPSTONE_RAM_GIB=16 \
  CAPSTONE_CPU=8 CAPSTONE_DISK_GIB=200 ./deploy/preflight-host.sh --plan
```

It exits non-zero when something is blocking and prints the fix for each line.

## 1. Prepare the OS

Ubuntu 24.04 LTS (server, no GUI) is the least surprising base: it is what the
live USB installs, and `scripts/install-capstone.sh` assumes apt.

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg git openssl python3

# Docker Engine + Compose v2 from Docker's repository (not the distro's old one)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out and back in
```

Then:

- **Time sync** — `sudo timedatectl set-ntp true`. Asterisk TLS and ARI tokens
  are time-sensitive; a drifting clock produces registration failures that look
  like credential problems.
- **Static address** — set it in Netplan or reserve a DHCP lease. Everything
  else in this guide assumes the host IP does not move.
- **Swap** if the box has less than 16 GiB:
  `sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
  then add it to `/etc/fstab`.
- **Firewall** — open only what you need. On a LAN, `ufw allow from 192.168.1.0/24`
  for `5060/udp`, `8089/tcp`, `3478/tcp`, `3478/udp`; keep the dashboard behind
  Nginx Proxy Manager rather than exposing container ports.

## 2. Install the stack

```sh
git clone https://github.com/inotellinc/capstone.git   # your fork/remote
cd capstone
./scripts/setup.sh
```

`setup.sh` generates `.env` with fresh secrets, boots both compose files,
bootstraps Grist, mints the OmniRoute key, wires the interview agents to
extensions `8000–8007`, provisions NPM proxy hosts when it can reach NPM, and
runs `scripts/smoke-e2e.sh`. It is idempotent — re-running it does not rotate
secrets you have already set.

If the host is offline, use the live USB / offline bundle instead
(`docs/operations.md` § *Offline install*): the ISO carries the images, so the
host never needs a registry.

## 3. Wire the phone as the SMS node

Follow [phone-node.md](phone-node.md) Path A to install the node in Termux, then
add this to `.env` on the host:

```sh
SMS_PROVIDER=opensms
OPENSMS_URL=http://192.168.1.77:9292          # the phone's fixed LAN IP
OPENSMS_API_KEY=<~/.opensms-bridge/key on the phone>
OPENSMS_TIMEOUT_MS=15000

# Replies (inbound). Generate once, then use the same value on the phone:
#   openssl rand -hex 32
CAPSTONE_SMS_INBOUND_TOKEN=<32-byte hex secret>
```

Restart the API so it picks up the new secret, and start the phone node with
inbound enabled:

```sh
docker compose up -d --force-recreate dashboard-api

# on the phone:
cd ~/capstone
FORWARD_URL=http://192.168.1.52:8080/sms-inbound \
CAPSTONE_SMS_INBOUND_TOKEN=<same secret> \
  bash phone-node/install-termux.sh
```

Notes that save time:

- `OPENSMS_URL` must be the phone's **LAN IP**, never `127.0.0.1` — inside the
  container that is the container.
- Precedence for the provider is: container env `SMS_PROVIDER` → the Control
  Center's saved state → `.env` → `zeus`.
- Unset `CAPSTONE_SMS_INBOUND_TOKEN` means `/sms-inbound` answers **503** — an
  unset secret is a closed route, never an open one.
- If the dashboard is behind NPM/TLS, point `FORWARD_URL` at the public
  `https://api.<domain>/sms-inbound` instead; the token travels in a header.

## 4. Smoke test

Run these in order; each one isolates a layer, so the first failure is the
answer.

```sh
# 1. The phone is a reachable, ready gateway
curl -s http://192.168.1.77:9292/health | python3 -m json.tool

# 2. Capstone's client resolves the same config the containers will use
python3 scripts/opensms_client.py --check

# 3. Outbound: one real SMS (modem, or PJSIP fallback if configured)
python3 scripts/opensms_client.py --to +15551234567 --body "capstone smoke"

# 4. The container can reach the phone (catches the loopback mistake)
docker compose exec -T dashboard-api python3 -c \
  "import urllib.request,os;print(urllib.request.urlopen(os.environ['OPENSMS_URL']+'/health',timeout=5).status)"

# 5. Inbound: text the phone from another handset, then read the reply back
curl -s -b "capstone_session=<your session cookie>" \
  http://127.0.0.1:8080/sms-inbound?limit=5   # or open the Control Center

# 6. The stack's own boot-and-verify pass
./scripts/smoke-e2e.sh

# 7. The phone-node contract, without needing a phone
python3 phone-node/test_bridge.py
python3 phone-node/test_sip_message.py
python3 phone-node/test_e2e_inbound.py
```

Expected: `/health` returns `"ready": true` with `"transport": "phone"` (or
`"pjsip"`); `--check` reports `"provider": "opensms"` and
`"endpoint": "http://<phone>:9292/sms/"`; step 3 prints `{"stat": true, ...}`;
step 5 shows the reply you just sent.

## 5. What "done" looks like

- `deploy/preflight-host.sh` is green (warnings read, not ignored).
- `scripts/smoke-e2e.sh` passes: PBX healthy, ARI reachable at the LAN IP,
  dialplan `Stasis()` before any voicemail fallback, softphone WSS upgrades,
  TURN advertising the current public IP.
- `docker compose ps` shows no restart loop; `docker stats` sits well under the
  RAM budget.
- A real call rings an agent extension and the transcript lands in the
  dashboard.
- An inbound SMS sent from another phone appears once in `/sms-inbound`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `setup.sh` fails at compose up with "no space left" | Images unpack to ~3× their compressed size; give `/var/lib/docker` room or move it to another disk. |
| Container cannot reach the phone | `OPENSMS_URL` is loopback; use the LAN IP. Also check the router's AP isolation for guest Wi-Fi. |
| `/health` 503 from the phone | `termux-api` installed but Termux:API app missing, or SMS permission not granted. |
| Replies never appear | `CAPSTONE_SMS_INBOUND_TOKEN` differs between phone and host, or `dashboard-api` was not recreated after the `.env` change. |
| Calls connect with no audio | coturn advertising a stale IP, or `TURN_EXTERNAL_IP` pinned; see the smoke test's TURN section. |
| Clock skew warnings in Asterisk | NTP not enabled. |
