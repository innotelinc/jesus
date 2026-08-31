#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# dograh-ARI bootstrap for the Innotel FreePBX fullstack image.
#
# Injects the dograh ARI wiring into /etc/asterisk BEFORE the stock entrypoint
# (entrypoint.sh) starts, so the config is in place for the first boot and
# re-applied (idempotently) on every restart:
#
#   ari.conf                ARI user [dograh] (Stasis app name = "dograh")
#   http.conf               Asterisk HTTP on 8088 (only if the image lacks one)
#   websocket_client.conf   external media WS -> dograh-api (host mode :8000)
#   extensions_custom.conf  [dograh-inbound] dialplan context -> Stasis(dograh)
#   rtp_custom.conf         cap RTP range to the compose-published 10101-10120
#
# /etc/asterisk is the named volume pbx-asterisk-config; FreePBX manages its
# own files there (extensions.conf, http_additional.conf, ...) and does NOT
# regenerate the four files above, so the injection survives Apply Config.
#
# Env overrides (from the compose .env):
#   DOGRAH_ARI_PASSWORD  strong password for the ARI user (sed'd into ari.conf)
#   DOGRAH_WS_URI        media WebSocket URI (default ws://host.docker.internal:8000/...)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SRC="/opt/pbx-dograh"
DEST="/etc/asterisk"

echo ">>> [dograh-ari] injecting dograh ARI config into ${DEST}"

# ── PHP memory_limit → 512M (idempotent) ──────────────────────────────────
# The fullstack image ships memory_limit=128M in the PHP ini files (Apache +
# FPM + CGI, PHP 8.2 and 7.4). The FreePBX UI / API can hit that ceiling on
# large configs, so raise it to 512M on every boot.
for ini in /etc/php/*/apache2/php.ini /etc/php/*/fpm/php.ini /etc/php/*/cgi/php.ini; do
  [ -f "$ini" ] || continue
  if grep -q '^memory_limit' "$ini"; then
    sed -i 's/^memory_limit.*/memory_limit = 512M/' "$ini"
  else
    printf '\nmemory_limit = 512M\n' >> "$ini"
  fi
done
echo ">>> [dograh-ari] PHP memory_limit set to 512M"

# ── ODBC driver / socket fix (idempotent) ──────────────────────────────────
# The image's /etc/odbc.ini references driver=MySQL, but only the MariaDB
# driver ("MariaDB Unicode") is installed, and the socket path points at a
# stale location. That makes res_odbc / cdr_adaptive_odbc / cel_odbc fail
# with "Data source name not found" on every boot. Point the DSN at the
# bundled MariaDB so CDR/CEL actually work.
if [ -f /etc/odbc.ini ]; then
  sed -i 's/^driver=MySQL[[:space:]]*$/driver=MariaDB Unicode/' /etc/odbc.ini
  sed -i 's|^Socket=.*|Socket=/var/run/mysqld/mysqld.sock|' /etc/odbc.ini
  echo ">>> [dograh-ari] odbc.ini driver -> MariaDB Unicode, socket fixed"
fi

# ── stasis.conf: keep minimum_size commented (idempotent) ──────────────────
# The shipped sample has a stray option that Asterisk 22's res_stasis does not
# register for its taskpool type, producing "Could not find option
# 'minimum_size' with type 'threadpool' in module 'stasis'" at load. Keep any
# uncommented occurrence commented out.
if [ -f "${DEST}/stasis.conf" ]; then
  sed -i 's/^[[:space:]]*minimum_size/;minimum_size/' "${DEST}/stasis.conf"
  echo ">>> [dograh-ari] stasis.conf minimum_size kept commented"
fi

