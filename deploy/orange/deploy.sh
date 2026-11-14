#!/bin/sh
set -eu
host=${1:-lisa}
root=$(git rev-parse --show-toplevel)
cd "$root"
previous=$(ssh "$host" 'doas -n cat /etc/openorange/apps/stats.image' | jaq -er '.image')
image=$(deploy/orange/build-image.sh "$host")
ssh "$host" doas -n /opt/openorange/bin/oo set-image stats "$image"
ssh "$host" doas -n /sbin/rc-service oo-app.stats restart
deadline=$(( $(date +%s) + 90 ))
until curl -fsS "${STATS_URL:-https://stats.17166969.xyz}/health" >/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        ssh "$host" doas -n /opt/openorange/bin/oo set-image stats "$previous"
        ssh "$host" doas -n /sbin/rc-service oo-app.stats restart
        echo 'Orange health failed; restored the previous image' >&2
        exit 1
    fi
    sleep 1
done
if ! deploy/deployed-smoke.sh; then
    ssh "$host" doas -n /opt/openorange/bin/oo set-image stats "$previous"
    ssh "$host" doas -n /sbin/rc-service oo-app.stats restart
    echo 'Orange smoke failed; restored the previous image' >&2
    exit 1
fi
printf 'deployed %s on %s\n' "$image" "$host"
