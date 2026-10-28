#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# make-persistent-usb.sh — write the Capstone live ISO to a USB stick and set
# up persistent storage so the live session saves across reboots.
#
# Run interactively with no arguments and it lets you CHOOSE the target drive
# and what to do with it:
#
#   sudo ./scripts/make-persistent-usb.sh
#
#   >>> Choose a drive to write to (from the list of non-system disks)
#   >>> Choose what to do with it:
#         1. Persistent live USB + data drive   (live session saves; ext4 data disk)
#         2. Plain live USB                     (read-only live session, ISO only)
#         3. Wipe & format a data drive         (no ISO — erase disk as one ext4 volume)
#
# Layout for option 1 (example sizes for a 64 GB USB):
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
# Non-interactive usage (same behaviour as before):
#   sudo ./scripts/make-persistent-usb.sh /dev/sdX            # -> persistent + data
#   sudo ACTION=plain    ./scripts/make-persistent-usb.sh /dev/sdX
#   sudo ACTION=data     ./scripts/make-persistent-usb.sh /dev/sdX
#
# Args:
#   DEV            whole USB device (e.g. /dev/sdb — NOT a partition).
#                  Omit it to pick a drive from a menu.
# Env:
#   ACTION         persistent | plain | data   (default persistent)
#   ISO            path to the Capstone ISO (default dist/live-usb/capstone-v2-live-amd64.iso)
#   PERSIST_MB     overlay partition size in MiB (default 8192 = 8 GiB)
#   DATA_LABEL     data partition label (default CAPSTONE_DATA)
# ═══════════════════════════════════════════════════════════════════════════

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${1:-}"
ACTION_SET="${ACTION+x}"                         # was ACTION given via env?
ACTION="${ACTION:-persistent}"
ISO="${ISO:-$REPO/dist/live-usb/capstone-v2-live-amd64.iso}"
PERSIST_MB="${PERSIST_MB:-8192}"
DATA_LABEL="${DATA_LABEL:-CAPSTONE_DATA}"

case "$ACTION" in
  persistent|plain|data) ;;
  *) echo "ERROR: ACTION must be persistent|plain|data (got '$ACTION')" >&2; exit 1;;
esac

[ -f "$ISO" ] || { echo "ERROR: ISO not found: $ISO  (build it with scripts/build-live-usb.sh first)" >&2; exit 1; }

