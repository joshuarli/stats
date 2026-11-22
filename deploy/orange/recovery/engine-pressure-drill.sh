#!/bin/sh
# Drives the STA-135 pressure/recovery case against a guest that recreate.sh kept (GUEST_KEEP=1).
#   deploy/orange/recovery/engine-pressure-drill.sh NAME FAULT OUT_DIR
# FAULT is one of
#   stall      throttle the guest's disk through QEMU (DRILL_IOPS, DRILL_BPS) for the pressure phase
#   warm-read  read the whole live depot on the guest's own disk while the Engine serves, throttled
#              like stall when DRILL_IOPS is set; DRILL_COPY=1 also writes the copy to the same disk,
#              as the 2026-11-22 capture did (it needs the depot's size free on the guest)
#   none       load only; with DRILL_FREE_BYTES this is the small log-budget case
# DRILL_FREE_BYTES, when set, first fills the guest's root filesystem with a ballast file until that
# many bytes stay free and restarts the Engine and app, so the Engine sizes its log shard and cold
# cache from that free space at startup, as it does in production.
#
# One cycle: BASELINE_S of load, PRESSURE_S with the fault, then the fault is removed and the run
# waits up to RECOVERY_S (120 by default, the campaign's pressure-recovery objective) for the healthy
# envelope: a synthetic ingest with readback and duplicate replay passes, and the Engine logged no
# refusal or deadline warning and used less than ENGINE_CPU_MAX percent in the last two samples.
# It keeps observing for WATCH_S more; three consecutive unhealthy samples there are a relapse. CYCLES repeats it on the same state.
# Requires GUEST_HOST, GUEST_ROOT (as for recreate.sh), STATS_CHECK_CREDENTIAL_FILE and STATSCTL.
# Writes OUT_DIR/samples.jsonl (one line per SAMPLE_S), load.jsonl and cycles.jsonl, and exits 0 only
# when every cycle recovered within RECOVERY_S without relapse.
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../../.." && pwd)
[ "$#" -eq 3 ] || { echo "usage: deploy/orange/recovery/engine-pressure-drill.sh NAME stall|warm-read|none OUT_DIR" >&2; exit 2; }
name=$1 fault=$2 out=$3
case "$fault" in stall|warm-read|none) ;; *) echo "engine-pressure-drill: unknown FAULT $fault" >&2; exit 2 ;; esac
host=${GUEST_HOST:?GUEST_HOST is required}
guest_root=${GUEST_ROOT:?GUEST_ROOT is required}
credential=${STATS_CHECK_CREDENTIAL_FILE:?STATS_CHECK_CREDENTIAL_FILE is required}
statsctl=${STATSCTL:?STATSCTL is required}
access=$HOME/.local/state/openorange/guests/$name.access
baseline_s=${BASELINE_S:-120} pressure_s=${PRESSURE_S:-300} recovery_s=${RECOVERY_S:-120} watch_s=${WATCH_S:-300}
cycles=${CYCLES:-1} sample_s=${SAMPLE_S:-5} cpu_max=${ENGINE_CPU_MAX:-100}
iops=${DRILL_IOPS:-} bps=${DRILL_BPS:-}
[ -r "$access/ssh_config" ] || { echo "engine-pressure-drill: no kept guest $name ($access)" >&2; exit 1; }
[ ! -e "$out" ] || { echo "engine-pressure-drill: $out already exists" >&2; exit 1; }
mkdir -p "$out"
fail() { echo "engine-pressure-drill: $*" >&2; exit 1; }
now() { date -u +%FT%TZ; }
ms() { python3 -I -c 'import time; print(int(time.time() * 1000))'; }
guest() { ssh -F "$access/ssh_config" guest "$@"; }
qmp() { ssh -o BatchMode=yes "$host" "printf '%s\n' '{\"execute\":\"qmp_capabilities\"}' '$1' | socat -t 2 - UNIX-CONNECT:$guest_root/$name/qmp.sock" >/dev/null; }
throttle() { qmp "{\"execute\":\"block_set_io_throttle\",\"arguments\":{\"device\":\"os\",\"bps\":$1,\"bps_rd\":0,\"bps_wr\":0,\"iops\":$2,\"iops_rd\":0,\"iops_wr\":0}}"; }
log() { printf '%s\n' "$1" >> "$out/events.jsonl"; echo "$1"; }

