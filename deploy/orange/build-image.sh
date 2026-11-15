#!/bin/sh
set -eu
host=${1:?usage: deploy/orange/build-image.sh HOST}
root=$(git rev-parse --show-toplevel)
cd "$root"
test -z "$(git status --porcelain --untracked-files=no)" || { echo "deploy/orange: commit tracked changes first, so the image tag names its contents" >&2; exit 1; }
release=$(git rev-parse --short=12 HEAD)
context="$root/.work/tmp/orange-image-$release"
rm -rf "$context"
mkdir -p "$context/orange"
(cd cloudflare && pnpm -s build && pnpm -s run build:observe) >&2
node --experimental-strip-types deploy/orange/generate.mts --out "$context/app" --release "stats-$release" >&2
cp deploy/orange/package.json deploy/orange/pnpm-lock.yaml deploy/orange/pnpm-workspace.yaml deploy/orange/Dockerfile "$context/orange/"
mv "$context/orange/Dockerfile" "$context/Dockerfile"
remote=".cache/stats-orange/$release"
ssh "$host" "mkdir -p $remote"
rsync -a --delete "$context/" "$host:$remote/"
ssh "$host" "docker build --platform linux/amd64 -t stats:$release $remote >&2 && docker image inspect stats:$release --format '{{.Os}}/{{.Architecture}}' >&2"
ssh "$host" "docker run --rm --network none --entrypoint node stats:$release -e 'const fs = require(\"node:fs\"); const path = require(\"node:path\"); for (const name of [\"stats\", \"observe\"]) { const config = JSON.parse(fs.readFileSync(\"/app/\" + name + \".jsonc\", \"utf8\")); fs.accessSync(path.resolve(\"/app\", config.main), fs.constants.R_OK); } fs.accessSync(\"/app/stats/assets/index.html\", fs.constants.R_OK)' >&2"
echo "stats:$release"
