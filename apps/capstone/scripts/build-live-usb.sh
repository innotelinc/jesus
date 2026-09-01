#!/usr/bin/env bash
set -euo pipefail

# Build a bootable Capstone live/install ISO.
#
# The image boots into an Xfce desktop (autologin as the "user" live account)
# with two launchers:
#   * Download Capstone v2  - fetch the release + offline bundle from GitHub
#   * Install Capstone v2   - install to this machine (live USB -> disk, or
#                             onto an already-installed Linux system)
#
# The ISO is BIOS + UEFI hybrid: GRUB el-torito for CD/BIOS, isohybrid MBR for
# BIOS-from-USB, and a GRUB EFI image for UEFI (Secure Boot must be disabled).
#
# Requirements: live-build, xorriso, grub-efi-amd64-bin, mtools, genisoimage,
# isolinux (isohdpfx.bin). Output: dist/live-usb/capstone-v2-live-amd64.iso

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/dist/live-usb}"
WORK_DIR="${WORK_DIR:-$REPO/.live-build}"
ISO_NAME="${ISO_NAME:-capstone-v2-live-amd64.iso}"
ISO_VOLUME="CAPSTONE_V2"
BOOTARGS="boot=live components quiet splash persistence"

for cmd in lb xorriso grub-mkimage mformat mcopy; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "required tool missing: $cmd" >&2; exit 1; }
done
[ -f /usr/lib/ISOLINUX/isohdpfx.bin ] || { echo "isolinux (isohdpfx.bin) is required" >&2; exit 1; }

mkdir -p "$OUT_DIR"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

lb config \
  --distribution noble \
  --architectures amd64 \
  --binary-images iso \
  --bootloader grub2 \
  --initramfs live-boot \
  --initsystem systemd \
  --archive-areas "main universe" \
  --bootappend-live "$BOOTARGS" \
  --iso-application "Capstone v2" \
  --iso-publisher "Capstone" \
  --iso-volume "$ISO_VOLUME" \
  --zsync false

# ---- chroot package list: desktop + tools + installer dependencies ----
cat > config/package-lists/capstone.list.chroot <<'EOF'
# live system bootstrap
live-boot
live-config
live-config-systemd
user-setup
# desktop
xorg
xfce4
lightdm
lightdm-gtk-greeter
xterm
dbus-x11
network-manager
network-manager-gnome
# installer tooling (live -> disk)
squashfs-tools
parted
dosfstools
grub2-common
grub-pc-bin
grub-efi-amd64-bin
efibootmgr
# docker runtime (baked in so the installed system has it offline too)
docker.io
docker-compose-v2
# network + utilities
netplan.io
sudo
curl
wget
ca-certificates
git
rsync
openssl
python3
gnupg
bash-completion
EOF

# ---- includes: installer scripts, autologin, sudo, desktop launchers ----
mkdir -p config/includes.chroot/opt/capstone
cp "$REPO/scripts/install-capstone.sh" config/includes.chroot/opt/capstone/
cp "$REPO/scripts/fetch-offline-bundle.sh" config/includes.chroot/opt/capstone/
chmod 0755 config/includes.chroot/opt/capstone/*.sh

# Bake the deployment bundle into the ISO so an offline install always has the
# full source/compose payload (docker images still come from the USB medium).
if [ -f "$REPO/dist/offline-bundle/capstone-v2-deployment.tar.gz" ]; then
  cp "$REPO/dist/offline-bundle/capstone-v2-deployment.tar.gz" config/includes.chroot/opt/capstone/
fi

mkdir -p config/includes.chroot/etc/lightdm/lightdm.conf.d
cat > config/includes.chroot/etc/lightdm/lightdm.conf.d/50-capstone-autologin.conf <<'EOF'
[Seat:*]
autologin-user=user
autologin-user-timeout=0
user-session=xfce
EOF

mkdir -p config/includes.chroot/etc/sudoers.d
cat > config/includes.chroot/etc/sudoers.d/99-capstone-live <<'EOF'
user ALL=(ALL) NOPASSWD: ALL
EOF
chmod 0440 config/includes.chroot/etc/sudoers.d/99-capstone-live

# ---- LAN DHCP for the live session ----
# live-build ships no networking config of its own, so bake in a netplan rule
# so the live desktop comes up on DHCP whenever it's plugged into a network.
#
# Use `renderer: networkd`, NOT NetworkManager: at live boot netplan's
# NM-renderer config isn't reliably generated (it needs netplan's NM
# dispatcher), so the wired NIC can come up with only a link-local 169.254
# address instead of DHCP. With `renderer: networkd`, netplan's systemd
# generator writes the DHCP rule into /run/systemd/network for
# systemd-networkd (which is explicitly enabled below) at boot — deterministic
# DHCP on any en*/eth* interface.
mkdir -p config/includes.chroot/etc/netplan
cat > config/includes.chroot/etc/netplan/99-capstone-dhcp.yaml <<'NETPLAN'
network:
  version: 2
  renderer: networkd
  ethernets:
    all-eth:
      match:
        # Common Ethernet NIC name prefixes (enp* / ens* / eno* / eth*).
        name: ["en*", "eth*"]
      dhcp4: true
      optional: true
NETPLAN

# Ensure the renderers actually start at live boot so the rule above is
# applied. systemd-networkd is the renderer that carries the DHCP rule above;
# NetworkManager is also enabled so the desktop still has a connection-manager
# UI and can drive wifi/extra links.
mkdir -p config/includes.chroot/etc/systemd/system/multi-user.target.wants
ln -sf /lib/systemd/system/NetworkManager.service \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants/NetworkManager.service
ln -sf /lib/systemd/system/systemd-networkd.service \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants/systemd-networkd.service

