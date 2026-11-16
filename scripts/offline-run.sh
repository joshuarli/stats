#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/offline-run.sh <command> [args...]  (runs the command with no Cloudflare credentials and no non-loopback network)" >&2
  exit 2
fi

for name in $(env | sed -n 's/^\(CLOUDFLARE_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(CF_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

profile='(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))'

case "$(uname -s)" in
  Darwin) exec sandbox-exec -p "$profile" "$@" ;;
  Linux)
    command -v unshare >/dev/null 2>&1 && command -v ip >/dev/null 2>&1 || {
      echo "offline-run: Linux requires unshare (util-linux), ip (iproute2), and enabled user/network namespaces" >&2
      exit 2
    }
    exec unshare --user --map-root-user --net sh -c 'set -e; ip link set lo up; exec "$@"' offline-run "$@"
    ;;
  *)
    echo "offline-run: no verified network sandbox on $(uname -s)" >&2
    exit 2
    ;;
esac
