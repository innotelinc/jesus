#!/usr/bin/env bash
# Create, deploy to, inspect and destroy the Vultr demo of the Cantus estate.
#
#   export VULTR_API_KEY=...        # or put the key in estate/tools/.vultr-key
#   ./vultr-demo.sh up              # create instance, upload this tree, boot the estate
#   ./vultr-demo.sh status          # instance state and the demo URLs
#   ./vultr-demo.sh logs            # the estate's boot log from the instance
#   ./vultr-demo.sh ip              # just the address (scriptable)
#   ./vultr-demo.sh ssh             # ssh in as root
#   ./vultr-demo.sh trunk <host> <user> <password> [did]   # point the gateway at a carrier
#   ./vultr-demo.sh pack [file]     # build the deployment archive without deploying
#   ./vultr-demo.sh down            # destroy the instance
#   ./vultr-demo.sh down --purge    # ...and the firewall group and SSH key
#
# What runs on the box is the tree *here*: `up` packs estate/, apps/cantus-switch
# and apps/telno, uploads the archive, and runs estate/up.sh over SSH. Nothing
# is cloned, so a branch that was never pushed cannot silently replace the code
# that was verified locally.
#
# Sizing: 2 vCPU / 2 GB. The running estate is small (switch ~80 MB, telno
# ~150 MB, console ~40 MB), but the telno image builds its web bundle on the
# instance, and on 1 vCPU / 1 GB that build does not fail — it starves the box:
# sshd stops answering mid-build, twice in a row, with 2.4 GB of swap in place.
# Vultr also rolled back an in-place resize, so the plan is chosen at creation
# here rather than patched afterwards. Override with VULTR_PLAN if you want to
# try something else.
#
# Requires bash, curl, tar, ssh/scp, ssh-keygen, base64, node. No jq.
set -euo pipefail

API="https://api.vultr.com/v2"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$HERE/.vultr-demo.json"
KEY_FILE="$HERE/.vultr-key"

REGION="${VULTR_REGION:-ewr}"
PLAN="${VULTR_PLAN:-vc2-2c-2gb}"
LABEL="${VULTR_LABEL:-cantus-estate-demo}"
FW_DESC="cantus-estate-demo"
SSH_KEY_NAME="cantus-estate-demo"
ESTATE_DIR="/opt/cantus-estate"
SSH_OPTS=(-i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o LogLevel=ERROR)

need() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }
for dep in curl node base64 tar ssh scp ssh-keygen; do need "$dep"; done

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# Values that go over SSH are base64ed first: a sub-account password may hold
# quotes, spaces or a `$`, and this string is handed to a remote shell.
b64e() { printf '%s' "$1" | base64 | tr -d '\n'; }

# The key can live in the environment or in the git-ignored file, so a deploy is
# one command on a machine that has the file and no exported secret.
if [ -z "${VULTR_API_KEY:-}" ] && [ -f "$HERE/.vultr-key.env" ]; then
  VULTR_API_KEY="$(sed -n 's/^VULTR_API_KEY=//p' "$HERE/.vultr-key.env" | head -1)"
fi
# `pack` is local and must work without an account; everything that talks to
# Vultr checks the key at the call, not at startup.
require_key() {
  [ -n "${VULTR_API_KEY:-}" ] || {
    echo "set VULTR_API_KEY (Vultr → Account → API), or put it in $HERE/.vultr-key.env as VULTR_API_KEY=..." >&2
    exit 1
  }
}

# Read JSON on stdin, print the result of a JS expression over `j`.
get() { EXPR="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");const v=eval(process.env.EXPR);process.stdout.write(v==null?"":String(v))})'; }

api() {
  # api METHOD PATH [BODY] -> body on stdout; non-2xx is fatal
  require_key
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  local out status
  out="$(curl "${args[@]}" -w '\n%{http_code}' "$API$path")"
  status="$(printf '%s' "$out" | tail -n1)"
  out="$(printf '%s' "$out" | sed '$d')"
  if [ "${status:0:1}" != "2" ]; then
    echo "vultr: $method $path -> $status" >&2
    echo "$out" >&2
    # Deployments call this from command substitutions (`id="$(api …)"`), where
    # a plain `exit 1` only leaves the subshell and the caller carries on with an
    # empty id — which is how an IP allowlist refusal once became "instance
    # created". $$ is the parent shell even inside a substitution, so the whole
    # run stops here.
    kill -TERM $$ 2>/dev/null || exit 1
    exit 1
  fi
  printf '%s' "$out"
}

