#!/bin/sh
set -eu
host=${1:-lisa}
root=$(git rev-parse --show-toplevel)
cd "$root"
previous=$(ssh "$host" doas -n /opt/openorange/bin/oo deployment stats | jaq -er '.image')
image=$(deploy/orange/build-image.sh "$host")
switched=true
rollback() {
    code=$?
    trap - 0 HUP INT TERM
    if [ "$switched" = true ]; then
        if ssh "$host" doas -n /opt/openorange/bin/oo set-image stats "$previous" --if-current "$image" &&
           ssh "$host" doas -n /sbin/rc-service oo-app.stats restart; then
            echo 'Deployment failed; restored the previous Orange image' >&2
        else
            echo 'Orange rollback failed; inspect oo-app.stats on the host' >&2
            code=1
        fi
    fi
    exit "$code"
}
trap rollback 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
ssh "$host" doas -n /opt/openorange/bin/oo set-image stats "$image" --if-current "$previous"
ssh "$host" doas -n /sbin/rc-service oo-app.stats restart
deadline=$(( $(date +%s) + 90 ))
until curl -fsS --connect-timeout 5 --max-time 10 "${STATS_URL:-https://stats.17166969.xyz}/health" >/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo 'Orange health failed' >&2
        exit 1
    fi
    sleep 1
done
if ! deploy/deployed-smoke.sh; then
    echo 'Orange smoke failed' >&2
    exit 1
fi
switched=false
printf 'deployed %s on %s\n' "$image" "$host"
