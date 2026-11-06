#!/bin/sh
set -eu

REPO="${STATS_REPO:-joshuarli/stats}"
VERSION="${STATS_VERSION:-latest}"
INSTALL_DIR="${STATS_INSTALL_DIR:-/usr/local/bin}"
CONFIG_DIR="${STATS_CONFIG_DIR:-/etc/stats}"
USER="${STATS_USER:-stats}"
SERVICE_NAME="stats"

OS=$(uname -s)
ARCH=$(uname -m)

# Detect if running as root
if [ "$(id -u)" != "0" ] && [ "$OS" != "Darwin" ]; then
  echo "This installer must run as root on Linux" >&2
  exit 1
fi

get_latest_version() {
  if [ "$VERSION" = "latest" ]; then
    # Try to get from GitHub API
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
    else
      echo "0.1.0"
    fi
  else
    echo "$VERSION"
  fi
}

VERSION=$(get_latest_version)
VERSION_NUM=$(echo "$VERSION" | sed 's/^v//')

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    echo "curl or wget required" >&2
    exit 1
  fi
}

sha256_check() {
  file="$1"
  expected="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
  else
    return 0
  fi
  [ "$actual" = "$expected" ]
}

echo "Installing stats $VERSION"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64) BINARY="stats-$VERSION_NUM-x86_64-unknown-linux-musl" ;;
      aarch64) BINARY="stats-$VERSION_NUM-aarch64-unknown-linux-musl" ;;
      arm64) BINARY="stats-$VERSION_NUM-aarch64-unknown-linux-musl" ;;
      *) echo "Unsupported architecture $ARCH" >&2; exit 1 ;;
    esac
    
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
    TMPDIR_INSTALL=$(mktemp -d)
    cd "$TMPDIR_INSTALL"
    
    download "$BASE_URL/$BINARY" stats
    download "$BASE_URL/SHA256SUMS" SHA256SUMS 2>/dev/null || true
    
    if [ -f SHA256SUMS ]; then
      EXPECTED=$(grep " $BINARY$" SHA256SUMS | awk '{print $1}')
      if [ -n "$EXPECTED" ]; then
        if ! sha256_check stats "$EXPECTED"; then
          echo "SHA256 verification failed" >&2
          exit 1
        fi
        echo "SHA256 verified"
      fi
    fi
    
    chmod +x stats
    mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
    
    # Create user if not exists
    if ! id "$USER" >/dev/null 2>&1; then
      if command -v useradd >/dev/null 2>&1; then
        useradd --system --no-create-home --shell /usr/sbin/nologin "$USER" || true
      elif command -v adduser >/dev/null 2>&1; then
        adduser -S -D -H -s /sbin/nologin "$USER" || true
      fi
    fi
    
    install -m 0755 stats "$INSTALL_DIR/stats"
    chown root:root "$INSTALL_DIR/stats" 2>/dev/null || true
    
    # Detect init system
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
      INIT="systemd"
    elif command -v rc-service >/dev/null 2>&1 || [ -d /etc/init.d ]; then
      INIT="openrc"
    else
      INIT="unknown"
    fi
    
    echo "Detected init system: $INIT"
    
    if [ "$INIT" = "systemd" ]; then
      cat > /etc/systemd/system/stats.service << 'EOF'
[Unit]
Description=Stats telemetry agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/stats --config /etc/stats/agent.json
Restart=always
RestartSec=5s
User=stats
Group=stats
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload
      echo "Installed systemd service to /etc/systemd/system/stats.service"
      echo "Edit /etc/stats/agent.json and /etc/stats/token, then run: systemctl enable --now stats"
    elif [ "$INIT" = "openrc" ]; then
      cat > /etc/init.d/stats << 'EOF'
#!/sbin/openrc-run

name="stats"
description="Static-musl host telemetry agent"
command="/usr/local/bin/stats"
command_args="--config /etc/stats/agent.json"
command_user="stats:stats"
command_background="yes"
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/stats.log"
error_log="/var/log/stats.log"

depend() {
  need net
  after firewall
}
EOF
      chmod +x /etc/init.d/stats
      echo "Installed OpenRC service to /etc/init.d/stats"
      echo "Edit /etc/stats/agent.json and /etc/stats/token, then run: rc-update add stats default && rc-service stats start"
    else
      echo "Unknown init system. Install supervisord or run manually:"
      echo "  stats --config $CONFIG_DIR/agent.json"
    fi
    
    rm -rf "$TMPDIR_INSTALL"
    ;;
    
  Darwin)
    case "$ARCH" in
      arm64) BINARY="stats-$VERSION_NUM-aarch64-apple-darwin" ;;
      *) echo "Unsupported architecture $ARCH" >&2; exit 1 ;;
    esac
    
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
    TMPDIR_INSTALL=$(mktemp -d)
    cd "$TMPDIR_INSTALL"
    
    download "$BASE_URL/$BINARY" stats
    download "$BASE_URL/SHA256SUMS" SHA256SUMS 2>/dev/null || true
    
    if [ -f SHA256SUMS ]; then
      EXPECTED=$(grep " $BINARY$" SHA256SUMS | awk '{print $1}')
      if [ -n "$EXPECTED" ]; then
        if ! sha256_check stats "$EXPECTED"; then
          echo "SHA256 verification failed" >&2
          exit 1
        fi
        echo "SHA256 verified"
      fi
    fi
    
    chmod +x stats
    mkdir -p "$HOME/.local/bin" "$HOME/.config/stats"
    install -m 0755 stats "$HOME/.local/bin/stats"
    
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$HOME/Library/LaunchAgents/xyz.17166969.stats.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>xyz.17166969.stats</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.local/bin/stats</string>
    <string>--config</string>
    <string>$HOME/.config/stats/agent.json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/stats.log</string>
</dict>
</plist>
EOF
    
    echo "Installed binary to $HOME/.local/bin/stats"
    echo "Installed launchd agent to $HOME/Library/LaunchAgents/xyz.17166969.stats.plist"
    echo "Edit $HOME/.config/stats/agent.json and token, then run:"
    echo "  launchctl bootstrap gui/\$(id -u) $HOME/Library/LaunchAgents/xyz.17166969.stats.plist"
    
    rm -rf "$TMPDIR_INSTALL"
    ;;
    
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

echo "Installation complete"