# `api ... | get ...` hides the API's exit status behind get's, which is how a
# 401 once looked like a successful call with an undefined field. These two
# helpers keep the failure where it belongs: the request.
api_get() { # api_get PATH EXPR
  local body
  body="$(api GET "$1")"
  printf '%s' "$body" | get "$2"
}

api_send() { # api_send METHOD PATH BODY EXPR
  local body
  body="$(api "$1" "$2" "$3")"
  printf '%s' "$body" | get "$4"
}

save_state() {
  IID="$1" FID="$2" IPADDR="$3" KID="$4" node -e 'process.stdout.write(JSON.stringify({instance_id:process.env.IID,firewall_id:process.env.FID,ip:process.env.IPADDR,ssh_key_id:process.env.KID})+`\n`)' > "$STATE"
}

load_state() {
  [ -f "$STATE" ] || { echo "no demo recorded in $STATE; run '$0 up' first" >&2; exit 1; }
  INSTANCE_ID="$(get 'j.instance_id' < "$STATE")"
  FIREWALL_ID="$(get 'j.firewall_id' < "$STATE")"
  IP="$(get 'j.ip' < "$STATE")"
  SSH_KEY_ID="$(get 'j.ssh_key_id' < "$STATE")"
}

resolve_os() {
  api_get "/os?per_page=500" '((j.os||[]).find(o=>o.arch==="x64"&&/ubuntu 24\.04/i.test(o.name))||{}).id'
}

ensure_ssh_key() {
  # One dedicated key pair, generated here, so the script never needs the
  # operator's own key and never asks for a password. It is git-ignored with the
  # rest of the local state.
  if [ ! -f "$KEY_FILE" ]; then
    echo "[vultr] generating an SSH key for the demo ($KEY_FILE)" >&2
    ssh-keygen -q -t ed25519 -N '' -C "$SSH_KEY_NAME" -f "$KEY_FILE"
  fi
  local pub existing
  pub="$(cat "$KEY_FILE.pub")"
  existing="$(NAME="$SSH_KEY_NAME" api_get "/ssh-keys?per_page=200" '(((j.ssh_keys||[]).find(k=>k.name===process.env.NAME))||{}).id')"
  if [ -n "$existing" ]; then
    printf '%s' "$existing"
    return
  fi
  api_send POST "/ssh-keys" "$(NAME="$SSH_KEY_NAME" PUB="$pub" node -e 'process.stdout.write(JSON.stringify({name:process.env.NAME,ssh_key:process.env.PUB}))')" 'j.ssh_key.id'
}

firewall_rule() {
  PROTO="$1" PORT="$2" SUBNET="$3" SIZE="$4" NOTES="$5" node -e '
    process.stdout.write(JSON.stringify({
      protocol: process.env.PROTO,
      port: process.env.PORT,
      subnet: process.env.SUBNET,
      subnet_size: Number(process.env.SIZE),
      // Vultr rejects the rule with "Missing required field ip_type" without
      // it; the API docs only mention it under IPv6.
      ip_type: "v4",
      action: "accept",
      notes: process.env.NOTES,
    }))'
}

# Rules are reconciled, not just added at group creation: the rules POST can fail
# after the group exists (it did — a missing ip_type), and a group that already
# exists but has no rules would attach an unreachable firewall to the instance.
ensure_firewall_rule() { # id proto port subnet size notes [update]
  local id="$1" proto="$2" port="$3" subnet="$4" size="$5" notes="$6" mode="${7:-}"
  local found rid current cursize
  found="$(NOTES="$notes" PORT="$port" PROTO="$proto" api_get "/firewalls/$id/rules" \
    '(()=>{const r=((j.firewall_rules||[]).find(x=>x.notes===process.env.NOTES||(x.protocol===process.env.PROTO&&String(x.port)===process.env.PORT)))||{};return [r.id||"",r.subnet||"",r.subnet_size??""].join("\t")})()')"
  rid="$(printf '%s' "$found" | cut -f1)"
  current="$(printf '%s' "$found" | cut -f2)"
  cursize="$(printf '%s' "$found" | cut -f3)"
  if [ -z "$rid" ]; then
    api POST "/firewalls/$id/rules" "$(firewall_rule "$proto" "$port" "$subnet" "$size" "$notes")" >/dev/null
    return 0
  fi
  # A rule that exists with the wrong source is worse than a missing one: the
  # firewall looks configured and locks you out. The SSH rule carries the
  # caller's address, which changes — on a NAT pool it can change between
  # flows — so it is rewritten when it drifts.
  #
  # Delete and re-create, not PATCH: the rules endpoint answers PATCH with 204
  # and changes nothing at all, so an operator whose address had moved was left
  # with a correct-looking allowlist and a box that dropped their packets. PUT
  # is refused with 405, and POST to an existing rule id is not an update.
  if [ "$mode" = update ] && { [ "$current" != "$subnet" ] || [ "$cursize" != "$size" ]; }; then
    api DELETE "/firewalls/$id/rules/$rid" >/dev/null
    api POST "/firewalls/$id/rules" "$(firewall_rule "$proto" "$port" "$subnet" "$size" "$notes")" >/dev/null
  fi
  return 0
}

