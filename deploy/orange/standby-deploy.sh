#!/bin/sh
# Deploys the committed tree to the native Stats standby writer (see docs/openorange.md).
#   deploy/orange/standby-deploy.sh [--check]
# SSH reaches the guest through STANDBY_SSH_CONFIG (default ~/.config/stats/standby/ssh_config,
# host alias stats-standby). --check verifies access, authority and runtime pins and changes nothing.
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
config=${STANDBY_SSH_CONFIG:-$HOME/.config/stats/standby/ssh_config}
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

[ -z "$(git -C "$root" status --porcelain)" ] || fail "commit or stash local changes first"
release="stats-$(git -C "$root" rev-parse --short=12 HEAD)"
[ "$release" != "$current" ] || { echo "standby already runs $release"; exit 0; }
work=$(mktemp -d "$root/.work/tmp/standby.XXXXXX")
trap 'rm -rf "$work"' EXIT
TMPDIR="$root/.work/tmp" sh "$root/deploy/orange/build-context.sh" "$work/ctx" "${release#stats-}" >"$work/build.log" 2>&1 || fail "build failed; see $work/build.log"
grep -q "\"APPLICATION_EVENTS_RELEASE\": \"$release\"" "$work/ctx/app/stats.jsonc" || fail "built descriptor does not name $release"
tar -C "$work/ctx/app" -czf "$work/app.tgz" stats observe stats.jsonc observe.jsonc

previous=${current#stats-}
guest "set -e; mkdir -p $releases/$previous; [ -e $releases/$previous/stats.jsonc ] || cp -a $app/stats $app/observe $app/stats.jsonc $app/observe.jsonc $releases/$previous/;
    rm -rf $releases/next; mkdir $releases/next; tar -C $releases/next -xzf -; chown -R root:root $releases/next" <"$work/app.tgz"

swap() {
    guest "set -e; rm -rf $app/stats $app/observe; cp -a $1/stats $1/observe $1/stats.jsonc $1/observe.jsonc $app/; rc-service native-stats restart >/dev/null;
        i=0; until wget -q -T 2 -O /dev/null http://127.0.0.1:8080/health 2>/dev/null; do i=\$((i+1)); [ \$i -lt 60 ] || exit 1; sleep 2; done;
        grep -q '$2' $app/stats.jsonc"
}
echo "activating $release (previous $current)"
if swap "$releases/next" "$release" && curl -fsS -m 15 -o /dev/null https://stats.17166969.xyz/health; then
    guest "rm -rf $releases/${release#stats-}; mv $releases/next $releases/${release#stats-}"
    echo "standby runs $release; rollback: $releases/$previous"
else
    echo "standby-deploy: $release failed health; restoring $current" >&2
    swap "$releases/$previous" "$current" || fail "rollback to $current failed; inspect native-stats on the standby"
    fail "rolled back to $current"
fi