# ── cel_sqlite3_custom.conf: fix stray values line (idempotent) ────────────
# The image ships a template where every section header is commented but one
# `values = ...` line is not, causing "parse error: No category context for
# line 64". Comment that stray line so the file parses (CEL stays disabled).
if [ -f "${DEST}/cel_sqlite3_custom.conf" ]; then
  # Hard-comment any stray uncommented key=value line that sits outside a
  # real (non-commented) [section] — the image ships one such line at 64.
  python3 - "${DEST}/cel_sqlite3_custom.conf" <<'PYEOF' 2>/dev/null || true
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
cur_section = None
changed = False
for i, line in enumerate(lines):
    s = line.strip()
    if s.startswith('['):
        cur_section = None if s.startswith(';[') else s
        continue
    if cur_section is None and s and not s.startswith(';') and '=' in s:
        lines[i] = ';' + lines[i]
        changed = True
if changed:
    open(p, 'w').write('\n'.join(lines))
    print('>>> [dograh-ari] commented stray keys in cel_sqlite3_custom.conf')
PYEOF
fi

# ── iax.conf / rtp.conf include hygiene (idempotent) ───────────────────────
# The fullstack image appends '#include iax_fax_custom.conf' to BOTH iax.conf
# and iax_custom.conf (and the module template adds it again), so the fax
# config is loaded twice -> "Same File included more than once". Move it to
# iax_custom_post.conf (included after everything else) and remove the dupes.
# rtp.conf likewise ends up with '#include rtp_custom.conf' twice.
fix_include_hygiene() {
  # rtp.conf: keep exactly one '#include rtp_custom.conf' (the image appends
  # a second one at build time -> "Same File included more than once")
  if [ -f "${DEST}/rtp.conf" ]; then
    python3 - "${DEST}/rtp.conf" <<'PYEOF' 2>/dev/null || true
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
seen = False
out = []
for line in lines:
    if line.strip() == '#include rtp_custom.conf':
        if seen:
            continue
        seen = True
    out.append(line)
open(p, 'w').write('\n'.join(out))
if seen:
    print('>>> [dograh-ari] rtp.conf: deduped #include rtp_custom.conf')
PYEOF
  fi

  # iax: drop the fax include from iax.conf and iax_custom.conf, keep it in
  # iax_custom_post.conf (which iax.conf includes after everything else).
  #
  # IMPORTANT: /etc/asterisk/iax.conf is a SYMLINK to the core module template
  # (/var/www/html/admin/modules/core/etc/iax.conf), and FreePBX re-creates the
  # symlink on reload. So we must edit THROUGH the symlink with python
  # (open() follows the link and rewrites the template in place); `sed -i`
  # would replace the symlink with a regular file and the include would
  # reappear on the next reload. Same for rtp.conf below.
  if [ -L "${DEST}/iax.conf" ] || [ -f "${DEST}/iax.conf" ]; then
    python3 - "${DEST}/iax.conf" <<'PYEOF' 2>/dev/null || true
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
out = [l for l in lines if l.strip() != '#include iax_fax_custom.conf']
if out != lines:
    open(p, 'w').write('\n'.join(out))
    print('>>> [dograh-ari] removed fax include from iax.conf (via template)')
PYEOF
  fi
  for f in iax_custom.conf; do
    [ -f "${DEST}/$f" ] || continue
    grep -q '^#include iax_fax_custom.conf' "${DEST}/$f" || continue
    sed -i '/^#include iax_fax_custom.conf/d' "${DEST}/$f"
    echo ">>> [dograh-ari] removed fax include from $f"
  done
  touch "${DEST}/iax_custom_post.conf"
  if ! grep -q '^#include iax_fax_custom.conf' "${DEST}/iax_custom_post.conf"; then
    printf '#include iax_fax_custom.conf\n' >> "${DEST}/iax_custom_post.conf"
    echo ">>> [dograh-ari] fax include moved to iax_custom_post.conf"
  fi
}
fix_include_hygiene

