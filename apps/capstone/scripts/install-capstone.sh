#!/usr/bin/env bash
set -euo pipefail

# Capstone installer.
#
# Two modes:
#   1. Live session (booted from the Capstone live USB): installs to a target
#      disk - partitions it, copies the live system, installs GRUB (BIOS and
#      UEFI), then runs the regular install inside the new system.
#   2. Already-installed Linux: installs the Capstone application (Docker +
#      images + systemd service) into this system.
#
# The offline bundle (capstone-v1-deployment.tar.gz + docker-images-v1.tar.gz)
# is used when present; otherwise the required pieces are fetched from GitHub
# and Docker registries over the network.

TARGET="${CAPSTONE_TARGET:-/opt/capstone}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSET_DIR="${CAPSTONE_ASSET_DIR:-$ROOT}"
RELEASE_TAG="${CAPSTONE_RELEASE_TAG:-v1.1.0}"
REPO_SLUG="${CAPSTONE_REPO:-innotelinc/capstone}"
CAPSTONE_DISK="${CAPSTONE_DISK:-}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

is_live_session() {
  # CAPSTONE_IN_CHROOT guards the second (chrooted) phase of a disk install.
  [ "${CAPSTONE_IN_CHROOT:-0}" = "1" ] && return 1
  [ -d /run/live ] || [ -d /run/live/medium ] || grep -q ' boot=live ' /proc/cmdline 2>/dev/null
}

install_docker() {
  command -v docker >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1 && [ "${CAPSTONE_ALLOW_APT:-1}" = "1" ]; then
    $SUDO apt-get update
    # docker-compose-v2 is the Ubuntu-archive plugin; docker-compose-plugin is
    # the Docker-repo name. Try both so either distro works.
    $SUDO apt-get install -y docker.io docker-compose-v2 curl rsync openssl python3 2>/dev/null || \
      $SUDO apt-get install -y docker.io docker-compose-plugin curl rsync openssl python3
    $SUDO systemctl enable --now docker 2>/dev/null || true
  fi
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is unavailable. Connect to the internet or provide a preinstalled Docker runtime." >&2
    exit 2
  }
}

