#!/usr/bin/env bash
# env-lib.sh — load a .env into the shell WITHOUT evaluating it.
#
# `set -a; source .env; set +a` runs the file as shell code, so a single value
# with a shell metacharacter aborts the load: this host's .env carried
# `VOIPMS_SIP_PASS=}[fFgqK}(&oe?CM` and every script that sourced it died with a
# syntax error partway through — silently losing every variable below that line
# (and `$(...)` in a value would have been executed outright).
#
# Here the file is read as DATA: no word splitting, no command substitution, no
# globbing, no `$` expansion. Keys must be shell identifiers; surrounding quotes
# are stripped; blank lines, whole-line comments and CRLF are tolerated.
#
# Semantics — deliberately the same as the `set -a; source` it replaces: the
# FILE WINS (a value in .env is assigned even if the variable already exists in
# the environment). Pass nothing to load `./.env`.
#
#   ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   . "$ROOT/scripts/env-lib.sh"
#   env_lib_load "$ROOT/.env"

env_lib_load() { # [path=.env]
  local file="${1:-.env}"
  [ -f "$file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    # Skip anything that is not a plain KEY= line (a stray sentence, a URL).
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    case "$key" in [0-9]*) continue ;; esac
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    printf -v "$key" '%s' "$val" || continue
    export "${key?}"   # export the variable the name points at (SC2163-safe)
  done < "$file"
}
