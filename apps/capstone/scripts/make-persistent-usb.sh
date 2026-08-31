#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# make-persistent-usb.sh — write the Capstone live ISO to a USB stick and set
# up persistent storage so the live session saves across reboots.
#
# Layout produced on the stick (example sizes for a 64 GB USB):
#
#   partition 1  Capstone live ISO (read-only boot medium)     ~4 GB
#   partition 2  "persistence" — live-session overlay          8 GB  (env)
#   partition 3  "CAPSTONE_DATA" — a normal ext4 DATA drive    rest  (~50 GB)
#
# How persistence works (live-boot):
#   • `persistence` is on the kernel cmdline (baked into the ISO by
#     scripts/build-live-usb.sh via BOOTARGS), so the running live system
#     looks for a writable volume labeled `persistence` and overlays the
#     root filesystem on it. Anything you change/install in the live session
#     (packages, config, home) survives a power-off.
#   • partition 3 is a plain, mountable ext4 volume (labeled CAPSTONE_DATA)
#     you can use for software, downloads, or as an install target. It is a
#     normal user disk, NOT part of the live overlay.
#
# Usage:
#   sudo ./scripts/make-persistent-usb.sh /dev/sdX
#
# Args:
#   DEV            whole USB device (e.g. /dev/sdb — NOT a partition)
# Env:
#   ISO            path to the Capstone ISO (default dist/live-usb/capstone-v2-live-amd64.iso)
#   PERSIST_MB     overlay partition size in MiB (default 8192 = 8 GiB)
#   DATA_LABEL     data partition label (default CAPSTONE_DATA)
# ═══════════════════════════════════════════════════════════════════════════

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${1:-}"
ISO="${ISO:-$REPO/dist/live-usb/capstone-v2-live-amd64.iso}"
PERSIST_MB="${PERSIST_MB:-8192}"
DATA_LABEL="${DATA_LABEL:-CAPSTONE_DATA}"

[ -n "$DEV" ] || { echo "usage: $0 /dev/sdX   (whole USB device, not a partition)" >&2; exit 1; }
[ -b "$DEV" ] || { echo "ERROR: $DEV is not a block device" >&2; exit 1; }
[ -f "$ISO" ] || { echo "ERROR: ISO not found: $ISO  (build it with scripts/build-live-usb.sh first)" >&2; exit 1; }

# The device must be a WHOLE disk: if any of its partitions are mounted, refuse.
if lsblk -ln -o MOUNTPOINTS "$DEV" 2>/dev/null | grep -q .; then
  echo "ERROR: a partition on $DEV is mounted (likely your boot/system disk). Aborting." >&2
  exit 1
fi

echo "WARNING: this destroys all data on $DEV (a whole USB stick)."
read -r -p "Type YES to continue: " answer </dev/tty || true
answer="$(printf '%s' "$answer" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
[ "$answer" = "YES" ] || { echo "Aborted."; exit 1; }

echo "── 1/4 writing ISO to $DEV ──"
dd if="$ISO" of="$DEV" bs=16M status=progress conv=fsync
sync

# Compact the MBR so the next partitions start where partition 1 (the ISO)
# ends, then re-read the table.
echo "── 2/4 partitioning $DEV ──"
partprobe "$DEV" 2>/dev/null || sleep 2
partprobe "$DEV" 2>/dev/null || true

# Find the end sector of the last existing partition (the ISO region).
END_SECTOR="$(
  parted -s "$DEV" unit s print 2>/dev/null \
    | awk '$1 ~ /^[0-9]+$/ { last=$3 } END { print last }'
)"
[ -n "$END_SECTOR" ] || { echo "ERROR: could not read the current partition table" >&2; exit 1; }

# Total device size in 512-byte sectors (from the sysfs size attribute).
DEVSIZE="$(cat /sys/class/block/$(basename "$DEV")/size 2>/dev/null || echo 0)"
TOTAL_SECTORS="${DEVSIZE:-0}"
[ "$TOTAL_SECTORS" -gt "$END_SECTOR" ] || { \
  echo "ERROR: device is not larger than the ISO region — is $DEV the right stick?" >&2; exit 1; }

START=$(( END_SECTOR + 2048 ))                      # 1 MiB alignment after ISO
PERSIST_END=$(( START + PERSIST_MB * 2 - 1 ))       # MiB -> sectors (512B)
[ "$PERSIST_END" -lt "$TOTAL_SECTORS" ] || { \
  echo "ERROR: PERSIST_MB=${PERSIST_MB} MiB leaves no room for the data drive" >&2; exit 1; }

parted -s "$DEV" unit s -- \
  mkpart primary ext4 "$START" "$PERSIST_END"
parted -s "$DEV" unit s -- \
  mkpart primary ext4 "$(( PERSIST_END + 2048 ))" "${TOTAL_SECTORS}"
sleep 2
partprobe "$DEV" 2>/dev/null || true
sleep 2

# Collect the partition device nodes in order (P1=ISO, P2=persistence, P3=data).
parts=()
while IFS= read -r name; do parts+=("/dev/$name"); done < <(
  lsblk -ln -o NAME,TYPE "$DEV" | awk '$2=="part"{print "/dev/"$1}')
[ "${#parts[@]}" -ge 2 ] || { echo "ERROR: expected 3 partitions, found ${#parts[@]}" >&2; exit 1; }
PERSIST_PART="${parts[1]}"
if [ "${#parts[@]}" -ge 3 ]; then DATA_PART="${parts[2]}"; else DATA_PART=""; fi

echo "── 3/4 formatting + labeling ──"
echo "  persistence overlay: $PERSIST_PART (${PERSIST_MB} MiB)"
mkfs.ext4 -F "$PERSIST_PART" >/dev/null
e2label "$PERSIST_PART" persistence
if [ -n "$DATA_PART" ]; then
  echo "  data drive:          $DATA_PART"
  mkfs.ext4 -F "$DATA_PART" >/dev/null
  e2label "$DATA_PART" "$DATA_LABEL" || true
fi

# Write persistence.conf so live-boot overlays the ENTIRE root filesystem.
# live-boot (this ISO uses --initramfs live-boot) will NOT persist anything
# from a bare partition labeled `persistence` on its own — it needs a
# persistence.conf listing the paths to overlay. `/ union` makes the whole
# live root writable-overlaid onto this volume, so installed packages, config
# and home all survive power-off. (`/ union` at the top level covers the
# whole filesystem including /home.)
mkdir -p /tmp/capstone-persist
mount "$PERSIST_PART" /tmp/capstone-persist
printf '/ union\n' > /tmp/capstone-persist/persistence.conf
sync
umount /tmp/capstone-persist

echo "── 4/4 done ──"
echo
echo "Persistent Capstone live USB ready on $DEV:"
echo "  partition 1 : live ISO boot medium"
echo "  partition 2 : persistence overlay (${PERSIST_MB} MiB) — live session saves across reboots"
if [ -n "$DATA_PART" ]; then
  echo "  partition 3 : $DATA_LABEL data drive ($DATA_PART) — use for software/downloads/install target"
fi
echo
echo "Boot the computer from this USB. Changes you make in the live session"
echo "persist. Mount the data drive when you want it:"
[ -n "$DATA_PART" ] && echo "    sudo mkdir -p /mnt/data && sudo mount $DATA_PART /mnt/data"