#!/bin/sh
set -eu

base=${STATS_URL:-https://stats.17166969.xyz}
work=$(mktemp -d "${TMPDIR:-/tmp}/stats-smoke.XXXXXX")
reraise() {
  trap - 0 "$1"
  rm -rf "$work"
  kill -s "$1" $$
}
trap 'rm -rf "$work"' 0
trap 'reraise HUP' 1
trap 'reraise INT' 2
trap 'reraise TERM' 15

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
frame="$repo/fixtures/v2/frames/minimal.stb2"
built_index="$repo/cloudflare/.cloudflare/output/v0/workers/default/assets/index.html"
[ -f "$frame" ] || fail "missing $frame"
fake="nft_smokeSMOKEsmokeSMOKEsmokeSMOKEsmokeSMOKE000"
ingest="$base/ingest/v2/batches"
media="application/vnd.stats.ingest.v2"

access_token=
access_header=
credential() {
  if [ -n "$access_token" ]; then return 0; fi
  access_header=${STATSCTL_AUTH_HEADER:-cf-access-token}
  if [ -n "${STATSCTL_AUTH_COMMAND:-}" ]; then
    access_token=$(sh -c "$STATSCTL_AUTH_COMMAND") || return 1
  else
    access_token=$(cf -q access token "$base") || return 1
  fi
  [ -n "$access_token" ] || return 1
}

curl_auth() {
  if [ -n "$access_token" ]; then
    curl -sS -H "$access_header: $access_token" "$@"
  else
    curl -sS "$@"
  fi
}

asset_refs() {
  rg -o '(src|href)="/assets/[^"]+"' "$1" | sed -E 's/.*="([^"]+)"/\1/' | sort -u
}

dashboard_ok() {
  status=$(curl_auth -o "$work/root" -w '%{http_code}' "$base/") || return 1
  if [ "$status" != 200 ]; then
    if [ -n "$access_token" ]; then return 1; fi
    credential || return 1
    status=$(curl_auth -o "$work/root" -w '%{http_code}' "$base/") || return 1
    [ "$status" = 200 ] || return 1
  fi
  refs=$(asset_refs "$work/root") || return 1
  [ -n "$refs" ] || return 1
  for path in $refs; do
    result=$(curl_auth -o /dev/null -w '%{http_code} %{content_type}' "$base$path") || return 1
    asset_status=${result%% *}
    asset_type=${result#* }
    [ "$asset_status" = 200 ] || return 1
    case "$path" in
      *.js) case "$asset_type" in text/javascript*) ;; *) return 1 ;; esac ;;
      *.css) case "$asset_type" in text/css*) ;; *) return 1 ;; esac ;;
      *) [ -n "$asset_type" ] || return 1 ;;
    esac
  done
  return 0
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

# The Worker and its assets propagate separately, so a deploy can report
# success while the entry page references assets that are not live yet.
dashboard_deadline=$(( $(date +%s) + 90 ))
until dashboard_ok; do
  if [ "$(date +%s)" -ge "$dashboard_deadline" ]; then
    fail "the dashboard at $base did not serve the assets its entry page references within 90s"
  fi
  sleep 5
done

if [ -f "$built_index" ]; then
  live_refs=$(asset_refs "$work/root")
  built_refs=$(asset_refs "$built_index")
  [ "$live_refs" = "$built_refs" ] || fail "the dashboard at $base does not reference the built assets; run make worker-bundle and redeploy"
fi

echo "OK: $base answers with security headers, protected routes, the binary ingest v2 route (v1 is gone), and the dashboard entry assets"
