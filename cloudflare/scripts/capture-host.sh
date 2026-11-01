#!/bin/sh
set -eu

name=${1:-}
if [ -z "$name" ]; then
  echo "usage: scripts/capture-host.sh <host name>" >&2
  exit 2
fi
base=${STATS_URL:-https://stats.17166969.xyz}
out="$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)/test/ui/captures/$name"
token=$(cf access token "$base")

get() {
  curl -fsS -H "cf-access-token: $token" "$base$1"
}

hosts=$(get /api/v1/hosts)
host_id=$(printf '%s' "$hosts" | jaq -er --arg name "$name" '.hosts[] | select(.name == $name) | .hostId')
rm -rf "$out"
mkdir -p "$out"
printf '%s' "$hosts" | jaq -c . > "$out/hosts.json"
get "/api/v1/hosts/$host_id/latest" | jaq -c . > "$out/latest.json"
for range in 1h 6h 24h 7d 90d; do
  for kind in summary disks nets filesystems block; do
    get "/api/v1/hosts/$host_id/history?range=$range&kind=$kind" | jaq -c . > "$out/$kind-$range.json"
  done
done
jaq -n --arg hostId "$host_id" --argjson capturedAtMs "$(($(date +%s) * 1000))" '{hostId: $hostId, capturedAtMs: $capturedAtMs}' > "$out/capture.json"
echo "captured $name ($host_id) into $out"