# ── modules.conf: silence loader errors (idempotent) ────────────────────────
# The fullstack image ships `preload = chan_local.so` but does NOT include
# chan_local.so in the module tree, so every Asterisk start logs "cannot open
# shared object file" for it. HEP and the SQLite CDR/CEL custom backends are
# likewise shipped-but-disabled and log "declined to load". Comment the
# chan_local preload and noload the unused modules so a clean boot runs quiet.
fix_modules_conf() {
  local MC="${DEST}/modules.conf"
  [ -f "$MC" ] || return 0
  sed -i 's|^preload = chan_local.so.*|;preload = chan_local.so  # module absent from image|' "$MC"
  for m in res_hep.so res_hep_rtcp.so res_hep_pjsip.so \
           cdr_sqlite3_custom.so cel_sqlite3_custom.so \
           res_pjsip_phoneprov_provider.so; do
    grep -q "^noload = $m$" "$MC" || printf 'noload = %s\n' "$m" >> "$MC"
  done
  echo ">>> [dograh-ari] modules.conf: chan_local preload + unused modules noloaded"
}
fix_modules_conf

# ── rtp_custom.conf: canonical content (idempotent) ─────────────────────────
# Rewrite the whole file so it always contains exactly the RTP cap block the
# compose publishes. Keeps stunaddr/icesupport even if the image file drifts.
RTP_START="${FREEPBX_RTP_PORT_START:-10101}"
RTP_END="${FREEPBX_RTP_PORT_END:-10120}"
if ! [[ "${RTP_START}" =~ ^[0-9]+$ && "${RTP_END}" =~ ^[0-9]+$ ]] || [ "${RTP_START}" -lt 1024 ] || [ "${RTP_START}" -gt "${RTP_END}" ]; then
  echo ">>> [dograh-ari] invalid RTP range ${RTP_START}-${RTP_END}" >&2
  exit 1
fi
cat > "${DEST}/rtp_custom.conf" <<EOF
[general]
stunaddr = stun.l.google.com:19302
icesupport = yes
rtpstart=${RTP_START}
rtpend=${RTP_END}
EOF
chown asterisk:asterisk "${DEST}/rtp_custom.conf" 2>/dev/null || true
echo ">>> [dograh-ari] rtp_custom.conf canonical (${RTP_START}-${RTP_END})"

# ── FreePBX API module: fix a corrupted line in the image ──────────────────
# pbx-portal fullstack images shipped a stray 't' on Api.class.php:290
# ("tif (!isset($activeModules[$module]))") which is a PHP parse error — it
# makes every /admin/api request return HTTP 500 and freezes the dograh route
# bootstrap (bootstrap_dograh_route.py waits forever for the OAuth token).
# Idempotent: only rewrites the file when the corruption is present.
API_CLASS="/var/www/html/admin/modules/api/Api.class.php"
if [ -f "${API_CLASS}" ] && grep -qP '^t\s+if \(' "${API_CLASS}" 2>/dev/null; then
  python3 - "${API_CLASS}" <<'PYEOF'
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
for i, line in enumerate(lines):
    if line.startswith('t') and 'if (!isset($activeModules' in line:
        lines[i] = '\t\t\t\t' + line[1:].lstrip()
        break
open(p, 'w').write('\n'.join(lines))
print('>>> [dograh-ari] fixed corrupted Api.class.php line')
PYEOF
fi

# ── ari.conf (always install) ──────────────────────────────────────────────
if [ -f "${SRC}/ari.conf" ]; then
  cp -f "${SRC}/ari.conf" "${DEST}/ari.conf"
  if [ -n "${DOGRAH_ARI_PASSWORD:-}" ]; then
    # `|` delimiter: DOGRAH_ARI_PASSWORD is base64 and can contain `/`, which
    # would terminate a s/// sed and kill the entrypoint (the container then
    # crash-looped and ARI/Webmin stayed down on fresh installs).
    sed -i "s|^password = .*|password = ${DOGRAH_ARI_PASSWORD}|" "${DEST}/ari.conf"
    echo ">>> [dograh-ari] ari.conf password set from DOGRAH_ARI_PASSWORD"
  else
    echo ">>> [dograh-ari] WARNING: DOGRAH_ARI_PASSWORD unset — ari.conf keeps CHANGE_ME_ARI_PASSWORD"
  fi
fi