mkdir -p config/includes.chroot/etc/skel/Desktop
cat > config/includes.chroot/etc/skel/Desktop/Download-Capstone-v1.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Download Capstone v2
Comment=Download the Capstone v2 release and offline bundle
Exec=x-terminal-emulator -e /opt/capstone/fetch-offline-bundle.sh
Icon=network-server
Terminal=true
Categories=System;
EOF
cat > config/includes.chroot/etc/skel/Desktop/Install-Capstone.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Install Capstone v2
Comment=Install Capstone v2 to this machine (live USB -> internal disk, or this system)
Exec=x-terminal-emulator -e sudo /opt/capstone/install-capstone.sh
Icon=drive-harddisk
Terminal=true
Categories=System;
EOF
chmod 0644 config/includes.chroot/etc/skel/Desktop/*.desktop

# ---- build ----
lb build

# The ISO produced by live-build is discarded; we re-master from the binary/
# tree so we can add the EFI boot image and isohybrid MBR ourselves.
[ -d binary/live ] || { echo "live-build did not produce binary/live" >&2; exit 1; }
[ -f binary/boot/grub/grub_eltorito ] || { echo "live-build did not produce the GRUB boot image" >&2; exit 1; }

# GRUB 2.12's grub-mkimage requires -p; live-build 3.0's el-torito step
# omits it and produces an empty core, so rebuild grub_eltorito here.
#
# With prefix /boot/grub the PC core resolves modules from the platform
# subdir /boot/grub/i386-pc/normal.mod (not the flat /boot/grub/*.mod that
# live-build copies). A BIOS/CSM boot (e.g. VMware) fails with
# "file /boot/grub/i386-pc/normal.mod not found" unless those modules exist
# there, so copy the full i386-pc module set into that subdirectory.
core_img="$(mktemp)"
grub-mkimage -d /usr/lib/grub/i386-pc -p /boot/grub \
  -o "$core_img" -O i386-pc biosdisk iso9660 \
  normal
cat /usr/lib/grub/i386-pc/cdboot.img "$core_img" > binary/boot/grub/grub_eltorito
rm -f "$core_img"
mkdir -p binary/boot/grub/i386-pc
cp /usr/lib/grub/i386-pc/* binary/boot/grub/i386-pc/

# ---- custom GRUB config: locate the ISO by volume label ----
KERNEL="$(basename "$(echo binary/live/vmlinuz-* | awk '{print $1}')")"
INITRD="initrd.img-${KERNEL#vmlinuz-}"
[ -f "binary/live/$KERNEL" ] || { echo "kernel not found in binary/live" >&2; exit 1; }
[ -f "binary/live/$INITRD" ] || { echo "initrd not found in binary/live" >&2; exit 1; }

cat > binary/boot/grub/grub.cfg <<EOF
set default=0
set timeout=10

insmod all_video
insmod gfxterm
insmod part_gpt
insmod part_msdos
insmod iso9660
insmod fat
insmod ext2
insmod search
insmod search_label

search --no-floppy --set=root --label $ISO_VOLUME

menuentry "Capstone v2 - Live" {
    linux /live/$KERNEL $BOOTARGS
    initrd /live/$INITRD
}

menuentry "Capstone v2 - Live (failsafe)" {
    linux /live/$KERNEL boot=live components noapic noacpi nomodeset
    initrd /live/$INITRD
}

menuentry "Reboot" {
    reboot
}
EOF

# ---- EFI boot image (GRUB x86_64-efi in a FAT image) ----
rm -rf efiboot
mkdir -p efiboot/EFI/BOOT
grub-mkimage -p /EFI/BOOT -O x86_64-efi \
  -o efiboot/EFI/BOOT/BOOTX64.EFI \
  normal linux echo configfile search search_label search_fs_uuid \
  loopback test loadenv part_gpt part_msdos iso9660 fat ext2 \
  all_video gfxterm font cat chain boot ls help
cp binary/boot/grub/grub.cfg efiboot/EFI/BOOT/grub.cfg
# Also place the EFI tree in the ISO filesystem root (as Ubuntu ISOs do) for
# compatibility with Windows USB-writing tools and some firmware quirks.
mkdir -p binary/EFI/BOOT
cp efiboot/EFI/BOOT/BOOTX64.EFI binary/EFI/BOOT/
cp efiboot/EFI/BOOT/grub.cfg binary/EFI/BOOT/

EFI_BYTES="$(du -sb efiboot | cut -f1)"
EFI_SECTORS=$(( EFI_BYTES * 3 / 512 + 128 ))
# Keep the image FAT32 (>= 65526 sectors) for widest UEFI firmware support.
# 67584 sectors x 512 B = 33 MiB, divisible by 32 (1 head x 32 sectors/track).
[ "$EFI_SECTORS" -lt 67584 ] && EFI_SECTORS=67584
mformat -C -F -i binary/boot/grub/efi.img -T "$EFI_SECTORS" ::
mcopy -s -i binary/boot/grub/efi.img efiboot/* ::
rm -rf efiboot

# ---- re-master: El Torito (BIOS) + EFI + isohybrid MBR (USB) ----
xorriso -as mkisofs \
  -V "$ISO_VOLUME" \
  -J -R -l -allow-multidot -cache-inodes \
  -A "Capstone v2" -publisher "Capstone" \
  -no-emul-boot -boot-load-size 4 -boot-info-table -b boot/grub/grub_eltorito \
  -eltorito-alt-boot -no-emul-boot -e boot/grub/efi.img \
  -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \
  -isohybrid-gpt-basdat \
  -o "$OUT_DIR/$ISO_NAME" binary

sha256sum "$OUT_DIR/$ISO_NAME" > "$OUT_DIR/$ISO_NAME.sha256"
echo "Created $OUT_DIR/$ISO_NAME"
