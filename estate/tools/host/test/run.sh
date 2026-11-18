#!/usr/bin/env bash
# test/run.sh - exercise the host tools without an incus daemon, a container or a
# network. Everything runs against test/fake-incus and a temporary directory.
#
# Why these tests and not others: `incus-guard` and `incus-migrate-safe` are the only
# tools here that decide whether two sessions may act on one instance and whether
# data gets copied; until now their verification was ShellCheck plus whatever the
# last person remembered, and i1's copies silently diverged from i4's for weeks.
# `estate-state` decides what "stopped" means, so its report is tested too.
#
#   ./test/run.sh        # all cases; exit 1 if any failed
#
# Runs on Linux: the guard uses flock, and systemd units are read for one smoke test.
set -uo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "$here")
pass=0 fail=0

ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
check() {   # label expected actual
	if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected '$2', got '$3')"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state/instances" "$TMP/guard"
cp "$here/fake-incus" "$TMP/bin/incus"
chmod +x "$TMP/bin/incus"
export FAKE_INCUS_STATE="$TMP/state"
export PATH="$TMP/bin:$PATH"
export INCUS_GUARD_DIR="$TMP/guard"

printf 'state=STOPPED\n' >"$FAKE_INCUS_STATE/instances/atheniq"
printf 'state=RUNNING\n' >"$FAKE_INCUS_STATE/instances/ontrak"
# Stopped, dated, and with no reason: the case `report` exists to surface.
printf 'state=STOPPED\nuser.estate.stopped_at=1\n' >"$FAKE_INCUS_STATE/instances/sleeper"

echo "== syntax"
for f in "$root"/sbin/* "$root"/install.sh "$root"/test/run.sh "$root"/test/fake-incus; do
	[ -f "$f" ] || continue
	case "$f" in
		*/incus-rebalance) python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$f" || no "python parse $(basename "$f")" ;;
		*) bash -n "$f" || no "bash -n $(basename "$f")" ;;
	esac
done
ok "every script parses"

echo "== incus-guard"
"$root/sbin/incus-guard" claim atheniq "test" >/dev/null 2>&1
check "first claim wins" 0 $?
"$root/sbin/incus-guard" claim atheniq "test" >/dev/null 2>&1
check "second claim is refused with 75" 75 $?
"$root/sbin/incus-guard" claim ontrak "other instance" >/dev/null 2>&1
check "a different instance is still free" 0 $?
"$root/sbin/incus-guard" release ontrak >/dev/null 2>&1
"$root/sbin/incus-guard" release atheniq >/dev/null 2>&1
check "release succeeds" 0 $?
"$root/sbin/incus-guard" claim atheniq "test" >/dev/null 2>&1
check "claim after release wins" 0 $?
printf 'instance=atheniq\nowner_host=x\nowner_pid=999999\nowner_user=u\nowner_tty=none\npurpose=t\nacquired_at=1\nexpires_at=2\n' \
	>"$INCUS_GUARD_DIR/atheniq.lease"
"$root/sbin/incus-guard" claim atheniq "test" >/dev/null 2>&1
check "an expired lease is reclaimable" 0 $?
"$root/sbin/incus-guard" release atheniq >/dev/null 2>&1
"$root/sbin/incus-guard" run atheniq "test" -- true >/dev/null 2>&1
check "run executes and exits 0" 0 $?
case "$(ls "$INCUS_GUARD_DIR"/*.lease 2>/dev/null | wc -l)" in
	0) ok "run released the lease" ;;
	*) no "run left a lease behind" ;;
esac

echo "== incus-migrate-safe"
"$root/sbin/incus-migrate-safe" >/dev/null 2>&1
check "no arguments prints usage (64)" 64 $?
"$root/sbin/incus-migrate-safe" --instance ghost --dataset pool/x --dest-host h --dest-root /r >/dev/null 2>&1
check "an instance that does not exist is refused" 1 $?
"$root/sbin/incus-migrate-safe" --instance ontrak --dataset pool/x --dest-host h --dest-root /r >/dev/null 2>&1
check "a RUNNING instance is refused before any copy" 1 $?

echo "== estate-state"
"$root/sbin/estate-state" note atheniq --why "swap emergency 2026-11-17" --by tester >/dev/null 2>&1
check "note records without changing state" 0 $?
check "note does not start the instance" STOPPED "$(sed -n 's/^state=//p' "$FAKE_INCUS_STATE/instances/atheniq")"
"$root/sbin/estate-state" show atheniq 2>/dev/null | grep -q "swap emergency" && ok "show prints the reason" || no "show lost the reason"
"$root/sbin/estate-state" show atheniq 2>/dev/null | grep -q "incus start local:atheniq" && ok "show prints the resume command" || no "no resume command"
# Captured, not piped: `report` exits 1 when it flags something, and under
# `set -o pipefail` the pipeline would report the tool's status instead of grep's.
report_out=$("$root/sbin/estate-state" report 2>/dev/null); report_rc=$?
check "report exits 1 when an old stop has no reason" 1 "$report_rc"
case "$report_out" in
	*sleeper*) ok "report names the unannotated instance" ;;
	*) no "report missed it" ;;
