#!/bin/sh
set -eu

config=${1:?usage: supervise.sh <config> [binary]}
binary=${2:-niceforge-telemetry}
delay=5
child=

stop() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

while :; do
  "$binary" --config "$config" &
  child=$!
  status=0
  wait "$child" || status=$?
  child=
  echo "niceforge-telemetry exited with $status; restarting in ${delay}s" >&2
  sleep "$delay"
  delay=$((delay * 2))
  [ "$delay" -le 60 ] || delay=60
done
