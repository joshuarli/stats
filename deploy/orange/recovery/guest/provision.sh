#!/bin/sh
# Provisions a Stats standby writer guest from a verified Engine capture (see docs/lisa-operational-recovery.md).
#   sh provision.sh BUNDLE
# Runs as root on an Alpine 3.24 cloud guest without network access. BUNDLE holds:
#   packages, apks/ (a local repository with APKINDEX.tar.gz), native-stats.openrc
#   standby-engine, stats-engine.json and oomanifest.py from Stuff's deploy/openorange
#   engine-image.tar (docker save of the declared Engine image)
#   runtime.tar (an OpenOrange runtime closure with its openorange.manifest_digest PAX header)
#   app/ (a Stats app release from deploy/orange/app-release.mts)
#   collector.tgz and collector-install.sh (deploy/orange/collector/install.sh --bundle)
#   depot/ and depot.sha256 (a sealed capture from deploy/orange/recovery/capture-standby.sh)
# The result matches the supported standby layout: the Engine container from the
# declaration, the runtime and app as rollout releases, and native-stats with its collector.
# Secrets are generated on the guest on the first run; rerunning changes nothing that exists.
set -eu
[ "$#" -eq 1 ] || { echo "usage: provision.sh BUNDLE" >&2; exit 2; }
b=$(realpath "$1")
opt=/opt/native-rehearsal
fail() { echo "provision: $*" >&2; exit 1; }
py() { code=$1; shift; python3 -I -c "import sys; sys.path.insert(0, '$b'); import oomanifest; $code" "$@"; }
point() { python3 -I -c 'import os, sys, uuid; t = sys.argv[2] + "." + uuid.uuid4().hex; os.symlink(sys.argv[1], t); os.replace(t, sys.argv[2])' "$1" "$2"; }
release_json() { printf '{"release": "%s", "digest": "%s", "source": "%s"}' "$1" "$2" "$3" > "$4"; }
random() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

echo "packages"
apk add --quiet --no-network --allow-untrusted --repositories-file /dev/null -X "$b/apks" $(cat "$b/packages")
rc-update add docker default >/dev/null
rc-service docker start >/dev/null

echo "accounts and directories"
getent passwd native-stats >/dev/null || adduser -S -D -H -h /home/native-stats -s /sbin/nologin native-stats
install -d -o root -g root -m 0755 "$opt" "$opt/apps" "$opt/runtime" "$opt/app" /var/lib/openorange-rollout
install -d -o native-stats -g root -m 0700 "$opt/app/.open-orange" /var/lib/stats-native
install -d -o root -g root -m 0700 /var/lib/live-stats /var/lib/live-stats-recovery /etc/stats-engine /etc/stats-native
[ -e /var/log/native-stats.log ] || install -o native-stats -g root -m 0600 /dev/null /var/log/native-stats.log

echo "secrets"
conf=/etc/conf.d/native-stats
if [ ! -s "$conf" ]; then
    (
        umask 077
        bridge=$(random)
        printf '%s' "$bridge" > /etc/stats-native/platform-bridge.token
        cat > "$conf.next" <<EOF
RIVET_ENDPOINT=http://127.0.0.1:6420
RIVET_NAMESPACE=stats-prod
RIVET_NODE_VERSION=27
RIVET_TOKEN=$(random)
GATEWAY_SECRET=$(random)
NODE_ENV=production
ORANGE_WORKER_SECRETS=GATEWAY_SECRET,PLATFORM_BRIDGE_TOKEN_SHA256
HOME=/var/lib/stats-native

export PLATFORM_BRIDGE_TOKEN_SHA256=$(printf '%s' "$bridge" | sha256sum | cut -d' ' -f1)
EOF
        mv "$conf.next" "$conf"
    )
fi
RIVET_TOKEN=$(sed -n 's/^RIVET_TOKEN=//p' "$conf")
[ -n "$RIVET_TOKEN" ] || fail "$conf has no RIVET_TOKEN"
[ -s /etc/stats-engine/engine.env ] || (umask 077; printf 'RIVET__AUTH__ADMIN_TOKEN=%s\n' "$RIVET_TOKEN" > /etc/stats-engine/engine.env)

echo "engine state from the capture"
if [ ! -d /var/lib/live-stats/log ]; then
    (cd "$b/depot" && sha256sum -c -s "$b/depot.sha256") || fail "the capture does not match depot.sha256"
    [ "$(cd "$b/depot" && find . -type f | LC_ALL=C sort)" = "$(awk '{print $2}' "$b/depot.sha256" | LC_ALL=C sort)" ] || fail "the capture holds files depot.sha256 does not list"
    cp -a "$b/depot/log" "$b/depot/objects" /var/lib/live-stats/
    chown -R 10001:10001 /var/lib/live-stats/log /var/lib/live-stats/objects
    chmod 0700 /var/lib/live-stats/log /var/lib/live-stats/objects