# ── http.conf (only if the image doesn't ship one — FreePBX manages HTTP) ──
# NOTE: the fullstack image ships http.conf → FreePBX's managed file, and its
# boot-time `fwconsole reload` REGENERATES http_additional.conf from the
# freepbx_settings DB. So enabling HTTP at the file level does not survive a
# boot. The durable enable happens post-boot via the settings DB (see the
# background hook at the bottom of this script); this file stays as a base
# fallback for images that ship no http.conf at all.
if [ -f "${SRC}/http.conf" ] && [ ! -f "${DEST}/http.conf" ]; then
  cp -f "${SRC}/http.conf" "${DEST}/http.conf"
  echo ">>> [dograh-ari] installed http.conf (was missing)"
fi

# ── websocket_client.conf (always install; URI overridable) ────────────────
if [ -f "${SRC}/websocket_client.conf" ]; then
  cp -f "${SRC}/websocket_client.conf" "${DEST}/websocket_client.conf"
  if [ -n "${DOGRAH_WS_URI:-}" ]; then
    sed -i "s|^uri = .*|uri = ${DOGRAH_WS_URI}|" "${DEST}/websocket_client.conf"
    echo ">>> [dograh-ari] websocket_client.conf uri set from DOGRAH_WS_URI"
  fi
fi

# ── extensions_custom.conf (context-aware merge, idempotent) ────────────────
# The source file is CANONICAL for every [context] it defines ([dograh-inbound]
# and [from-internal-custom]): the PBX copy's matching context is replaced
# wholesale with the source version, so added/changed extensoins propagate on
# the next boot and can never duplicate. Contexts that exist only on the PBX
# side pass through untouched, and source-only contexts are appended.
inject_dialplan() {
  local src="$1" dst="$2" tmp
  tmp="$(mktemp)"
  awk -v srcfile="${src}" '
    BEGIN {
      cur = ""
      while ((getline line < srcfile) > 0) {
        if (line ~ /^\[[^]]+\][ \t]*$/) {
          cur = line
          inctx[line] = 1
          if (!(line in sblk)) sblk[line] = line "\n"
          else sblk[line] = sblk[line] line "\n"
        } else if (cur != "") {
          sblk[cur] = sblk[cur] line "\n"
        }
      }
      close(srcfile)
    }
    {
      if ($0 ~ /^\[[^]]+\][ \t]*$/) {
        if ($0 in inctx) {
          if (!done[$0]) { printf "%s", sblk[$0]; done[$0] = 1 }
          skipping = 1
          next
        }
        skipping = 0
        print
        next
      }
      if (skipping) next
      print
    }
    END {
      for (c in inctx) if (!(c in done)) printf "%s", sblk[c]
    }
  ' "${dst}" > "${tmp}"
  mv -f "${tmp}" "${dst}"
  echo ">>> [dograh-ari] dialplan contexts merged from $(basename "${src}")"
}
if [ -f "${SRC}/extensions_custom.conf" ]; then
  touch "${DEST}/extensions_custom.conf"
  inject_dialplan "${SRC}/extensions_custom.conf" "${DEST}/extensions_custom.conf"
  # The Stasis app name is GENERATED by dograh per config (dograh_<hex>), not
  # the ARI username. dograh_wire.py persists it as DOGRAH_STASIS_APP_NAME;
  # rewrite the injected dialplan to route into that app (the source file
  # keeps the legacy "dograh" default for pre-split configs).
  if [ -n "${DOGRAH_STASIS_APP_NAME:-}" ]; then
    sed -i "s/Stasis(dograh)/Stasis(${DOGRAH_STASIS_APP_NAME})/g" "${DEST}/extensions_custom.conf"
    echo ">>> [dograh-ari] dialplan Stasis app name -> ${DOGRAH_STASIS_APP_NAME}"
  fi
fi

# Asterisk reads configs as the asterisk user — match the image's ownership.
chown -R asterisk:asterisk \
  "${DEST}/ari.conf" \
  "${DEST}/websocket_client.conf" \
  "${DEST}/extensions_custom.conf" \
  "${DEST}/rtp_custom.conf" 2>/dev/null || true