# ── pick a drive interactively, if none was given ─────────────────────────
pick_drive() {
  # Only whole disks (TYPE=disk), excluding loop/ram and anything the OS is
  # booted from. Show size + model + mountpoints so the choice is unambiguous.
  local -a rows=()
  while IFS= read -r r; do rows+=("$r"); done < <(
    lsblk -dn -o NAME,SIZE,TYPE,TRAN,MODEL,MOUNTPOINTS 2>/dev/null \
      | awk '$3=="disk" && $1 !~ /^loop|^ram/ {print}')
  # Also drop the disk that the running system is mounted from.
  local bootdisk=""
  bootdisk="$(findmnt -no SOURCE / 2>/dev/null | sed -E 's#^/dev/([a-z]+)[0-9]*$#\1#' \
    | xargs -r -I{} lsblk -no PKNAME /dev/{} 2>/dev/null || true)"

  local i=0 filtered=()
  for row in "${rows[@]}"; do
    local name; name="$(echo "$row" | awk '{print $1}')"
    [ -n "$bootdisk" ] && [ "$name" = "$bootdisk" ] && continue
    filtered+=("$row")
  done

  if [ "${#filtered[@]}" -eq 0 ]; then
    echo "No eligible drives found." >&2
    echo "Disks:" >&2
    lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS >&2
    exit 3
  fi

  echo
  echo "Available drives:"
  for i in "${!filtered[@]}"; do
    printf '  %d) /dev/%s\n' "$((i+1))" "$(echo "${filtered[$i]}" | awk '{print $1}')"
    echo "     $(echo "${filtered[$i]}" | awk '{print $2, $3, $4, $5, $6}')"
  done
  echo
  while true; do
    read -r -p "Pick a drive number (or enter /dev/sdX directly): " choice </dev/tty || true
    case "$choice" in
      '' ) echo "No selection. Aborting." >&2; exit 1;;
      /* ) [ -b "$choice" ] && { DEV="$choice"; return; } || echo "Not a block device: $choice";;
      * )
        if [ "$choice" -ge 1 ] 2>/dev/null && [ "$choice" -le "${#filtered[@]}" ]; then
          DEV="/dev/$(echo "${filtered[$((choice-1))]}" | awk '{print $1}')"
          return
        else
          echo "Bad selection: $choice"
        fi ;;
    esac
  done
}

# ── pick what to do with the chosen drive, interactively ────────────────
pick_action() {
  echo
  echo "What would you like to do with $DEV?"
  echo "  1) Persistent live USB + data drive   (live session saves; ~50 GB data disk)"
  echo "  2) Plain live USB                     (read-only live session, ISO only)"
  echo "  3) Wipe & format a data drive         (no ISO — erase as one ext4 volume)"
  while true; do
    read -r -p "Choose 1, 2 or 3: " choice </dev/tty || true
    case "$choice" in
      1) ACTION=persistent; return;;
      2) ACTION=plain; return;;
      3) ACTION=data; return;;
      *) echo "Please enter 1, 2 or 3 (got: '$choice')";;
    esac
  done
}

confirm() { # $1 = human-readable description
  echo
  echo "======================================================"
  echo " Action : $ACTION"
  echo " Device : $DEV"
  echo " What   : $1"
  echo " ALL DATA ON THIS DEVICE WILL BE DESTROYED."
  echo "======================================================"
  lsblk "$DEV" 2>/dev/null || true
  echo
  read -r -p "Type YES to continue: " answer </dev/tty || true
  answer="$(printf '%s' "$answer" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
  [ "$answer" = "YES" ] || { echo "Aborted."; exit 1; }
}

require_whole_disk() {
  [ -b "$DEV" ] || { echo "ERROR: $DEV is not a block device" >&2; exit 1; }
  if lsblk -ln -o MOUNTPOINTS "$DEV" 2>/dev/null | grep -q .; then
    echo "ERROR: a partition on $DEV is mounted (likely your boot/system disk)." >&2
    exit 1
  fi
}

# ── actions ────────────────────────────────────────────────────────────────
write_iso() { # dd the ISO, then re-read the table
  echo "── writing ISO to $DEV ──"
  dd if="$ISO" of="$DEV" bs=16M status=progress conv=fsync
  sync
  partprobe "$DEV" 2>/dev/null || sleep 2
  partprobe "$DEV" 2>/dev/null || true
}

add_persistence_and_data() {
  # Find the end sector of the last partition (the ISO region).
  local end_sector devsize total pers_start persist_end
  end_sector="$(
    parted -s "$DEV" unit s print 2>/dev/null \
      | awk '$1 ~ /^[0-9]+$/ { last=$3 } END { print last }'
  )"
  [ -n "$end_sector" ] || { echo "ERROR: could not read the partition table" >&2; exit 1; }

  devsize="$(cat "/sys/class/block/$(basename "$DEV")/size" 2>/dev/null || echo 0)"
  total="${devsize:-0}"
  [ "$total" -gt "$end_sector" ] || {
    echo "ERROR: device not larger than the ISO region — check you picked the right stick" >&2; exit 1; }

  pers_start=$(( end_sector + 2048 ))                  # 1 MiB alignment after ISO
  persist_end=$(( pers_start + PERSIST_MB * 2 - 1 ))   # MiB -> 512B sectors
  [ "$persist_end" -lt "$total" ] || {
    echo "ERROR: PERSIST_MB=${PERSIST_MB} MiB leaves no room for the data drive" >&2; exit 1; }

  echo "── adding persistence overlay + data drive ──"
  parted -s "$DEV" unit s -- mkpart primary ext4 "$pers_start" "$persist_end"
  parted -s "$DEV" unit s -- mkpart primary ext4 "$(( persist_end + 2048 ))" "$total"
  sleep 2
  partprobe "$DEV" 2>/dev/null || true
  sleep 2

  # Collect the partition nodes in order (P1=ISO, P2=persistence, P3=data).
  local parts=() name
  while IFS= read -r name; do parts+=("/dev/$name"); done < <(
    lsblk -ln -o NAME,TYPE "$DEV" | awk '$2=="part"{print "/dev/"$1}')
  [ "${#parts[@]}" -ge 2 ] || { echo "ERROR: expected 3 partitions, found ${#parts[@]}" >&2; exit 1; }
  local persist_part data_part=""
  persist_part="${parts[1]}"
  if [ "${#parts[@]}" -ge 3 ]; then data_part="${parts[2]}"; fi

  echo "  persistence overlay: $persist_part (${PERSIST_MB} MiB)"
  mkfs.ext4 -F "$persist_part" >/dev/null
  e2label "$persist_part" persistence
  mkdir -p /tmp/capstone-persist
  mount "$persist_part" /tmp/capstone-persist
  # live-boot needs persistence.conf (`/ union`) or it won't overlay anything.
  printf '/ union\n' > /tmp/capstone-persist/persistence.conf
  sync
  umount /tmp/capstone-persist

  if [ -n "$data_part" ]; then
    echo "  data drive:          $data_part"
    mkfs.ext4 -F "$data_part" >/dev/null
    e2label "$data_part" "$DATA_LABEL" || true
    DATA_PART="$data_part"
  fi
}

make_data_only() {
  echo "── wiping $DEV as one ext4 volume ──"
  # Remove any existing partition table, then a single full-disk partition.
  parted -s "$DEV" mklabel msdos
  parted -s "$DEV" unit s -- mkpart primary ext4 2048 100%
  sleep 2
  partprobe "$DEV" 2>/dev/null || true
  sleep 2
  local name data_part=""
  while IFS= read -r name; do data_part="/dev/$name"; done < <(
    lsblk -ln -o NAME,TYPE "$DEV" | awk '$2=="part"{print "/dev/"$1; exit}')
  [ -n "$data_part" ] || { echo "ERROR: data partition not found" >&2; exit 1; }
  mkfs.ext4 -F "$data_part" >/dev/null
  e2label "$data_part" "$DATA_LABEL" || true
  DATA_PART="$data_part"
  echo "  data drive: $data_part ($DATA_LABEL)"
}

# ── main ───────────────────────────────────────────────────────────────────
root_check() {
  [ "$(id -u)" -eq 0 ] || { echo "Please run with sudo (partitioning needs root)." >&2; exit 1; }
}
root_check

# Choose the drive first (menu if not given on the command line), then choose
# what to do with it. `ACTION` set in the environment skips the action menu.
if [ -z "$DEV" ]; then
  pick_drive
fi
[ -z "$ACTION_SET" ] && pick_action

case "$ACTION" in
  persistent)
    require_whole_disk
    confirm "write the Capstone ISO, then add a persistence overlay + a $DATA_LABEL data drive"
    write_iso
    add_persistence_and_data
    echo
    echo "Persistent Capstone live USB ready on $DEV:"
    echo "  partition 1 : live ISO boot medium"
    echo "  partition 2 : persistence overlay (${PERSIST_MB} MiB) — saves across reboots"
    [ -n "${DATA_PART:-}" ] && echo "  partition 3 : $DATA_LABEL data drive ($DATA_PART) — software/downloads/install target"
    echo
    echo "Boot from the USB; changes persist. Mount the data drive with:"
    [ -n "${DATA_PART:-}" ] && echo "    sudo mkdir -p /mnt/data && sudo mount $DATA_PART /mnt/data"
    ;;
  plain)
    require_whole_disk
    confirm "write the Capstone ISO as a read-only live USB"
    write_iso
    echo
    echo "Plain live USB ready on $DEV (read-only live session, nothing persists)."
    ;;
  data)
    require_whole_disk
    confirm "erase $DEV and format it as one $DATA_LABEL ext4 data drive"
    make_data_only
    echo
    echo "Data drive ready: $DATA_PART ($DATA_LABEL)"
    echo "    sudo mkdir -p /mnt/data && sudo mount $DATA_PART /mnt/data"
    ;;
esac