fi

echo "engine"
python3 -I -c 'import json, sys; json.dump(json.load(open(sys.argv[1]))["config"], open(sys.argv[2], "w"), indent=2)' "$b/stats-engine.json" "$opt/live-engine.json"
image=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["image"])' "$b/stats-engine.json")
if ! docker image inspect "$image" >/dev/null 2>&1; then
    loaded=$(docker load -q -i "$b/engine-image.tar" | sed -n 's/^Loaded image ID: //p')
    [ "$loaded" = "${image#*@}" ] || fail "engine-image.tar holds $loaded, not ${image#*@}"
    # A saved image carries no name, so the declared digest reference resolves offline only after
    # the loaded image is named in its repository.
    docker tag "$loaded" "${image%@*}:standby-declared"
fi
container=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["container"])' "$b/stats-engine.json")
if ! docker inspect "$container" >/dev/null 2>&1; then
    python3 -I "$b/standby-engine" create-args --declaration "$b/stats-engine.json" --env-file /etc/stats-engine/engine.env \
        | python3 -I -c 'import json, subprocess, sys; subprocess.run(json.load(sys.stdin), check=True, stdout=subprocess.DEVNULL)'
    parent=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["state_root"]["path"].rstrip("/").rsplit("/", 1)[0])' "$b/stats-engine.json")
    python3 -I "$b/standby-engine" state-root-archive --declaration "$b/stats-engine.json" | docker cp - "$container:$parent"
fi
docker start "$container" >/dev/null
i=0
until wget -q -T 2 -O /dev/null http://127.0.0.1:6420/health; do
    i=$((i + 1)); [ "$i" -lt 60 ] || fail "the Engine did not answer its health route"; sleep 2
done

echo "runtime release"
digest=$(python3 -I -c 'import sys, tarfile; print(tarfile.open(sys.argv[1]).pax_headers["openorange.manifest_digest"])' "$b/runtime.tar")
runtime=rt-$(printf '%s' "${digest#sha256:}" | cut -c1-12)
if [ ! -d "$opt/runtime/$runtime" ]; then
    staging=$opt/runtime/.staging-$$
    rm -rf "$staging"; mkdir "$staging"
    python3 -I -c 'import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter="data")' "$b/runtime.tar" "$staging"
    [ "$(py 'print(oomanifest.closure_digest(sys.argv[1]))' "$staging")" = "$digest" ] || fail "runtime.tar does not match its manifest digest"
    release_json "$runtime" "$digest" "provisioned from runtime.tar" "$staging/release.json"
    chown -R root:root "$staging"
    mv "$staging" "$opt/runtime/$runtime"
fi
[ -L "$opt/orange" ] || point "runtime/$runtime" "$opt/orange"
[ -e "$opt/runtime/.previous" ] || echo "$runtime" > "$opt/runtime/.previous"

echo "app release"
digest=$(py 'print(oomanifest.app_digest(sys.argv[1]))' "$b/app")
app=$(py 'print(oomanifest.app_release_id(sys.argv[1]))' "$digest")
if [ ! -d "$opt/apps/$app" ]; then
    staging=$opt/apps/.staging-$$
    rm -rf "$staging"
    cp -R "$b/app" "$staging"
    [ "$(py 'print(oomanifest.app_digest(sys.argv[1]))' "$staging")" = "$digest" ] || fail "the app release changed while it was copied"
    release_json "$app" "$digest" "provisioned from app/" "$staging/release.json"
    chown -R root:root "$staging"
    mv "$staging" "$opt/apps/$app"
fi
[ -L "$opt/app/current" ] || point "../apps/$app" "$opt/app/current"
for part in observe observe.jsonc stats stats.jsonc; do [ -L "$opt/app/$part" ] || point "current/$part" "$opt/app/$part"; done
[ -L /opt/stats-infra-collector ] || point native-rehearsal/app/current/collector /opt/stats-infra-collector
[ -e "$opt/apps/.previous" ] || echo "$app" > "$opt/apps/.previous"

echo "services"
install -o root -g root -m 0755 "$b/native-stats.openrc" /etc/init.d/native-stats
rc-update add native-stats default >/dev/null
sh "$b/collector-install.sh" < "$b/collector.tgz"
rc-service native-stats start >/dev/null
rc-service stats-infra-collector start >/dev/null
i=0
until wget -q -T 2 -O /dev/null http://127.0.0.1:8080/health; do
    i=$((i + 1)); [ "$i" -lt 90 ] || fail "native-stats did not answer its health route"; sleep 2
done
echo "provisioned $app on $runtime with $container"
