#!/usr/bin/env bash
# Create, deploy to, inspect and destroy a CHRIST instance on Vultr.
#
#   export VULTR_API_KEY=...        # or put the key in christ/deploy/.vultr-key.env
#   ./vultr.sh up                   # create the instance, upload the tree, boot the stack
#   ./vultr.sh status               # instance state, IP and the demo URLs
#   ./vultr.sh logs                 # the compose log from the box
#   ./vultr.sh wire                 # apply estate.json to the running switch
#   ./vultr.sh down                 # destroy the instance
#
# What runs is the tree *here*: `up` packs christ/, the apps its compose builds
# and the console, uploads the archive and runs compose over SSH. Nothing is
# cloned, so a branch that was never pushed cannot silently replace the code
# that was verified locally.
#
# Default selection: core + pstn + console + platform. That is the voice plane,
# the SIP border, the operator's window and the inventory platform — the
# smallest set that is a telephone system somebody can log in to. Add `agents`
# (dograh, the runtime that answers 8003) or `models`/`mail`/`support` with
# VULTR_PROFILES.
#
# RAM: telno builds its web bundle on the box and dograh's stack is ~1.5 GB at
# rest, so `agents` and `platform` together want 8 GB. On a 4 GB plan the build
# swap this script creates is what keeps it from being OOM-killed; it is slower,
# not broken.
#
# Requires bash, curl, tar, ssh/scp, ssh-keygen, node. No jq.

set -euo pipefail

API="https://api.vultr.com/v2"
HERE="$(cd "$(dirname "$0")" && pwd)"
CHRIST="$(cd "$HERE/.." && pwd)"
TREE="$(cd "$CHRIST/.." && pwd)"
STATE="$HERE/.vultr-christ.json"
KEY_FILE="$HERE/.vultr-key"

REGION="${VULTR_REGION:-ewr}"
PLAN="${VULTR_PLAN:-vc2-2c-4gb}"
LABEL="${VULTR_LABEL:-christ-demo}"
PROFILES="${VULTR_PROFILES:-core pstn console platform}"
REMOTE="/opt/christ"
SSH_OPTS=(-i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o LogLevel=ERROR)

need() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }
for dep in curl node base64 tar ssh scp ssh-keygen; do need "$dep"; done

if [ -z "${VULTR_API_KEY:-}" ] && [ -f "$HERE/.vultr-key.env" ]; then
  VULTR_API_KEY="$(sed -n 's/^VULTR_API_KEY=//p' "$HERE/.vultr-key.env" | head -1)"
fi
if [ -z "${VULTR_API_KEY:-}" ] && [ -f "$TREE/estate/tools/.vultr-key.env" ]; then
  VULTR_API_KEY="$(sed -n 's/^VULTR_API_KEY=//p' "$TREE/estate/tools/.vultr-key.env" | head -1)"
fi
have_key() { [ -n "${VULTR_API_KEY:-}" ] || { echo "VULTR_API_KEY is not set (env, christ/deploy/.vultr-key.env, or estate/tools/.vultr-key.env)" >&2; exit 1; }; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $VULTR_API_KEY")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}" "$API$path"
}

state_get() { node -e "try{const s=require(process.argv[1]);process.stdout.write(s[process.argv[2]]||'')}catch{}" "$STATE" "$1"; }
state_set() {
  node -e "
    const fs=require('fs'); const p=process.argv[1];
    let s={}; try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
    s[process.argv[2]]=process.argv[3];
    fs.writeFileSync(p, JSON.stringify(s)+'\n');
  " "$STATE" "$1" "$2"
}

b64e() { printf '%s' "$1" | base64 | tr -d '\n'; }

ensure_key() {
  if [ ! -f "$KEY_FILE" ]; then
    ssh-keygen -t ed25519 -N '' -C "$LABEL" -f "$KEY_FILE" >/dev/null
    echo "generated $KEY_FILE" >&2
  fi
  [ -f "$KEY_FILE.pub" ] || ssh-keygen -y -f "$KEY_FILE" >"$KEY_FILE.pub"
}

ensure_account_key() {
  local pub existing
  pub="$(cat "$KEY_FILE.pub")"
  existing="$(api GET '/ssh-keys' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const k=(j.ssh_keys||[]).find(x=>x.name==='$LABEL');process.stdout.write(k?k.id:'')})")"
  if [ -n "$existing" ]; then
    state_set ssh_key_id "$existing"
    return
  fi
  local id
  id="$(api POST '/ssh-keys' "$(node -e "process.stdout.write(JSON.stringify({name:process.argv[1],ssh_key:process.argv[2]}))" "$LABEL" "$pub")" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.ssh_key?.id||'')})")"
  [ -n "$id" ] || { echo "could not register the SSH key" >&2; exit 1; }
  state_set ssh_key_id "$id"
  echo "registered SSH key $id" >&2
}

