#!/bin/sh
set -eu

config=${1:?usage: supervise.sh <config> [binary]}
binary=${2:-stats}
delay=5
child=
sleeper=

stop() {
  if [ -n "$sleeper" ]; then
    kill -TERM "$sleeper" 2>/dev/null || true
    wait "$sleeper" 2>/dev/null || true
    sleeper=
  fi
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

while :; do
  started=$(date +%s)
  "$binary" --config "$config" &
  child=$!
  status=0
  wait "$child" || status=$?
  child=
  elapsed=$(( $(date +%s) - started ))
  if [ "$elapsed" -gt 60 ]; then
    delay=5
  fi
  echo "stats exited with $status after ${elapsed}s; restarting in ${delay}s" >&2
  sleep "$delay" &
  sleeper=$!
  wait "$sleeper" 2>/dev/null || true
  sleeper=
  delay=$((delay * 2))
  [ "$delay" -le 60 ] || delay=60
done