[ -f "${DEST}/http.conf" ] && chown asterisk:asterisk "${DEST}/http.conf" 2>/dev/null || true

echo ">>> [dograh-ari] configs injected — starting stock entrypoint in background"

# ── Harden the stock entrypoint's value-injecting s/// seds ───────────────
# The stock /usr/local/bin/entrypoint.sh uses UNGUARDED s///-delimited seds to
# inject env values that are base64 (or otherwise can contain `/`) into config
# files:
#
#     sed -i "s/secret = .*/secret = ${FREEPBX_AMI_SECRET}/" manager_custom.conf
#     sed -i "s/define('AFDB_PASS',.*/...'${AVANTFAX_DB_PASS}'.../"
#     sed -i "s/define('ADMIN_EMAIL',.*/...'${FAX_EMAIL}'.../"
#
# A `/` in the value terminates the s/// delimiter, sed fails with "unknown
# option to `s'", and under `set -e` the entrypoint exits — the container
# crash-loops (until-stopped restarts). This is the same bug we already
# guarded for DOGRAH_ARI_PASSWORD: switch the delimiter to `|` so any value
# (base64/hex/email, none of which contain `|`) works. Idempotent.
#
# Note: iteration over a list of (old, new) pairs is deliberate — the target
# lines sit on DISK in the image and we rewrite them in place; a byte-exact
# replace is the only safe transform.
if [ -f /usr/local/bin/entrypoint.sh ]; then
  python3 - <<'PYEOF' 2>/dev/null || true
path = '/usr/local/bin/entrypoint.sh'
src = open(path).read()
changes = []

# AMI secret (base64, the original crash-loop bug)
pairs = [
    ('s/secret = .*/secret = ${FREEPBX_AMI_SECRET}/',  'AMI secret',
     's|secret = .*|secret = ${FREEPBX_AMI_SECRET}|'),
    ("s/define('AFDB_PASS',.*/define('AFDB_PASS',     '${AVANTFAX_DB_PASS}');/",
     'AvantFax AFDB_PASS',
     "s|define('AFDB_PASS',.*|define('AFDB_PASS',     '${AVANTFAX_DB_PASS}');|"),
    ("s/define('ADMIN_EMAIL',.*/define('ADMIN_EMAIL', '${FAX_EMAIL:-fax@innotel.us}');/",
     'AvantFax ADMIN_EMAIL',
     "s|define('ADMIN_EMAIL',.*|define('ADMIN_EMAIL', '${FAX_EMAIL:-fax@innotel.us}');|"),
]
for old, name, new in pairs:
    if old in src:
        src = src.replace(old, new)
        changes.append(name)
if changes:
    open(path, 'w').write(src)
    print('>>> [dograh-ari] hardened stock entrypoint seds: ' + ', '.join(changes) + ' -> `|` delimiter')
PYEOF
fi

# ── Run the stock entrypoint in the background so we can enable Asterisk ──
# HTTP/ARI at the FreePBX settings-DB level AFTER it boots. The entrypoint's
# own `fwconsole reload` regenerates http_additional.conf from the DB, so the
# file-level http.conf above is not enough — HTTPENABLED must be flipped in
# freepbx_settings (idempotent; harmless if already set).
/usr/local/bin/entrypoint.sh "$@" &
ENTRYPOINT_PID=$!

trap 'kill -TERM ${ENTRYPOINT_PID} 2>/dev/null; exit 0' TERM INT

# Wait for MariaDB to accept connections (the entrypoint starts it). Root
# auth works via the unix socket — plain `mysql -u root` (no -h) is correct.
for i in $(seq 1 120); do
  if mysqladmin ping --silent 2>/dev/null; then
    echo ">>> [dograh-ari] MariaDB up (attempt ${i})"
    break
  fi
  sleep 5
done

