#!/usr/bin/env bash
set -euo pipefail

lane=$1
shift
root=$PWD
archive=$(mktemp -d "$root/.work/tmp/ingest-mutation-archive.XXXXXX")
trap 'rm -rf "$archive"' EXIT
git archive HEAD | tar -x -C "$archive"
cd "$archive"
mkdir -p .work/tmp

export TMPDIR="$PWD/.work/tmp"
if [[ $lane == rust ]]; then
  # Pin the isolated agent to its own workspace so Cargo cannot discover the outer checkout.
  if ! rg -q '^\[workspace\]' agent/Cargo.toml; then
    printf '\n[workspace]\n' >> agent/Cargo.toml
  fi
  export CARGO_TARGET_DIR="$root/.work/tmp/ingest-rust-target"
  cargo mutants --manifest-path agent/Cargo.toml --in-place --no-config --file src/wire.rs \
    --re 'in (decode_ack|Reader.*::varint)$' --timeout 20 --build-timeout 180 \
    --output "$root/.work/tmp/ingest-mutation-rust" -- --locked --lib --test conformance
  exit
fi
pnpm install --frozen-lockfile --ignore-scripts
result=0
"$@" run scripts/ingest-mutation.config.mjs || result=$?
if [[ -f .work/tmp/ingest-mutation-worker.json ]]; then
  cp .work/tmp/ingest-mutation-worker.json "$root/.work/tmp/ingest-mutation-worker.json"
fi
if [[ $result -ne 0 ]]; then
  exit "$result"
fi
node scripts/check-ingest-mutations.mjs
