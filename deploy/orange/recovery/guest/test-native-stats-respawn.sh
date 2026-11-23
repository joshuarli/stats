#!/bin/sh
# Runs a native-stats unit under the guest's OpenRC with a child that fails until it is healthy.
#   deploy/orange/recovery/guest/test-native-stats-respawn.sh [UNIT]
# Needs Docker and takes about five minutes.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unit=$(CDPATH= cd -- "$(dirname -- "${1:-$here/native-stats.openrc}")" && pwd)/$(basename -- "${1:-native-stats.openrc}")

docker run --rm -i -v "$unit:/unit:ro" alpine:3.24 sh -s <<'GUEST'
set -eu
apk add --no-cache openrc=0.63.2-r0 >/dev/null
grep -qx 'respawn_max=5' /etc/rc.conf
mkdir -p /run/openrc
touch /run/openrc/softlevel
printf 'rc_sys="docker"\n' >> /etc/rc.conf
cat > /child <<'CHILD'
#!/bin/sh
date +%s >> /tmp/starts
[ -f /tmp/healthy ] && exec sleep 3600
sleep 1
exit 1
CHILD
chmod +x /child
awk '
/^directory=/ || /^command_args=/ || /^command_user=/ || /^export / || /^depend\(\)/ { next }
/^command=/ { print "command=/child"; next }
/^output_log=/ { print "output_log=/tmp/app.log"; next }
/^error_log=/ { print "error_log=/tmp/app.log"; next }
/^start_pre\(\)/ { exit }
{ print }
' /unit > /etc/init.d/native-stats
chmod +x /etc/init.d/native-stats
: > /tmp/starts
rc-service native-stats start >/dev/null 2>&1

waited=0
while [ "$(wc -l < /tmp/starts)" -lt 7 ]; do
    if [ "$waited" -ge 260 ]; then
        echo "FAIL: supervisor stopped after $(wc -l < /tmp/starts) failed starts" >&2
        exit 1
    fi
    sleep 1
    waited=$((waited + 1))
done

gaps=$(awk 'NR > 1 { printf "%d ", $1 - previous } { previous = $1 }' /tmp/starts)
first=${gaps%% *}
last=$(printf '%s\n' "$gaps" | awk '{ print $NF }')
if [ "$first" -ge "$last" ]; then
    echo "FAIL: respawn delay did not back off: $gaps" >&2
    exit 1
fi

touch /tmp/healthy
before=$(wc -l < /tmp/starts)
waited=0
while [ "$(wc -l < /tmp/starts)" -le "$before" ]; do
    if [ "$waited" -ge 90 ]; then
        echo "FAIL: no start after the child became healthy" >&2
        exit 1
    fi
    sleep 1
    waited=$((waited + 1))
done
sleep 3
pgrep -f 'sleep 3600' >/dev/null || { echo "FAIL: healthy child is not running" >&2; exit 1; }
rc-service native-stats status >/dev/null 2>&1 || { echo "FAIL: service is not started" >&2; exit 1; }
echo "PASS: kept retrying with delays $gaps and recovered"
GUEST
