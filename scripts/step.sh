#!/bin/sh
set -u

show=
if [ "${1:-}" = "-s" ]; then
  show=$2
  shift 2
fi
if [ "$#" -lt 2 ]; then
  echo "usage: scripts/step.sh [-s REGEX] <label> <command> [args...]" >&2
  exit 2
fi
label=$1
shift

repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
logs=${STEP_LOG_DIR:-$repo/.work/tmp/steps}
mkdir -p "$logs"
log="$logs/$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '-').log"

if [ -t 1 ]; then
  printf '  \033[2m…\033[0m %s' "$label"
fi
started=$(date +%s)
status=0
"$@" > "$log" 2>&1 || status=$?
elapsed=$(( $(date +%s) - started ))
if [ -t 1 ]; then
  printf '\r\033[K'
fi

if [ "$status" -ne 0 ]; then
  printf '  \033[31m✗\033[0m %s (%ss, exit %s)\n' "$label" "$elapsed" "$status"
  tail -n 40 "$log" | sed 's/^/      /'
  printf '      full log: %s\n' "${log#"$repo"/}"
  exit "$status"
fi

printf '  \033[32m✓\033[0m %s (%ss)\n' "$label" "$elapsed"
if [ -n "$show" ]; then
  rg -N -e "$show" "$log" | sed 's/^[│ ]*/      /' || true
fi
