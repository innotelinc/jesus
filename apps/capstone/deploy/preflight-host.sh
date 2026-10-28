#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# capstone — host preflight
#
# Answers one question before you spend an afternoon on `setup.sh`: will this
# box carry the stack? Every requirement below is derived from this repository,
# not from a generic sizing guide.
#
#   ./deploy/preflight-host.sh                 # check THIS box
#   CAPSTONE_RAM_GIB=16 CAPSTONE_CPU=8 \
#     ./deploy/preflight-host.sh --plan         # size a host you don't have yet
#
# Exit status: 0 = no FAIL, 1 = at least one FAIL. WARN never fails the run.
# Requirements: bash, coreutils. python3 is used for port and JSON probes when
# present; the checks that need it are skipped (not failed) without it.
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Thresholds. The floor and the recommendation are separate because the stack
# does run below the recommendation — it just has no headroom for a rebuild.
MIN_RAM_GIB="${CAPSTONE_MIN_RAM_GIB:-8}"      # capstone alone measured at 5.84 GiB
REC_RAM_GIB="${CAPSTONE_REC_RAM_GIB:-12}"     # the reference host is 13.1 GiB
MIN_CPU="${CAPSTONE_MIN_CPU:-2}"
REC_CPU="${CAPSTONE_REC_CPU:-4}"
MIN_DISK_GIB="${CAPSTONE_MIN_DISK_GIB:-50}"   # ~50 GB data disk in the live-USB docs
REC_DISK_GIB="${CAPSTONE_REC_DISK_GIB:-100}"
INSTALL_DIR="${CAPSTONE_INSTALL_DIR:-$REPO}"

PLAN=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --plan) PLAN=1 ;;
    --json) JSON=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Spec overrides put the script in planning mode: you are sizing a host you have
# not provisioned, so runtime checks (docker, ports, …) are irrelevant and skipped.
if [ -n "${CAPSTONE_ARCH:-}${CAPSTONE_OS:-}${CAPSTONE_CPU:-}${CAPSTONE_RAM_GIB:-}${CAPSTONE_DISK_GIB:-}" ]; then
  PLAN=1
fi

RED=''; GREEN=''; YELLOW=''; DIM=''; NC=''
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'
fi

IDS=(); STATES=(); DETAILS=()
fails=0; warns=0; oks=0

record() { # id state detail
  IDS+=("$1"); STATES+=("$2"); DETAILS+=("$3")
  case "$2" in
    PASS) oks=$((oks + 1)) ;;
    WARN) warns=$((warns + 1)) ;;
    FAIL) fails=$((fails + 1)) ;;
  esac
  [ "$JSON" = "1" ] && return 0
  local colour="$GREEN" tag="PASS"
  case "$2" in
    WARN) colour="$YELLOW"; tag="WARN" ;;
    FAIL) colour="$RED";    tag="FAIL" ;;
    SKIP) colour="$DIM";    tag="SKIP" ;;
  esac
  printf '%b%-4s%b %-22s %s\n' "$colour" "$tag" "$NC" "$1" "$3"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── facts about this machine ─────────────────────────────────────────────────
ARCH="${CAPSTONE_ARCH:-$(uname -m 2>/dev/null || echo unknown)}"
OS="${CAPSTONE_OS:-$(uname -s 2>/dev/null || echo unknown)}"
CPU="${CAPSTONE_CPU:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 0)}"

if [ -n "${CAPSTONE_RAM_GIB:-}" ]; then
  RAM_GIB="$CAPSTONE_RAM_GIB"
elif [ -r /proc/meminfo ]; then
  RAM_GIB="$(awk '/^MemTotal:/{printf "%d", $2/1048576}' /proc/meminfo)"
else
  RAM_GIB=0
fi

if [ -n "${CAPSTONE_DISK_GIB:-}" ]; then
  DISK_GIB="$CAPSTONE_DISK_GIB"
elif have df; then
  DISK_GIB="$(df -Pk "$INSTALL_DIR" 2>/dev/null | awk 'NR==2{printf "%d", $4/1048576}')"
  DISK_GIB="${DISK_GIB:-0}"
else
  DISK_GIB=0
fi

[ "$JSON" = "1" ] || {
  echo "══════════════════════════════════════════════════════════════"
  echo "  Capstone — host preflight${PLAN:+ }"
  [ "$PLAN" = "1" ] && echo "  planning mode: runtime checks skipped"
  echo "══════════════════════════════════════════════════════════════"
  echo ""
}

# ── 1. architecture and OS ───────────────────────────────────────────────────
# Not a preference: the image set and the release ISO are amd64. Everything
# else on a phone/arm64 box is a port project, not a deploy.
case "$ARCH" in
  x86_64|amd64) record "arch" PASS "$ARCH" ;;
  arm64|aarch64) record "arch" FAIL "$ARCH — images/live ISO are amd64-only; arm64 needs a port (see docs/phone-node.md)" ;;
  *) record "arch" FAIL "$ARCH — only x86_64 is supported" ;;
esac

case "$OS" in
  Linux) record "os" PASS "Linux" ;;
  Darwin) record "os" FAIL "macOS — Asterisk needs host networking and the compose stack targets Linux" ;;
  *) record "os" FAIL "$OS — Linux required" ;;
esac

# ── 2. compute ──────────────────────────────────────────────────────────────
if [ "$CPU" -ge "$REC_CPU" ] 2>/dev/null; then
  record "cpu" PASS "$CPU vCPU (recommended $REC_CPU+)"
