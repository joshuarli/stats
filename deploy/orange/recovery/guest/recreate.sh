#!/bin/sh
# Recreates the declared Stats standby writer on a disposable guest and checks it (see docs/lisa-operational-recovery.md).
#   deploy/orange/recovery/guest/recreate.sh NAME CAPTURE_DIR
# CAPTURE_DIR is a sealed capture from capture-standby.sh (depot/ and depot.sha256), copied off-host.
# Requires GUEST_HOST (SSH alias of the Linux host that runs the guest), BASE_IMAGE (path on that host
# of an Alpine 3.24 cloud image with IMAGE.sha512 beside it), STUFF_ROOT (a laputa-systems/stuff
# checkout), RUNTIME_DIR (a runtime build directory holding runtime.tar), APP_DIR (an app release),
# STATS_CHECK_CREDENTIAL_FILE and STATSCTL. Requires hdiutil, genisoimage or xorriso for the seed.
#
# The guest has no outbound network: packages, the Engine image, runtime and app are staged from the
# host. It is provisioned with provision.sh, then checked for health, the declared app and Engine,
# and synthetic ingest with readback and duplicate replay; then it reboots and is checked again.
# The result is written to ~/.local/state/openorange/guests/NAME.json and the guest is destroyed,
# since it holds a copy of production state. Exit 0 only when every check passed after the reboot.
#
# It writes several GB to the host's disk (image cache, Engine image, overlay disk, restored depot).
# Do not run it on a host whose disk also holds the production writer: on 2026-11-22 these writes on
# Threadripper raised production Stats latency from about 60 ms to 1.4-1.9 s and produced Engine
# heartbeat and alarm warnings. The host keeps the runtime archive and capture in
# ~/.local/share/stats-guest/cache (owner-only) between runs.
set -eu
# macOS tar otherwise adds ._* AppleDouble entries for extended attributes, and the Engine refuses
# to read an object store that contains them.
export COPYFILE_DISABLE=1
root=$(CDPATH='' cd -- "$(dirname "$0")/../../../.." && pwd)
here=$root/deploy/orange/recovery/guest
[ "$#" -eq 2 ] || { echo "usage: deploy/orange/recovery/guest/recreate.sh NAME CAPTURE_DIR" >&2; exit 2; }
name=$1 capture=$(CDPATH='' cd -- "$2" && pwd)
case "$name" in *[!A-Za-z0-9._-]*|.*|"") echo "recreate: NAME may hold only letters, digits, '.', '_' and '-'" >&2; exit 2 ;; esac
host=${GUEST_HOST:?GUEST_HOST is required}
base=${BASE_IMAGE:?BASE_IMAGE is required}
stuff=${STUFF_ROOT:?STUFF_ROOT is required}
runtime=${RUNTIME_DIR:?RUNTIME_DIR is required}
app=${APP_DIR:?APP_DIR is required}
credential=${STATS_CHECK_CREDENTIAL_FILE:?STATS_CHECK_CREDENTIAL_FILE is required}
statsctl=${STATSCTL:?STATSCTL is required}
ssh_port=49291
remote=.local/share/stats-guest/$name
results=$HOME/.local/state/openorange/guests
result=$results/$name.json
fail() { echo "recreate: $*" >&2; exit 1; }
now() { date -u +%FT%TZ; }
on_host() { ssh -o BatchMode=yes "$host" "$@"; }