ensure_firewall() {
  local id
  id="$(DESC="$FW_DESC" api_get "/firewalls?per_page=200" '(((j.firewall_groups||[]).find(g=>g.description===process.env.DESC))||{}).id')"
  if [ -z "$id" ]; then
    id="$(api_send POST "/firewalls" "$(DESC="$FW_DESC" node -e 'process.stdout.write(JSON.stringify({description:process.env.DESC}))')" 'j.firewall_group.id')"
    [ -n "$id" ] || { echo "vultr: firewall group creation returned no id" >&2; exit 1; }
  fi

  # Only what the demo serves. SSH is limited to the caller's address when it
  # can be discovered — a throwaway box is still not a reason to leave port 22
  # open to the world silently.
  local ssh_subnet="0.0.0.0" ssh_size=0 myip
  myip="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "$myip" ]; then ssh_subnet="$myip"; ssh_size=32; fi

  ensure_firewall_rule "$id" tcp 22 "$ssh_subnet" "$ssh_size" ssh update
  ensure_firewall_rule "$id" tcp 8000 0.0.0.0 0 console
  ensure_firewall_rule "$id" tcp 8188 0.0.0.0 0 'switch api + softphone'
  ensure_firewall_rule "$id" tcp 8090 0.0.0.0 0 telno
  ensure_firewall_rule "$id" udp 7443 0.0.0.0 0 'cantus signalling + media'
  ensure_firewall_rule "$id" udp 7444 0.0.0.0 0 'cantus relay'
  # The PSTN boundary: SIP to the carrier and the RTP range the gateway binds.
  # Nothing else in the estate needs a port range, which is the point.
  ensure_firewall_rule "$id" udp 5060 0.0.0.0 0 'sip trunk'
  ensure_firewall_rule "$id" udp "40000:40063" 0.0.0.0 0 'gateway rtp'
  printf '%s' "$id"
}

# The deployable tree: what `up` uploads and what `pack` writes.
pack() {
  local out="$1"
  # node_modules, build output and local state are rebuilt by the Dockerfile and
  # by up.sh on the instance; shipping them would be slower and can mask a
  # missing build step.
  tar -czf "$out" -C "$ROOT" \
    --exclude='estate/.env' \
    --exclude='estate/tools/.vultr-*' \
    --exclude='node_modules' \
    --exclude='*/node_modules/*' \
    --exclude='.git' \
    --exclude='*/data' \
    --exclude='*/data/*' \
    --exclude='*/web/dist' \
    --exclude='*.log' \
    estate apps/cantus-switch apps/telno apps/cantus-gateway
}

wait_for_ssh() {
  # The wait is not just for sshd: cloud-init installs Docker first, and the
  # ready marker only appears afterwards. The delays grow on purpose. A steady
  # 5 s retry against port 22 gets throttled upstream — in a live run the box
  # went unreachable on 22 while 8000 kept answering, which reads exactly like a
  # dead instance and is not one.
  local tries=1 delay=5
  printf '[vultr] waiting for ssh' >&2
  while [ "$tries" -le 24 ]; do
    if ssh "${SSH_OPTS[@]}" "root@$IP" 'test -f /var/lib/cantus-demo-ready' >/dev/null 2>&1; then
      printf '\n' >&2
      return 0
    fi
    tries=$((tries + 1))
    printf '.' >&2
    sleep "$delay"
    if [ "$tries" -gt 6 ]; then delay=20; elif [ "$tries" -gt 3 ]; then delay=10; fi
  done
  printf '\n' >&2
  echo "[vultr] ssh did not become ready; the instance is at $IP" >&2
  echo "[vultr] if 8000 answers but 22 does not, port 22 is being throttled — wait a minute and rerun '$0 deploy $IP'" >&2
  exit 1
}

