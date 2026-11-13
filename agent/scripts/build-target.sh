#!/bin/sh
set -eu

target=$1
version=$2

suffix=$(printf '%s' "$target" | tr '-' '_')
upper=$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')
arch=${target%%-*}
clang="$TOOLCHAIN/bin/clang"
readobj="$TOOLCHAIN/bin/llvm-readobj"
dist=/repo/agent/dist
unwind=$CARGO_HOME/unwind

/repo/agent/scripts/build-libgcc-s.sh "$TOOLCHAIN" "$arch" "$unwind"
export LD_LIBRARY_PATH=$unwind
export LIBRARY_PATH=$unwind

/repo/agent/scripts/build-probe.sh "$TOOLCHAIN/bin/clang" >/dev/null

export "CC_$suffix=$clang"
export "AR_$suffix=$TOOLCHAIN/bin/llvm-ar"
export "CFLAGS_$suffix=--target=$arch-linux-musl --sysroot=/"
case "$arch" in
  aarch64) linker=/repo/agent/scripts/static-pie-clang.sh ;;
  *) linker=$clang ;;
esac
export "CARGO_TARGET_${upper}_LINKER=$linker"
export "CARGO_TARGET_${upper}_RUSTFLAGS=-Clink-self-contained=no -Clink-arg=--target=$arch-linux-musl -Clink-arg=--sysroot=/"

cd /repo/agent
cargo build --release --locked --target "$target" --features block-latency
destination="$dist/stats-$version-$target"
cp "$CARGO_TARGET_DIR/$target/release/stats" "$destination"
"$readobj" --elf-output-style=GNU --program-headers --dynamic-table "$destination" > "$destination.elf.txt"
if grep -Eq 'INTERP|NEEDED' "$destination.elf.txt"; then
  echo "$target has a dynamic interpreter or dependency" >&2
  exit 1
fi
printf '%s  %s\n' "$(sha256sum "$destination" | cut -d' ' -f1)" "$(basename "$destination")" >> "$dist/SHA256SUMS"
