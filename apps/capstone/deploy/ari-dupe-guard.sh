#!/bin/bash
# Keeps the dograh ARI app alive on the FreePBX box.
#
# Three failures are repaired, all of which took 201/202 down or lost their
# records on 2026-11-25:
#   1. A second "[dograh]" user lands in FreePBX's generated ari_additional.conf
#      and collides with ari_additional_custom.conf. Asterisk then rejects the
#      whole ari.conf with "configuration contains a duplicate object", every ARI
#      user disappears and Stasis() has no app.
#   2. dograh parks its own telephony config after 5 consecutive ARI auth
#      failures and never retries on its own.
#   3. FreePBX ships cdr.uniqueid/linkedid and cel.uniqueid/linkedid as
#      varchar(32), but dograh's external ARI channel is named
#      "dograh-ext-<uuid>" (47 chars). Under sql_mode STRICT_TRANS_TABLES every
#      CDR/CEL row for that channel is rejected ("Data too long"), so the dograh
#      leg silently vanishes from the history. Reinstalling the cdr module
#      recreates the narrow columns, so the width is re-asserted here.
#
# Installed on the PBX host as /usr/local/sbin/ari-dupe-guard.sh and run from
# /etc/cron.d/ari-dupe-guard every 5 minutes.
#
# Quiet when healthy. Only writes to the log when it acts.
#   ari-dupe-guard.sh --check   report what it would do, change nothing
set -u

C=${FREEPBX_CONTAINER:-freepbx-qvifit87vftfxd9ejsch2vxy}
P=${DOGRAH_PG_CONTAINER:-postgres-qvifit87vftfxd9ejsch2vxy}
APP=dograh_88f73f01f10a
LOG=/var/log/ari-dupe-guard.log
DRY=0
[ "${1:-}" = "--check" ] && DRY=1

[ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && : > "$LOG"
say() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG" >&2; }
ast() { docker exec "$C" asterisk -rx "$1" 2>&1; }

# ---- 1. duplicate section in the generated file ----------------------------
OUT=$(docker exec "$C" grep -nE '^\[dograh\]' /etc/asterisk/ari_additional.conf 2>/dev/null)
if [ -n "$OUT" ]; then
  say "CRITICAL duplicate [dograh] section in ari_additional.conf (line ${OUT%%:*}); it collides with ari_additional_custom.conf"
  if [ $DRY -eq 0 ]; then
    TMP=$(mktemp) ; FIX=$(mktemp)
    if docker cp "$C:/etc/asterisk/ari_additional.conf" "$TMP" 2>/dev/null; then
      BK=/etc/asterisk/ari_additional.conf.guard.$(date +%Y%m%d-%H%M%S).bak
      docker exec "$C" cp -a /etc/asterisk/ari_additional.conf "$BK"
      awk 'BEGIN{skip=0}
           /^\[dograh\]/{skip=1; print "; [dograh] disabled by ari-dupe-guard: duplicate of ari_additional_custom.conf"; next}
           /^\[/{skip=0}
           {if(!skip) print}' "$TMP" > "$FIX"
      if docker cp "$FIX" "$C:/etc/asterisk/ari_additional.conf" 2>/dev/null; then
        say "commented out the duplicate block (backup: $BK); reloading res_ari"
        ast "module reload res_ari.so" >/dev/null
      else
        say "FAILED to write the repaired config back; manual fix needed"
      fi
    else
      say "FAILED to read ari_additional.conf out of $C"
    fi
    rm -f "$TMP" "$FIX"
  fi
fi

# ---- 2. is the ARI user actually loaded? -----------------------------------
USERS=$(ast "ari show users")
if ! printf '%s' "$USERS" | grep -qE '(^|[[:space:]])dograh([[:space:]]|$)'; then
  say "CRITICAL ARI user 'dograh' is not loaded (ari.conf rejected?); reloading res_ari and re-checking"
  if [ $DRY -eq 0 ]; then
    ast "module reload res_ari.so" >/dev/null
    sleep 2
    USERS=$(ast "ari show users")
    printf '%s' "$USERS" | grep -qE '(^|[[:space:]])dograh([[:space:]]|$)' \
      || say "CRITICAL 'dograh' still missing after reload - ari.conf is broken, check 'Config file ari.conf could not be loaded' in /var/log/asterisk/full"
  fi
fi

# ---- 3. has the app gone missing (client parked itself)? -------------------
if ! ast "ari show apps" | grep -q "$APP"; then
  say "WARNING ARI app $APP is not registered; re-enabling dograh telephony config 1 if it is parked"
  if [ $DRY -eq 0 ]; then
    R=$(docker exec "$P" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "update telephony_configurations set inactive=false, inactive_since=null, inactive_reason=null, updated_at=now() where id=1 and inactive returning id"' 2>/dev/null | tr -d '[:space:]')
    [ "${R:-}" = "1" ] && say "telephony config 1 was parked - reactivated; dograh reconnects on its 60s refresh"
  fi
fi

# ---- 4. can cdr/cel still store a dograh uniqueid? -------------------------
# Returns one "table.column=type" per column still narrower than 64 chars.
narrow_cols() {
  docker exec "$C" sh -c 'mysql -N -e "select concat(table_name, \".\", column_name, \"=\", column_type) from information_schema.columns where table_schema = \"asteriskcdrdb\" and column_name in (\"uniqueid\", \"linkedid\") and character_maximum_length < 64 order by table_name, column_name"' 2>/dev/null
}
NEED=$(narrow_cols)
if [ -n "$NEED" ]; then
  say "CRITICAL cdr/cel columns are too narrow for dograh uniqueids: $(printf '%s ' $NEED)"
  if [ $DRY -eq 0 ]; then
    docker exec "$C" sh -c 'mysqldump --no-data --skip-comments asteriskcdrdb > /root/asteriskcdrdb-schema-$(date +%Y%m%d-%H%M%S).sql' 2>/dev/null
    docker exec "$C" sh -c 'mysql asteriskcdrdb -e "ALTER TABLE cdr MODIFY uniqueid varchar(64) NOT NULL, MODIFY linkedid varchar(64) NOT NULL; ALTER TABLE cel MODIFY uniqueid varchar(64) NOT NULL, MODIFY linkedid varchar(64) NOT NULL;"' 2>/dev/null
    LEFT=$(narrow_cols)
    if [ -z "$LEFT" ]; then
      say "widened cdr/cel uniqueid+linkedid to varchar(64); schema dump kept in $C:/root"
    else
      say "FAILED to widen cdr/cel, still narrow: $(printf '%s ' $LEFT)"
    fi
  fi
fi

exit 0