remote() { ssh "${SSH_OPTS[@]}" "root@$IP" "$@"; }

# Everything after the address is known: upload the tree, start it, wait for the
# console. Shared by `up` (instance created here) and `deploy` (instance created
# in the Vultr web UI, which needs no API key at all).
upload_and_start() {
  wait_for_ssh

  # A redeploy over a running estate must not report success before the rebuild
  # lands: the console answers on 8000 from the *old* containers the whole time,
  # so polling it proved nothing, and a new image read as deployed while the
  # previous one was still serving. Start times are the cheap proof that
  # `docker compose up --build` actually replaced something — all three that
  # carry code, because a run that changes only the switch never restarts telno
  # and used to wait the full ten minutes before reporting a failure.
  local inspected="docker inspect -f '{{.Name}} {{.State.StartedAt}}' estate-switch estate-telno estate-gateway 2>/dev/null || true"
  local started_before
  started_before="$(remote "$inspected" || true)"

  local archive
  archive="$(mktemp -t cantus-estate.XXXXXX).tgz"
  echo "[vultr] packing the tree …" >&2
  pack "$archive"
  echo "[vultr] uploading $(du -h "$archive" | cut -f1) …" >&2
  scp -q "${SSH_OPTS[@]}" "$archive" "root@$IP:/tmp/cantus-estate.tgz"
  rm -f "$archive"

  echo "[vultr] starting the estate on the instance (this builds two images)" >&2
  remote "set -eu
    mkdir -p $ESTATE_DIR
    tar -xzf /tmp/cantus-estate.tgz -C $ESTATE_DIR
    chmod +x $ESTATE_DIR/estate/up.sh
    cd $ESTATE_DIR/estate
    nohup ./up.sh up > /var/log/estate-up.log 2>&1 &
    echo started"

  echo "[vultr] waiting for the console" >&2
  local tries=0
  until curl -fsS --max-time 5 "http://$IP:8000/healthz" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 120 ]; then
      echo "[vultr] the console did not answer in 10 minutes; see '$0 logs'" >&2
      exit 1
    fi
    sleep 5
  done

  echo "[vultr] waiting for the rebuilt containers" >&2
  tries=0
  local started_now
  while :; do
    started_now="$(remote "$inspected" || true)"
    if [ -n "$started_now" ] && [ "$started_now" != "$started_before" ] \
      && curl -fsS --max-time 5 "http://$IP:8090/api/healthz" >/dev/null 2>&1 \
      && curl -fsS --max-time 5 "http://$IP:8188/healthz" >/dev/null 2>&1; then
      break
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt 120 ]; then
      echo "[vultr] the estate containers did not restart in 10 minutes; see '$0 logs'" >&2
      exit 1
    fi
    sleep 5
  done

  # The estate is up at this point; a failed motd edit must not turn a working
  # deploy into an error (it did, once ssh throttled in the middle of one).
  remote "sed -i 's#http://<ip>:8000#http://$IP:8000#; s#http://<ip>:8188/v1/status#http://$IP:8188/v1/status#; s#http://<ip>:8090#http://$IP:8090#' /etc/motd" \
    || echo "[vultr] could not update /etc/motd (ssh dropped); the estate is up regardless" >&2
}