port=$((49700 + $$ % 200)) proxy_port=$((49900 + $$ % 90))
gateway=$(guest "sed -n 's/^GATEWAY_SECRET=//p' /etc/conf.d/native-stats")
(umask 077; printf '%s' "$gateway" > "$out/.gateway-secret")
tunnel= proxy= load= copy=
cleanup() {
    status=$?
    trap - EXIT INT TERM
    for pid in $load $proxy $tunnel; do kill "$pid" 2>/dev/null || :; done
    throttle 0 0 2>/dev/null || :
    [ -z "$copy" ] || guest "pkill -x rsync; [ ! -s /run/drill-read.pid ] || { pkill -P \$(cat /run/drill-read.pid); kill \$(cat /run/drill-read.pid); rm -f /run/drill-read.pid; }; rm -rf /var/lib/live-stats-recovery/drill-copy" 2>/dev/null || :
    rm -f "$out/.gateway-secret"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ssh -F "$access/ssh_config" -o ExitOnForwardFailure=yes -N -L "$port:127.0.0.1:8080" guest & tunnel=$!
GATEWAY_SECRET=$gateway node "$root/deploy/orange/recovery/guest/gateway-proxy.mjs" "$proxy_port" "$port" >/dev/null & proxy=$!
sleep 3
origin=http://127.0.0.1:$proxy_port

if [ -n "${DRILL_FREE_BYTES:-}" ]; then
    guest "set -e; rm -f /var/lib/drill-ballast; free=\$(df -B1 / | awk 'NR==2{print \$4}'); [ \$free -gt $DRILL_FREE_BYTES ] && fallocate -l \$((free - $DRILL_FREE_BYTES)) /var/lib/drill-ballast; sync; rc-service stats-infra-collector stop; rc-service native-stats stop; docker restart live-stats-engine >/dev/null; until wget -q -T 2 -O /dev/null http://127.0.0.1:6420/health; do sleep 1; done; rc-service native-stats start; rc-service stats-infra-collector start; i=0; until wget -q -T 2 -O /dev/null http://127.0.0.1:8080/health; do i=\$((i + 1)); [ \$i -lt 90 ] || exit 1; sleep 2; done" >/dev/null || fail "the app did not answer its health route after the ballast restart"
    log "{\"at\":\"$(now)\",\"event\":\"ballast\",\"freeBytes\":$DRILL_FREE_BYTES,\"budget\":\"$(guest "docker logs live-stats-engine 2>&1 | grep 'resolved storage disk capacities' | tail -1 | sed 's/.*log_disk_bytes=\([0-9]*\).*cache_bytes=\([0-9]*\).*/log \1 cache \2/'")\"}"
fi

# One sample, run in this shell so the check cadence and the last check persist: Engine CPU, Engine warning classes and app registration losses since the last sample,
# and a synthetic check every 30 s (the check host is admitted six frames a minute).
last_check=0 check='null'
sample() {
    phase=$1
    t=$(ms)
    if [ $((t - last_check)) -ge 30000 ]; then
        last_check=$t
        check=$("$statsctl" check ingest --origin "$origin" --credential-file "$credential" --json 2>/dev/null | python3 -I -c 'import json, sys
try:
    p = json.load(sys.stdin)["payload"]; print(json.dumps({"ok": p["ok"], "ms": round(sum(s["ms"] or 0 for s in p["steps"])), "failed": [s["name"] for s in p["steps"] if not s["ok"]]}))
except Exception: print(json.dumps({"ok": False, "ms": None, "failed": ["unreadable"]}))')
    else check='null'; fi
    engine=$(guest "since=${sample_s}s; cpu=\$(docker stats --no-stream --format '{{.CPUPerc}}' live-stats-engine | tr -d %); logs=\$(docker logs --since \$since live-stats-engine 2>&1); c() { printf '%s' \"\$logs\" | grep -c \"\$1\"; }; printf '{\"cpu\":%s,\"refused\":%s,\"deadline\":%s,\"alarmFailed\":%s,\"capacity\":%s,\"nearCapacity\":%s,\"coldReads\":%s,\"warn\":%s,\"lost\":%s,\"free\":%s}' \"\${cpu:-null}\" \"\$(c 'refusing envoy connect')\" \"\$(c request_deadline_exceeded)\" \"\$(c 'alarm callback failed')\" \"\$(c command_capacity)\" \"\$(c 'near its capacity')\" \"\$(c 'cold reads near')\" \"\$(c 'level=warn')\" \"\$(tail -c 65536 /var/log/native-stats.log | grep -c 'losing the engine')\" \"\$(df -B1 / | awk 'NR==2{print \$4}')\"" 2>/dev/null || echo null)
    printf '{"atMs":%s,"phase":"%s","engine":%s,"check":%s}\n' "$t" "$phase" "$engine" "$check" >> "$out/samples.jsonl"
}
healthy() { printf '%s' "$engine" | python3 -I -c 'import json, sys; e = json.loads(sys.stdin.read() or "null"); sys.exit(0 if e and e["cpu"] is not None and e["cpu"] < float(sys.argv[1]) and e["refused"] == 0 and e["deadline"] == 0 else 1)' "$cpu_max"; }
run_phase() {
    phase=$1 seconds=$2 end=$(( $(ms) + $2 * 1000 ))
    while [ "$(ms)" -lt "$end" ]; do load_alive; sample "$phase"; sleep "$sample_s"; done
}

node --experimental-strip-types "$root/deploy/orange/recovery/contention-load.mts" --origin "$origin" --gateway-secret-file "$out/.gateway-secret" \
    --duration-s $(( cycles * (baseline_s + pressure_s + recovery_s + watch_s) + 60 )) --prefix "drill-$fault" > "$out/load.jsonl" 2>"$out/load.err" & load=$!
# A load driver that exits early leaves a run without its declared pressure, so the run stops.
load_alive() { kill -0 "$load" 2>/dev/null || fail "the load driver exited early; see $out/load.err"; }
sleep 10
load_alive
cycle=1 failed=0
while [ "$cycle" -le "$cycles" ]; do
    log "{\"at\":\"$(now)\",\"cycle\":$cycle,\"event\":\"baseline\"}"
    run_phase baseline "$baseline_s"
    log "{\"at\":\"$(now)\",\"cycle\":$cycle,\"event\":\"pressure\",\"fault\":\"$fault\",\"iops\":\"$iops\",\"bps\":\"$bps\"}"
    case "$fault" in
    stall) throttle "${bps:-1048576}" "${iops:-20}" ;;
    warm-read)
        [ -z "$iops" ] || throttle "${bps:-0}" "$iops"
        if [ "${DRILL_COPY:-0}" = 1 ]; then
            guest "rm -rf /var/lib/live-stats-recovery/drill-copy; nohup rsync -a /var/lib/live-stats/ /var/lib/live-stats-recovery/drill-copy/ >/dev/null 2>&1 &"
        else
            guest "nohup sh -c 'while :; do tar -cf - -C /var/lib/live-stats log objects | cat >/dev/null; done' >/dev/null 2>&1 & echo \$! > /run/drill-read.pid"
        fi
        copy=1 ;;
    none) ;;
    esac
    run_phase pressure "$pressure_s"
    [ "$fault" = none ] || throttle 0 0
    [ -z "$copy" ] || { guest "pkill -x rsync; [ ! -s /run/drill-read.pid ] || { pkill -P \$(cat /run/drill-read.pid); kill \$(cat /run/drill-read.pid); rm -f /run/drill-read.pid; }; rm -rf /var/lib/live-stats-recovery/drill-copy" || :; copy=; }
    released=$(ms)
    log "{\"at\":\"$(now)\",\"cycle\":$cycle,\"event\":\"released\"}"
    recovered_ms= good=0 checked=false
    end=$(( released + recovery_s * 1000 ))
    while [ "$(ms)" -lt "$end" ]; do
        load_alive
        sample recovery
        if healthy; then good=$((good + 1)); else good=0; fi
        if [ "$check" != null ]; then
            if printf '%s' "$check" | python3 -I -c 'import json, sys; sys.exit(0 if json.load(sys.stdin)["ok"] else 1)'; then checked=true; else checked=false; fi
        fi
        if [ "$good" -ge 2 ] && [ "$checked" = true ]; then recovered_ms=$(( $(ms) - released )); break; fi
        sleep "$sample_s"
    done
    relapsed=false
    if [ -n "$recovered_ms" ]; then
        end=$(( $(ms) + watch_s * 1000 ))
        bad=0
        while [ "$(ms)" -lt "$end" ]; do
            load_alive
            sample watch
            if healthy; then bad=0; else bad=$((bad + 1)); fi
            [ "$bad" -lt 3 ] || relapsed=true
            sleep "$sample_s"
        done
    else
        run_phase unrecovered "$watch_s"
    fi
    ok=false; [ -n "$recovered_ms" ] && [ "$relapsed" = false ] && ok=true
    [ "$ok" = true ] || failed=1
    log "{\"at\":\"$(now)\",\"cycle\":$cycle,\"event\":\"result\",\"fault\":\"$fault\",\"recoveredAfterMs\":${recovered_ms:-null},\"relapsed\":$relapsed,\"ok\":$ok}"
    printf '{"cycle":%s,"fault":"%s","recoveredAfterMs":%s,"relapsed":%s,"ok":%s}\n' "$cycle" "$fault" "${recovered_ms:-null}" "$relapsed" "$ok" >> "$out/cycles.jsonl"
    cycle=$((cycle + 1))
done
exit "$failed"
