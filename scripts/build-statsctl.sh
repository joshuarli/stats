#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo/cloudflare"

# Get version from agent or use a default
version=$(grep '^version' "$repo/agent/Cargo.toml" | head -1 | sed -n 's/version = "\(.*\)"/\1/p')
if [ -z "$version" ]; then
  version="0.1.0"
fi

mkdir -p "$repo/dist"
out="$repo/dist/statsctl-$version.mjs"

# Bundle with esbuild using Node APIs at runtime
if [ -f node_modules/.bin/esbuild ]; then
  node_modules/.bin/esbuild src/cli/statsctl.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node20 \
    --outfile="$out" \
    --banner:js="#!/usr/bin/env node
import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
else
  # Fallback: use node to run bundler if available differently
  echo "esbuild not found, trying to bundle manually" >&2
  exit 1
fi

# Make executable
chmod +x "$out"

# Generate SHA256
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$repo/dist" && sha256sum "$(basename "$out")") >> "$repo/dist/SHA256SUMS.statsctl" 2>/dev/null || (cd "$repo/dist" && sha256sum "$(basename "$out")" > SHA256SUMS.statsctl)
elif command -v shasum >/dev/null 2>&1; then
  (cd "$repo/dist" && shasum -a 256 "$(basename "$out")") >> "$repo/dist/SHA256SUMS.statsctl" 2>/dev/null || (cd "$repo/dist" && shasum -a 256 "$(basename "$out")" > SHA256SUMS.statsctl)
fi

echo "Built $out"
