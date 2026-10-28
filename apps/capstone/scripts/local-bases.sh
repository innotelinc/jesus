#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# local-bases.sh — the base images the Control Center builds FROM, cached here.
#
# `python:3.12-slim`, `node:20-alpine` and `nginx:1.27-alpine` are docker.io
# tags, and docker.io answers this host with 429 Too Many Requests often enough
# that a deploy failed on it four times in a row. Both Dockerfiles therefore take
# their base as a build arg, and this script resolves that arg: it prefers the
# canonical upstream tag (pulled with the host's Docker Hub login, so the base is
# the version the Dockerfiles name), retags it as a stable local name
# (`capstone-base/<role>:local`) and only falls back to the previously pinned
# image when upstream cannot be obtained.
#
#   ./scripts/local-bases.sh            # ensure the tags, then print the refs
#   ./scripts/local-bases.sh --print    # print the refs, create nothing
#
# Output (build args, one per line):
#   PYTHON_IMAGE=capstone-base/python:local
#   NODE_IMAGE=capstone-base/node:local
#   NGINX_IMAGE=capstone-base/nginx:local
#
# When docker.io refuses a pull outright, the same tag is requested from a Hub
# mirror (mirror.gcr.io, public.ecr.aws — CAPSTONE_BASE_MIRRORS overrides), so a
# 429 delays nothing. A substitute base is named on stderr, because "3.13 built
# this" is something an operator should be able to see. If neither upstream nor
# mirror answers, the pinned image is used and the substitution is printed. When
# no nginx image has ever been on the host, the fallback is built from `alpine`
# with dashboard/nginx-base.Dockerfile (nginx + envsubst + the template-rendering
# entrypoint), so the Control Center's base never has to be another image in this
# stack.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${CAPSTONE_BASE_PREFIX:-capstone-base}"
PULL_TIMEOUT="${CAPSTONE_BASE_PULL_TIMEOUT:-90}"
# docker.io applies a per-IP anonymous pull quota and this host hits it (429)
# often enough that it blocked a deploy four times. These are mirrors of the
# same Hub images (verified: identical image id and digest for alpine:3.20), so
# the second half of the pull path asks one of them instead of giving up.
# Space-separated path prefixes; override to add your own.
MIRRORS="${CAPSTONE_BASE_MIRRORS:-mirror.gcr.io/library public.ecr.aws/docker/library}"
PRINT_ONLY=0

case "${1:-}" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    "") ;;
    *) printf 'local-bases: unknown argument: %s\n' "$1" >&2; exit 2 ;;
esac

note() { printf 'local-bases: %s\n' "$*" >&2; }
fail() { printf 'local-bases: %s\n' "$*" >&2; exit 1; }

have() { docker image inspect "$1" >/dev/null 2>&1; }

# pull_cand <candidate>... — pull the first reachable tag, directly then from a
# docker.io mirror; echoes the ref that worked.
pull_cand() {
    local cand name tag mirror
    for cand in "$@"; do
        if timeout "$PULL_TIMEOUT" docker pull "$cand" >/dev/null 2>&1; then
            printf '%s\n' "$cand"
            return 0
        fi
    done
    for cand in "$@"; do
        case "$cand" in
            *:*) name="${cand%:*}"; tag="${cand##*:}" ;;
            *)   name="$cand"; tag="latest" ;;
        esac
        for mirror in $MIRRORS; do
            if timeout "$PULL_TIMEOUT" docker pull "$mirror/$name:$tag" >/dev/null 2>&1; then
                printf '%s\n' "$mirror/$name:$tag"
                return 0
            fi
        done
    done
    return 1
}

# ensure <role> <upstream tag>... — the local ref for <role>.
#
# Upstream is preferred while it can be obtained: the host holds a Docker Hub
# login now, so the canonical base (python:3.12-slim, node:20-alpine) is what
# builds — the pins are a fallback for the 429 case, not the default. A tag
# already on the host is reused without a registry call, so repeat builds stay
# offline.
ensure() {
    local role="$1"; shift
    local target="$PREFIX/$role:local" cand pulled
    if [ "$PRINT_ONLY" = "1" ]; then
        printf '%s\n' "$target"
        return 0
    fi
    for cand in "$@"; do
        if have "$cand"; then
            docker tag "$cand" "$target" || fail "could not tag $cand as $target"
            note "$role <- $cand (upstream tag, on this host)"
            printf '%s\n' "$target"
            return 0
        fi
    done
    if pulled="$(pull_cand "$@")" && [ -n "$pulled" ]; then
        docker tag "$pulled" "$target" || fail "could not tag $pulled as $target"
        note "$role <- $pulled (pulled)"
        printf '%s\n' "$target"
        return 0
    fi
    if have "$target"; then
        note "$role <- $target (pinned fallback: upstream unreachable)"
        printf '%s\n' "$target"
        return 0
    fi
    return 1
}