esac
case "$report_out" in
	*"swap emergency 2026-11-17"*) ok "report prints the recorded reason" ;;
	*) no "report lost the recorded reason" ;;
esac
"$root/sbin/estate-state" start atheniq >/dev/null 2>&1
check "start succeeds" 0 $?
check "start sets RUNNING" RUNNING "$(sed -n 's/^state=//p' "$FAKE_INCUS_STATE/instances/atheniq")"
"$root/sbin/estate-state" show atheniq 2>/dev/null | grep -q "(none recorded)" && ok "start clears the note" || no "note survived the start"
"$root/sbin/estate-state" report >/dev/null 2>&1
check "report exits 1 only for the undated-reason case left" 1 $?

echo "== estate-sample"
export ESTATE_SAMPLES="$TMP/samples" ESTATE_SAMPLE_KEEP=3
"$root/sbin/estate-sample"
check "one sample run exits 0" 0 $?
check "one row per instance" 3 "$(wc -l <"$TMP/samples/$(hostname -s).tsv")"
for _ in 1 2 3 4; do "$root/sbin/estate-sample"; done
lines=$(wc -l <"$TMP/samples/$(hostname -s).tsv")
[ "$lines" -le 3 ] && ok "the ring buffer keeps at most KEEP rows ($lines)" || no "buffer grew past KEEP ($lines)"
"$root/sbin/estate-sample" --show 2 >/dev/null 2>&1
check "sample --show reads the buffer" 0 $?
cut -f3 "$TMP/samples/$(hostname -s).tsv" | grep -qx atheniq && ok "rows name the instance" || no "instance column wrong"

echo "== estate-health"
"$root/sbin/estate-health" >/dev/null 2>&1
check "estate-health exits 0" 0 $?
"$root/sbin/estate-health" --history atheniq >/dev/null 2>&1
check "estate-health --history exits 0" 0 $?

echo "== estate-edge"
# A parked instance is not a failure; an unreachable running one is, but only once.
printf 'state=STOPPED\nuser.estate.why=parked for a test\n' >"$FAKE_INCUS_STATE/instances/parked"
printf 'parked\t127.0.0.1:1\tlocal\tparked\n' >"$TMP/edge-parked.tsv"
ESTATE_EDGE_TARGETS="$TMP/edge-parked.tsv" ESTATE_EDGE_STATE="$TMP/es1" \
	"$root/sbin/estate-edge" --timeout 1 >"$TMP/edge1.out" 2>&1
check "a stopped instance with a note is not a failure" 0 $?
case "$(cat "$TMP/edge1.out")" in
	*down-on-purpose*) ok "and it says down-on-purpose" ;;
	*) no "it did not name the deliberate stop" ;;
esac
printf 'up\t127.0.0.1:1\tlocal\tatheniq\n' >"$TMP/edge-down.tsv"
ESTATE_EDGE_TARGETS="$TMP/edge-down.tsv" ESTATE_EDGE_STATE="$TMP/es2" \
	"$root/sbin/estate-edge" --timeout 1 >/dev/null 2>&1
check "an unreachable RUNNING upstream fails the first time" 1 $?
ESTATE_EDGE_TARGETS="$TMP/edge-down.tsv" ESTATE_EDGE_STATE="$TMP/es2" \
	"$root/sbin/estate-edge" --timeout 1 >/dev/null 2>&1
check "the same failure does not fail a second time" 0 $?

"$root/sbin/estate-edge" --config /nonexistent >/dev/null 2>&1
check "a missing target list is exit 2, not a clean pass" 2 $?

echo "== estate-timer-audit"
"$root/sbin/estate-timer-audit" --since 1d >/dev/null 2>&1
check "timer audit runs" 0 $?

echo "== install.sh --check"
(cd "$root" && ./install.sh --check >/dev/null 2>&1)
check "install.sh --check passes on this checkout" 0 $?

# The disable direction is destructive, so a host that declares nothing must be
# treated as unknown rather than as "declares none of these".
notimers="$TMP/notimers"
mkdir -p "$notimers"
cp -a "$root"/. "$notimers"/ 2>/dev/null
rm -rf "$notimers/hosts/$(hostname -s)"
notimers_out=$(cd "$notimers" && ./install.sh --check 2>&1); notimers_rc=$?
check "a host with no timers file still checks clean" 0 "$notimers_rc"
case "$notimers_out" in
	*"nothing repo-managed will be disabled"*) ok "and it promises to leave timers alone" ;;
	*) no "an unrecognised host would have its timers disabled" ;;
esac

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
