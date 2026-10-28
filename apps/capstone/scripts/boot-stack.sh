#!/usr/bin/env bash
# boot-stack.sh — the boot sequence `systemd/capstone.service` runs.
#
# Why this is a script and not two literal ExecStart lines: the stack is laid out
# two different ways, and the unit has to boot both.
#
#  * **Split** (this deployment): the voice platform runs as its OWN compose
#    project — `dograh`, from dograh/upstream plus docker-compose.dograh-capstone.yml —
#    and this repo's compose file then supplies only what that project does not.
#    The capstone run therefore MUST NOT name postgres/redis/minio/dograh-api/
#    dograh-ui/speaches/grist: the `dograh` project already owns those container
#    names and host ports, so compose aborts on the collision ("Bind for
#    127.0.0.1:4317 failed: port is already allocated", "container name is
#    already in use"). That abort happens before the first service is reached,
#    which reads as "the boot path is broken" with no service named — the reason
#    the service list below is load-bearing rather than tidiness.
#  * **Standalone**: no dograh/upstream checkout, one project, and the capstone
#    run starts the whole stack.
#
# `--pull=never` on both runs: a boot must not depend on registry access, and a
# tag that no longer exists has to fail loudly here instead of silently
# hand-editing which build a service runs. It is also what turns stale image
# references in `.env` into a named, immediate failure (`minio/minio:latest`,
# which upstream deleted from docker.io, or a `dograh-local/*` build tag nobody
# built) instead of a pull that hangs a boot. `.env.example` keeps every IMAGE
# override on a value that is actually published — see "Registry images" and
# "MinIO image" there before repointing one.
#
# The capstone service list is a measured working set: an unlisted `up -d` starts
# all 29 services, which on the 2-core / 7.3 GiB host this list was curated on
# pinned the container at its memory cap (full pressure 69%) for 20 minutes on
# first boot. It names the services no other project claims — the Control Center,
# the TTS shim, the SSO gateways and the observability pair. Override it per host
# with `CAPSTONE_BOOT_SERVICES` (space-separated) in the environment or in
# /etc/capstone/boot.env; leaving it empty on a standalone box is what makes that
# run start everything.
#
# Usage:  scripts/boot-stack.sh [--dry-run] | [--stop]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# The services this repo owns when the voice platform is its own project. Order
# is not significant to compose; it is grouped by role for readability.
#
# The `*-sso` gateways are doors the edge already routes (n8n.<domain> → 14010,
# grist.<domain> → 14011, workflow.<domain> → 14013) and the apps behind them
# are loopback-only, so the gateway IS the door: without it those names answer
# 502 from the edge rather than the app. `n8n` and `grist` themselves are the
# voice project's (see docker-compose.dograh-capstone.yml note 6, which is what
# puts them on interview-net for their gateway to reach); `workflow-studio` is
# this project's and the only app behind `workflow.<domain>`.
CAPSTONE_SERVICES_DEFAULT="minio tts-shim dashboard dashboard-api \
pbx-sso prometheus grafana grafana-sso \
otel-collector searxng sandbox-api sandbox-runner-1 \
n8n-sso grist-sso workflow-sso workflow-studio"

# The voice platform's own project: the upstream compose plus the fork's image
# overrides, with the platform's env file (written by scripts/setup.sh). Booted
# without --wait on purpose — its one-shots (signoz-schema-migrator, n8n-import)
# run their job and exit, and compose would otherwise decide the unit's fate on
# them, the same way setup.sh avoids --wait on the single-project layout.
DOGRAH_COMPOSE=(--project-directory dograh/upstream -p dograh
    -f dograh/upstream/docker-compose.yaml -f docker-compose.dograh-capstone.yml
    --env-file data/.env.dograh --profile tunnel)

log() { printf 'boot-stack: %s\n' "$*"; }
die() { printf 'boot-stack: %s\n' "$*" >&2; exit 1; }

DRY_RUN=()
STOP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=(--dry-run) ;;
        --stop)    STOP=1 ;;
        -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
        *) die "unknown option: $1 (usage: boot-stack.sh [--dry-run|--stop])" ;;
    esac
    shift
done

