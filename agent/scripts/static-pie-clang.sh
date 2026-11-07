#!/bin/sh
set -eu

static=
cross=
for argument in "$@"; do
  case "$argument" in
    -static) static=1 ;;
    --target=*) cross=1 ;;
  esac
done
test -n "$static" && test -n "$cross" || exec "$TOOLCHAIN/bin/clang" "$@"
for argument in "$@"; do
  shift
  test "$argument" = -no-pie || set -- "$@" "$argument"
done
exec "$TOOLCHAIN/bin/clang" "$@" -static-pie