cmd_up() {
  if [ -f "$STATE" ]; then
    load_state
    if api GET "/instances/$INSTANCE_ID" >/dev/null 2>&1; then
      echo "an instance already exists ($INSTANCE_ID at ${IP:-?}); run '$0 status' or '$0 down'" >&2
      exit 1
    fi
    rm -f "$STATE"
  fi

  local os_id fw_id key_id
  os_id="$(resolve_os)"
  [ -n "$os_id" ] || { echo "could not find an Ubuntu 24.04 x64 image; check VULTR_REGION" >&2; exit 1; }
  key_id="$(ensure_ssh_key)"
  [ -n "$key_id" ] || { echo "vultr: ssh key registration returned no id" >&2; exit 1; }
  echo "[vultr] firewall group …" >&2
  fw_id="$(ensure_firewall)"

  local user_data
  user_data="$(sed -e "s#@ESTATE_DIR@#${ESTATE_DIR}#g" "$HERE/cloud-init.sh" | base64 | tr -d '\n')"

  echo "[vultr] creating $PLAN in $REGION …" >&2
  local body
  body="$(REGION="$REGION" PLAN="$PLAN" LABEL="$LABEL" OS_ID="$os_id" FW="$fw_id" KEY="$key_id" UD="$user_data" node -e '
    process.stdout.write(JSON.stringify({
      region: process.env.REGION,
      plan: process.env.PLAN,
      os_id: Number(process.env.OS_ID),
      label: process.env.LABEL,
      hostname: process.env.LABEL.slice(0, 60),
      firewall_group_id: process.env.FW,
      // v2 wants a list here; a bare string is rejected with "sshkey_id must be
      // an array".
      sshkey_id: [process.env.KEY],
      user_data: process.env.UD,
      backups: "disabled",
      enable_ipv6: false,
      tags: ["cantus-estate", "demo"],
    }))')"
  INSTANCE_ID="$(api_send POST "/instances" "$body" 'j.instance.id')"
  [ -n "$INSTANCE_ID" ] || { echo "vultr: instance creation returned no id" >&2; exit 1; }
  save_state "$INSTANCE_ID" "$fw_id" "" "$key_id"
  echo "[vultr] instance $INSTANCE_ID created; booting" >&2

  cmd_status --wait
  upload_and_start
  cmd_status
}

# Deploy to an instance this script did not create: one you made in the Vultr
# web UI (or any Ubuntu box with Docker-install rights) whose /root is reachable
# with tools/.vultr-key. Needs no API key.
cmd_deploy() {
  IP="${1:-}"
  [ -n "$IP" ] || { echo "usage: $0 deploy <ip>" >&2; exit 2; }
  echo "[deploy] $IP — make sure root@$IP authorises $KEY_FILE.pub" >&2
  upload_and_start
  echo
  echo "  console    http://$IP:8000"
  echo "  switch     http://$IP:8188/v1/status"
  echo "  telno      http://$IP:8090"
  echo "  ARI        http://$IP:8188/ari/asterisk/info"
  echo
  echo "  boot log   $0 ssh 'tail -n 40 /var/log/estate-up.log'"
}

cmd_status() {
  load_state
  local wait=0
  [ "${1:-}" = "--wait" ] && wait=1
  # `addr`, not `ip`: a local named `ip` shadows the global the rest of the
  # script uses for the address, and the URLs below come out with no host.
  local tries=0 state addr info
  while :; do
    info="$(api GET "/instances/$INSTANCE_ID")"
    state="$(printf '%s' "$info" | get 'j.instance.status')"
    addr="$(printf '%s' "$info" | get 'j.instance.main_ip')"
    if [ "$state" = "active" ] && [ -n "$addr" ] && [ "$addr" != "0.0.0.0" ]; then break; fi
    [ "$wait" = "0" ] && break
    tries=$((tries + 1))
    [ "$tries" -gt 90 ] && { echo "[vultr] still $state after 15 min; check the Vultr console" >&2; exit 1; }
    printf '[vultr] %s …\n' "$state" >&2
    sleep 10
  done
  save_state "$INSTANCE_ID" "$FIREWALL_ID" "$addr" "$SSH_KEY_ID"
  IP="$addr"
  echo
  echo "  instance   $INSTANCE_ID   $state   $IP"
  [ -n "$IP" ] && [ "$IP" != "0.0.0.0" ] || return 0
  echo "  console    http://$IP:8000"
  echo "  switch     http://$IP:8188/v1/status"
  echo "  telno      http://$IP:8090"
  echo "  ARI        http://$IP:8188/ari/asterisk/info"
  echo
  echo "  boot log   $0 logs"
  echo "  telno owner password (printed once, on first boot):"
  echo "             $0 ssh 'cd $ESTATE_DIR/estate && docker compose logs telno | grep -i password'"
}

cmd_logs() {
  load_state
  remote "tail -n 40 /var/log/estate-up.log 2>/dev/null || echo 'no boot log yet'"
}