# Compose interpolation reads one file, and for a stack whose .env carries
# `vault://` references that file has to be the resolved copy: a service written
# as `KEY: "${KEY:-}"` otherwise receives the literal reference string as its
# credential and dies (zeus-freepbx crash-looped on FREEPBX_AMI_SECRET exactly
# this way). scripts/compose-vault.sh and scripts/setup.sh both write it.
#
# The resolved copy exists to stand in for those references, so it is the source
# only while `.env` still holds them. A copy that outlives them is a stale
# snapshot of an older `.env`, and it wins silently — measured on this host: a
# `.env` whose references had all been replaced by their values booted from a
# four-hour-old `data/.env.resolved` carrying a *different*
# AUTHENTIK_CLIENT_SECRET, so nothing the operator edited took effect until the
# file was noticed.
REFS="$(grep -c 'vault://' "$REPO/.env" 2>/dev/null || true)"
if [ "${REFS:-0}" -gt 0 ]; then
    if [ -s "$REPO/data/.env.resolved" ]; then
        ENV_FILE="$REPO/data/.env.resolved"
        log "env: data/.env.resolved ($REFS vault:// reference(s) in .env)"
    else
        die ".env holds $REFS vault:// reference(s) but data/.env.resolved is missing — \
run scripts/compose-vault.sh (or scripts/setup.sh) once before booting"
    fi
    if [ "$REPO/.env" -nt "$ENV_FILE" ]; then
        log "note: .env is newer than $(basename "$ENV_FILE") — re-run scripts/compose-vault.sh to pick the change up"
    fi
else
    ENV_FILE="$REPO/.env"
    if [ -e "$REPO/data/.env.resolved" ]; then
        log "note: .env has no vault:// references, so it is the interpolation source; \
data/.env.resolved is a leftover snapshot of an older .env — move it aside if it is not wanted"
    fi
fi

if [ "$STOP" = 1 ]; then
    # What `systemctl stop capstone` has always meant: this project goes down.
    # The voice platform runs under its own unit-lifecycle-free project and is
    # deliberately left alone.
    log "stopping the capstone project (the voice platform keeps running)"
    exec docker compose --env-file "$ENV_FILE" -f docker-compose.yml down --remove-orphans
fi

# The object store first, from the project that owns it. The voice platform's
# own minio is parked (`profiles: ["dograh-minio-legacy"]` in
# docker-compose.dograh-capstone.yml) because the container name `minio` and the
# media volume belong to this project, and its api waits on that store — this is
# the health-then-start ordering api's depends_on used to express. `--wait`
# (minio has a healthcheck) is what makes the ordering real; no
# --remove-orphans, so this cannot disturb the rest of the project.
log "1/3 object store (project: capstone)"
# minio-data is external (see docker-compose.yml): compose will not create it,
# and a host that never ran scripts/setup.sh would otherwise fail here rather
# than start. Creating it when absent is the same thing setup.sh does.
docker volume inspect capstone_minio-data >/dev/null 2>&1 \
    || docker volume create capstone_minio-data >/dev/null
docker compose "${DRY_RUN[@]}" --env-file "$ENV_FILE" -f docker-compose.yml \
    up -d --wait --pull=never minio

SPLIT=0
if [ -f "$REPO/dograh/upstream/docker-compose.yaml" ]; then
    SPLIT=1
    log "2/3 voice platform (project: dograh)"
    docker compose "${DRY_RUN[@]}" "${DOGRAH_COMPOSE[@]}" up -d --pull=never
else
    log "2/3 no dograh/upstream checkout — single-project layout, the capstone run starts the whole stack"
fi

if [ -n "${CAPSTONE_BOOT_SERVICES:-}" ]; then
    read -r -a SERVICES <<<"$CAPSTONE_BOOT_SERVICES"
elif [ "$SPLIT" = 1 ]; then
    read -r -a SERVICES <<<"$CAPSTONE_SERVICES_DEFAULT"
else
    SERVICES=()
fi

if [ "${#SERVICES[@]}" -gt 0 ]; then
    log "3/3 capstone: ${SERVICES[*]}"
else
    log "3/3 capstone: the whole file"
fi

# --wait is the boot verification: it returns non-zero unless every service with
# a healthcheck is healthy and every depends_on condition is met. The one-shots
# (sandbox-certs, healthprobe) are dependencies of listed services and exit 0;
# compose reports their exit and continues.
exec docker compose "${DRY_RUN[@]}" --env-file "$ENV_FILE" -f docker-compose.yml \
    up -d --wait --remove-orphans --pull=never "${SERVICES[@]}"
