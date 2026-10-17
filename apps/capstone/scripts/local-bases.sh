#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# local-bases.sh — the base images the Control Center builds FROM, cached here.
#
# `python:3.12-slim`, `node:20-alpine` and `nginx:1.27-alpine` are docker.io
# tags, and docker.io answers this host with 429 Too Many Requests often enough
# that a deploy failed on it four times in a row. A build does not need the
# registry once the image is on the host — but BuildKit resolves a tag's
# metadata even then — so the durable fix is to stop naming a docker.io tag:
# this script pins a stable local name (`capstone-base/<role>:local`) to
# whichever image the host actually has, and both Dockerfiles take that name as
# a build arg.
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
# this" is something an operator should be able to see. The nginx role cannot be
# substituted by a tag alone: when no nginx image is on the host, this builds one
# from `alpine` with dashboard/nginx-base.Dockerfile (nginx + envsubst + the
# template-rendering entrypoint), so the Control Center's base is its own image
# rather than the previous Control Center image.
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

# ensure <role> <candidate>... — the local ref for <role>, creating the tag if
# a candidate is already present (or can be pulled).
ensure() {
    local role="$1"; shift
    local target="$PREFIX/$role:local" cand
    if have "$target"; then
        printf '%s\n' "$target"
        return 0
    fi
    if [ "$PRINT_ONLY" = "1" ]; then
        printf '%s\n' "$target"
        return 0
    fi
    for cand in "$@"; do
        if have "$cand"; then
            docker tag "$cand" "$target" || fail "could not tag $cand as $target"
            note "$role <- $cand (already on this host)"
            printf '%s\n' "$target"
            return 0
        fi
    done
    for cand in "$@"; do
        if timeout "$PULL_TIMEOUT" docker pull "$cand" >/dev/null 2>&1; then
            docker tag "$cand" "$target" || fail "could not tag $cand as $target"
            note "$role <- $cand (pulled)"
            printf '%s\n' "$target"
            return 0
        fi
    done
    # docker.io refused (typically 429): try the same tag from a mirror.
    local name tag mirror
    for cand in "$@"; do
        case "$cand" in
            *:*) name="${cand%:*}"; tag="${cand##*:}" ;;
            *)   name="$cand"; tag="latest" ;;
        esac
        for mirror in $MIRRORS; do
            if timeout "$PULL_TIMEOUT" docker pull "$mirror/$name:$tag" >/dev/null 2>&1; then
                docker tag "$mirror/$name:$tag" "$target" \
                    || fail "could not tag $mirror/$name:$tag as $target"
                note "$role <- $mirror/$name:$tag (docker.io refused; pulled via mirror)"
                printf '%s\n' "$target"
                return 0
            fi
        done
    done
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
elif have "$PREFIX/nginx:local" && \
     { [ -z "$nginx_built_hash" ] || [ "$nginx_built_hash" = "$nginx_hash" ]; }; then
    nginx_ref="$PREFIX/nginx:local"
    [ -n "$nginx_built_hash" ] \
        && note "nginx <- $PREFIX/nginx:local (built by this script, up to date)"
elif have "$PREFIX/nginx:local"; then
    note "nginx <- $PREFIX/nginx:local is stale (dashboard/nginx-base changed) — rebuilding"
else
    # No local base yet: adopt one of the host's nginx images if there is one.
    for cand in nginx:1.27-alpine nginx:1.27 nginx:alpine; do
        if have "$cand"; then
            docker tag "$cand" "$PREFIX/nginx:local" \
                || fail "could not tag $cand as $PREFIX/nginx:local"
            note "nginx <- $cand (already on this host)"
            nginx_ref="$PREFIX/nginx:local"
            break
        fi
    done
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
