#!/bin/sh
# shellcheck disable=SC2016
set -eu
umask 077

repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
name=${1:-}
ssh_target=${2:-}
if [ -z "$name" ] || [ -z "$ssh_target" ]; then
  echo "usage: deploy/add-host.sh <name> <user@host|local>" >&2
  exit 2
fi

base=${STATS_URL:-https://stats.17166969.xyz}
label=xyz.17166969.stats
plist_source="$repo/agent/contrib/launchd/$label.plist"
openrc_source="$repo/agent/contrib/openrc/stats"

die() {
  echo "$name: $*" >&2
  exit 1
}

mkdir -p "$repo/.work/tmp"
work=$(mktemp -d "$repo/.work/tmp/add-host.XXXXXX")
reraise() {
  trap - 0 "$1"
  rm -rf "$work"
  kill -s "$1" $$
}
trap 'rm -rf "$work"' 0
trap 'reraise HUP' 1
trap 'reraise INT' 2
trap 'reraise TERM' 15

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
remote_arch=$(remote_output 'uname -m') || die "cannot read the architecture on $ssh_target"

platform=
elevate=
case "$remote_os" in
  Darwin)
    platform=launchd
    [ "$(uname -s)" = Darwin ] || die "installing a macOS agent needs a Mac to build the native binary"
    local_arch=$(uname -m)
    [ "$remote_arch" = "$local_arch" ] || die "$ssh_target runs $remote_arch but this machine builds $local_arch; build and run on a matching Mac"
    home=$(remote_output 'printf %s "$HOME"') || die "cannot read the home directory on $ssh_target"
    case "$home" in
      /*) ;;
      *) die "the home directory on $ssh_target is not absolute" ;;
    esac
    case "$home" in
      *"|"*) die "the home directory on $ssh_target contains a pipe" ;;
    esac
    remote_cmd 'command -v launchctl >/dev/null 2>&1' || die "$ssh_target has no launchctl"
    [ -f "$plist_source" ] || die "missing $plist_source"
    artifact="$repo/agent/target/release/stats"
    build_hint="make agent-build-macos"
    [ -f "$artifact" ] || die "missing $artifact; run $build_hint"
    remote_bin=$home/.local/bin/stats
    remote_dir=$home/.config/stats
    remote_config=$remote_dir/agent.json
    remote_token=$remote_dir/token
    remote_unit=$home/Library/LaunchAgents/$label.plist
    remote_log=$home/Library/Logs/stats.log
    ;;
  Linux)
    platform=openrc
    remote_cmd 'test -x /sbin/rc-service && test -x /sbin/rc-update' || die "$ssh_target does not run OpenRC; add-host supports Alpine hosts"
    [ -f "$openrc_source" ] || die "missing $openrc_source"
    case "$remote_arch" in
      x86_64|amd64) rust_target=x86_64-unknown-linux-musl ;;
      aarch64|arm64) rust_target=aarch64-unknown-linux-musl ;;
      *) die "$ssh_target runs $remote_arch, which has no static agent target" ;;
    esac
    version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$repo/agent/Cargo.toml" | head -n 1)
    [ -n "$version" ] || die "cannot read the agent version"
    artifact="$repo/agent/dist/stats-$version-$rust_target"
    build_hint="make agent-build"
    [ -f "$artifact" ] || die "missing $artifact; run $build_hint"
    remote_bin=/usr/local/bin/stats
    remote_dir=/etc/stats
    remote_config=$remote_dir/agent.json
    remote_token=$remote_dir/token
    remote_unit=/etc/init.d/stats
    remote_log=/var/log/stats.log
    elevate=${ELEVATE:-}
    if [ -z "$elevate" ]; then
      if remote_cmd 'command -v doas >/dev/null 2>&1'; then
        elevate=doas
      elif remote_cmd 'command -v sudo >/dev/null 2>&1'; then
        elevate=sudo
      else
        die "$ssh_target has neither doas nor sudo"
      fi
    fi
    case "$elevate" in
      doas|sudo) ;;
      *) die "unsupported ELEVATE '$elevate'" ;;
    esac
    remote_cmd "$elevate -n true" || die "$elevate -n failed on $ssh_target; passwordless elevation is required"
    ;;
  *)
    die "$ssh_target runs $remote_os; add-host supports macOS and Alpine/OpenRC Linux"
    ;;
esac

root_cmd() {
  remote_cmd "$elevate -n sh -c '$1'"
}

root_output() {
  remote_output "$elevate -n sh -c '$1'"
}

config_present() {
  case "$platform" in
    launchd) remote_cmd "test -f '$remote_config'" ;;
    openrc) root_cmd "test -f $remote_config" ;;
  esac
}

read_config() {
  case "$platform" in
    launchd) remote_output "cat '$remote_config'" ;;
    openrc) root_output "cat $remote_config" ;;
  esac
}

token_present() {
  case "$platform" in
    launchd) remote_cmd "test -f '$remote_token'" ;;
    openrc) root_cmd "test -f $remote_token" ;;
  esac
}

unit_present() {
  case "$platform" in
    launchd) remote_cmd "test -f '$remote_unit'" ;;
    openrc) root_cmd "test -f $remote_unit" ;;
  esac
}

read_unit() {
  case "$platform" in
    launchd) remote_output "cat '$remote_unit'" ;;
    openrc) root_output "cat $remote_unit" ;;
  esac
}

tail_log() {
  case "$platform" in
    launchd) remote_output "tail -20 '$remote_log'" ;;
    openrc) root_output "tail -20 $remote_log" ;;
  esac
}

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
    access_token=$(cf -q access token "$base") || die "cf access token $base failed; run cf access login $base"
  fi
  curl -fsS -H "Cf-Access-Jwt-Assertion: $access_token" "$@"
}

api "$base/api/v1/hosts" > "$work/hosts.json" || die "cannot read $base/api/v1/hosts; run cf access login $base"

remote_host_id=
if config_present; then
  read_config > "$work/remote-agent.json" || die "cannot read $remote_config"
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
  if ! token_present; then
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

if [ -n "$remote_host_id" ]; then
  jaq --arg endpoint "$base" --arg hostId "$host_id" --arg tokenFile "$remote_token" \
    '. + {endpoint:$endpoint,hostId:$hostId,tokenFile:$tokenFile}' "$work/remote-agent.json" > "$work/agent.json"
else
  jaq -n --arg endpoint "$base" --arg hostId "$host_id" --arg tokenFile "$remote_token" \
    '{endpoint:$endpoint,hostId:$hostId,tokenFile:$tokenFile}' > "$work/agent.json"
fi

case "$platform" in
  launchd) sed "s|HOME_DIR|$home|g" "$plist_source" > "$work/unit" ;;
  openrc) cp "$openrc_source" "$work/unit" ;;
esac

local_hash=$(hash_file "$artifact")
remote_hash=$(remote_output "if [ -f '$remote_bin' ]; then if command -v sha256sum >/dev/null 2>&1; then sha256sum '$remote_bin'; else shasum -a 256 '$remote_bin'; fi | cut -d' ' -f1; fi") || die "cannot read $remote_bin"
binary_changed=0
[ "$local_hash" = "$remote_hash" ] || binary_changed=1

config_changed=1
if config_present; then
  read_config > "$work/remote-config.json" || die "cannot read $remote_config"
  if jaq -S . "$work/remote-config.json" > "$work/remote-config.norm" 2>/dev/null &&
    jaq -S . "$work/agent.json" > "$work/agent.norm" 2>/dev/null &&
    cmp -s "$work/remote-config.norm" "$work/agent.norm"; then
    config_changed=0
  fi
fi

unit_changed=1
if unit_present; then
  read_unit > "$work/remote-unit" || die "cannot read $remote_unit"
  if cmp -s "$work/remote-unit" "$work/unit"; then
    unit_changed=0
  fi
fi

install_remote() {
  path=$1
  mode=$2
  source=$3
  remote_cmd "cat > '$path.new' && chmod '$mode' '$path.new' && mv -f '$path.new' '$path'" < "$source" || die "cannot install $path"
}

install_root() {
  path=$1
  mode=$2
  owner=$3
  source=$4
  root_cmd "cat > $path.new && chmod $mode $path.new && chown $owner $path.new && mv -f $path.new $path" < "$source" || die "cannot install $path"
}

case "$platform" in
  launchd)
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
    if [ "$unit_changed" -eq 1 ]; then
      install_remote "$remote_unit" 0644 "$work/unit"
    fi

    uid=$(remote_output 'id -u') || die "cannot read the uid on $ssh_target"
    service="gui/$uid/$label"
    loaded=0
    if remote_cmd "launchctl print '$service' >/dev/null 2>&1"; then
      loaded=1
    fi

    if [ "$binary_changed" -eq 1 ] || [ "$token" -eq 1 ] || [ "$config_changed" -eq 1 ] || [ "$unit_changed" -eq 1 ] || [ "$loaded" -eq 0 ]; then
      remote_cmd "launchctl bootout '$service' >/dev/null 2>&1 || true" || die "cannot stop $label"
      started=0
      for _ in 1 2 3 4 5; do
        if remote_cmd "launchctl bootstrap 'gui/$uid' '$remote_unit'"; then
          started=1
          break
        fi
        sleep 2
      done
      [ "$started" -eq 1 ] || {
        tail_log >&2 || true
        die "launchd did not load $label"
      }
      echo "$name: agent started"
    else
      echo "$name: agent already current"
    fi

    if ! remote_cmd "launchctl print '$service' >/dev/null 2>&1"; then
      tail_log >&2 || true
      die "launchd did not load $label"
    fi
    ;;
  openrc)
    if ! root_cmd "id stats >/dev/null 2>&1"; then
      adduser=
      for candidate in /usr/sbin/adduser /sbin/adduser; do
        if remote_cmd "test -x $candidate"; then
          adduser=$candidate
          break
        fi
      done
      [ -n "$adduser" ] || die "$ssh_target has no adduser; create the stats group and user, then rerun"
      nologin=/sbin/nologin
      if ! remote_cmd 'test -x /sbin/nologin'; then
        nologin=/usr/sbin/nologin
      fi
      if ! root_cmd "getent group stats >/dev/null 2>&1"; then
        addgroup=
        for candidate in /usr/sbin/addgroup /sbin/addgroup; do
          if remote_cmd "test -x $candidate"; then
            addgroup=$candidate
            break
          fi
        done
        [ -n "$addgroup" ] || die "$ssh_target has no addgroup; create the stats group, then rerun"
        root_cmd "$addgroup -S stats" || die "cannot create the stats group"
      fi
      root_cmd "$adduser -S -D -H -G stats -s $nologin stats" || die "cannot create the stats user"
    fi

    root_cmd "mkdir -p $remote_dir && chmod 0700 $remote_dir && chown stats:stats $remote_dir" || die "cannot create $remote_dir"
    root_cmd "mkdir -p /usr/local/bin && touch $remote_log && chown stats:stats $remote_log && chmod 0640 $remote_log" || die "cannot prepare $remote_log"

    if [ "$binary_changed" -eq 1 ]; then
      if remote_cmd "test -f $remote_bin"; then
        root_cmd "cp -p $remote_bin $remote_bin.prev" || die "cannot save $remote_bin.prev"
      fi
      install_root "$remote_bin" 0755 0:0 "$artifact"
    fi
    if [ "$token" -eq 1 ]; then
      install_root "$remote_token" 0600 stats:stats "$work/token"
    fi
    if [ "$config_changed" -eq 1 ]; then
      install_root "$remote_config" 0600 stats:stats "$work/agent.json"
    fi
    if [ "$unit_changed" -eq 1 ]; then
      install_root "$remote_unit" 0755 0:0 "$work/unit"
    fi

    active=0
    if root_cmd "/sbin/rc-service stats status >/dev/null 2>&1"; then
      active=1
    fi

    if [ "$binary_changed" -eq 1 ] || [ "$token" -eq 1 ] || [ "$config_changed" -eq 1 ] || [ "$unit_changed" -eq 1 ] || [ "$active" -eq 0 ]; then
      root_cmd "/sbin/rc-update add stats default >/dev/null" || die "cannot enable the stats service"
      if [ "$active" -eq 1 ]; then
        root_cmd "rm -f /run/stats.pid && /sbin/rc-service stats restart >/dev/null" || die "cannot restart the stats service"
      else
        root_cmd "rm -f /run/stats.pid && /sbin/rc-service stats start >/dev/null" || die "cannot start the stats service"
      fi
      echo "$name: agent started"
    else
      echo "$name: agent already current"
    fi

    if ! root_cmd "/sbin/rc-service stats status >/dev/null 2>&1"; then
      tail_log >&2 || true
      die "the stats service is not active"
    fi
    ;;
esac

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
    tail_log >&2 || true
    die "no upload within 90s"
  fi
  sleep 5
done