# Flip HTTP on at the settings level (survives fwconsole reloads). Retry
# until it actually takes effect — on first boot FreePBX may still be
# populating freepbx_settings when MariaDB first answers. Guard everything
# against `set -e` (a failed probe must NOT kill this wrapper).
for i in $(seq 1 24); do
  set +e
  done=$(mysql -u root asterisk -N -B 2>/dev/null \
    -e "UPDATE freepbx_settings SET value='1' WHERE keyword='HTTPENABLED' AND value!='1'; \
        UPDATE freepbx_settings SET value='0.0.0.0' WHERE keyword='HTTPBINDADDRESS' AND value!='0.0.0.0'; \
        INSERT INTO kvstore_Sipsettings (\`key\`, val, type, id) VALUES ('rtpstart','${RTP_START}',NULL,'noid') ON DUPLICATE KEY UPDATE val='${RTP_START}'; \
        INSERT INTO kvstore_Sipsettings (\`key\`, val, type, id) VALUES ('rtpend','${RTP_END}',NULL,'noid') ON DUPLICATE KEY UPDATE val='${RTP_END}'; \
        SELECT COUNT(*) FROM freepbx_settings WHERE keyword='HTTPENABLED' AND value='1';" \
    2>/dev/null | tail -1)
  rc=$?
  set -e
  if [ "${rc}" -eq 0 ] && [ "${done:-0}" = "1" ]; then
    echo ">>> [dograh-ari] HTTPENABLED=1 / HTTPBINDADDRESS=0.0.0.0 written to freepbx_settings"
    # FreePBX may leave a stale generated file after the DB update. Ensure the
    # generated config explicitly enables the HTTP server before reloading.
    HTTP_ADDITIONAL="${DEST}/http_additional.conf"
    if [ -f "${HTTP_ADDITIONAL}" ]; then
      if grep -q '^enabled[[:space:]]*=' "${HTTP_ADDITIONAL}"; then
        sed -i 's/^enabled[[:space:]]*=.*/enabled = yes/' "${HTTP_ADDITIONAL}"
      else
        printf '\n[general]\nenabled = yes\nbindaddr = 0.0.0.0\nbindport = 8088\n' >> "${HTTP_ADDITIONAL}"
      fi
      chown asterisk:asterisk "${HTTP_ADDITIONAL}" 2>/dev/null || true
    fi
    break
  fi
  sleep 5
done

# Wait for the entrypoint's boot reload + web stack to finish (Apache on :80),
# then reload once more so Asterisk picks up the DB change cleanly. Also
# re-apply the include hygiene + canonical RTP file: the stock entrypoint may
# regenerate iax.conf/rtp.conf from the module templates on first boot (or
# after a module repair), which would re-introduce the duplicate includes.
for i in $(seq 1 60); do
  if timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/80' 2>/dev/null; then
    echo ">>> [dograh-ari] web UI up (attempt ${i}) — reloading for ARI"
    # Reload FIRST, then apply include hygiene LAST: `fwconsole reload`
    # regenerates iax.conf/rtp.conf from the module templates, which would
    # otherwise re-introduce the duplicate includes we just removed.
    fwconsole reload >/tmp/dograh-ari-reload.log 2>&1 || true
    fix_include_hygiene
    fix_modules_conf
    # Re-assert the canonical RTP file too (regeneration can drop it).
    if [ -f "${DEST}/rtp_custom.conf" ]; then
      grep -q '^rtpstart=10101' "${DEST}/rtp_custom.conf" 2>/dev/null || \
        printf '[general]\nstunaddr = stun.l.google.com:19302\nicesupport = yes\nrtpstart=10101\nrtpend=10120\n' > "${DEST}/rtp_custom.conf"
      chown asterisk:asterisk "${DEST}/rtp_custom.conf" 2>/dev/null || true
    fi
    # Reload once more so the running Asterisk actually loads the cleaned
    # configs (the reload above regenerated iax.conf/rtp.conf from the
    # templates; hygiene cleaned them after the fact).
    fwconsole reload >/tmp/dograh-ari-reload2.log 2>&1 || true
    break
  fi
  sleep 5
done

echo ">>> [dograh-ari] bootstrap complete — following stock entrypoint"
wait "${ENTRYPOINT_PID}"
