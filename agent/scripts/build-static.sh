#!/bin/sh
set -eu

LLVM_RELEASE=release-b29e4d07a2b9a5e72319b37429cf375149212755
LLVM_VERSION=23.1.5
LLVM_SHA256_x86_64=de3f6d0ad089391482147c61648c511c500b25289132fe7f2c446a0905406d2a
LLVM_SHA256_aarch64=4d8b637d65ed0299c8b7852c1e7e1d41f7141346ce31e707f0975ff67460121e
ALPINE_IMAGE=alpine:3.23@sha256:f3d55900449227ae9e237ede521e7b665d53a253b42065ba90b9db9275e198ad
RUSTUP_VERSION=1.29.3
RUSTUP_SHA256_x86_64=1552169aba2836777136ccff7a381e95c17233b5d8250cd5e10ae3cb971bfcfc
RUSTUP_SHA256_aarch64=956deacdc27ab82ae7ac821d5d3e9e95e4795d476d17efe99743bb8531ca1031

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
agent="$repo/agent"
dist="$agent/dist"
cache="$repo/.work/llvm-agent-build"

command -v docker >/dev/null || {
  echo "docker is required for static musl builds" >&2
  exit 1
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$agent/Cargo.toml" | head -n 1)
test -n "$version"
channel=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$repo/rust-toolchain.toml")
test -n "$channel"
mkdir -p "$dist" "$cache"
: > "$dist/SHA256SUMS"

for target in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  arch=${target%%-*}
  package="clang+llvm-$LLVM_VERSION-$arch-linux-musl"
  archive="$cache/$package.tar.xz"
  case "$arch" in
    x86_64) llvm_sha256=$LLVM_SHA256_x86_64 rustup_sha256=$RUSTUP_SHA256_x86_64 ;;
    aarch64) llvm_sha256=$LLVM_SHA256_aarch64 rustup_sha256=$RUSTUP_SHA256_aarch64 ;;
  esac

  if [ ! -f "$archive" ]; then
    curl --proto '=https' --tlsv1.2 -fsSL -o "$archive.part" \
      "https://github.com/laputa-systems/llvm-prebuilt-musl/releases/download/$LLVM_RELEASE/$package.tar.xz"
    mv "$archive.part" "$archive"
  fi
  test "$(hash_file "$archive")" = "$llvm_sha256" || {
    echo "$archive does not match its pinned sha256" >&2
    exit 1
  }
  if [ ! -x "$cache/$llvm_sha256/$package/bin/clang" ]; then
    rm -rf "$cache/$llvm_sha256"
    mkdir -p "$cache/$llvm_sha256.part"
    tar -xf "$archive" -C "$cache/$llvm_sha256.part"
    mv "$cache/$llvm_sha256.part" "$cache/$llvm_sha256"
  fi

  image="stats-agent-build:$arch"
  docker build --quiet --platform "linux/$arch" \
    --build-arg "ALPINE_IMAGE=$ALPINE_IMAGE" \
    --build-arg "RUSTUP_VERSION=$RUSTUP_VERSION" \
    --build-arg "RUSTUP_SHA256=$rustup_sha256" \
    --build-arg "RUST_CHANNEL=$channel" \
    --build-arg "RUST_TARGET=$target" \
    -t "$image" "$agent/build" >/dev/null

  mkdir -p "$cache/cargo-$arch" "$cache/target-$arch"
  docker run --rm --platform "linux/$arch" \
    --user "$(id -u):$(id -g)" \
    -v "$repo:/repo" \
    -v "$cache/$llvm_sha256/$package:/toolchain:ro" \
    -v "$cache/cargo-$arch:/cache/cargo" \
    -v "$cache/target-$arch:/cache/target" \
    -e TOOLCHAIN=/toolchain \
    -e CARGO_HOME=/cache/cargo \
    -e CARGO_TARGET_DIR=/cache/target \
    -e HOME=/tmp \
    "$image" /repo/agent/scripts/build-target.sh "$target" "$version"
done

cat "$dist/SHA256SUMS"
