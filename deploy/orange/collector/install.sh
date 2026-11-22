#!/bin/sh
# Provisions the infrastructure metrics collector on the native Stats standby (see docs/openorange.md).
#   deploy/orange/collector/install.sh            provision the standby guest under the rollout lease
#   deploy/orange/collector/install.sh --bundle DIR  write collector.tgz and collector-install.sh
#                                                     to DIR for deploy/orange/recovery/guest
# Idempotent. Installs the service account, collector.json and OpenRC unit, creates the
# stats-infra credential on the guest when absent and writes only its SHA-256 verifier and
# RIVETKIT_METRICS_PORT into /etc/conf.d/native-stats. The collector code ships in each app
# release (deploy/orange/standby-deploy.mts). Configuration takes effect on the next
# native-stats restart, which also restarts the collector.
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../../.." && pwd)
metrics_port=9100
fail() { echo "collector-install: $*" >&2; exit 1; }
bundle=
case "${1:-}" in
    --bundle) bundle=${2:?--bundle needs a directory}; [ -d "$bundle" ] || fail "$bundle is not a directory" ;;
    "") config=${STANDBY_SSH_CONFIG:?STANDBY_SSH_CONFIG is required}
        : "${STATS_ROLLOUT:?STATS_ROLLOUT is required}"
        [ -r "$config" ] || fail "missing SSH config $config" ;;
    *) echo "usage: deploy/orange/collector/install.sh [--bundle DIR]" >&2; exit 2 ;;
esac
work=$(mktemp -d "$root/.work/tmp/collector.XXXXXX")
trap 'rm -rf "$work"' EXIT

cat >"$work/collector.json" <<EOF
{"name":"standby","releaseFile":"/run/stats-infra/release.json","tokenFile":"/etc/stats-infra/token",
 "endpoint":"http://127.0.0.1:8080/ingest/metrics/v1/batches",
 "targets":[{"id":"engine:live","url":"http://127.0.0.1:6430/metrics"},
  {"id":"worker:stats:0","url":"http://127.0.0.1:$metrics_port/metrics"},
  {"id":"worker:stats-observe:1","url":"http://127.0.0.1:$((metrics_port + 1))/metrics"}]}
EOF
cp "$root/deploy/orange/collector/stats-infra-collector.openrc" "$work/"
tar -C "$work" -czf "$work/install.tgz" collector.json stats-infra-collector.openrc

cat >"$work/install-guest.sh" <<'GUEST'
set -eu; stage=$(mktemp -d); trap 'rm -rf $stage' EXIT; tar -C $stage -xzf -
    getent group stats-infra >/dev/null || addgroup -S stats-infra
    id stats-infra >/dev/null 2>&1 || adduser -S -D -H -h /var/empty -s /sbin/nologin -G stats-infra stats-infra
    install -d -o root -g stats-infra -m 0750 /etc/stats-infra
    install -o root -g stats-infra -m 0640 $stage/collector.json /etc/stats-infra/collector.json
    if [ ! -s /etc/stats-infra/token ]; then
        umask 077
        printf 'nft_%s' "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" >/etc/stats-infra/token.next
        chown root:stats-infra /etc/stats-infra/token.next; chmod 0440 /etc/stats-infra/token.next
        mv /etc/stats-infra/token.next /etc/stats-infra/token
    fi
    grep -qx 'nft_[A-Za-z0-9_-]\{43\}' /etc/stats-infra/token
    verifier=$(tr -d '\n' </etc/stats-infra/token | sha256sum | cut -d' ' -f1)
    conf=/etc/conf.d/native-stats
    [ -e $conf.pre-infra-metrics ] || cp -p $conf $conf.pre-infra-metrics
    sed -i -e '/^export INFRA_METRICS_TOKEN_SHA256=/d' -e '/^export RIVETKIT_METRICS_PORT=/d' $conf
    printf 'export INFRA_METRICS_TOKEN_SHA256=%s\nexport RIVETKIT_METRICS_PORT=%s\n' $verifier 9100 >>$conf
    grep -q '^ORANGE_WORKER_SECRETS=.*INFRA_METRICS_TOKEN_SHA256' $conf ||
        sed -i 's/^ORANGE_WORKER_SECRETS=\(.*\)$/ORANGE_WORKER_SECRETS=\1,INFRA_METRICS_TOKEN_SHA256/' $conf
    install -o root -g root -m 0755 $stage/stats-infra-collector.openrc /etc/init.d/stats-infra-collector
    rc-update add stats-infra-collector default >/dev/null
GUEST
if [ -n "$bundle" ]; then
    cp "$work/install.tgz" "$bundle/collector.tgz"
    cp "$work/install-guest.sh" "$bundle/collector-install.sh"
    exit 0
fi
stage=/var/lib/stats-deploy/collector-$(basename "$work")
ssh -F "$config" stats-standby "rm -rf '$stage'; mkdir -p '$stage'; cat >'$stage/collector.tgz'" <"$work/install.tgz" || fail "cannot upload the collector"
ssh -F "$config" stats-standby "cat >'$stage/collector-install.sh'" <"$work/install-guest.sh" || fail "cannot upload the collector"
status=0
"$STATS_ROLLOUT" lease run --target-kind native --host stats-standby --ssh-config "$config" --operation collector-install --bound-s 300 -- sh -c 'sh "$1/collector-install.sh" <"$1/collector.tgz"' sh "$stage" || status=$?
ssh -F "$config" stats-standby "rm -rf '$stage'" || :
[ "$status" -eq 0 ] || fail "lease unavailable or installation failed"
echo "collector provisioned; restart native-stats (or deploy an app release) to apply it"