wait_for_ip() {
  local id="$1" ip=''
  for _ in $(seq 1 60); do
    ip="$(api GET "/instances/$id" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const i=j.instance||{};process.stdout.write(i.status==='active'?(i.main_ip&&i.main_ip!=='0.0.0.0'?i.main_ip:''):'')})")"
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
    sleep 5
  done
  return 1
}

sh_remote() { ssh "${SSH_OPTS[@]}" "root@$1" "$2"; }

create() {
  have_key
  ensure_key
  ensure_account_key
  local key_id; key_id="$(state_get ssh_key_id)"

  local ip; ip="$(state_get ip)"
  if [ -n "$ip" ]; then
    echo "instance already recorded: $ip (run 'down' first for a fresh one)" >&2
    printf '%s' "$ip"; return 0
  fi

  # Written beside the script, not in /tmp: on Windows git-bash /tmp is a bash
  # convenience that node cannot open as a path, and the cloud-init body is read
  # by node when the request body is built.
  CLOUD_INIT="$HERE/.cloud-init.sh"
  cat > "$CLOUD_INIT" <<'CLOUD'
#!/bin/bash
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 curl ca-certificates python3
systemctl enable --now docker
# A building stack on a small plan is not a stack that needs more cores: the
# telno bundle and a dograh image pull both peak above the RAM a 4 GB plan has.
# Swap turns an OOM kill into a slow minute, and swappiness keeps the page
# cache for the containers that are actually serving calls.
if [ ! -f /swapfile ]; then
  fallocate -l 6G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=6144
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi
mkdir -p /opt/christ
CLOUD

  # Resolve the image rather than pin a numeric id: Vultr renumbers them and a
  # stale id fails with a 400 that does not say which image was wanted.
  local os_id
  os_id="$(api GET '/os?per_page=500' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const o=(j.os||[]).find(x=>x.arch==='x64'&&/ubuntu 24\.04/i.test(x.name));process.stdout.write(o?String(o.id):'')})")"
  [ -n "$os_id" ] || { echo "no Ubuntu 24.04 x64 image in $REGION" >&2; exit 1; }

  local body
  body="$(node -e "
    const fs=require('fs');
    process.stdout.write(JSON.stringify({
      region: process.argv[1],
      plan: process.argv[2],
      label: process.argv[3],
      sshkey_id: [process.argv[4]],
      os_id: Number(process.argv[5]),
      hostname: 'christ',
      // The v2 API wants user_data base64-encoded; a raw script is rejected
      // with an Invalid user_data 400.
      user_data: fs.readFileSync(process.argv[6]).toString('base64'),
      backups: 'disabled'
    }))" "$REGION" "$PLAN" "$LABEL" "$key_id" "$os_id" "$CLOUD_INIT")"

  local id
  id="$(api POST '/instances' "$body" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.instance?.id||'')})")"
  [ -n "$id" ] || { echo "instance creation failed: $(api POST '/instances' "$body")" >&2; exit 1; }
  state_set instance_id "$id"
  # Progress goes to stderr: this function's stdout is the address, and a
  # comment on that line becomes a hostname scp refuses.
  echo "created instance $id ($PLAN, $REGION) — waiting for an address" >&2

  ip="$(wait_for_ip "$id")" || { echo "instance did not become active in 5 minutes" >&2; exit 1; }
  state_set ip "$ip"
  printf '%s' "$ip"
}

pack() {
  local out="${1:-/tmp/christ-tree.tgz}"
  rm -f "$out"
  # Only what the selected profiles build, so the upload stays small: the whole
  # tree is 2.8 GB of history, and none of it is needed to run a phone system.
  # Excludes come before the member list: tar takes them positionally and warns
  # (then fails) when they trail the names they are meant to filter.
  tar czf "$out" -C "$TREE" \
    --exclude 'christ/out' --exclude 'christ/state' --exclude 'christ/.env' \
    --exclude 'christ/deploy/.vultr-key*' --exclude 'christ/deploy/.env.passthrough' \
    --exclude 'apps/telno/node_modules' --exclude 'apps/cantus-gateway/node_modules' \
    --exclude 'apps/telno/.env' --exclude 'apps/telno/web/dist' \
    christ apps/cantus-switch apps/cantus-gateway estate/console apps/telno \
    apps/capstone/dograh apps/capstone/scripts/dograh_wire.py
  [ -s "$out" ] || { echo "pack produced no archive" >&2; exit 1; }
  printf '%s' "$out"
}