[ -f "$capture/depot.sha256" ] && [ -d "$capture/depot" ] || fail "$capture is not a sealed capture"
[ -f "$runtime/runtime.tar" ] || fail "$runtime has no runtime.tar"
mkdir -p "$results" "$root/.work/tmp"
[ ! -e "$result" ] || fail "$result already exists"
work=$(mktemp -d "$root/.work/tmp/guest-$name.XXXXXX")
tunnel= proxy=
cleanup() {
    status=$?
    trap - EXIT INT TERM
    [ -z "$proxy" ] || kill "$proxy" 2>/dev/null || :
    [ -z "$tunnel" ] || kill "$tunnel" 2>/dev/null || :
    if [ "$status" -ne 0 ] && [ -s "$work/ssh_config" ]; then
        ssh -F "$work/ssh_config" guest 'rc-status default; docker ps -a; docker logs --tail 300 live-stats-engine 2>&1; tail -100 /var/log/native-stats.log' > "$results/$name.diagnostics.log" 2>&1 || :
        echo "recreate: guest diagnostics in $results/$name.diagnostics.log" >&2
    fi
    on_host "cd $remote 2>/dev/null && { [ ! -s qemu.pid ] || kill \$(cat qemu.pid) 2>/dev/null; sleep 2; cp console.log ~/.local/share/stats-guest/$name.console.log 2>/dev/null; }; docker run --rm -v \$HOME/.local/share/stats-guest:/g alpine:3.24 rm -rf /g/$name" >/dev/null 2>&1 || echo "recreate: remove $host:$remote by hand" >&2
    rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "seed and key"
# lock_passwd must stay false: a locked root password ("!" in /etc/shadow) makes this image's
# sshd, which runs without PAM, refuse root's key. Root keeps the image's "*" password, so
# password login stays impossible.
ssh-keygen -q -t ed25519 -N '' -C "stats-guest-$name" -f "$work/key"
mkdir "$work/seed" "$work/bundle"
printf 'instance-id: stats-guest-%s\nlocal-hostname: stats-guest\n' "$name" > "$work/seed/meta-data"
printf '#cloud-config\nssh_pwauth: false\ndisable_root: false\nusers:\n  - name: root\n    lock_passwd: false\n    ssh_authorized_keys:\n      - %s\n' "$(cat "$work/key.pub")" > "$work/seed/user-data"
if command -v hdiutil >/dev/null; then hdiutil makehybrid -quiet -iso -joliet -default-volume-name cidata -o "$work/seed.iso" "$work/seed"
elif command -v genisoimage >/dev/null; then genisoimage -quiet -output "$work/seed.iso" -volid cidata -joliet -rock "$work/seed"
elif command -v xorriso >/dev/null; then xorriso -as mkisofs -quiet -o "$work/seed.iso" -V cidata -J -R "$work/seed"
else fail "no ISO tool (hdiutil, genisoimage or xorriso)"; fi

echo "bundle"
for file in packages native-stats.openrc provision.sh; do cp "$here/$file" "$work/bundle/"; done
cp "$stuff/deploy/openorange/bin/standby-engine" "$stuff/deploy/openorange/standby/stats-engine.json" "$stuff/deploy/openorange/lib/oomanifest.py" "$work/bundle/"
sh "$root/deploy/orange/collector/install.sh" --bundle "$work/bundle"
cp -R "$app" "$work/bundle/app"
rm -f "$work/bundle/app/release.json"
image=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["image"])' "$work/bundle/stats-engine.json")

echo "host: image, overlay disk, packages and Engine image"
on_host "set -e; [ \"\$(sha512sum $base | cut -d' ' -f1)\" = \"\$(cut -d' ' -f1 $base.sha512)\" ] || { echo 'base image checksum mismatch' >&2; exit 1; }; mkdir -p $remote/bundle/apks/x86_64; cd $remote; qemu-img create -q -f qcow2 -F qcow2 -b $base os.qcow2 24G"
scp -q "$work/seed.iso" "$work/key" "$host:$remote/"
scp -q "$work/bundle/packages" "$host:$remote/bundle/"
on_host "set -e; cd $remote/bundle; docker run --rm -v \$PWD:/b alpine:3.24 sh -ec 'apk update -q; apk fetch -q -R -o /b/apks/x86_64 \$(cat /b/packages); apk index -q -o /b/apks/x86_64/APKINDEX.tar.gz --allow-untrusted /b/apks/x86_64/*.apk; ln -s x86_64 /b/apks/noarch'; docker image inspect $image >/dev/null 2>&1 || docker pull -q $image >/dev/null; docker save -o engine-image.tar $image"
echo "host: runtime, app and capture"
tar -C "$work/bundle" -cf - . | on_host "tar -C $remote/bundle -xf -"
# The runtime archive and the capture are large, so the host keeps them in an owner-only cache
# keyed by their digests and copies them from this machine only when absent.
cache=.local/share/stats-guest/cache
runtime_key=$(shasum -a 256 "$runtime/runtime.tar" | cut -d' ' -f1)
capture_key=$(shasum -a 256 "$capture/depot.sha256" | cut -d' ' -f1)
on_host "umask 077; mkdir -p $cache"
if ! on_host "[ -s $cache/runtime-$runtime_key.tar ]"; then
    tar -C "$runtime" -cf - runtime.tar | on_host "tar -C $cache -xf - && mv $cache/runtime.tar $cache/runtime-$runtime_key.tar"
fi
if ! on_host "[ -d $cache/capture-$capture_key ]"; then
    tar -C "$capture" -cf - depot depot.sha256 | on_host "rm -rf $cache/capture-$capture_key.partial && mkdir $cache/capture-$capture_key.partial && tar -C $cache/capture-$capture_key.partial -xf - && mv $cache/capture-$capture_key.partial $cache/capture-$capture_key"
fi
on_host "set -e; cd $remote/bundle; cp ~/$cache/runtime-$runtime_key.tar runtime.tar; cp -R ~/$cache/capture-$capture_key/depot ~/$cache/capture-$capture_key/depot.sha256 .; [ \"\$(sha256sum runtime.tar | cut -d' ' -f1)\" = $runtime_key ]; [ \"\$(sha256sum depot.sha256 | cut -d' ' -f1)\" = $capture_key ]; cd depot; sha256sum -c -s ../depot.sha256; [ \"\$(find . -type f | LC_ALL=C sort)\" = \"\$(awk '{print \$2}' ../depot.sha256 | LC_ALL=C sort)\" ]"

