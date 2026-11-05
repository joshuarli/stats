#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/offline-run.sh <command> [args...]  (runs the command with no Cloudflare credentials and no non-loopback network)" >&2
  exit 2
fi

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "offline-run: no verified network sandbox on $(uname -s); only macOS sandbox-exec is supported" >&2
    exit 2
    ;;
esac

for name in $(env | sed -n 's/^\(CLOUDFLARE_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(CF_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

profile='(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))'

exec sandbox-exec -p "$profile" "$@"
