#!/bin/sh
# shellcheck disable=SC2016
set -eu
umask 077

repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
name=${1:-}
ssh_target=${2:-}
if [ -z "$name" ] || [ -z "$ssh_target" ]; then
  echo "usage: deploy/add-macos-host.sh <name> <user@host|local>" >&2
  exit 2
fi

base=${STATS_URL:-https://stats.17166969.xyz}
label=xyz.17166969.stats
plist_source="$repo/agent/contrib/launchd/$label.plist"
artifact="$repo/agent/target/release/stats"

die() {
  echo "$name: $*" >&2
  exit 1
}

[ -f "$plist_source" ] || die "missing $plist_source"
[ -x "$artifact" ] || die "missing $artifact; run make agent-build-macos"
[ "$(uname -s)" = Darwin ] || die "this target installs macOS agents and must run from macOS"

mkdir -p "$repo/.work/tmp"
work=$(mktemp -d "$repo/.work/tmp/add-host.XXXXXX")
trap 'rm -rf "$work"' 0 1 2 15

ssh_opts=${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10}
if [ "$ssh_target" = local ]; then
  # shellcheck disable=SC2317
  remote() { sh -c "$*"; }
else
  # shellcheck disable=SC2086,SC2029
  remote() { ssh $ssh_opts -- "$ssh_target" "$@"; }
fi

single_quote() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

remote_cmd() {
  script=$1
  marker="__STATS_STATUS_$$__"
  quoted=$(single_quote "$script")
  remote "/bin/sh -c '$quoted'; printf '\\n$marker%s\\n' \"\$?\" >&2" > "$work/remote.stdout" 2> "$work/remote.stderr"
  last=$(tail -n 1 "$work/remote.stderr" 2>/dev/null || true)
  case "$last" in
    "$marker"*) status=${last#"$marker"} ;;
    *) status=255 ;;
  esac
  if [ "$status" -ne 0 ]; then
    message=$(sed '$d' "$work/remote.stderr" 2>/dev/null || true)
    if [ -n "$message" ]; then
      printf '%s\n' "$message" >&2
    fi
  fi
  return "$status"
}

remote_output() {
  remote_cmd "$1" || return $?
  cat "$work/remote.stdout"
}

