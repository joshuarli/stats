#!/bin/sh
# Starts a standby soak on Threadripper's host: the sampler and the fault runner, detached.
#   sh bench/standby-soak-start.sh NAME DEFINITION
# Run on the host from a Stats checkout. Writes ~/.local/state/stats-soak/NAME/{samples,faults}.jsonl
# and the two processes' logs; the fault runner's offsets count from the sampler's start.
# Uses ~/.config/stats/standby/ssh_config, ~/.config/stats/soak-check.json (a host credential used
# only by the soak), Stuff's rollout from ~/repos/laputa-systems/stuff and the observer's statsctl.
set -eu
[ "$#" -eq 2 ] || { echo "usage: sh bench/standby-soak-start.sh NAME DEFINITION" >&2; exit 2; }
name=$1 definition=$(realpath "$2")
repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
dir=$HOME/.local/state/stats-soak/$name
[ ! -e "$dir" ] || { echo "standby-soak-start: $dir already exists" >&2; exit 1; }
umask 077
mkdir -p "$dir"
cp "$definition" "$dir/definition.json"
git -C "$repo" rev-parse HEAD > "$dir/stats-revision"
git -C "$HOME/repos/laputa-systems/stuff" rev-parse HEAD > "$dir/stuff-revision"
config=$HOME/.config/stats/standby/ssh_config
credential=$HOME/.config/stats/soak-check.json
statsctl=/opt/stats-observer/tools/statsctl
interval=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["intervalSeconds"])' "$definition")
every=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["checkEverySamples"])' "$definition")
started=$(python3 -I -c 'import time; print(time.time_ns() // 1_000_000)')
nohup python3 -I "$repo/bench/standby-soak.py" --output "$dir/samples.jsonl" --ssh-config "$config" --statsctl "$statsctl" \
    --credential-file "$credential" --interval "$interval" --check-every "$every" --definition "$dir/definition.json" \
    > "$dir/sampler.log" 2>&1 < /dev/null &
echo $! > "$dir/sampler.pid"
nohup python3 -I "$repo/bench/standby-soak-faults.py" --definition "$dir/definition.json" --output "$dir/faults.jsonl" --started-at-ms "$started" \
    --ssh-config "$config" --rollout "$HOME/repos/laputa-systems/stuff/deploy/openorange/bin/rollout" --statsctl "$statsctl" \
    --credential-file "$credential" --node "$HOME/.local/bin/node" --repo "$repo" > "$dir/faults.log" 2>&1 < /dev/null &
echo $! > "$dir/faults.pid"
echo "soak $name started at $started: $dir"