echo "guest: boot"
on_host "cd $remote && nice -n 10 qemu-system-x86_64 -enable-kvm -cpu host -smp 8 -m 4096 -drive file=os.qcow2,format=qcow2,if=virtio -cdrom seed.iso -nic user,model=virtio-net-pci,restrict=on,hostfwd=tcp:127.0.0.1:$ssh_port-:22 -display none -serial file:console.log -monitor none -pidfile qemu.pid -daemonize"
cat > "$work/ssh_config" <<EOF
Host guest
    HostName 127.0.0.1
    Port $ssh_port
    User root
    IdentityFile $work/key
    IdentitiesOnly yes
    ProxyJump $host
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
    BatchMode yes
    ConnectTimeout 10
EOF
guest() { ssh -F "$work/ssh_config" guest "$@"; }
wait_guest() {
    i=0
    until guest true 2>/dev/null; do i=$((i + 1)); [ "$i" -lt 60 ] || fail "the guest did not answer SSH"; sleep 5; done
}
wait_guest
echo "guest: copy the bundle"
on_host "cd $remote && tar -C bundle -cf - . | ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i key -p $ssh_port root@127.0.0.1 'mkdir -p /root/bundle && tar -C /root/bundle -xf -'"
echo "guest: provision"
started=$(now)
guest "sh /root/bundle/provision.sh /root/bundle" 2>&1 | tee "$work/provision.log"
[ "$(tail -1 "$work/provision.log" | cut -d' ' -f1)" = provisioned ] || fail "provision failed; see the log above"
provisioned=$(now)

expected_app=$(python3 -I -c "import sys; sys.path.insert(0, '$stuff/deploy/openorange/lib'); import oomanifest; print(oomanifest.app_release_id(oomanifest.app_digest(sys.argv[1])))" "$work/bundle/app")
check() {
    phase=$1
    gateway=$(guest "sed -n 's/^GATEWAY_SECRET=//p' /etc/conf.d/native-stats")
    local_port=$((49300 + $$ % 300)) proxy_port=$((49600 + $$ % 300))
    ssh -F "$work/ssh_config" -N -L "$local_port:127.0.0.1:8080" guest & tunnel=$!
    GATEWAY_SECRET=$gateway node "$here/gateway-proxy.mjs" "$proxy_port" "$local_port" >/dev/null & proxy=$!
    sleep 3
    ingest=false
    i=0
    while [ "$i" -lt 24 ]; do
        if "$statsctl" check ingest --origin "http://127.0.0.1:$proxy_port" --credential-file "$credential" --json >"$work/ingest-$phase.json" 2>&1; then ingest=true; break; fi
        i=$((i + 1)); sleep 5
    done
    kill "$proxy" "$tunnel" 2>/dev/null || :; proxy= tunnel=
    identity=$("$stuff/deploy/openorange/bin/rollout" observe --target-kind native-app --host guest --ssh-config "$work/ssh_config" --json)
    app_ok=$(printf '%s' "$identity" | python3 -I -c 'import json, sys; s = json.load(sys.stdin); e = sys.argv[1]; print(str(s["selected"] == e and s["running"] == e and s["collector_running"] == e and s["healthy"]).lower())' "$expected_app")
    engine=$("$stuff/deploy/openorange/bin/standby-engine" inspect --host guest --ssh-config "$work/ssh_config" --json || :)
    engine_ok=$(printf '%s' "$engine" | python3 -I -c 'import json, sys; print(str(json.load(sys.stdin)["ok"]).lower())' 2>/dev/null || echo false)
    printf '"%s":{"at":"%s","ingest":%s,"app":%s,"engine":%s,"engineDrift":%s}' "$phase" "$(now)" "$ingest" "$app_ok" "$engine_ok" "$(printf '%s' "$engine" | python3 -I -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["drift"]))' 2>/dev/null || echo null)"
}
echo "guest: check"
first=$(check provisioned)
echo "guest: reboot"
guest "reboot" || :
sleep 20
wait_guest
i=0
until guest "wget -q -T 2 -O /dev/null http://127.0.0.1:8080/health" 2>/dev/null; do i=$((i + 1)); [ "$i" -lt 60 ] || break; sleep 5; done
echo "guest: check after reboot"
second=$(check rebooted)
cat >"$result" <<EOF
{"schema":"stats-guest-recreation/1","name":"$name","host":"$host","baseImage":"$base","capture":"$capture","app":"$expected_app","startedAt":"$started","provisionedAt":"$provisioned",$first,$second}
EOF
cat "$result"
python3 -I -c 'import json, sys; r = json.load(open(sys.argv[1])); sys.exit(0 if all(r[p][k] for p in ("provisioned", "rebooted") for k in ("ingest", "app", "engine")) else 1)' "$result"
