#!/bin/sh
# Applies the standby Engine configuration declared in Stuff under the shared rollout lease
# (see docs/lisa-operational-recovery.md).
#   deploy/orange/recovery/apply-engine-config.sh NAME
# Requires STANDBY_SSH_CONFIG, STATS_ROLLOUT, STATS_CHECK_CREDENTIAL_FILE, STATSCTL and STUFF_ROOT
# (its deploy/openorange/standby/stats-engine.json is the declaration). Writes
# ~/.local/state/openorange/engine-config/NAME.json. The change succeeds only when the Engine
# resolved the declared capacities, every service it stopped is running again, the declared
# Engine shows no drift and the app passes the functional check (synthetic ingest with readback)
# within READY_S. A failed or interrupted change is recovered under a new lease and recorded as
# failed. Exit codes: 0 applied, 1 failed, 2 usage, 4 lease held (nothing changed).
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../../.." && pwd)
config=${STANDBY_SSH_CONFIG:?STANDBY_SSH_CONFIG is required}
rollout=${STATS_ROLLOUT:?STATS_ROLLOUT is required}
credential=${STATS_CHECK_CREDENTIAL_FILE:?STATS_CHECK_CREDENTIAL_FILE is required}
statsctl=${STATSCTL:?STATSCTL is required}
stuff=${STUFF_ROOT:?STUFF_ROOT is required}
[ "$#" -eq 1 ] || { echo "usage: deploy/orange/recovery/apply-engine-config.sh NAME" >&2; exit 2; }
name=$1
case "$name" in *[!A-Za-z0-9._-]*|.*|"") echo "apply-engine-config: NAME may hold only letters, digits, '.', '_' and '-'" >&2; exit 2 ;; esac
host=stats-standby
declaration=$stuff/deploy/openorange/standby/stats-engine.json
container=$(jaq -r .container "$declaration")
target=$(jaq -r .config_path "$declaration")
state=/var/lib/live-stats
script=/var/lib/live-stats-recovery/.engine-config.sh
staged=/var/lib/live-stats-recovery/.engine-config.json
ready_s=120
records=$HOME/.local/state/openorange/engine-config
receipt=$records/$name.json
fail() { echo "apply-engine-config: $*" >&2; exit 1; }
now() { date -u +%FT%TZ; }
guest() { ssh -F "$config" -o BatchMode=yes "$host" "$@"; }
leased() {
    operation=$1 bound=$2
    shift 2
    "$rollout" lease run --target-kind native --host "$host" --ssh-config "$config" --operation "$operation" --bound-s "$bound" -- sh "$script" "$@"
}

mkdir -p "$records"
[ ! -e "$receipt" ] || fail "$receipt already exists"
observed=$("$rollout" observe --target-kind native-app --host "$host" --ssh-config "$config" --json) || fail "cannot observe the standby app"
release=$(printf '%s' "$observed" | jaq -r '.running // empty')
digest=$(printf '%s' "$observed" | jaq -r '.digest // empty')
[ -n "$release" ] && [ "$release" = "$(printf '%s' "$observed" | jaq -r '.selected // empty')" ] || fail "the standby's running app is unknown"
guest "cat >$script" <"$root/deploy/orange/recovery/engine-config.sh" || fail "cannot upload the configuration script"
jaq .config "$declaration" | guest "umask 077; cat >$staged" || fail "cannot stage the declared configuration"
declared_config=$(jaq -c .config "$declaration") || fail "cannot read the declared configuration"
digest_line=$(
    sha256sum <<EOF
$declared_config
EOF
)
declared=${digest_line%% *}
[ -n "$declared" ] || fail "cannot hash the declared configuration"

started=$(now)
apply_status=0
leased engine-config "$((ready_s + 300))" apply "$container" "$target" "$staged" "$state" || apply_status=$?
[ "$apply_status" -ne 4 ] || { echo "apply-engine-config: another operation holds the standby lease; nothing changed" >&2; exit 4; }
recover_status=none
if [ "$apply_status" -ne 0 ]; then
    recover_status=0
    leased engine-config-recover 300 recover "$state" || recover_status=$?
fi

ready_after=null
functional=false
deadline=$(($(date +%s) + ready_s))
begin=$(date +%s)
while :; do
    if ROLLOUT_RELEASE=$release ROLLOUT_DIGEST=$digest node "$root/deploy/orange/functional-check.mjs" --target-kind native-app \
        --rollout "$rollout" --ssh-config "$config" --host "$host" --credential-file "$credential" --statsctl "$statsctl" >/dev/null 2>&1; then
        functional=true; ready_after=$(($(date +%s) - begin)); break
    fi
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 5
done
drift=$(python3 -I "$stuff/deploy/openorange/bin/standby-engine" inspect --host "$host" --ssh-config "$config" --json 2>/dev/null | jaq -c .drift) || drift=null
outcome=failed
[ "$apply_status" -eq 0 ] && [ "$functional" = true ] && [ "$drift" = "[]" ] && outcome=applied
cat >"$receipt" <<EOF
{"schema":"stats-engine-config/1","name":"$name","outcome":"$outcome","host":"$host","container":"$container","config":"$target",
 "declaredConfigSha256":"sha256:$declared","declaration":"$declaration","startedAt":"$started","finishedAt":"$(now)",
 "applyExit":$apply_status,"recoverExit":$( [ "$recover_status" = none ] && echo null || echo "$recover_status"),
 "app":{"release":"$release","digest":"$digest"},"functional":{"ok":$functional,"readyAfterS":$ready_after,"budgetS":$ready_s},"engineDrift":$drift}
EOF
echo "apply-engine-config: $outcome; receipt $receipt"
[ "$outcome" = applied ]
