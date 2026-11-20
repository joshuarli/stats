#!/bin/sh
# Installs the infrastructure metrics collector on the native Stats standby (see docs/openorange.md).
#   deploy/orange/collector/install.sh
# Idempotent. Creates the stats-infra credential on the guest when absent and writes only its
# SHA-256 verifier and RIVETKIT_METRICS_PORT into /etc/conf.d/native-stats. Those take effect on
# the next native-stats restart, which also (re)starts the collector.
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../../.." && pwd)
config=${STANDBY_SSH_CONFIG:-$HOME/.config/stats/standby/ssh_config}
metrics_port=9100
guest() { ssh -F "$config" stats-standby "$@"; }
fail() { echo "collector-install: $*" >&2; exit 1; }

[ -r "$config" ] || fail "missing SSH config $config"
work=$(mktemp -d "$root/.work/tmp/collector.XXXXXX")
trap 'rm -rf "$work"' EXIT
node "$root/cloudflare/scripts/build-infra-collector.mjs" --out "$work/bundle" >/dev/null || fail "collector build failed"

cat >"$work/collector.json" <<EOF
{"name":"standby","releaseFile":"/run/stats-infra/release.json","tokenFile":"/etc/stats-infra/token",
 "endpoint":"http://127.0.0.1:8080/ingest/metrics/v1/batches",
 "targets":[{"id":"engine:live","url":"http://127.0.0.1:6430/metrics"},
  {"id":"worker:stats:0","url":"http://127.0.0.1:$metrics_port/metrics"},
  {"id":"worker:stats-observe:1","url":"http://127.0.0.1:$((metrics_port + 1))/metrics"}]}
EOF
cp "$root/deploy/orange/collector/stats-infra-collector.openrc" "$work/"
tar -C "$work" -czf "$work/install.tgz" bundle/main.mjs bundle/manifest.json collector.json stats-infra-collector.openrc

guest "set -eu; stage=\$(mktemp -d); trap 'rm -rf \$stage' EXIT; tar -C \$stage -xzf -
    getent group stats-infra >/dev/null || addgroup -S stats-infra
    id stats-infra >/dev/null 2>&1 || adduser -S -D -H -h /var/empty -s /sbin/nologin -G stats-infra stats-infra
    install -d -o root -g root -m 0755 /opt/stats-infra-collector
    install -o root -g root -m 0644 \$stage/bundle/main.mjs \$stage/bundle/manifest.json /opt/stats-infra-collector/
    install -d -o root -g stats-infra -m 0750 /etc/stats-infra
    install -o root -g stats-infra -m 0640 \$stage/collector.json /etc/stats-infra/collector.json
    if [ ! -s /etc/stats-infra/token ]; then
        umask 077
        printf 'nft_%s' \"\$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')\" >/etc/stats-infra/token.next
        chown root:stats-infra /etc/stats-infra/token.next; chmod 0440 /etc/stats-infra/token.next
        mv /etc/stats-infra/token.next /etc/stats-infra/token
    fi
    grep -qx 'nft_[A-Za-z0-9_-]\{43\}' /etc/stats-infra/token
    verifier=\$(tr -d '\n' </etc/stats-infra/token | sha256sum | cut -d' ' -f1)
    conf=/etc/conf.d/native-stats
    [ -e \$conf.pre-infra-metrics ] || cp -p \$conf \$conf.pre-infra-metrics
    sed -i -e '/^export INFRA_METRICS_TOKEN_SHA256=/d' -e '/^export RIVETKIT_METRICS_PORT=/d' \$conf
    printf 'export INFRA_METRICS_TOKEN_SHA256=%s\nexport RIVETKIT_METRICS_PORT=%s\n' \$verifier $metrics_port >>\$conf
    grep -q '^ORANGE_WORKER_SECRETS=.*INFRA_METRICS_TOKEN_SHA256' \$conf ||
        sed -i 's/^ORANGE_WORKER_SECRETS=\(.*\)$/ORANGE_WORKER_SECRETS=\1,INFRA_METRICS_TOKEN_SHA256/' \$conf
    install -o root -g root -m 0755 \$stage/stats-infra-collector.openrc /etc/init.d/stats-infra-collector
    rc-update add stats-infra-collector default >/dev/null" <"$work/install.tgz"
echo "collector installed; restart native-stats (or run standby-deploy.sh) to activate"