cmd_ip() {
  load_state
  api_get "/instances/$INSTANCE_ID" 'j.instance.main_ip'
  echo
}

cmd_ssh() {
  load_state
  [ -n "$IP" ] && [ "$IP" != "0.0.0.0" ] || IP="$(cmd_ip)"
  if [ "$#" -gt 0 ]; then
    remote "$@"
  else
    exec ssh "${SSH_OPTS[@]}" "root@$IP"
  fi
}

# Hand the deployed gateway a carrier. The credentials only ever travel to the
# box: they are written to its .env (mode 600, git-ignored) and never echoed
# back, and the command ends by asking the gateway whether it registered.
cmd_trunk() {
  load_state
  [ -n "${IP:-}" ] && [ "$IP" != "0.0.0.0" ] || IP="$(cmd_ip)"
  local host="${1:-}" user="${2:-}" pass="${3:-}" did="${4:-}" port="${5:-5060}"
  if [ -z "$host" ] || [ -z "$user" ] || [ -z "$pass" ]; then
    echo "usage: $0 trunk <sip-host> <sub-account> <password> [presented-number] [port]" >&2
    echo "   eg: $0 trunk atlanta.voip.ms 123456_switch 'sub-account-password' 14132642700" >&2
    exit 2
  fi
  [ "$port" = "5060" ] || echo "[vultr] using SIP port $port" >&2
  echo "[vultr] writing the trunk into $ESTATE_DIR/estate/.env on $IP" >&2
  remote "set -eu
    cd $ESTATE_DIR/estate
    VOIPMS_SIP_HOST=\$(printf '%s' '$(b64e "$host")' | base64 -d) \
    VOIPMS_SIP_PORT='$port' \
    VOIPMS_SIP_USERNAME=\$(printf '%s' '$(b64e "$user")' | base64 -d) \
    VOIPMS_SIP_PASSWORD=\$(printf '%s' '$(b64e "$pass")' | base64 -d) \
    VOIPMS_SIP_DOMAIN=\$(printf '%s' '$(b64e "$host")' | base64 -d) \
    VOIPMS_SIP_FROM_USER='$(printf '%s' "$did" | tr -cd '0-9+')' \
    sh ./up.sh env
    docker compose up -d gateway >/dev/null
    echo written"

  echo "[vultr] waiting for the trunk to register" >&2
  local tries=0 body
  while :; do
    body="$(remote "curl -sS --max-time 5 http://127.0.0.1:7454/healthz || true" || true)"
    case "$body" in
      *'"ok":true'*) break ;;
    esac
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      echo "[vultr] the gateway is not registered: $body" >&2
      echo "[vultr] the carrier's own reason is the one that matters:" >&2
      remote "docker logs --tail 20 estate-gateway 2>&1 | grep -i -e sip -e register || docker logs --tail 20 estate-gateway" >&2 || true
      exit 1
    fi
    sleep 2
  done
  echo "[vultr] trunk registered" >&2
  echo "$body"
}

cmd_down() {
  load_state
  echo "[vultr] destroying instance $INSTANCE_ID" >&2
  api DELETE "/instances/$INSTANCE_ID" >/dev/null || true
  if [ "${1:-}" = "--purge" ]; then
    [ -n "$FIREWALL_ID" ] && { echo "[vultr] destroying firewall group $FIREWALL_ID" >&2; api DELETE "/firewalls/$FIREWALL_ID" >/dev/null || true; }
    [ -n "$SSH_KEY_ID" ] && { echo "[vultr] destroying ssh key $SSH_KEY_ID" >&2; api DELETE "/ssh-keys/$SSH_KEY_ID" >/dev/null || true; }
  fi
  rm -f "$STATE"
  echo "[vultr] gone"
}

case "${1:-}" in
  up) cmd_up ;;
  status) shift; cmd_status "${1:-}" ;;
  logs) cmd_logs ;;
  ip) cmd_ip ;;
  ssh) shift; cmd_ssh "$@" ;;
  pack) shift; pack "${1:-$HERE/estate-demo.tgz}"; echo "wrote ${1:-$HERE/estate-demo.tgz}" ;;
  trunk) shift; cmd_trunk "$@" ;;
  deploy) shift; cmd_deploy "${1:-}" ;;
  down) shift; cmd_down "${1:-}" ;;
  *) usage ;;
esac
