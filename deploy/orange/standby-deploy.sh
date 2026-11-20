#!/bin/sh
# Deploys the committed tree to the native Stats standby writer (see docs/openorange.md).
#   deploy/orange/standby-deploy.sh [--check]
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
config=${STANDBY_SSH_CONFIG:?STANDBY_SSH_CONFIG is required}
app=/opt/native-rehearsal/app
releases=/opt/native-rehearsal/releases
check=false
case "${1:-}" in
    --check) check=true ;;
    "") ;;
    *) echo "usage: deploy/orange/standby-deploy.sh [--check]" >&2; exit 2 ;;
esac

guest() { ssh -F "$config" stats-standby "$@"; }
fail() { echo "standby-deploy: $*" >&2; exit 1; }

[ -r "$config" ] || fail "missing SSH config $config"
current=$(guest "grep -o 'stats-[0-9a-f]\{12\}' $app/stats.jsonc | head -1") || fail "cannot reach the standby"
guest "rc-service native-stats status >/dev/null" || fail "native-stats is not running on the standby"
writer=$(ssh lisa doas -n cat /etc/openorange/recovery-routes.json | jaq -r '.stats.mode // empty')
[ "$writer" = writer ] || fail "Lisa's recovery route does not name the standby as the Stats writer"
for file in package.json pnpm-lock.yaml; do
    local_sum=$(shasum -a 256 "$root/deploy/orange/$file" | cut -d' ' -f1)
    remote_sum=$(guest "sha256sum /opt/native-rehearsal/orange/$file" | cut -d' ' -f1)
    [ "$local_sum" = "$remote_sum" ] || fail "deploy/orange/$file differs from the standby runtime; update /opt/native-rehearsal/orange first"
done
echo "standby runs $current; runtime pins match"
$check && exit 0
: "${STATS_ROLLOUT:?STATS_ROLLOUT is required}"

[ -z "$(git -C "$root" status --porcelain)" ] || fail "commit or stash local changes first"
release="stats-$(git -C "$root" rev-parse --short=12 HEAD)"
[ "$release" != "$current" ] || { echo "standby already runs $release"; exit 0; }
work=$(mktemp -d "$root/.work/tmp/standby.XXXXXX")
trap 'rm -rf "$work"' EXIT
TMPDIR="$root/.work/tmp" sh "$root/deploy/orange/build-context.sh" "$work/ctx" "${release#stats-}" >"$work/build.log" 2>&1 || fail "build failed; see $work/build.log"
grep -q "\"APPLICATION_EVENTS_RELEASE\": \"$release\"" "$work/ctx/app/stats.jsonc" || fail "built descriptor does not name $release"
tar -C "$work/ctx/app" -czf "$work/app.tgz" stats observe stats.jsonc observe.jsonc

sh "$root/deploy/orange/collector/install.sh" --prepare "$work" || fail "collector build failed"
cat >"$work/deploy-guest.sh" <<'GUEST'
set -eu
stage=$1
release=$2
current=$3
app=/opt/native-rehearsal/app
releases=/opt/native-rehearsal/releases
previous=${current#stats-}
grep -q "$current" "$app/stats.jsonc" || exit 1
mkdir -p "$releases/$previous"
[ -e "$releases/$previous/stats.jsonc" ] || cp -a "$app/stats" "$app/observe" "$app/stats.jsonc" "$app/observe.jsonc" "$releases/$previous/"
rm -rf "$releases/next"
mkdir -p "$releases/next"
tar -C "$releases/next" -xzf "$stage/app.tgz"
chown -R root:root "$releases/next"
if [ -d /opt/stats-infra-collector ]; then
    cp -a /opt/stats-infra-collector "$stage/previous-collector"
fi
activate() {
    rm -rf "$app/stats" "$app/observe"
    cp -a "$1/stats" "$1/observe" "$1/stats.jsonc" "$1/observe.jsonc" "$app/"
}
restart() {
    rc-service native-stats restart >/dev/null || return 1
    i=0
    until wget -q -T 2 -O /dev/null http://127.0.0.1:8080/health; do
        i=$((i+1)); [ "$i" -lt 60 ] || return 1; sleep 2
    done
    grep -q "$1" "$app/stats.jsonc"
}
if activate "$releases/next" && sh "$stage/collector-install.sh" <"$stage/collector.tgz" && restart "$release" && wget -q -T 15 -O /dev/null https://stats.17166969.xyz/health; then
    rm -rf "$releases/${release#stats-}"
    mv "$releases/next" "$releases/${release#stats-}"
else
    if [ -d "$stage/previous-collector" ]; then
        rm -rf /opt/stats-infra-collector
        cp -a "$stage/previous-collector" /opt/stats-infra-collector
    else
        rm -rf /opt/stats-infra-collector
    fi
    activate "$releases/$previous" && restart "$current" || exit 1
    exit 1
fi
GUEST
tar -C "$work" -czf "$work/payload.tgz" app.tgz collector.tgz collector-install.sh deploy-guest.sh
fifo="/tmp/stats-deploy-$(basename "$work").fifo"
"$STATS_ROLLOUT" lease run --target-kind native --host stats-standby --ssh-config "$config" --operation stats-deploy --bound-s 300 -- sh -c 'fifo=$1; stage=$(mktemp -d); trap "rm -f $fifo; rm -rf $stage" EXIT; mkfifo "$fifo"; tar -C "$stage" -xzf "$fifo"; rm -f "$fifo"; sh "$stage/deploy-guest.sh" "$stage" "$2" "$3"' sh "$fifo" "$release" "$current" &
lease_pid=$!
ssh -F "$config" stats-standby "i=0; while [ ! -p '$fifo' ]; do i=\$((i+1)); [ \$i -lt 300 ] || exit 1; sleep 1; done; cat >'$fifo'" <"$work/payload.tgz" &
sender_pid=$!
status=0
wait "$lease_pid" || status=$?
kill "$sender_pid" 2>/dev/null || :
wait "$sender_pid" 2>/dev/null || :
[ "$status" -eq 0 ] || fail "activation failed or lease unavailable"
echo "standby runs $release; rollback: $releases/${current#stats-}"
