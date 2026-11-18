#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
    echo "usage: capture-engine.sh CONTAINER STATE_DIRECTORY OUTPUT_DIRECTORY" >&2
    exit 2
fi

container=$1
state=$(realpath "$2")
output_parent=$(realpath "$(dirname "$3")")
output_leaf=$(basename "$3")
case "$output_leaf" in .|..) exit 2 ;; esac
output="$output_parent/$output_leaf"
case "$output/" in "$state/"*) echo "capture output must be outside the depot" >&2; exit 2 ;; esac
partial="$output.partial"
umask 077
exec 9>"$state/.capture.lock"
flock -n 9 || { echo "an Engine capture already owns $state" >&2; exit 1; }
test ! -e "$output" && test ! -L "$output"
mkdir "$partial"
mkdir "$partial/depot"
for leaf in log objects; do
    mount=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"/var/lib/rivet/$leaf\"}}{{.Source}}{{end}}{{end}}" "$container")
    test "$mount" = "$state/$leaf" || { echo "unexpected Engine mount for $leaf" >&2; exit 1; }
done
test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
docker inspect --format '{{.Config.Image}} {{.Image}}' "$container" > "$partial/image"
engine_config=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/rivet/config.json"}}{{.Source}}{{end}}{{end}}' "$container")
test -f "$engine_config"
cp "$engine_config" "$partial/engine.json"

restart_required=0
cleanup() {
    status=$?
    trap - EXIT
    trap '' HUP INT TERM QUIT
    if [ "$restart_required" -eq 1 ]; then
        if ! docker start "$container" >/dev/null; then
            echo "failed to restart $container after capture" >&2
            if [ "$status" -eq 0 ]; then status=1; fi
        fi
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 131' QUIT

warm_status=0
timeout 180 rsync -aH --numeric-ids "$state/log" "$state/objects" "$partial/depot/" || warm_status=$?
case "$warm_status" in 0|24) ;; *) exit "$warm_status" ;; esac

restart_required=1
date -u +%FT%TZ > "$partial/stop-requested-at"
docker stop --time 20 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" -eq 0
date -u +%FT%TZ > "$partial/captured-at"
timeout 55 rsync -aH --numeric-ids --checksum --delete "$state/log" "$state/objects" "$partial/depot/"
docker start "$container" >/dev/null
restart_required=0
date -u +%FT%TZ > "$partial/restarted-at"
mv "$partial" "$output"
printf 'Engine capture ready at %s\n' "$output"
