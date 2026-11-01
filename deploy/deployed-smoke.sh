#!/bin/sh
set -eu

base=${NICEFORGE_TELEMETRY_URL:-https://stats.17166969.xyz}
work=$(mktemp -d "${TMPDIR:-/tmp}/niceforge-smoke.XXXXXX")
trap 'rm -rf "$work"' 0 1 2 15

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

curl -fsS -D "$work/headers" -o "$work/health" "$base/health" || fail "health request failed"
jaq -e '.ok == true and .service == "niceforge-telemetry"' "$work/health" >/dev/null || fail "health response is not this service"

for header in \
  "content-security-policy:.*frame-ancestors 'none'" \
  "x-frame-options: DENY" \
  "x-content-type-options: nosniff" \
  "cache-control: no-store"
do
  rg -qi "^$header" "$work/headers" || fail "missing or wrong header: $header"
done

ingest_status=$(curl -sS -o "$work/ingest" -w '%{http_code}' "$base/ingest/v1/batches")
[ "$ingest_status" = "405" ] || fail "GET /ingest/v1/batches returned $ingest_status, expected 405"

api_status=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/v1/hosts")
case "$api_status" in
  302|303|401|403) ;;
  *) fail "GET /api/v1/hosts returned $api_status without Access credentials" ;;
esac

echo "OK: $base answers with security headers and protected routes"
