#!/bin/bash
# greeting-contexts.sh — export the initial_context each live route will pass.
#
# The greeting is a template ("Hi {{initial_context.candidate_name |
# fallback:there}}"), and the rendered text is part of the TTS cache key. To
# prewarm what a call will actually ask for, the renderer needs the context the
# route supplies — which lives in dograh's own tables, not in this repo:
#
#   telephony_phone_numbers.extra_metadata   per-route values (what an operator
#                                            sets for one number)
#   workflows.template_context_variables     defaults carried by the workflow
#
# Today every route's extra_metadata is `{}`, so this exports a list of empty
# objects and the greetings render with their fallbacks — the list the shim is
# already prewarming. The point is the day someone gives 201 a candidate name:
# prewarm-watch.sh re-exports this, re-renders, and re-prewarms within five
# minutes, with no restart and no first-caller miss.
#
# Writes JSON (an array, one object per active inbound route) to
# /etc/capstone/greeting-contexts.json.
set -u

P=${DOGRAH_PG_CONTAINER:-postgres-qvifit87vftfxd9ejsch2vxy}
OUT=${GREETING_CONTEXTS:-/etc/capstone/greeting-contexts.json}
TMP=$(mktemp) || exit 1
trap 'rm -f "$TMP"' EXIT

# Both columns are jsonb and may hold an array instead of an object, so each is
# checked by type: `||` on mismatched types is an error, not a merge.
# Both columns are `json`, not `jsonb` — `jsonb_typeof(json)` is a type error,
# and psql exits 0 on a failed script unless ON_ERROR_STOP is set, which would
# turn a broken query into a confident "0 route(s)".
if ! docker exec -i "$P" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' >"$TMP" <<'SQL'
select coalesce(json_agg(ctx order by address), '[]'::json)
  from (
    select p.address,
           (case when jsonb_typeof(p.extra_metadata::jsonb) = 'object'
                 then p.extra_metadata::jsonb else '{}'::jsonb end)
        || (case when jsonb_typeof(w.template_context_variables::jsonb) = 'object'
                 then w.template_context_variables::jsonb else '{}'::jsonb end) as ctx
      from telephony_phone_numbers p
      left join workflows w on w.id = p.inbound_workflow_id
     where p.is_active
       and p.inbound_workflow_id is not null
  ) s;
SQL
then
  echo "greeting-contexts: could not read the routes out of $P" >&2
  exit 1
fi

python3 - "$TMP" "$OUT" <<'PY'
import json, pathlib, sys

raw = pathlib.Path(sys.argv[1]).read_text().strip()
try:
    contexts = json.loads(raw)
except json.JSONDecodeError as exc:
    sys.exit(f"greeting-contexts: the database returned something that is not JSON: {exc}")
if not isinstance(contexts, list):
    sys.exit("greeting-contexts: expected a JSON array of route contexts")
if not contexts:
    # An empty export would tell the renderer there is nothing to prewarm, which
    # is the opposite of true: every scripted greeting still gets asked for.
    sys.exit("greeting-contexts: the query returned no routes — refusing to write an empty "
             "export, which would disable the greeting prewarm")
out = pathlib.Path(sys.argv[2])
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(contexts, indent=2, sort_keys=True) + "\n")
named = [c for c in contexts if c]
print(f"greeting-contexts: {len(contexts)} route(s), {len(named)} with values → {out}")
PY
