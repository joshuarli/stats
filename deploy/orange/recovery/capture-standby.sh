#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../../.." && pwd)
config=${STANDBY_SSH_CONFIG:?STANDBY_SSH_CONFIG is required}
rollout=${STATS_ROLLOUT:?STATS_ROLLOUT is required}
hosts=${STATS_CHECK_HOSTS:?STATS_CHECK_HOSTS is required}
statsctl=${STATSCTL:?STATSCTL is required}
[ "$#" -eq 1 ] || { echo "usage: deploy/orange/recovery/capture-standby.sh NAME" >&2; exit 2; }
name=$1
case "$name" in *[!A-Za-z0-9._-]*|.*|"") echo "capture-standby: NAME may hold only letters, digits, '.', '_' and '-'" >&2; exit 2 ;; esac
host=stats-standby
container=live-stats-engine
depot=/var/lib/live-stats
output=/var/lib/live-stats-recovery/$name
script=/var/lib/live-stats-recovery/.capture-engine.sh
capture_bound_s=900
recover_bound_s=300
ready_s=120
records=$HOME/.local/state/openorange/captures
receipt=$records/$name.json
fail() { echo "capture-standby: $*" >&2; exit 1; }
now() { date -u +%FT%TZ; }
guest() { ssh -F "$config" -o BatchMode=yes "$host" "$@"; }
leased() {
    operation=$1 bound=$2
    shift 2
    "$rollout" lease run --target-kind native --host "$host" --ssh-config "$config" --operation "$operation" --bound-s "$bound" -- sh "$script" "$@"
}

[ -r "$config" ] || fail "missing SSH config $config"
mkdir -p "$records"
[ ! -e "$receipt" ] || fail "$receipt already exists"
observed=$("$rollout" observe --target-kind native-app --host "$host" --ssh-config "$config" --json) || fail "cannot observe the standby app"
release=$(printf '%s' "$observed" | jaq -r '.running // empty')
digest=$(printf '%s' "$observed" | jaq -r '.digest // empty')
[ -n "$release" ] && [ "$release" = "$(printf '%s' "$observed" | jaq -r '.selected // empty')" ] || fail "the standby's running app is unknown"
guest "mkdir -p /var/lib/live-stats-recovery && cat >$script" <"$root/deploy/orange/recovery/capture-engine.sh" || fail "cannot upload the capture script"

started=$(now)
capture_status=0
leased engine-capture "$capture_bound_s" capture "$container" "$depot" "$output" || capture_status=$?
[ "$capture_status" -ne 4 ] || { echo "capture-standby: another operation holds the standby lease; nothing changed" >&2; exit 4; }
recover_status=none
if [ "$capture_status" -ne 0 ]; then
    recover_status=0
    leased engine-capture-recover "$recover_bound_s" recover "$depot" || recover_status=$?
fi

ready_after=null
functional=false
deadline=$(($(date +%s) + ready_s))
begin=$(date +%s)
while :; do
    if ROLLOUT_RELEASE=$release ROLLOUT_DIGEST=$digest node "$root/deploy/orange/functional-check.mjs" --target-kind native-app \
        --rollout "$rollout" --ssh-config "$config" --host "$host" --hosts "$hosts" --statsctl "$statsctl" >/dev/null 2>&1; then
        functional=true; ready_after=$(($(date +%s) - begin)); break
    fi
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 5
done

manifest=null
if [ "$capture_status" -eq 0 ]; then
    manifest=$(guest "sha256sum $output/depot.sha256" | cut -d' ' -f1) || manifest=null
    [ "$manifest" = null ] || manifest="\"sha256:$manifest\""
fi
outcome=failed
[ "$capture_status" -eq 0 ] && [ "$functional" = true ] && [ "$manifest" != null ] && outcome=captured
cat >"$receipt" <<EOF
{"schema":"stats-engine-capture/1","name":"$name","outcome":"$outcome","host":"$host","container":"$container","depot":"$depot","output":"$output",
 "startedAt":"$started","finishedAt":"$(now)","captureExit":$capture_status,"recoverExit":$( [ "$recover_status" = none ] && echo null || echo "$recover_status"),
 "app":{"release":"$release","digest":"$digest"},"functional":{"ok":$functional,"readyAfterS":$ready_after,"budgetS":$ready_s},"depotManifestSha256":$manifest}
EOF
echo "capture-standby: $outcome; receipt $receipt"
[ "$outcome" = captured ]
