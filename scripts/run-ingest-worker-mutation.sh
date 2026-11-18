#!/usr/bin/env bash
set -euo pipefail

root=$PWD
archive=$(mktemp -d "$root/.work/tmp/ingest-mutation-archive.XXXXXX")
trap 'rm -rf "$archive"' EXIT
git archive HEAD | tar -x -C "$archive"
cd "$archive"
mkdir -p .work/tmp

export TMPDIR="$PWD/.work/tmp"
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