load_docker_images() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  local found=0
  for archive in "$dir"/*.tar.gz; do
    [ -e "$archive" ] || continue
    found=1
    echo "Loading $(basename "$archive")"
    gzip -dc "$archive" | $SUDO docker load
  done
  if [ "$found" -eq 0 ]; then
    echo "No image archives found in $dir - images will be pulled from the network if needed." >&2
  fi
}

install_service() {
  local root="$1"
  $SUDO mkdir -p "$root/etc/capstone"
  $SUDO cp "$root$TARGET/systemd/capstone.service" "$root/etc/systemd/system/capstone.service"
  $SUDO sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$TARGET|" "$root/etc/systemd/system/capstone.service"
  if [ -n "$root" ]; then
    $SUDO systemctl --root "$root" daemon-reload
    $SUDO systemctl --root "$root" enable capstone.service
    $SUDO systemctl --root "$root" start capstone.service 2>/dev/null || true
  else
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable capstone.service
    $SUDO systemctl start capstone.service 2>/dev/null || true
  fi
}

# ---- Mode 2: install into the running (already-installed) system ----
install_in_place() {
  mkdir -p "$TARGET"
  if [ "$ASSET_DIR" != "$TARGET" ]; then
    $SUDO rsync -a --delete --exclude '.env' "$ASSET_DIR/" "$TARGET/"
  fi
  install_docker
  load_docker_images "$TARGET/dist/docker-images-v1"
  install_service ""
  echo "Capstone installed at $TARGET and started."
}

# ---- Mode 1: live USB -> install to a disk ----
install_to_disk() {
  local disk="$CAPSTONE_DISK"

  if [ -z "$disk" ]; then
    # Exclude the live medium's disk and prefer a disk with no partitions.
    local live_disk=""
    local src=""
    src="$(findmnt -n -o SOURCE /run/live/medium 2>/dev/null || true)"
    [ -n "$src" ] && live_disk="$(lsblk -no PKNAME "$src" 2>/dev/null || true)"
    for cand in $(lsblk -dn -o NAME,TYPE | \
      awk -v excl="$live_disk" '$2=="disk" && $1 != excl && $1 !~ /^loop|^ram/ {print $1}'); do
      if [ "$(lsblk -ln -o NAME,TYPE "/dev/$cand" 2>/dev/null | awk '$2=="part"' | wc -l)" -eq 0 ]; then
        disk="/dev/$cand"
        break
      fi
    done
    if [ -z "$disk" ]; then
      disk="$(lsblk -dn -o NAME,TYPE | \
        awk -v excl="$live_disk" '$2=="disk" && $1 != excl && $1 !~ /^loop|^ram/ {print "/dev/"$1; exit}')"
    fi
  fi
  if [ -z "$disk" ] || [ ! -b "$disk" ]; then
    echo "No target disk found. Set CAPSTONE_DISK=/dev/sdX to choose one." >&2
    echo "Disks:" >&2
    lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS 2>/dev/null >&2
    exit 2
  fi

  if [ "${CAPSTONE_YES:-0}" != "1" ]; then
    echo "======================================================"
    echo " Capstone will install to: $disk"
    echo " ALL DATA ON THIS DISK WILL BE DESTROYED."
    echo "======================================================"
    lsblk "$disk"
    read -r -p "Type YES to continue: " answer
    [ "$answer" = "YES" ] || { echo "Aborted."; exit 1; }
  fi

  # Partition: MBR with a small FAT32 ESP/boot partition + ext4 root.
  parted -s "$disk" mklabel msdos
  parted -s "$disk" mkpart primary fat32 1MiB 513MiB
  parted -s "$disk" set 1 boot on
  parted -s "$disk" set 1 esp on
  parted -s "$disk" mkpart primary ext4 513MiB 100%
  sleep 2
  partprobe "$disk" 2>/dev/null || true
  sleep 2

  local parts=()
  while IFS= read -r name; do parts+=("/dev/$name"); done < <(
    lsblk -ln -o NAME,TYPE "$disk" | awk '$2=="part"{print $1}')
  [ "${#parts[@]}" -ge 2 ] || { echo "Failed to create partitions on $disk" >&2; exit 1; }
  local efi_part="${parts[0]}" root_part="${parts[1]}"

  echo "Formatting $efi_part (FAT32) and $root_part (ext4)..."
  mkfs.vfat -F32 "$efi_part"
  mkfs.ext4 -F "$root_part"

  local mnt
  mnt="$(mktemp -d)"
  mount "$root_part" "$mnt"
  mkdir -p "$mnt/boot/efi"
  mount "$efi_part" "$mnt/boot/efi"

  echo "Copying the live system to $root_part..."
  local squash=""
  for candidate in \
    /run/live/medium/live/filesystem.squashfs \
    /live/filesystem.squashfs \
    /media/*/live/filesystem.squashfs; do
    [ -f "$candidate" ] && squash="$candidate" && break
  done
  if [ -n "$squash" ]; then
    unsquashfs -f -d "$mnt" "$squash"
  else
    rsync -aAX --one-file-system \
      --exclude '/proc/*' --exclude '/sys/*' --exclude '/dev/*' \
      --exclude '/run/*' --exclude '/mnt/*' --exclude '/media/*' \
      --exclude '/tmp/*' --exclude '/live' --exclude '/opt/capstone' \
      / "$mnt/"
  fi

  # Stage the Capstone application payload (source/compose/systemd) into the
  # target. The baked ISO copy or the offline bundle on the USB is used when
  # present; otherwise the payload is fetched after boot.
  mkdir -p "$mnt/opt/capstone"
  if [ -f "$ROOT/capstone-v1-deployment.tar.gz" ]; then
    tar -xzf "$ROOT/capstone-v1-deployment.tar.gz" -C "$mnt/opt/capstone"
  elif [ -f /opt/capstone/capstone-v1-deployment.tar.gz ]; then
    tar -xzf /opt/capstone/capstone-v1-deployment.tar.gz -C "$mnt/opt/capstone"
  else
    echo "No deployment bundle found; the target will fetch it after boot." >&2
  fi

  # Stage offline docker images if the bundle is on an attached medium.
  mkdir -p "$mnt/opt/capstone/dist"
  for medium in /media/* /mnt/* /run/live/medium; do
    [ -d "$medium" ] || continue
    if [ -d "$medium/dist/docker-images-v1" ]; then
      echo "Copying offline images from $medium..."
      cp -a "$medium/dist/docker-images-v1" "$mnt/opt/capstone/dist/"
    elif [ -f "$medium/docker-images-v1.tar.gz" ]; then
      echo "Copying offline images from $medium..."
      mkdir -p "$mnt/opt/capstone/dist/docker-images-v1"
      tar -xzf "$medium/docker-images-v1.tar.gz" -C "$mnt/opt/capstone/dist/docker-images-v1" --strip-components=1 2>/dev/null \
        || tar -xzf "$medium/docker-images-v1.tar.gz" -C "$mnt/opt/capstone/dist/docker-images-v1"
    fi
  done

  # chroot setup
  mount --bind /dev "$mnt/dev"
  mount --bind /dev/pts "$mnt/dev/pts"
  mount --bind /proc "$mnt/proc"
  mount --bind /sys "$mnt/sys"
  cp /etc/resolv.conf "$mnt/etc/resolv.conf" 2>/dev/null || true

  local uuid_root uuid_efi
  uuid_root="$(blkid -s UUID -o value "$root_part")"
  uuid_efi="$(blkid -s UUID -o value "$efi_part")"
  cat > "$mnt/etc/fstab" <<EOF
UUID=$uuid_root / ext4 errors=remount-ro 0 1
UUID=$uuid_efi /boot/efi vfat umask=0077 0 1
EOF

  cat > "$mnt/tmp/capstone-chroot.sh" <<'CHROOT'
#!/bin/bash
set -e
if [ -d /sys/firmware/efi ]; then
  echo "Installing GRUB for UEFI..."
  grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=capstone --recheck
else
  echo "Installing GRUB for BIOS..."
  grub-install --target=i386-pc --recheck "$CAPSTONE_DISK"
fi
update-grub
systemctl enable NetworkManager 2>/dev/null || true
CHROOT
  chmod 0755 "$mnt/tmp/capstone-chroot.sh"
  CAPSTONE_DISK="$disk" chroot "$mnt" /bin/bash /tmp/capstone-chroot.sh
  rm -f "$mnt/tmp/capstone-chroot.sh"

  echo "Installing the Capstone application inside the new system..."
  CAPSTONE_IN_CHROOT=1 CAPSTONE_DISK="$disk" \
    chroot "$mnt" /bin/bash /opt/capstone/install-capstone.sh || {
      echo "Application install inside the target reported an error; the system is still installed." >&2
    }

  umount "$mnt/boot/efi" 2>/dev/null || true
  umount "$mnt/dev/pts" 2>/dev/null || true
  umount "$mnt/dev" 2>/dev/null || true
  umount "$mnt/proc" 2>/dev/null || true
  umount "$mnt/sys" 2>/dev/null || true
  umount "$mnt" 2>/dev/null || true
  rmdir "$mnt" 2>/dev/null || true

  echo "======================================================"
  echo " Capstone is installed on $disk."
  echo " Remove the USB stick and reboot into the new system."
  echo "======================================================"
}

if is_live_session; then
  install_to_disk
else
  install_in_place
fi