upload_and_boot() {
  local ip="$1"
  local archive; archive="$(pack)"
  echo "uploading $(du -h "$archive" | cut -f1)…"
  scp "${SSH_OPTS[@]}" -q "$archive" "root@$ip:/tmp/christ-tree.tgz"

  local secret token
  secret="${CANTUS_SECRET:-$(state_get cantus_secret)}"
  secret="${secret:-$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")}"
  token="${CANTUS_CONTROL_TOKEN:-$(state_get cantus_token)}"
  token="${token:-$(node -e "process.stdout.write(require('crypto').randomBytes(18).toString('hex'))")}"
  state_set cantus_secret "$secret"
  state_set cantus_token "$token"

  # Secrets that must survive a redeploy: re-generating them would change the
  # ARI password the agent runtime holds and the admin password already in use,
  # and both failures look like a bug in the feature rather than a changed key.
  local admin_password ari_password dograh_jwt
  admin_password="${ADMIN_PASSWORD:-$(state_get admin_password)}"
  admin_password="${admin_password:-$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))")}"
  ari_password="${CANTUS_ARI_PASSWORD:-$(state_get ari_password)}"
  ari_password="${ari_password:-$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")}"
  dograh_jwt="${DOGRAH_JWT_SECRET:-$(state_get dograh_jwt)}"
  dograh_jwt="${dograh_jwt:-$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")}"
  local dograh_email="${DOGRAH_ADMIN_EMAIL:-ops@innotel.us}"
  state_set admin_password "$admin_password"
  state_set ari_password "$ari_password"
  state_set dograh_jwt "$dograh_jwt"

  local env_file
  env_file="$(cat <<ENV
CANTUS_DOMAIN=${CANTUS_DOMAIN:-estate.local}
CANTUS_SECRET=$secret
CANTUS_CONTROL_TOKEN=$token
CANTUS_ARI_USER=${CANTUS_ARI_USER:-dograh}
CANTUS_ARI_PASSWORD=$ari_password
CANTUS_ARI_APP=${CANTUS_ARI_APP:-dograh}
PUBLIC_IP=$ip
PUBLIC_URL=http://$ip:8090
SWITCH_PORT=8188
CHRIST_PORT=8001
ESTATE_PORT=8000
TELNO_PORT=8090
DOGRAH_PORT=8100
DOGRAH_UI_PORT=3010
DOGRAH_PUBLIC_URL=http://$ip:8100
DOGRAH_JWT_SECRET=$dograh_jwt
DOGRAH_DB_PASSWORD=${DOGRAH_DB_PASSWORD:-postgres}
DOGRAH_REDIS_PASSWORD=${DOGRAH_REDIS_PASSWORD:-redissecret}
MINIO_ROOT_USER=${MINIO_ROOT_USER:-minioadmin}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-minioadmin}
VOIPMS_SIP_HOST=${VOIPMS_SIP_HOST:-}
VOIPMS_SIP_PORT=${VOIPMS_SIP_PORT:-5060}
VOIPMS_SIP_USERNAME=${VOIPMS_SIP_USERNAME:-}
VOIPMS_SIP_PASSWORD=${VOIPMS_SIP_PASSWORD:-}
VOIPMS_SIP_FROM_USER=${VOIPMS_SIP_FROM_USER:-}
VOIPMS_SIP_DOMAIN=${VOIPMS_SIP_DOMAIN:-}
SIP_SRTP=${SIP_SRTP:-on}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@estate.local}
ADMIN_PASSWORD=$admin_password
ENV
)"

  local profiles='' p
  for p in $PROFILES; do
    profiles="$profiles --profile $p"
    # A URL for a container this selection does not run would make the board
    # report a broken product instead of an absent one.
    case "$p" in
      platform) env_file="$env_file
TELNO_URL=http://telno:8080" ;;
      pstn) env_file="$env_file
GATEWAY_URL=http://gateway:7454" ;;
      models) env_file="$env_file
OMNIROUTE_URL=http://omniroute:20128" ;;
      agents) env_file="$env_file
DOGRAH_URL=http://dograh-api:8000
DOGRAH_UI_URL=http://dograh-ui:3010" ;;
    esac
  done

  local script
  script="$(cat <<REMOTE
