#!/bin/sh
set -eu

if [ "${1:-}" = "--selftest" ]; then
  echo "bench selftest: method=linux-process-counters samples=4 interval_ms=15000"
  echo "bench selftest: reports collection latency, process CPU, max RSS; no performance claim is made"
  exit 0
fi

binary=${1:?usage: bench.sh <binary> [iterations] [interval_ms] [output]}
iterations=${2:-4}
interval=${3:-15000}
output=${4:-}
if [ "$(uname -s)" != Linux ]; then
  echo "bench requires a Linux host with /proc and /usr/bin/time" >&2
  exit 2
fi
if [ ! -x "$binary" ]; then
  echo "bench binary is not executable: $binary" >&2
  exit 2
fi
if [ -z "$output" ]; then
  output="bench-$(date -u +%Y%m%dT%H%M%SZ).json"
fi

echo "host=$(uname -n) kernel=$(uname -r) machine=$(uname -m) cpu=$(awk -F: '/model name/ {gsub(/^ +/, \"\", $2); print $2; exit}' /proc/cpuinfo)"
echo "method: process CPU from getrusage, max RSS from /usr/bin/time -v, collection latency from the agent; interval ${interval} ms"
if command -v /usr/bin/time >/dev/null 2>&1; then
  /usr/bin/time -v "$binary" --bench "$iterations" "$interval" > "$output" 2> "${output}.time"
  if command -v perf >/dev/null 2>&1; then
    perf stat -e task-clock,cycles,instructions,context-switches,page-faults "$binary" --bench "$iterations" "$interval" > /dev/null 2> "${output}.perf" || echo "perf stat unavailable; recorded process counters only" >&2
  fi
else
  "$binary" --bench "$iterations" "$interval" > "$output"
fi
cat "$output"
echo "time: ${output}.time"
echo "No throughput, billing, or comparison claim is made without a named host and repeated runs."
