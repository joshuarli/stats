#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
out="$repo/.work/bpf/block_latency.bpf.o"
mkdir -p "$(dirname "$out")"

clang=${1:-${LLVM_CLANG:-}}
if [ -z "$clang" ]; then
  clang=$(ls -d "$repo"/.work/llvm-agent-build/*/clang+llvm-*-linux-musl/bin/clang 2>/dev/null | sort | tail -1)
fi
test -n "$clang" && test -x "$clang" || {
  echo "no clang with the BPF backend found" >&2
  echo "pass a clang with the BPF backend as the first argument, or set LLVM_CLANG" >&2
  echo "(the pinned llvm-prebuilt-musl release needs the BPF backend)" >&2
  exit 2
}

"$clang" --target=bpf -ffreestanding -nostdinc -O2 -g \
  -c "$repo/agent/bpf/block_latency.bpf.c" -o "$out"
printf '%s\n' "$out"
