#!/bin/sh
set -eu

host=${1:?usage: deploy/node/deploy.sh USER@HOST}
logins=${STATS_ALLOWED_LOGINS:?set STATS_ALLOWED_LOGINS to the tailnet logins allowed to read the dashboard}
case $logins in
  *[!A-Za-z0-9._%+@,-]* | , | ,* | *, | *,,*) echo "deploy/node: STATS_ALLOWED_LOGINS must be comma-separated logins of letters, digits and . _ % + @ -" >&2; exit 1 ;;
esac
root=$(git rev-parse --show-toplevel)
cd "$root"
test -z "$(git status --porcelain --untracked-files=no)" || { echo "deploy/node: commit tracked changes first, so the image tag names its contents" >&2; exit 1; }
commit=$(git rev-parse --short=12 HEAD)
stage="$root/.work/tmp/node-image/$commit"

pnpm --dir cloudflare build
rm -rf "$stage"
mkdir -p "$stage/cloudflare/.cloudflare/output/v0/workers/default" "$stage/deploy/node"
cp deploy/node/Dockerfile "$stage/deploy/node/"
cp cloudflare/package.json "$stage/cloudflare/"
git archive HEAD cloudflare/src | tar -x -C "$stage"
cp -R cloudflare/.cloudflare/output/v0/workers/default/assets "$stage/cloudflare/.cloudflare/output/v0/workers/default/"

free_kb=$(ssh "$host" "df -Pk /home | awk 'NR==2 {print \$4}'")
test "$free_kb" -ge 52428800 || { echo "deploy/node: $host has under 50 GB free" >&2; exit 1; }

ssh "$host" "rm -rf ~/stats-node-build/$commit && mkdir -p ~/stats-node-build/$commit ~/.local/share/stats-node ~/.local/share/stats-node-run && chmod 700 ~/.local/share/stats-node-run"
tar -C "$stage" -c . | ssh "$host" "tar -x -C ~/stats-node-build/$commit"
ssh "$host" "docker build -q -t stats-node:$commit -f ~/stats-node-build/$commit/deploy/node/Dockerfile ~/stats-node-build/$commit"
ssh "$host" "if docker container inspect stats-node >/dev/null 2>&1; then docker stop -t 20 stats-node >/dev/null && docker rm stats-node >/dev/null; fi"
ssh "$host" "docker run -d --name stats-node --restart unless-stopped --network none -v \$HOME/.local/share/stats-node:/data -v \$HOME/.local/share/stats-node-run:/run/stats -e STATS_ALLOWED_LOGINS='$logins' stats-node:$commit"
ssh "$host" "for n in 1 2 3 4 5 6 7 8 9 10; do docker exec stats-node node -e \"require('node:http').get({socketPath:'/run/stats/stats.sock',path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\" >/dev/null 2>&1 && exit 0; sleep 1; done; docker logs --tail 20 stats-node; exit 1"
echo "deploy/node: stats-node:$commit is serving on $host unix:\$HOME/.local/share/stats-node-run/stats.sock"
