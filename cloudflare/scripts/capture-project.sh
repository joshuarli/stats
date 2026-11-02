#!/bin/sh
set -eu

id=${1:-}
if [ -z "$id" ]; then
  echo "usage: scripts/capture-project.sh <project id> [range...]" >&2
  exit 2
fi
shift
ranges=${*:-1h}
here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
base=${STATS_URL:-https://stats.17166969.xyz}
out="$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)/test/ui/captures/$id"
token=$(cf access token "$base")

get() {
  curl -fsS -H "cf-access-token: $token" "$base$1"
}

projects=$(get /api/v1/projects)
printf '%s' "$projects" | jaq -er --arg id "$id" '.[] | select(.id == $id) | .id' > /dev/null
rm -rf "$out"
mkdir -p "$out"
printf '%s' "$projects" | jaq -c . > "$out/projects.json"
for range in $ranges; do
  for kind in worker r2 probes collector; do
    get "/api/v1/projects/$id/history?range=$range&kind=$kind" | node "$here/history-json.mjs" | jaq -c . > "$out/$kind-$range.json"
  done
done
jaq -n --arg id "$id" --argjson capturedAtMs "$(($(date +%s) * 1000))" '{projectId: $id, capturedAtMs: $capturedAtMs}' > "$out/capture.json"
echo "captured $id into $out"
