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
  for kind in worker routes r2 probes collector; do
    node "$here/api.mjs" "/projects/$id/history?range=$range&kind=$kind" | jaq -c . > "$out/$kind-$range.json"
  done
done
if [ "$id" = stats ]; then
  for kind in durable-objects; do
    node "$here/api.mjs" "/projects/$id/history?range=1h&kind=$kind" | jaq -c . > "$out/$kind-1h.json"
  done
  node "$here/api.mjs" "/projects/$id/deployments" | jaq -c . > "$out/deployments.json"
  node "$here/api.mjs" /api/observe/stats/health | jaq -c . > "$out/observe-health.json"
  node "$here/api.mjs" "/api/observe/stats/traces?limit=100" | jaq -c . > "$out/observe-traces.json"
  for trace in $(jaq -r '.items[].traceId // empty' "$out/observe-traces.json"); do
    node "$here/api.mjs" "/api/observe/stats/traces/$trace" | jaq -c . > "$out/observe-trace-$trace.json"
  done
  open=$(node "$here/api.mjs" "/api/observe/stats/issues?state=open&limit=100")
  resolved=$(node "$here/api.mjs" "/api/observe/stats/issues?state=resolved&limit=100")
  jaq -nc --argjson open "$open" --argjson resolved "$resolved" '{items: ($open.items + $resolved.items), next: null}' > "$out/observe-issues.json"
  for issue in $(jaq -r '.items[].fingerprint' "$out/observe-issues.json"); do
    node "$here/api.mjs" "/api/observe/stats/issues/$issue/occurrences?limit=100" | jaq -c . > "$out/observe-occurrences-$issue.json"
  done
fi
jaq -n --arg id "$id" --argjson capturedAtMs "$(($(date +%s) * 1000))" '{projectId: $id, capturedAtMs: $capturedAtMs}' > "$out/capture.json"
echo "captured $id into $out"
