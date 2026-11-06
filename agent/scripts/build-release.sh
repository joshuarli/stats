#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
agent="$repo/agent"
dist="$agent/dist"
version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$agent/Cargo.toml" | head -n 1)
test -n "$version"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$dist"
os_name=$(uname -s)
arch_name=$(uname -m)

case "$os_name" in
  Linux)
    "$repo/agent/scripts/build-static.sh"
    ;;
  Darwin)
    if [ "$arch_name" = "arm64" ]; then
      cd "$agent"
      cargo build --release --locked
      cp "$agent/target/release/stats" "$dist/stats-$version-aarch64-apple-darwin"
      (cd "$dist" && printf '%s  %s\n' "$(hash_file "stats-$version-aarch64-apple-darwin")" "stats-$version-aarch64-apple-darwin" >> SHA256SUMS)
    else
      echo "macOS build supported on arm64 only" >&2
      exit 1
    fi
    ;;
  *)
    echo "unsupported OS: $os_name" >&2
    exit 1
    ;;
esac
