#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# install-onnx-kokoro.sh — put an ONNX Kokoro TTS model where the stack can
# reach it, and prove it synthesizes.
#
# Why speaches and not the `kokoro` service: the kokoro-fastapi image this
# stack defaults to (`ghcr.io/remsky/kokoro-fastapi-cpu:latest`, v0.9.0) is
# PyTorch-only — no onnxruntime, no ONNX inference path, its model file is
# `kokoro-v1_0.pth`. The ONNX Kokoro runtime this box already runs is
# `speaches` (onnxruntime, OpenAI-compatible /v1/audio/speech), which is the
# same service that carries STT. This script installs the model into it.
#
# The model lands on speaches' `speaches_models` volume, so it is a one-time
# download per host and survives a rebuild of the container.
#
# Usage:
#   ./scripts/install-onnx-kokoro.sh [--url http://127.0.0.1:8001] [--check]
#
#   --check   report whether the model is installed and synthesizes, change
#             nothing (exit 1 when it is missing).
#
# Env:
#   SPEACHES_URL        base URL of the speaches service   (default 127.0.0.1:8001)
#   ONNX_KOKORO_MODEL   model id to install                (default below)
#   ONNX_KOKORO_VOICE   voice used for the smoke synthesis (default af_heart)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SPEACHES_URL="${SPEACHES_URL:-http://127.0.0.1:8001}"
ONNX_KOKORO_MODEL="${ONNX_KOKORO_MODEL:-speaches-ai/Kokoro-82M-v1.0-ONNX}"
ONNX_KOKORO_VOICE="${ONNX_KOKORO_VOICE:-af_heart}"

CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)   SPEACHES_URL="$2"; shift 2 ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
SPEACHES_URL="${SPEACHES_URL%/}"

say()  { printf '%s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

installed() { # is the model in speaches' catalogue?
  curl -fsS -m 15 "$SPEACHES_URL/v1/models" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("yes" if any(m.get("id")=="'"$ONNX_KOKORO_MODEL"'" for m in d.get("data",[])) else "no")' \
    2>/dev/null || echo "no"
}

synthesizes() { # 200 with audio, not an error body
  local body http
  body="$(mktemp)"
  http="$(curl -sS -m 120 -o "$body" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    -d "{\"model\":\"$ONNX_KOKORO_MODEL\",\"input\":\"Kokoro onnx runtime check.\",\"voice\":\"$ONNX_KOKORO_VOICE\",\"response_format\":\"pcm\"}" \
    "$SPEACHES_URL/v1/audio/speech" 2>/dev/null || echo 000)"
  if [[ "$http" == "200" && -s "$body" ]]; then :; else
    say "     synthesise returned HTTP $http: $(head -c 200 "$body")"
    rm -f "$body"; return 1
  fi
  say "PASS synthesized $(wc -c <"$body" | tr -d ' ') bytes of PCM from $ONNX_KOKORO_MODEL ($ONNX_KOKORO_VOICE)"
  rm -f "$body"
  return 0
}

say "── speaches: $SPEACHES_URL"
say "── model:    $ONNX_KOKORO_MODEL"

curl -fsS -m 15 "$SPEACHES_URL/health" >/dev/null 2>&1 \
  || fail "speaches is not answering on $SPEACHES_URL — start it first (docker compose up -d speaches)"

if [[ "$(installed)" == "yes" ]]; then
  say "PASS model already installed"
else
  if [[ "$CHECK" -eq 1 ]]; then
    fail "model not installed (run without --check to download it)"
  fi
  say "── downloading (one-time, lands on the speaches_models volume)…"
  code="$(curl -sS -m 900 -o /dev/null -w '%{http_code}' \
    -X POST "$SPEACHES_URL/v1/models/$ONNX_KOKORO_MODEL" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] || fail "download returned HTTP $code"
  say "PASS downloaded"
fi

if [[ "$CHECK" -eq 1 ]]; then
  synthesizes || fail "model is installed but does not synthesize"
  exit 0
fi

synthesizes || fail "model is installed but does not synthesize"

say ""
say "To serve calls from it, point the TTS shim's kokoro engine at speaches:"
say "  TTS_SHIM_KOKORO_URL=http://speaches:8000"
say "  TTS_SHIM_KOKORO_MODEL=$ONNX_KOKORO_MODEL"
say "then: docker compose up -d tts-shim   (the kokoro service stays as the fallback)"
