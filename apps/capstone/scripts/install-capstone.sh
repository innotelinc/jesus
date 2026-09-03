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
# The offline bundle (capstone-v2-deployment.tar.gz + docker-images-v2.tar.gz)
# is used when present; otherwise the required pieces are fetched from GitHub
# and Docker registries over the network.

TARGET="${CAPSTONE_TARGET:-/opt/capstone}"

# Resolve the deployment root (the dir that holds docker-compose.yml / the
# deployment payload). The same installer runs from two layouts:
#   * repo layout:       <repo>/scripts/install-capstone.sh  -> ROOT=<repo>
#   * deployed layout:   /opt/capstone/install-capstone.sh   -> ROOT=/opt/capstone
# A naive "dirname $0/.." only matches the repo layout; in the deployed system
# it resolves one level too high (to /opt), which makes install_in_place treat
# ASSET_DIR!=TARGET and recursively rsync /opt into /opt/capstone -- creating a
# stray /opt/capstone/capstone and wiping the real payload.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR"
for cand in "$SCRIPT_DIR" "$(cd "$SCRIPT_DIR/.." && pwd)"; do
  if [ -e "$cand/docker-compose.yml" ] || \
     [ -e "$cand/capstone-v2-deployment.tar.gz" ] || \
     [ -e "$cand/scripts/install-capstone.sh" ]; then
    ROOT="$cand"
    break
  fi
done
ASSET_DIR="${CAPSTONE_ASSET_DIR:-$ROOT}"
CAPSTONE_DISK="${CAPSTONE_DISK:-}"

# Local login account for the installed system (documented in the README).
# Overridable with CAPSTONE_USER / CAPSTONE_PASSWORD.
CAPSTONE_USER="${CAPSTONE_USER:-capstone}"
CAPSTONE_PASSWORD="${CAPSTONE_PASSWORD:-capstone}"

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
  # dograh → FreePBX sync: a timer re-runs scripts/sync_dograh_routes.py
  # every 2 minutes so numbers created/removed in the dograh UI land in
  # FreePBX (custom extensions + inbound routes) automatically. Install with
  # the main service; the timer starts only when the stack is up.
  $SUDO cp "$root$TARGET/systemd/capstone-pbx-sync.service" "$root/etc/systemd/system/capstone-pbx-sync.service"
  $SUDO cp "$root$TARGET/systemd/capstone-pbx-sync.timer" "$root/etc/systemd/system/capstone-pbx-sync.timer"
  $SUDO sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$TARGET|" "$root/etc/systemd/system/capstone-pbx-sync.service"
  # FreePBX web-UI healthcheck: the container's own healthcheck probes only
  # Asterisk, so a stale /var/run/apache2/apache2.pid (kept across docker
  # restarts) can take the web UI down while the container reports healthy.
  # A timer probes :80 and restarts Apache if needed.
  $SUDO cp "$root$TARGET/systemd/capstone-freepbx-web.service" "$root/etc/systemd/system/capstone-freepbx-web.service"
  $SUDO cp "$root$TARGET/systemd/capstone-freepbx-web.timer" "$root/etc/systemd/system/capstone-freepbx-web.timer"
  $SUDO sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$TARGET|" "$root/etc/systemd/system/capstone-freepbx-web.service"
  # systemctl --root works offline (no running systemd needed), so it also
  # works from inside the installer chroot. Prefer it whenever a root dir is
  # given, or when we're in the chroot phase of a disk install.
  if [ -n "$root" ] || [ "${CAPSTONE_IN_CHROOT:-0}" = "1" ]; then
    local sysroot="${root:-/}"
    $SUDO systemctl --root "$sysroot" daemon-reload 2>/dev/null || true
    $SUDO systemctl --root "$sysroot" enable capstone.service 2>/dev/null || \
      $SUDO ln -sf /etc/systemd/system/capstone.service "$sysroot/etc/systemd/system/multi-user.target.wants/capstone.service"
    $SUDO systemctl --root "$sysroot" enable capstone-pbx-sync.timer 2>/dev/null || \
      $SUDO ln -sf /etc/systemd/system/capstone-pbx-sync.timer "$sysroot/etc/systemd/system/timers.target.wants/capstone-pbx-sync.timer"
    $SUDO systemctl --root "$sysroot" enable capstone-freepbx-web.timer 2>/dev/null || \
      $SUDO ln -sf /etc/systemd/system/capstone-freepbx-web.timer "$sysroot/etc/systemd/system/timers.target.wants/capstone-freepbx-web.timer"
    # start only makes sense with a running systemd (live install)
    if [ -z "$root" ] && [ -d /run/systemd/system ]; then
      $SUDO systemctl start capstone.service 2>/dev/null || true
      $SUDO systemctl start capstone-pbx-sync.timer 2>/dev/null || true
      $SUDO systemctl start capstone-freepbx-web.timer 2>/dev/null || true
    fi
  else
    $SUDO systemctl daemon-reload 2>/dev/null || true
    $SUDO systemctl enable capstone.service 2>/dev/null || \
      $SUDO ln -sf /etc/systemd/system/capstone.service /etc/systemd/system/multi-user.target.wants/capstone.service
    $SUDO systemctl enable capstone-pbx-sync.timer 2>/dev/null || \
      $SUDO ln -sf /etc/systemd/system/capstone-pbx-sync.timer /etc/systemd/system/timers.target.wants/capstone-pbx-sync.timer
    $SUDO systemctl enable capstone-freepbx-web.timer 2>/dev/null || \
      $SUDO ln -sf /etc/systemd/system/capstone-freepbx-web.timer /etc/systemd/system/timers.target.wants/capstone-freepbx-web.timer
    $SUDO systemctl start capstone.service 2>/dev/null || true
    $SUDO systemctl start capstone-pbx-sync.timer 2>/dev/null || true
    $SUDO systemctl start capstone-freepbx-web.timer 2>/dev/null || true
  fi
}

