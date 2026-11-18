#!/bin/sh
set -eu
context=${1:?usage: deploy/orange/build-context.sh OUTPUT RELEASE}
release=${2:?usage: deploy/orange/build-context.sh OUTPUT RELEASE}
mkdir -p "$context/orange"
(cd cloudflare && pnpm -s build && pnpm -s run build:observe) >&2
node --experimental-strip-types deploy/orange/generate.mts --out "$context/app" --release "stats-$release" >&2
cp deploy/orange/package.json deploy/orange/pnpm-lock.yaml deploy/orange/pnpm-workspace.yaml "$context/orange/"