set -euo pipefail
cd /opt/christ
rm -rf jesus
mkdir -p jesus
tar xzf /tmp/christ-tree.tgz -C jesus
cat > jesus/christ/.env <<ENVEOF
$env_file
ENVEOF
cd jesus/christ
docker compose $profiles up -d --build 2>&1 | tail -20
docker compose $profiles ps
REMOTE
)"

  echo "booting the stack on $ip (first build takes a few minutes)…"
  sh_remote "$ip" "$script"
  echo
  echo "wiring estate.json into the switch…"
  sh_remote "$ip" "cd /opt/christ/jesus/christ && docker compose exec -T christ node cli.js wire --url http://switch:8088 --token $token"

  case " $PROFILES " in *" platform "*)
    # The platform becomes the inventory owner the moment it boots, so its first
    # line and the DID are created through its own API — the same two writes the
    # setup wizard makes. Waiting on healthz rather than sleep: a slow first
    # build is the normal case, and a seeded line on a container that is still
    # migrating is an empty line.
    echo
    echo "seeding the platform's first line and the DID…"
    sh_remote "$ip" "cd /opt/christ/jesus/christ && for i in \$(seq 1 60); do docker compose exec -T telno node -e \"fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\" && break; sleep 5; done"
    sh_remote "$ip" "cd /opt/christ/jesus/christ && docker compose exec -T -e TELNO_URL=http://telno:8080 christ node cli.js seed"
  ;;
  esac

  case " $PROFILES " in *" agents "*)
    echo
    echo "wiring the agent runtime to the switch…"
    # dograh signs up its first admin, imports the receptionist workflow, creates
    # the ARI configuration against THIS switch and binds 8003 to it. Idempotent:
    # a second run changes nothing that is already right.
    sh_remote "$ip" "cd /opt/christ/jesus/christ && for i in \$(seq 1 90); do curl -fsS http://127.0.0.1:8100/api/v1/health >/dev/null && break; sleep 5; done"
    # The ARI endpoint is the switch on the compose network, not this host's
    # loopback: dograh is a container, and 127.0.0.1 there is itself. The admin
    # address cannot be a `.local` one either — dograh validates it as an email
    # address and refuses special-use domains.
    sh_remote "$ip" "cd /opt/christ/jesus/apps/capstone && \
DOGRAH_API_ENDPOINT=http://127.0.0.1:8100 \
DOGRAH_ADMIN_EMAIL=$dograh_email \
DOGRAH_ADMIN_PASSWORD=$admin_password \
DOGRAH_ADMIN_NAME='CHRIST ops' \
DOGRAH_ARI_ENDPOINT=http://switch:8088 \
DOGRAH_ARI_APP_NAME=dograh \
DOGRAH_ARI_PASSWORD=$ari_password \
DOGRAH_WS_CLIENT_NAME=dograh \
DOGRAH_CONFIG_NAME='Cantus ARI (dograh)' \
python3 scripts/dograh_wire.py --env-file /opt/christ/jesus/christ/.env || true"
    echo
    echo "pointing the dial plan at the runtime's own Stasis application…"
    # The name is dograh's, not ours. Reading it back and re-wiring is what makes
    # the agent route answer instead of ringing an application nothing listens on.
    sh_remote "$ip" "cd /opt/christ/jesus/christ && export DOGRAH_API_TOKEN=\$(sed -n 's/^DOGRAH_API_TOKEN=//p' .env) && \
docker compose exec -T -e DOGRAH_API_TOKEN -e DOGRAH_URL christ node cli.js wire --url http://switch:8088 --token $token && \
docker compose restart telno"
  ;;
  esac
}

status() {
  have_key
  local ip id
  id="$(state_get instance_id)"; ip="$(state_get ip)"
  [ -n "$id" ] || { echo "no instance recorded — run 'up'" >&2; exit 1; }
  api GET "/instances/$id" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const i=JSON.parse(s).instance||{};
      console.log('instance', i.id, i.status, i.plan, i.region);
      console.log('address ', i.main_ip);
    })"
  echo
  echo "  board    http://$ip:8001/"
  echo "  switch   http://$ip:8188/v1/status"
  echo "  console  http://$ip:8000/"
  echo "  telno    http://$ip:8090/   (only with the platform profile)"
  echo "  dograh   http://$ip:3010/   (only with the agents profile; API on :8100)"
  echo "  wire     ./vultr.sh wire"
}

case "${1:-}" in
  up)
    ip="$(create)"
    upload_and_boot "$ip"
    echo
    status
    ;;
  pack) pack "${2:-/tmp/christ-tree.tgz}"; echo ;;
  status) status ;;
  ip) state_get ip; echo ;;
  ssh) exec ssh "${SSH_OPTS[@]}" "root@$(state_get ip)" ;;
  logs)
    ip="$(state_get ip)"
    sh_remote "$ip" "cd /opt/christ/jesus/christ && docker compose logs --tail=120"
    ;;
  wire)
    ip="$(state_get ip)"; token="$(state_get cantus_token)"
    sh_remote "$ip" "cd /opt/christ/jesus/christ && docker compose exec -T christ node cli.js wire --url http://switch:8088 --token $token"
    ;;
  down)
    have_key
    id="$(state_get instance_id)"
    [ -n "$id" ] && api DELETE "/instances/$id" >/dev/null && echo "destroyed $id"
    key="$(state_get ssh_key_id)"
    [ -n "$key" ] && api DELETE "/ssh-keys/$key" >/dev/null && echo "removed ssh key $key"
    rm -f "$STATE"
    ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
