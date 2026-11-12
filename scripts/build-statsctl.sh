#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo/cloudflare"

mkdir -p "$repo/dist"

# Bundle with Vite using SSR build
if [ -x node_modules/.bin/vite ]; then
  vite=node_modules/.bin/vite
elif [ -x ../node_modules/.bin/vite ]; then
  vite=../node_modules/.bin/vite
else
  echo "vite not found; run pnpm install" >&2
  exit 1
fi

"$vite" build --config vite.statsctl.config.ts

# Get version from agent or use a default for making executable/checksums
version=$(grep '^version' "$repo/agent/Cargo.toml" | head -1 | sed -n 's/version = "\(.*\)"/\1/p')
if [ -z "$version" ]; then
  version="0.1.0"
fi
out="$repo/dist/statsctl-$version.mjs"

# Make executable
chmod +x "$out"

# Generate SHA256
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$repo/dist" && sha256sum "$(basename "$out")") >> "$repo/dist/SHA256SUMS.statsctl" 2>/dev/null || (cd "$repo/dist" && sha256sum "$(basename "$out")" > SHA256SUMS.statsctl)
elif command -v shasum >/dev/null 2>&1; then
  (cd "$repo/dist" && shasum -a 256 "$(basename "$out")") >> "$repo/dist/SHA256SUMS.statsctl" 2>/dev/null || (cd "$repo/dist" && shasum -a 256 "$(basename "$out")" > SHA256SUMS.statsctl)
fi

echo "Built $out"
