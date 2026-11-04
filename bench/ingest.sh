#!/bin/sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
baseline=${BASELINE_WORKTREE:-}

echo "commit $(git -C "$repo" rev-parse --short HEAD); $(uname -s) $(uname -r) $(uname -m); $(node --version); $(rustc --version)"
echo
echo "== Bytes"
node "$repo/bench/ingest-bytes.mjs"
echo
echo "== Rust encoder (release, interleaved rounds)"
(cd "$repo/agent" && cargo run --quiet --release --example ingest_bench)
echo
echo "== TypeScript decode + validate + normalize + canonicalize (node)"
node "$repo/bench/ingest-decode.ts"
echo
echo "== End to end through the Worker and Durable Object (local workerd)"
(cd "$repo/cloudflare" && pnpm -s exec vitest run --config vitest.bench.mjs --silent=false 2>&1 | grep 'workerd ingest')
if [ -n "$baseline" ]; then
  test -f "$baseline/cloudflare/bench/ingest-v1.workerd.ts" || cp "$repo/bench/legacy-v1/ingest-v1.workerd.ts" "$baseline/cloudflare/bench/ingest-v1.workerd.ts"
  test -f "$baseline/cloudflare/vitest.bench.mjs" || cp "$repo/cloudflare/vitest.bench.mjs" "$baseline/cloudflare/vitest.bench.mjs"
  (cd "$baseline/cloudflare" && pnpm -s exec vitest run --config vitest.bench.mjs --silent=false 2>&1 | grep 'workerd ingest')
fi
