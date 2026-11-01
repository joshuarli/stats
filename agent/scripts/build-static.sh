#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
agent="$repo/agent"
tools="$repo/tools"
dist="$agent/dist"
host=$(rustc -vV | sed -n 's/^host: //p')
readobj="$(rustc --print sysroot)/lib/rustlib/$host/bin/llvm-readobj"

test -x "$readobj" || {
  echo "llvm-readobj is missing from the pinned toolchain" >&2
  exit 1
}
command -v zig >/dev/null || {
  echo "zig is required for static musl builds" >&2
  exit 1
}

version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$agent/Cargo.toml" | head -n 1)
test -n "$version"
mkdir -p "$dist"
rm -f "$dist"/*

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

cd "$agent"
for target in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  suffix=$(printf '%s' "$target" | tr '-' '_')
  case "$target" in
    x86_64-unknown-linux-musl) cc="$tools/zig-cc-x86_64-linux-musl" ;;
    aarch64-unknown-linux-musl) cc="$tools/zig-cc-aarch64-linux-musl" ;;
  esac
  ar="$tools/zig-ar"
  env \
    "CC_$suffix=$cc" \
    "AR_$suffix=$ar" \
    "CARGO_TARGET_$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')_LINKER=$cc" \
    cargo build --release --target "$target"

  binary="$agent/target/$target/release/stats"
  destination="$dist/stats-$version-$target"
  cp "$binary" "$destination"
  "$readobj" --elf-output-style=GNU --program-headers --dynamic-table "$destination" > "$destination.elf.txt"
  if grep -Eq 'INTERP|NEEDED' "$destination.elf.txt"; then
    echo "$target has a dynamic interpreter or dependency" >&2
    exit 1
  fi
  printf '%s  %s\n' "$(hash_file "$destination")" "$(basename "$destination")" >> "$dist/SHA256SUMS"
done

cat "$dist/SHA256SUMS"
