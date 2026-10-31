#!/bin/sh
set -eu

output=${1:?usage: collector.sh <snapshot-path> [bpftrace-script]}
script=${2:-"$(dirname "$0")/biolatency-collector.bt"}
directory=$(dirname "$output")
temporary="${output}.tmp.$$"

mkdir -p "$directory"
chmod 0755 "$directory"
trap 'rm -f "$temporary"' EXIT INT TERM

bpftrace "$script" 2> "${output}.log" | while IFS= read -r line; do
  case "$line" in
    \{*\})
      printf '%s\n' "$line" > "$temporary"
      chmod 0644 "$temporary"
      mv "$temporary" "$output"
      ;;
  esac
done
