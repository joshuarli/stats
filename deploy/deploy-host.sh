#!/bin/sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
manifest="$repo/deploy/hosts.json"
name=${1:-}
if [ -z "$name" ]; then
  echo "usage: deploy/deploy-host.sh <host> [--rollback]" >&2
  exit 2
fi
mode=${2:-deploy}
case "$mode" in
  deploy|--rollback) ;;
  *) echo "deploy: unsupported mode '$mode'" >&2; exit 2 ;;
esac

# shellcheck disable=SC2016
if ! jaq -e --arg host "$name" '.hosts[$host] != null' "$manifest" >/dev/null; then
  echo "deploy: unknown host '$name' in $manifest" >&2
  exit 2
fi

field() {
  # shellcheck disable=SC2016
  jaq -er --arg host "$name" --arg field "$1" '.hosts[$host][$field]' "$manifest"
}

label=$(field name)
ssh_target=$(field ssh)
rust_target=$(field target)
init=$(field init)
elevate=$(field elevate)

case "$init" in
  systemd|openrc) ;;
  *) echo "deploy: $name has unsupported init '$init'" >&2; exit 2 ;;
esac
case "$elevate" in
  sudo|doas) ;;
  *) echo "deploy: $name has unsupported elevation '$elevate'" >&2; exit 2 ;;
esac

version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$repo/agent/Cargo.toml" | head -n 1)
if [ -z "$version" ]; then
  echo "deploy: cannot read the agent version" >&2
  exit 1
fi
artifact="$repo/agent/dist/stats-$version-$rust_target"
if [ ! -f "$artifact" ]; then
  echo "deploy: missing $artifact; run make agent-build" >&2
  exit 1
fi

case "$init" in
  systemd)
    unit_source="$repo/agent/contrib/systemd/stats.service"
    unit_path=/etc/systemd/system/stats.service
    unit_mode=0644
    ;;
  openrc)
    unit_source="$repo/agent/contrib/openrc/stats"
    unit_path=/etc/init.d/stats
    unit_mode=0755
    ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/stats-host.XXXXXX")
remote_tmp=
cleanup() {
  if [ -n "$remote_tmp" ]; then
    remote "rm -f '$remote_tmp'" >/dev/null 2>&1 || true
  fi
}
trap 'cleanup; rm -rf "$work"' 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

base=${STATS_URL:-https://stats.17166969.xyz}
access_token=
host_id=
baseline=

api() {
  if [ -z "$access_token" ]; then
    access_token=$(cf access token "$base") || return 1
  fi
  curl -fsS -H "Cf-Access-Jwt-Assertion: $access_token" "$@"
}

api_receipt() {
  # shellcheck disable=SC2016
  api "$base/api/v1/hosts" | jaq --arg id "$host_id" -er '[.hosts[] | select(.hostId == $id)][0].lastReceivedAtMs // 0'
}

prepare_receipt() {
  host_id=$(remote "$elevate cat /etc/stats/agent.json" | jaq -er '.hostId') || {
    echo "$label: cannot read the agent hostId" >&2
    exit 1
  }
  api_receipt >/dev/null || {
    echo "$label: cannot read /api/v1/hosts; run cf access login $base" >&2
    exit 1
  }
}

take_baseline() {
  baseline=$(api_receipt) || {
    echo "$label: cannot read /api/v1/hosts; run cf access login $base" >&2
    exit 1
  }
}

wait_for_upload() {
  deadline=$(( $(date +%s) + 90 ))
  while :; do
    current=$(api_receipt) || current=
    if [ -n "$current" ] && [ "$current" -gt "$baseline" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$label: no fresh receipt for $host_id within 90s" >&2
      return 1
    fi
    sleep 5
  done
}

ssh_opts=${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10}
# shellcheck disable=SC2086,SC2029
remote() {
  ssh $ssh_opts -- "$ssh_target" "$@"
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

local_hash=$(hash_file "$artifact")
remote_hash=$(remote 'if [ -f /usr/local/bin/stats ]; then sha256sum /usr/local/bin/stats | cut -d" " -f1; fi')
binary_changed=0
if [ "$remote_hash" != "$local_hash" ]; then
  binary_changed=1
fi

if ! remote "if [ -f '$unit_path' ]; then cat '$unit_path'; fi" > "$work/unit"; then
  echo "$label: cannot read $unit_path" >&2
  exit 1
fi
unit_changed=0
if ! cmp -s "$work/unit" "$unit_source"; then
  unit_changed=1
fi

if ! remote "$elevate test -f /etc/stats/agent.json"; then
  echo "$label: /etc/stats/agent.json is missing; provision the agent first" >&2
  exit 1
fi

is_active() {
  case "$init" in
    systemd) remote "$elevate systemctl is-active --quiet stats" ;;
    openrc) remote "$elevate /sbin/rc-service stats status >/dev/null 2>&1" ;;
  esac
}

active=0
if is_active; then
  active=1
fi

if [ "$mode" = "--rollback" ]; then
  if ! remote "$elevate test -x /usr/local/bin/stats.prev"; then
    echo "$label: /usr/local/bin/stats.prev is missing; nothing to roll back to" >&2
    exit 1
  fi
  prepare_receipt
  echo "$label: restoring the previous agent"
  remote "$elevate install -m 0755 -o root -g root /usr/local/bin/stats.prev /usr/local/bin/stats.new"
  remote "$elevate mv -f /usr/local/bin/stats.new /usr/local/bin/stats"
  case "$init" in
    systemd) remote "$elevate systemctl restart stats" ;;
    openrc) remote "$elevate /sbin/rc-service stats restart >/dev/null" ;;
  esac
  take_baseline
  if ! is_active; then
    echo "$label: service did not become active after rollback" >&2
    exit 1
  fi
  wait_for_upload || exit 1
  echo "$label: rolled back"
  exit 0
