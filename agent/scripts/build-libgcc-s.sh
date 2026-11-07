#!/bin/sh
set -eu

toolchain=$1
arch=$2
output=$3

mkdir -p "$output"
"$toolchain/bin/clang" --target="$arch-linux-musl" -shared -nostdlib -fuse-ld=lld \
  -Wl,-soname,libgcc_s.so.1 \
  -Wl,--whole-archive "$toolchain/lib/libunwind.a" -Wl,--no-whole-archive \
  -L/usr/lib -o "$output/libgcc_s.so.1"
ln -sf libgcc_s.so.1 "$output/libgcc_s.so"
