#!/bin/sh
# Applies a declared Engine configuration to the standby (see docs/lisa-operational-recovery.md).
#   engine-config.sh apply CONTAINER CONFIG_PATH NEW_CONFIG STATE_DIRECTORY
#   engine-config.sh recover STATE_DIRECTORY
# Run on the guest under the shared rollout lease (deploy/orange/recovery/apply-engine-config.sh).
# apply records the running services and the previous configuration in
# STATE_DIRECTORY/.config-intent before stopping anything, stops the app before the Engine, writes
# NEW_CONFIG over CONFIG_PATH while the Engine is stopped, starts the Engine and waits for its
# health route and for a startup log line whose capacities match NEW_CONFIG, then starts the app.
# Any failure restores the previous configuration and the recorded services; recover does the
# same for an apply that was interrupted.
set -eu

engine_health=http://127.0.0.1:6420/health
app_services="stats-infra-collector native-stats"

usage() { echo "usage: engine-config.sh apply CONTAINER CONFIG_PATH NEW_CONFIG STATE_DIRECTORY | recover STATE_DIRECTORY" >&2; exit 2; }

wait_health() {
    i=0
    until wget -q -T 2 -O /dev/null "$engine_health"; do
        i=$((i + 1)); [ "$i" -lt 120 ] || { echo "the Engine did not answer $engine_health" >&2; return 1; }
        sleep 1
    done
}

start_services() {
    for service in native-stats stats-infra-collector; do
        if grep -qx "started $service" "$1"; then rc-service "$service" start >/dev/null || { echo "cannot start $service" >&2; return 1; }; fi
    done
}

# Restores the configuration recorded in the intent and the services it lists.
restore() {
    intent=$1
    container=$(sed -n 's/^container //p' "$intent")
    config=$(sed -n 's/^config //p' "$intent")
    previous="$intent.previous"
    if [ -f "$previous" ] && ! cmp -s "$previous" "$config"; then
        docker stop --time 20 "$container" >/dev/null 2>&1 || :
        cat "$previous" > "$config"
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
        docker start "$container" >/dev/null || { echo "cannot start $container" >&2; return 1; }
    fi
    wait_health || return 1
    start_services "$intent" || return 1
    rm -f "$previous" "$intent"
}

case "${1:-}" in
    recover)
        [ "$#" -eq 2 ] || usage
        intent="$(realpath "$2")/.config-intent"
        [ -f "$intent" ] || { echo "no interrupted configuration change in $2"; exit 0; }
        restore "$intent"
        echo "restored the configuration and services recorded in $intent"
        exit 0 ;;
    apply) [ "$#" -eq 5 ] || usage ;;
    *) usage ;;
esac

container=$2 config=$3 new=$4 state=$(realpath "$5")
intent="$state/.config-intent"
umask 077
exec 9>"$state/.capture.lock"
flock -n 9 || { echo "an Engine capture or configuration change already owns $state" >&2; exit 1; }
[ ! -e "$intent" ] || { echo "an interrupted configuration change left $intent; run recover first" >&2; exit 1; }
[ ! -e "$state/.capture-intent" ] || { echo "an interrupted capture left $state/.capture-intent; recover it first" >&2; exit 1; }
python3 -I -c 'import json, sys; json.load(open(sys.argv[1]))' "$new" || { echo "$new is not JSON" >&2; exit 1; }
mounted=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/rivet/config.json"}}{{.Source}}{{end}}{{end}}' "$container")
[ "$mounted" = "$config" ] || { echo "$container does not mount $config as its configuration" >&2; exit 1; }
test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
if cmp -s "$new" "$config"; then echo "configuration already applied"; exit 0; fi
expected=$(python3 -I -c 'import json, sys
s = json.load(open(sys.argv[1])).get("storage", {})
print(s.get("log_shard", {}).get("max_disk_bytes", ""), s.get("cold_store", {}).get("disk_cache_bytes", ""))' "$new")

cp "$config" "$intent.previous"
{
    echo "container $container"
    echo "config $config"
    for service in $app_services; do
        if rc-service "$service" status >/dev/null 2>&1; then echo "started $service"; fi
    done
} > "$intent.next"
sync
mv "$intent.next" "$intent"

cleanup() {
    status=$?
    trap - EXIT
    trap '' HUP INT TERM QUIT
    if [ -e "$intent" ]; then
        if [ "$status" -eq 0 ]; then status=1; fi
        restore "$intent" || echo "the configuration change could not restore its services; run recover" >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 131' QUIT

for service in $app_services; do
    if grep -qx "started $service" "$intent"; then rc-service "$service" stop >/dev/null; fi
done
docker stop --time 20 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" -eq 0
cat "$new" > "$config"
started=$(date -u +%FT%TZ)
docker start "$container" >/dev/null
wait_health
# The Engine logs the capacities it resolved; configured values must be the declared ones, so a
# configuration that did not take effect is refused rather than reported as applied.
line=$(docker logs --since "$started" "$container" 2>&1 | grep 'resolved storage disk capacities' | tail -1)
log=$(printf '%s' "$line" | sed -n 's/.*log_disk_bytes=\([0-9]*\) log_configured=true.*/\1/p')
cache=$(printf '%s' "$line" | sed -n 's/.*cache_bytes=\([0-9]*\) cache_configured=true.*/\1/p')
[ "$log $cache" = "$expected" ] || { echo "the Engine resolved '${log:-auto} ${cache:-auto}', not the declared '$expected'" >&2; exit 1; }
start_services "$intent"
rm -f "$intent.previous" "$intent"
echo "applied: log $log cache $cache"