python_ref="$(ensure python python:3.12-slim python:3.13-slim python:3.12 python:3.13)" \
    || fail "no python base here, and docker.io would not give one (rate limited?)"
node_ref="$(ensure node node:20-alpine node:22-alpine node:22-slim node:20-slim)" \
    || fail "no node base here, and docker.io would not give one (rate limited?)"
# nginx: one of its own tags if the host has them, otherwise built from alpine
# — its own image, not the previous dashboard image, and no registry pull on the
# 429 path (alpine is local, so this build costs seconds).
#
# A base this script built carries a label with the hash of the files it was
# built FROM. Without it, editing dashboard/nginx-base/* would move the UI
# image's hash but the build would reuse the stale base tag, so the edit would
# deploy and change nothing. A base tagged from an upstream nginx image has no
# such label and is left alone.
nginx_src_hash() {
    { cat "$REPO/dashboard/nginx-base.Dockerfile"
      find "$REPO/dashboard/nginx-base" -type f | LC_ALL=C sort | while IFS= read -r f; do
          printf '%s\n' "$f" && cat "$f"
      done
    } | sha256sum | awk '{print $1}'
}
nginx_ref=""
nginx_hash="$(nginx_src_hash)"
nginx_built_hash="$(docker image inspect "$PREFIX/nginx:local" \
    --format '{{index .Config.Labels "capstone.nginx-base.src"}}' 2>/dev/null || true)"
if [ "$PRINT_ONLY" = "1" ]; then
    # Print the name only: CI must not need Docker, and the hash includes the
    # build args, so resolving real images here would move the deploy hash.
    nginx_ref="$PREFIX/nginx:local"
else
    # Upstream nginx first (same preference as python/node), then our own base.
    upstream_nginx=""
    for cand in nginx:1.27-alpine nginx:1.27 nginx:alpine; do
        if have "$cand"; then upstream_nginx="$cand"; break; fi
    done
    [ -n "$upstream_nginx" ] \
        || upstream_nginx="$(pull_cand nginx:1.27-alpine nginx:1.27 nginx:alpine)"
    if [ -n "$upstream_nginx" ]; then
        docker tag "$upstream_nginx" "$PREFIX/nginx:local" \
            || fail "could not tag $upstream_nginx as $PREFIX/nginx:local"
        note "nginx <- $upstream_nginx (upstream tag)"
        nginx_ref="$PREFIX/nginx:local"
    fi
fi
if [ -z "$nginx_ref" ] && [ "$PRINT_ONLY" != "1" ]; then
    if have "$PREFIX/nginx:local" && \
       { [ -z "$nginx_built_hash" ] || [ "$nginx_built_hash" = "$nginx_hash" ]; }; then
        nginx_ref="$PREFIX/nginx:local"
        [ -n "$nginx_built_hash" ] \
            && note "nginx <- $PREFIX/nginx:local (built by this script, up to date)"
    fi
    if have "$PREFIX/nginx:local" && [ "$nginx_built_hash" != "$nginx_hash" ] \
       && [ -n "$nginx_built_hash" ]; then
        note "nginx <- $PREFIX/nginx:local is stale (dashboard/nginx-base changed) — rebuilding"
    fi
fi
if [ -z "$nginx_ref" ]; then
    alpine_ref="$(ensure alpine alpine:3.20 alpine:3.21 alpine:latest)" \
        || fail "no nginx image and no alpine image to build one from"
    note "nginx <- built from $alpine_ref (dashboard/nginx-base.Dockerfile)"
    docker build -q \
        -f "$REPO/dashboard/nginx-base.Dockerfile" \
        --build-arg "ALPINE_IMAGE=$alpine_ref" \
        --label "capstone.nginx-base.src=$nginx_hash" \
        -t "$PREFIX/nginx:local" \
        "$REPO/dashboard" >/dev/null \
        || fail "could not build the local nginx base"
    nginx_ref="$PREFIX/nginx:local"
fi

printf 'PYTHON_IMAGE=%s\n' "$python_ref"
printf 'NODE_IMAGE=%s\n' "$node_ref"
printf 'NGINX_IMAGE=%s\n' "$nginx_ref"
