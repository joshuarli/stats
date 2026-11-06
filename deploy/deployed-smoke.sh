#!/bin/sh
set -eu

base=${STATS_URL:-https://stats.17166969.xyz}
work=$(mktemp -d "${TMPDIR:-/tmp}/stats-smoke.XXXXXX")
trap 'rm -rf "$work"' 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

curl -fsS -D "$work/headers" -o "$work/health" "$base/health" || fail "health request failed"
jaq -e '.ok == true and .service == "stats"' "$work/health" >/dev/null || fail "health response is not this service"

for header in \
  "content-security-policy:.*frame-ancestors 'none'" \
  "x-frame-options: DENY" \
  "x-content-type-options: nosniff" \
  "cache-control: no-store"
do
  rg -qi "^$header" "$work/headers" || fail "missing or wrong header: $header"
done

repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
frame="$repo/fixtures/v2/frames/minimal.stb2"
[ -f "$frame" ] || fail "missing $frame"
fake="nft_smokeSMOKEsmokeSMOKEsmokeSMOKEsmokeSMOKE000"
ingest="$base/ingest/v2/batches"
media="application/vnd.stats.ingest.v2"

expect() {
  want=$1
  code=$2
  label=$3
  shift 3
  got=$(curl -sS -o "$work/body" -w '%{http_code}' "$@") || fail "$label: request failed"
  [ "$got" = "$want" ] || fail "$label returned $got, expected $want"
  if [ -n "$code" ]; then
    jaq -e --arg code "$code" '.error.code == $code' "$work/body" >/dev/null || fail "$label: error code is not $code"
  fi
}

expect 405 invalid_request "GET /ingest/v2/batches" "$ingest"
expect 410 gone "POST /ingest/v1/batches" -X POST -H 'Content-Type: application/json' --data '{}' "$base/ingest/v1/batches"
expect 401 unauthorized "unauthenticated STB2 POST" -X POST -H "Content-Type: $media" --data-binary "@$frame" "$ingest"
expect 415 invalid_request "JSON POST to the v2 route" -X POST -H "Authorization: Bearer $fake" -H 'Content-Type: application/json' --data '{}' "$ingest"
printf 'STB2\001' > "$work/old-version"
expect 400 unknown_version "STB2 frame with version 1" -X POST -H "Authorization: Bearer $fake" -H "Content-Type: $media" --data-binary "@$work/old-version" "$ingest"
expect 401 unauthorized "valid STB2 frame with an unknown token" -X POST -H "Authorization: Bearer $fake" -H "Content-Type: $media" --data-binary "@$frame" "$ingest"

api_status=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/v1/hosts")
case "$api_status" in
  302|303|401|403) ;;
  *) fail "GET /api/v1/hosts returned $api_status without Access credentials" ;;
esac

echo "OK: $base answers with security headers, protected routes, and the binary ingest v2 route (v1 is gone)"
