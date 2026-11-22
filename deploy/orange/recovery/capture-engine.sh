#!/bin/sh
# Captures a consistent copy of the standby Engine depot (see docs/lisa-operational-recovery.md).
#   capture-engine.sh capture CONTAINER STATE_DIRECTORY OUTPUT_DIRECTORY
#   capture-engine.sh recover STATE_DIRECTORY
# Run on the guest under the shared rollout lease (deploy/orange/recovery/capture-standby.sh).
# capture records which of native-stats, its collector and the Engine are running in
# STATE_DIRECTORY/.capture-intent before stopping anything, stops the app before the Engine,
# copies the depot only while both are stopped, then starts the Engine, waits for its health
# route and starts the app again. A capture that cannot restore leaves the intent in place;
# recover restores it. The depot is not copied while the Engine runs: on 2026-11-22 a warm
# copy on the same disk made the app lose its Engine registration within 70 seconds.
set -eu

engine_health=http://127.0.0.1:6420/health
# The copy shares the Engine's filesystem, and the Engine refuses to start when its declared log and
# cache capacities no longer fit, so a capture that would leave less than this free is refused
# before anything stops.
free_floor_kb=$((2 * 1024 * 1024))
app_services="stats-infra-collector native-stats"

usage() { echo "usage: capture-engine.sh capture CONTAINER STATE_DIRECTORY OUTPUT_DIRECTORY | recover STATE_DIRECTORY" >&2; exit 2; }

restore() {
    intent=$1
    container=$(sed -n 's/^container //p' "$intent")
    if grep -qx "running $container" "$intent" && [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
        docker start "$container" >/dev/null || { echo "cannot start $container" >&2; return 1; }
    fi
    if grep -qx "running $container" "$intent"; then
        i=0
        until wget -q -T 2 -O /dev/null "$engine_health"; do
            i=$((i + 1)); [ "$i" -lt 60 ] || { echo "$container did not answer $engine_health" >&2; return 1; }
            sleep 1
        done
    fi
    for service in native-stats stats-infra-collector; do
        if grep -qx "started $service" "$intent"; then
            rc-service "$service" start >/dev/null || { echo "cannot start $service" >&2; return 1; }
        fi
    done
    rm -f "$intent"
}

case "${1:-}" in
    recover)
        [ "$#" -eq 2 ] || usage
        intent="$(realpath "$2")/.capture-intent"
        [ -f "$intent" ] || { echo "no interrupted capture in $2"; exit 0; }
        restore "$intent"
        echo "restored the services recorded in $intent"
        exit 0 ;;
    capture) [ "$#" -eq 4 ] || usage ;;
    *) usage ;;
esac

container=$2
state=$(realpath "$3")
output_parent=$(realpath "$(dirname "$4")")
output_leaf=$(basename "$4")
case "$output_leaf" in .|..) exit 2 ;; esac
output="$output_parent/$output_leaf"
case "$output/" in "$state/"*) echo "capture output must be outside the depot" >&2; exit 2 ;; esac
partial="$output.partial"
intent="$state/.capture-intent"
umask 077
exec 9>"$state/.capture.lock"
flock -n 9 || { echo "an Engine capture already owns $state" >&2; exit 1; }
[ ! -e "$intent" ] || { echo "an interrupted capture left $intent; run recover first" >&2; exit 1; }
test ! -e "$output" && test ! -L "$output"
mkdir "$partial"
mkdir "$partial/depot"
for leaf in log objects; do
    mount=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"/var/lib/rivet/$leaf\"}}{{.Source}}{{end}}{{end}}" "$container")
    test "$mount" = "$state/$leaf" || { echo "unexpected Engine mount for $leaf" >&2; exit 1; }
done
test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
need_kb=$(du -sk "$state/log" "$state/objects" | awk '{n += $1} END {print n}')
free_kb=$(df -Pk "$output_parent" | awk 'NR == 2 {print $4}')
if [ $((free_kb - need_kb)) -lt "$free_floor_kb" ]; then
    rmdir "$partial/depot" "$partial"
    echo "capture needs ${need_kb} KiB and would leave less than ${free_floor_kb} KiB free of ${free_kb} KiB" >&2
    exit 1
fi
docker inspect --format '{{.Config.Image}} {{.Image}}' "$container" > "$partial/image"
engine_config=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/rivet/config.json"}}{{.Source}}{{end}}{{end}}' "$container")
test -f "$engine_config"
cp "$engine_config" "$partial/engine.json"

{
    echo "container $container"
    echo "running $container"
    for service in $app_services; do
        if rc-service "$service" status >/dev/null 2>&1; then echo "started $service"; fi
    done
} > "$intent.next"
sync "$intent.next" 2>/dev/null || sync
mv "$intent.next" "$intent"
cp "$intent" "$partial/intent"

cleanup() {
    status=$?
    trap - EXIT
    trap '' HUP INT TERM QUIT
    if [ -e "$intent" ] && ! restore "$intent"; then
        echo "capture could not restore its services; run recover" >&2
        if [ "$status" -eq 0 ]; then status=1; fi
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 131' QUIT

date -u +%FT%TZ > "$partial/stop-requested-at"
for service in $app_services; do
    if grep -qx "started $service" "$intent"; then rc-service "$service" stop >/dev/null; fi
done
docker stop --time 20 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" -eq 0
date -u +%FT%TZ > "$partial/captured-at"
timeout 300 rsync -aH --numeric-ids "$state/log" "$state/objects" "$partial/depot/"
restore "$intent"
date -u +%FT%TZ > "$partial/restarted-at"
(cd "$partial/depot" && find . -type f -exec sha256sum {} + | LC_ALL=C sort -k 2) > "$partial/depot.sha256"
mv "$partial" "$output"
printf 'Engine capture ready at %s\n' "$output"
