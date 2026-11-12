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
(cd cloudflare && node scripts/bundle-node.mjs)
rm -rf "$stage"
mkdir -p "$stage/cloudflare/.cloudflare/output/v0/workers/default" "$stage/deploy/node"
cp deploy/node/Dockerfile "$stage/deploy/node/"
cp .work/tmp/node-bundle/main.mjs "$stage/cloudflare/"
cp -R cloudflare/.cloudflare/output/v0/workers/default/assets "$stage/cloudflare/.cloudflare/output/v0/workers/default/"

free_kb=$(ssh "$host" "df -Pk /home | awk 'NR==2 {print \$4}'")
test "$free_kb" -ge 52428800 || { echo "deploy/node: $host has under 50 GB free" >&2; exit 1; }

ssh "$host" "rm -rf ~/stats-node-build/$commit && mkdir -p ~/stats-node-build/$commit ~/.local/share/stats-node ~/.local/share/stats-node-run && chmod 700 ~/.local/share/stats-node-run"
tar -C "$stage" -c . | ssh "$host" "tar -x -C ~/stats-node-build/$commit"
ssh "$host" "docker build -q -t stats-node:$commit -f ~/stats-node-build/$commit/deploy/node/Dockerfile ~/stats-node-build/$commit"
ssh "$host" sh -s -- "$commit" "$logins" <<'REMOTE'
set -eu
commit=$1
logins=$2
health() {
  for n in 1 2 3 4 5 6 7 8 9 10; do
    docker exec "$1" node -e "require('node:http').get({socketPath:'/run/stats/stats.sock',path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs --tail 20 "$1"
  return 1
}
trap 'docker rm -f stats-node-candidate >/dev/null 2>&1 || true' 0
docker run -d --name stats-node-candidate --network none --tmpfs /data:uid=1000,gid=1000 --tmpfs /run/stats:uid=1000,gid=1000 -e STATS_ALLOWED_LOGINS="$logins" "stats-node:$commit"
health stats-node-candidate
if docker container inspect stats-node >/dev/null 2>&1; then
  if docker container inspect stats-node-previous >/dev/null 2>&1; then
    echo "deploy/node: recover or remove stats-node-previous before deployment" >&2
    exit 1
  fi
  docker stop -t 20 stats-node >/dev/null
  if ! docker rename stats-node stats-node-previous; then
    docker start stats-node >/dev/null
    exit 1
  fi
fi
if docker run -d --name stats-node --restart unless-stopped --network none --cgroup-parent=/stats.slice/stats-node.slice -v "$HOME/.local/share/stats-node:/data" -v "$HOME/.local/share/stats-node-run:/run/stats" -e STATS_ALLOWED_LOGINS="$logins" "stats-node:$commit" && health stats-node; then
  docker rm stats-node-previous >/dev/null 2>&1 || true
else
  docker rm -f stats-node >/dev/null 2>&1 || true
  if docker container inspect stats-node-previous >/dev/null 2>&1; then
    docker rename stats-node-previous stats-node
    docker start stats-node >/dev/null
    health stats-node
  fi
  exit 1
fi
REMOTE
deployed_at=$(date -u +%Y%m%dT%H%M%SZ)
echo "deploy/node: stats-node:$commit is serving on $host unix:\$HOME/.local/share/stats-node-run/stats.sock"

credential=.work/credentials/stats-node-deploy.json
if test -f "$credential"; then
  pnpm --dir cloudflare -s statsctl deploy mark --service stats-node --version "$commit" --marker-id "d-$commit-$deployed_at" --message "make node-deploy" --token-file "$credential" --origin "${STATS_NODE_ORIGIN:-http://threadripper.tailcf741.ts.net:18790}"
else
  echo "deploy/node: no $credential, so this deploy is not marked; create the stats-node service as described in docs/operations.md (Services and deploy markers)"
fi