fi

if [ "$binary_changed" -eq 0 ] && [ "$unit_changed" -eq 0 ] && [ "$active" -eq 1 ]; then
  prepare_receipt
  take_baseline
  wait_for_upload || exit 1
  echo "$label: unchanged"
  exit 0
fi

prepare_receipt

if [ "$binary_changed" -eq 1 ]; then
  echo "$label: installing agent $version"
  remote_tmp=$(remote 'mktemp /tmp/stats.XXXXXX')
  remote "cat > '$remote_tmp'" < "$artifact"
  remote "if [ -f /usr/local/bin/stats ]; then $elevate install -m 0755 -o root -g root /usr/local/bin/stats /usr/local/bin/stats.prev; fi"
  remote "$elevate install -m 0755 -o root -g root '$remote_tmp' /usr/local/bin/stats.new"
  remote "$elevate mv -f /usr/local/bin/stats.new /usr/local/bin/stats"
  remote "rm -f '$remote_tmp'"
  remote_tmp=
fi

if [ "$unit_changed" -eq 1 ]; then
  echo "$label: installing $init unit"
  remote "$elevate tee '$unit_path' >/dev/null" < "$unit_source"
  remote "$elevate chmod '$unit_mode' '$unit_path'"
fi

case "$init" in
  systemd)
    if [ "$unit_changed" -eq 1 ]; then
      remote "$elevate systemctl daemon-reload"
    fi
    remote "$elevate systemctl enable stats >/dev/null"
    if [ "$binary_changed" -eq 1 ] || [ "$unit_changed" -eq 1 ]; then
      remote "$elevate systemctl restart stats"
    elif [ "$active" -eq 0 ]; then
      remote "$elevate systemctl start stats"
    fi
    ;;
  openrc)
    remote "$elevate touch /var/log/stats.log"
    remote "$elevate chown stats:stats /var/log/stats.log"
    remote "$elevate chmod 0640 /var/log/stats.log"
    remote "$elevate /sbin/rc-update add stats default >/dev/null"
    if [ "$binary_changed" -eq 1 ] || [ "$unit_changed" -eq 1 ]; then
      remote "$elevate /sbin/rc-service stats restart >/dev/null"
    elif [ "$active" -eq 0 ]; then
      remote "$elevate rm -f /run/stats.pid"
      remote "$elevate /sbin/rc-service stats start >/dev/null"
    fi
    ;;
esac

take_baseline
if ! is_active; then
  echo "$label: service did not become active" >&2
  exit 1
fi
wait_for_upload || exit 1

echo "$label: deployed"