# ---- Mode 2: install into the running (already-installed) system ----
install_in_place() {
  mkdir -p "$TARGET"
  if [ "$ASSET_DIR" != "$TARGET" ]; then
    $SUDO rsync -a --delete --exclude '.env' "$ASSET_DIR/" "$TARGET/"
  fi
  install_docker
  load_docker_images "$TARGET/dist/docker-images-v2"
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
    local answer=""
    if [ -e /dev/tty ]; then
      read -r -p "Type YES to continue: " answer < /dev/tty || true
    else
      read -r -p "Type YES to continue: " answer || true
    fi
    # Normalize so the check is forgiving of case/spaces (e.g. "yes", " YES ").
    answer="$(printf '%s' "$answer" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
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
  if [ -f "$ROOT/capstone-v2-deployment.tar.gz" ]; then
    tar -xzf "$ROOT/capstone-v2-deployment.tar.gz" -C "$mnt/opt/capstone"
  elif [ -f /opt/capstone/capstone-v2-deployment.tar.gz ]; then
    tar -xzf /opt/capstone/capstone-v2-deployment.tar.gz -C "$mnt/opt/capstone"
  else
    echo "No deployment bundle found; the target will fetch it after boot." >&2
  fi

  # Stage offline docker images if the bundle is on an attached medium.
  mkdir -p "$mnt/opt/capstone/dist"
  for medium in /media/* /mnt/* /run/live/medium; do
    [ -d "$medium" ] || continue
    if [ -d "$medium/dist/docker-images-v2" ]; then
      echo "Copying offline images from $medium..."
      cp -a "$medium/dist/docker-images-v2" "$mnt/opt/capstone/dist/"
    elif [ -f "$medium/docker-images-v2.tar.gz" ]; then
      echo "Copying offline images from $medium..."
      mkdir -p "$mnt/opt/capstone/dist/docker-images-v2"
      # The bundle is a multi-member gzip; split it into per-image archives
      # via the splitter that ships in the deployment payload.
      if [ -x "$ROOT/scripts/split-image-bundle.sh" ]; then
        bash "$ROOT/scripts/split-image-bundle.sh" \
          "$medium/docker-images-v2.tar.gz" "$mnt/opt/capstone/dist/docker-images-v2"
      else
        # Fallback: honor the legacy tar-of-archives layout from older bundles.
        tar -xzf "$medium/docker-images-v2.tar.gz" -C "$mnt/opt/capstone/dist/docker-images-v2" --strip-components=1 2>/dev/null \
          || tar -xzf "$medium/docker-images-v2.tar.gz" -C "$mnt/opt/capstone/dist/docker-images-v2"
      fi
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

  # The chroot script creates a login user, sets up DHCP networking and
  # enables NetworkManager + docker + the capstone service. systemctl needs
  # `--root /` here because no systemd is running inside the chroot.
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

# ── login user (the live CD's 'user' account only exists in the live session)
# Create a real admin login account with a known password + sudo + docker.
#
# The live session bakes in an autologin for the transient 'user' account
# (/etc/lightdm/lightdm.conf.d/50-capstone-autologin.conf). That account does
# not exist on an installed disk, and the stale autologin rule can prevent a
# clean greeter, so remove it before booting the installed OS.
rm -f /etc/lightdm/lightdm.conf.d/50-capstone-autologin.conf

# The docker group exists in the live/image, but ensure it exists anyway so
# `useradd -G docker` can never fail on a trimmed-disk install.
getent group docker >/dev/null || groupadd docker

# Create the admin user if missing; if it already exists (e.g. a partial or
# re-run bootstrap), just top up its admin/docker groups. The password is
# always reset below so every install ends up with a known working login.
if ! id "$CAPSTONE_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G sudo,docker "$CAPSTONE_USER"
elif ! id -nG "$CAPSTONE_USER" | grep -qw docker; then
  usermod -a -G sudo,docker "$CAPSTONE_USER"
fi

# Set the password unconditionally. Under `set -e` a failure here aborts the
# install loudly instead of silently shipping a box you can't log into.
echo "$CAPSTONE_USER:$CAPSTONE_PASSWORD" | chpasswd
id "$CAPSTONE_USER" >/dev/null 2>&1 \
  || { echo "FATAL: login user '$CAPSTONE_USER' could not be created/reset" >&2; exit 1; }
echo "Login user ready: $CAPSTONE_USER"

# passwordless sudo for the capstone admin user
cat > /etc/sudoers.d/99-capstone-admin <<EOF
$CAPSTONE_USER ALL=(ALL) NOPASSWD: ALL
EOF
chmod 0440 /etc/sudoers.d/99-capstone-admin

# ── networking: DHCP on every ethernet interface ──────────────────────────
# The live session gets its IP from NetworkManager; the installed system must
# too. Enable NetworkManager + systemd-networkd and add a netplan rule so
# ethernet comes up with DHCP on first boot (works with or without NM).
mkdir -p /etc/netplan
cat > /etc/netplan/99-capstone-dhcp.yaml <<'NETPLAN'
network:
  version: 2
  renderer: NetworkManager
  ethernets:
    all-eth:
      match:
        # Common Ethernet NIC name prefixes (enp* / ens* / eno* / eth*).
        name: ["en*", "eth*"]
      dhcp4: true
      optional: true
NETPLAN
systemctl --root / enable NetworkManager 2>/dev/null || true
systemctl --root / enable systemd-networkd 2>/dev/null || true
systemctl --root / enable docker 2>/dev/null || true
CHROOT
  chmod 0755 "$mnt/tmp/capstone-chroot.sh"
  CAPSTONE_DISK="$disk" CAPSTONE_USER="$CAPSTONE_USER" CAPSTONE_PASSWORD="$CAPSTONE_PASSWORD" \
    chroot "$mnt" /bin/bash /tmp/capstone-chroot.sh
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
