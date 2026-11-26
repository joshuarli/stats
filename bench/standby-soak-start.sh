#!/bin/sh
set -eu
[ "$#" -eq 3 ] || { echo "usage: sh bench/standby-soak-start.sh NAME DEFINITION HOSTS" >&2; exit 2; }
name=$1
definition=$(realpath "$2")
hosts=$3
repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
dir=$HOME/.local/state/stats-soak/$name
[ ! -e "$dir" ] || { echo "standby-soak-start: $dir already exists" >&2; exit 1; }
umask 077
mkdir -p "$dir"
cp "$definition" "$dir/definition.json"
git -C "$repo" rev-parse HEAD > "$dir/stats-revision"
git -C "$HOME/repos/laputa-systems/stuff" rev-parse HEAD > "$dir/stuff-revision"
config=$HOME/.config/stats/standby/ssh_config
statsctl=/opt/stats-observer/tools/statsctl
interval=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["intervalSeconds"])' "$definition")
every=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["checkEverySamples"])' "$definition")
started=$(python3 -I -c 'import time; print(time.time_ns() // 1_000_000)')
nohup python3 -I "$repo/bench/standby-soak.py" --output "$dir/samples.jsonl" --ssh-config "$config" --statsctl "$statsctl" \
    --hosts "$hosts" --interval "$interval" --check-every "$every" --definition "$dir/definition.json" \
    > "$dir/sampler.log" 2>&1 < /dev/null &
echo $! > "$dir/sampler.pid"
nohup python3 -I "$repo/bench/standby-soak-faults.py" --definition "$dir/definition.json" --output "$dir/faults.jsonl" --started-at-ms "$started" \
    --ssh-config "$config" --rollout "$HOME/repos/laputa-systems/stuff/deploy/openorange/bin/rollout" --statsctl "$statsctl" \
    --hosts "$hosts" > "$dir/faults.log" 2>&1 < /dev/null &
echo $! > "$dir/faults.pid"
echo "soak $name started at $started: $dir"
