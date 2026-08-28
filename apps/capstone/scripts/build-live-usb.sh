#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/dist/live-usb}"
WORK_DIR="${WORK_DIR:-$REPO/.live-build}"
ISO_NAME="${ISO_NAME:-capstone-v1-live-amd64.iso}"

command -v lb >/dev/null || { echo "live-build is required" >&2; exit 1; }
command -v xorriso >/dev/null || { echo "xorriso is required" >&2; exit 1; }

mkdir -p "$OUT_DIR"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

lb config \
  --distribution noble \
  --architectures amd64 \
  --binary-images iso \
  --bootloader grub-efi \
  --bootappend-live "boot=live components persistence noeject" \
  --archive-areas "main" \
  --linux-packages "linux-image" \
  --iso-application "Capstone v1" \
  --iso-publisher "Innotel" \
  --iso-volume "CAPSTONE_V1" \
  --zsync false

mkdir -p config/includes.chroot/opt/capstone
cp "$REPO/scripts/live-usb-download.sh" config/includes.chroot/opt/capstone/
cp "$REPO/scripts/live-usb-install.sh" config/includes.chroot/opt/capstone/
cp "$REPO/scripts/install-capstone.sh" config/includes.chroot/opt/capstone/
cp "$REPO/scripts/fetch-offline-bundle.sh" config/includes.chroot/opt/capstone/
chmod 0755 config/includes.chroot/opt/capstone/*.sh

mkdir -p config/includes.chroot/etc/skel/Desktop
cat > config/includes.chroot/etc/skel/Desktop/Download-Capstone-v1.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Download Capstone v1
Comment=Download and start Capstone from the v1 release
Exec=x-terminal-emulator -e /opt/capstone/live-usb-download.sh
Icon=network-server
Terminal=true
Categories=System;
EOF
cat > config/includes.chroot/etc/skel/Desktop/Install-Capstone.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Install Capstone v1
Comment=Download and install Capstone v1 to this Linux system
Exec=x-terminal-emulator -e sudo /opt/capstone/install-capstone.sh
Icon=drive-harddisk
Terminal=true
Categories=System;
EOF
chmod 0644 config/includes.chroot/etc/skel/Desktop/*.desktop

lb build
ISO_SOURCE="live-image-amd64.iso"
[ -f "$ISO_SOURCE" ] || ISO_SOURCE="live-image-amd64.hybrid.iso"
[ -f "$ISO_SOURCE" ] || ISO_SOURCE="binary.iso"
[ -f "$ISO_SOURCE" ] || { echo "live-build did not produce an ISO" >&2; exit 1; }
mv "$ISO_SOURCE" "$OUT_DIR/$ISO_NAME"
sha256sum "$OUT_DIR/$ISO_NAME" > "$OUT_DIR/$ISO_NAME.sha256"
echo "Created $OUT_DIR/$ISO_NAME"