remote_os=$(remote_output 'uname -s') || die "cannot reach $ssh_target over SSH"
[ "$remote_os" = Darwin ] || die "$ssh_target runs $remote_os, not macOS"
local_arch=$(uname -m)
remote_arch=$(remote_output 'uname -m') || die "cannot read the architecture on $ssh_target"
[ "$remote_arch" = "$local_arch" ] || die "$ssh_target runs $remote_arch but this Mac builds $local_arch; build and run on a matching Mac"
home=$(remote_output 'printf %s "$HOME"') || die "cannot read the home directory on $ssh_target"
case "$home" in
  /*) ;;
  *) die "the home directory on $ssh_target is not absolute" ;;
esac
case "$home" in
  *"|"*) die "the home directory on $ssh_target contains a pipe" ;;
esac
remote_cmd 'command -v launchctl >/dev/null 2>&1' || die "$ssh_target has no launchctl"

remote_bin=$home/.local/bin/stats
remote_dir=$home/.config/stats
remote_config=$remote_dir/agent.json
remote_token=$remote_dir/token
remote_plist=$home/Library/LaunchAgents/$label.plist
remote_log=$home/Library/Logs/stats.log

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

access_token=
api() {
  if [ -z "$access_token" ]; then
    access_token=$(cf access token "$base") || die "cf access token $base failed; run cf access login $base"
  fi
  curl -fsS -H "Cf-Access-Jwt-Assertion: $access_token" "$@"
}

api "$base/api/v1/hosts" > "$work/hosts.json" || die "cannot read $base/api/v1/hosts; run cf access login $base"

remote_host_id=
if remote_cmd "test -f '$remote_config'"; then
  remote_cmd "cat '$remote_config'" || die "cannot read $remote_config"
  cp "$work/remote.stdout" "$work/remote-agent.json"
  remote_host_id=$(jaq -er '.hostId' "$work/remote-agent.json") || die "$remote_config has no hostId"
fi

server_name() {
  jaq -er --arg id "$1" '[.hosts[] | select(.hostId == $id)][0].name // ""' "$work/hosts.json"
}

token=0
if [ -n "$remote_host_id" ]; then
  host_id=$remote_host_id
  found_name=$(server_name "$host_id") || die "cannot read the host list"
  [ -n "$found_name" ] || die "the config at $remote_config uses hostId $host_id, which $base does not know; move that file aside and rerun"
  [ "$found_name" = "$name" ] || die "$ssh_target is configured as '$found_name', not '$name'"
  if ! remote_cmd "test -f '$remote_token'"; then
    echo "$name: token file is missing; rotating the token for $host_id"
    api -X POST "$base/api/v1/admin/hosts/$host_id/rotate" > "$work/token.json" || die "cannot rotate the token for $host_id"
    jaq -jr '.token' "$work/token.json" > "$work/token"
    token=1
  fi
else
  matches=$(jaq -er --arg name "$name" '[.hosts[] | select(.name == $name)] | length' "$work/hosts.json") || die "cannot read the host list"
  case "$matches" in
    0)
      body=$(jaq -nc --arg name "$name" '{name:$name}')
      api -X POST -H 'content-type: application/json' --data "$body" "$base/api/v1/admin/hosts" > "$work/token.json" || die "cannot create the host"
      host_id=$(jaq -er '.hostId' "$work/token.json") || die "the create response has no hostId"
      jaq -jr '.token' "$work/token.json" > "$work/token"
      token=1
      echo "$name: created host $host_id"
      ;;
    1)
      host_id=$(jaq -er --arg name "$name" '[.hosts[] | select(.name == $name)][0].hostId' "$work/hosts.json")
      echo "$name: no local config; rotating the token for existing host $host_id"
      api -X POST "$base/api/v1/admin/hosts/$host_id/rotate" > "$work/token.json" || die "cannot rotate the token for $host_id"
      jaq -jr '.token' "$work/token.json" > "$work/token"
      token=1
      ;;
    *)
      die "$base has $matches hosts named '$name'; purge the extras or choose another name"
      ;;
  esac
fi

jaq -n --arg endpoint "$base" --arg hostId "$host_id" --arg tokenFile "$remote_token" \
  '{endpoint:$endpoint,hostId:$hostId,tokenFile:$tokenFile}' > "$work/agent.json"
sed "s|HOME_DIR|$home|g" "$plist_source" > "$work/plist"

local_hash=$(hash_file "$artifact")
remote_hash=$(remote_output "if [ -f '$remote_bin' ]; then shasum -a 256 '$remote_bin' | cut -d' ' -f1; fi") || die "cannot read $remote_bin"
binary_changed=0
[ "$local_hash" = "$remote_hash" ] || binary_changed=1

config_changed=1
if remote_cmd "test -f '$remote_config'"; then
  remote_cmd "cat '$remote_config'" || die "cannot read $remote_config"
  cp "$work/remote.stdout" "$work/remote-config.json"
  if jaq -S . "$work/remote-config.json" > "$work/remote-config.norm" 2>/dev/null &&
    jaq -S . "$work/agent.json" > "$work/agent.norm" 2>/dev/null &&
    cmp -s "$work/remote-config.norm" "$work/agent.norm"; then
    config_changed=0
  fi
fi

plist_changed=1
if remote_cmd "test -f '$remote_plist'"; then
  remote_cmd "cat '$remote_plist'" || die "cannot read $remote_plist"
  cp "$work/remote.stdout" "$work/remote-plist"
  if cmp -s "$work/remote-plist" "$work/plist"; then
    plist_changed=0
  fi
fi

install_remote() {
  path=$1
  mode=$2
  source=$3
  remote_cmd "cat > '$path.new' && chmod '$mode' '$path.new' && mv -f '$path.new' '$path'" < "$source" || die "cannot install $path"
}

remote_cmd "mkdir -p '$home/.local/bin' '$remote_dir' '$home/Library/LaunchAgents' '$home/Library/Logs' && chmod 700 '$remote_dir'" || die "cannot create the install directories"

if [ "$binary_changed" -eq 1 ]; then
  install_remote "$remote_bin" 0755 "$artifact"
fi
if [ "$token" -eq 1 ]; then
  install_remote "$remote_token" 0600 "$work/token"
fi
if [ "$config_changed" -eq 1 ]; then
  install_remote "$remote_config" 0600 "$work/agent.json"
fi
if [ "$plist_changed" -eq 1 ]; then
  install_remote "$remote_plist" 0644 "$work/plist"
fi

uid=$(remote_output 'id -u') || die "cannot read the uid on $ssh_target"
service="gui/$uid/$label"
loaded=0
if remote_cmd "launchctl print '$service' >/dev/null 2>&1"; then
  loaded=1
fi

if [ "$binary_changed" -eq 1 ] || [ "$token" -eq 1 ] || [ "$config_changed" -eq 1 ] || [ "$plist_changed" -eq 1 ] || [ "$loaded" -eq 0 ]; then
  remote_cmd "launchctl bootout '$service' >/dev/null 2>&1 || true" || die "cannot stop $label"
  started=0
  for _ in 1 2 3 4 5; do
    if remote_cmd "launchctl bootstrap 'gui/$uid' '$remote_plist'"; then
      started=1
      break
    fi
    sleep 2
  done
  [ "$started" -eq 1 ] || {
    remote_output "tail -20 '$remote_log'" >&2 || true
    die "launchd did not load $label"
  }
  echo "$name: agent started"
else
  echo "$name: agent already current"
fi

if ! remote_cmd "launchctl print '$service' >/dev/null 2>&1"; then
  remote_output "tail -20 '$remote_log'" >&2 || true
  die "launchd did not load $label"
fi

api_receipt() {
  api "$base/api/v1/hosts" | jaq -er --arg id "$host_id" '[.hosts[] | select(.hostId == $id)][0].lastReceivedAtMs // 0'
}

baseline=$(api_receipt) || die "cannot read the receipt for $host_id"
deadline=$(( $(date +%s) + 90 ))
while :; do
  current=$(api_receipt) || current=0
  if [ "${current:-0}" -gt "$baseline" ]; then
    echo "$name: reporting as $host_id"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    remote_output "tail -20 '$remote_log'" >&2 || true
    die "no upload within 90s"
  fi
  sleep 5
done