elif [ "$CPU" -ge "$MIN_CPU" ] 2>/dev/null; then
  record "cpu" WARN "$CPU vCPU — works, but builds and STT/TTS will be slow (recommended $REC_CPU+)"
else
  record "cpu" FAIL "$CPU vCPU — below the $MIN_CPU vCPU floor"
fi

if [ "$RAM_GIB" -ge "$REC_RAM_GIB" ] 2>/dev/null; then
  record "ram" PASS "${RAM_GIB} GiB (recommended $REC_RAM_GIB+)"
elif [ "$RAM_GIB" -ge "$MIN_RAM_GIB" ] 2>/dev/null; then
  record "ram" WARN "${RAM_GIB} GiB — Capstone alone measured at 5.84 GiB; little headroom (recommended $REC_RAM_GIB+)"
else
  record "ram" FAIL "${RAM_GIB} GiB — below the $MIN_RAM_GIB GiB floor (Capstone alone measured at 5.84 GiB in docs/host-move.md)"
fi

if [ "$DISK_GIB" -ge "$REC_DISK_GIB" ] 2>/dev/null; then
  record "disk" PASS "${DISK_GIB} GiB free at $INSTALL_DIR"
elif [ "$DISK_GIB" -ge "$MIN_DISK_GIB" ] 2>/dev/null; then
  record "disk" WARN "${DISK_GIB} GiB free — enough for the stack, tight for images + recordings (recommended $REC_DISK_GIB+)"
else
  record "disk" FAIL "${DISK_GIB} GiB free at $INSTALL_DIR — below the $MIN_DISK_GIB GiB floor"
fi

# ── 3. runtime ──────────────────────────────────────────────────────────────
if [ "$PLAN" = "1" ]; then
  for id in docker compose tools systemd swap timesync ports; do
    record "$id" SKIP "planning mode — size decided, runtime not inspected"
  done
else
  if have docker; then
    if server="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" && [ -n "$server" ]; then
      record "docker" PASS "engine $server"
    else
      record "docker" FAIL "docker CLI present but the daemon is not reachable (add your user to the docker group / start dockerd)"
    fi
  else
    record "docker" FAIL "docker not installed — see docs/host-bringup.md step 2"
  fi

  if have docker && docker compose version >/dev/null 2>&1; then
    record "compose" PASS "$(docker compose version --short 2>/dev/null || echo 'v2')"
  else
    record "compose" FAIL "Docker Compose v2 plugin missing — setup.sh requires it"
  fi

  missing=""
  for tool in openssl curl python3 git; do
    have "$tool" || missing="$missing $tool"
  done
  if [ -z "$missing" ]; then
    record "tools" PASS "openssl, curl, python3, git"
  else
    record "tools" FAIL "missing:$missing"
  fi

  if [ -d /run/systemd/system ]; then
    record "systemd" PASS "running as PID 1"
  else
    record "systemd" WARN "systemd not PID 1 — the units in systemd/ will not install; the stack still runs"
  fi

  swap_kb="$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "${swap_kb:-0}" -gt 0 ] 2>/dev/null; then
    record "swap" PASS "$((swap_kb / 1048576)) GiB"
  else
    record "swap" WARN "no swap — a rebuild under memory pressure will OOM-kill containers"
  fi

  if have timedatectl; then
    sync="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
    case "$sync" in
      yes) record "timesync" PASS "NTP synchronised" ;;
      no) record "timesync" WARN "clock not synchronised — Asterisk TLS and ARI tokens are time-sensitive" ;;
      *) record "timesync" WARN "cannot read NTP state" ;;
    esac
  else
    record "timesync" WARN "timedatectl absent — verify the clock is NTP-synced"
  fi

  # Ports the stack binds on the host. Busy is a WARN, not a FAIL: a re-run
  # against an already-running stack is normal and setup.sh is idempotent.
  if have python3; then
    busy="$(python3 - "$@" <<'PY'
import socket, sys
targets = [(80, "tcp"), (443, "tcp"), (5060, "udp"), (8088, "tcp"), (8089, "tcp"),
           (3478, "tcp"), (3478, "udp")]
busy = []
for port, kind in targets:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", port))
    except OSError:
        busy.append(f"{port}/{kind}")
    finally:
        s.close()
print(" ".join(busy))
PY
)"
    if [ -z "$busy" ]; then
      record "ports" PASS "80, 443, 5060/udp, 8088, 8089, 3478 free"
    else
      record "ports" WARN "in use: $busy — fine if Capstone is already running, else stop the other service"
    fi
  else
    record "ports" SKIP "python3 absent — cannot probe ports"
  fi
fi

# ── verdict ─────────────────────────────────────────────────────────────────
if [ "$JSON" = "1" ]; then
  python3 - "$fails" "${#IDS[@]}" "${IDS[*]}" "${STATES[*]}" <<'PY'
import json, sys
fails, n, ids, states = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3].split(), sys.argv[4].split()
print(json.dumps({"ok": fails == 0, "checks": [{"id": i, "status": s} for i, s in zip(ids, states)]}, indent=2))
PY
else
  echo ""
  if [ "$fails" -eq 0 ]; then
    printf '%b%s%b\n' "$GREEN" "READY — no blocking problems found." "$NC"
    [ "$warns" -gt 0 ] && echo "  $warns warning(s) above: read them before an unattended rebuild."
    echo "  Next: docs/host-bringup.md step 3 (./scripts/setup.sh)"
  else
    printf '%b%s%b\n' "$RED" "NOT READY — $fails blocking problem(s) above." "$NC"
    echo "  See docs/host-bringup.md for the fix for each one."
  fi
fi

[ "$fails" -eq 0 ] && exit 0
exit 1
