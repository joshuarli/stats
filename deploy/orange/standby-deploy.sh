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
mode=$1
stage=$2
release=$3
current=$4
app=/opt/native-rehearsal/app
releases=/opt/native-rehearsal/releases
previous=${current#stats-}
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
rollback() {
    rm -rf /opt/stats-infra-collector
    [ ! -d "$stage/previous-collector" ] || cp -a "$stage/previous-collector" /opt/stats-infra-collector
    activate "$releases/$previous" && restart "$current"
}
case "$mode" in
    activate)
        grep -q "$current" "$app/stats.jsonc"
        mkdir -p "$releases/$previous"
        [ -e "$releases/$previous/stats.jsonc" ] || cp -a "$app/stats" "$app/observe" "$app/stats.jsonc" "$app/observe.jsonc" "$releases/$previous/"
        rm -rf "$releases/${release#stats-}"
        mkdir -p "$releases/${release#stats-}"
        tar -C "$releases/${release#stats-}" -xzf "$stage/app.tgz"
        chown -R root:root "$releases/${release#stats-}"
        rm -rf "$stage/previous-collector"
        [ ! -d /opt/stats-infra-collector ] || cp -a /opt/stats-infra-collector "$stage/previous-collector"
        if activate "$releases/${release#stats-}" && sh "$stage/collector-install.sh" <"$stage/collector.tgz" && restart "$release"; then
            exit 0
        fi
        rollback
        exit 1 ;;
    rollback)
        rollback ;;
    *) exit 2 ;;
esac
GUEST
tar -C "$work" -czf "$work/payload.tgz" app.tgz collector.tgz collector-install.sh deploy-guest.sh
stage=/var/lib/stats-deploy/${release#stats-}
guest "rm -rf '$stage'; mkdir -p '$stage'; tar -C '$stage' -xzf -" <"$work/payload.tgz" || fail "cannot upload the release to the standby"
leased() {
    "$STATS_ROLLOUT" lease run --target-kind native --host stats-standby --ssh-config "$config" --operation "$1" --bound-s 300 -- sh "$stage/deploy-guest.sh" "$2" "$stage" "$release" "$current"
}
echo "activating $release (previous $current)"
if leased stats-deploy activate && curl -fsS -m 15 -o /dev/null https://stats.17166969.xyz/health; then
    guest "rm -rf '$stage'"
    echo "standby runs $release; rollback: $releases/${current#stats-}"
else
    echo "standby-deploy: $release failed activation, public health or the lease; restoring $current" >&2
    leased stats-deploy-rollback rollback || fail "rollback to $current failed or the lease is held; inspect native-stats on the standby"
    guest "rm -rf '$stage'"
    fail "rolled back to $current"
fi
