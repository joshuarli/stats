#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
candidate=
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate) candidate=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || { echo '--out is required' >&2; exit 2; }
mkdir -p "$out" "$root/.work/tmp"
out=$(CDPATH= cd -- "$out" && pwd)
work=$(mktemp -d "$root/.work/tmp/runtime-build.XXXXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir "$work/closure" "$work/store"
cp "$root/deploy/orange/package.json" "$root/deploy/orange/pnpm-lock.yaml" "$root/deploy/orange/pnpm-workspace.yaml" "$work/closure/"
if [ -n "$candidate" ]; then
  actual=$(shasum -a 256 "$candidate" | cut -d ' ' -f1)
  [ "$actual" = 2a3932cd31115bf01bfcbd84d2a836fd66889203e7dd7d5d5e86c07cde2c8dfb ] || { echo 'candidate checksum mismatch' >&2; exit 1; }
  cp "$candidate" "$work/candidate.tgz"
fi
image=node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
docker run --rm --platform linux/amd64 -v "$work:/work" -w /work/closure "$image" sh -ec '
  npm install -g pnpm@12.21.0
  if [ -f /work/candidate.tgz ]; then
    node -e '\''const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json")); p.dependencies["open-orange"]="file:/work/candidate.tgz"; fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'\''
    pnpm install --lockfile-only --ignore-scripts --store-dir /work/store
  fi
  pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /work/store
'
python3 "$root/deploy/orange/runtime-artifact/pack.py" "$work/closure" "$out" "${candidate:+2a3932cd31115bf01bfcbd84d2a836fd66889203e7dd7d5d5e86c07cde2c8dfb}"
