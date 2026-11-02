#!/bin/sh
# Cloud-init for the Vultr demo.
#
# It prepares a Docker host and nothing else. The estate itself is uploaded by
# vultr-demo.sh after this runs, so the instance runs the tree that was verified
# on the operator's machine — not whatever happens to be on a branch somewhere.
#
# Placeholder: @ESTATE_DIR@ is substituted by vultr-demo.sh.
set -eu

export DEBIAN_FRONTEND=noninteractive

# 1. Docker from Docker's own repository: the distro package lags far enough
#    behind that `docker compose` is a plugin the image does not ship.
apt-get update -qq
apt-get install -y -qq ca-certificates curl tar >/dev/null
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
systemctl enable --now docker

# 2. Where the estate lands. empty until vultr-demo.sh uploads it.
mkdir -p "@ESTATE_DIR@"

# 3. A marker the deploy script waits for, so it never copies into a box that
#    is still installing packages.
touch /var/lib/cantus-demo-ready

cat > /etc/motd <<'EOF'

  Cantus estate demo — the estate is uploaded and started by the deploy script.
  Once it is up:
    console   http://<ip>:8000
    switch    http://<ip>:8188/v1/status
    telno     http://<ip>:8090

  logs      cd /opt/cantus-estate/estate && docker compose logs -f
  restart   ./up.sh up
  reset     ./up.sh reset

EOF
