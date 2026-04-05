#!/usr/bin/env bash
# Installer for openclaw-claude-proxy.
#
# Installs the proxy as a systemd service and wires it into an existing
# OpenClaw config. Safe to re-run (idempotent — existing service is
# overwritten, existing openclaw.json gets a baseUrl entry merged in).
#
# Usage:   sudo ./install.sh
# Options: --port <n>           bind on a different port (default 18790)
#          --no-service         skip systemd install; just validate env
#          --no-openclaw        skip the openclaw.json patch
#          --openclaw-config P  use a non-default openclaw.json path
#          --service-user U     user the service runs as (default: $SUDO_USER or current)

set -euo pipefail

PORT=18790
INSTALL_SERVICE=1
PATCH_OPENCLAW=1
OPENCLAW_CONFIG=""
SERVICE_USER="${SUDO_USER:-$(id -un)}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --no-openclaw) PATCH_OPENCLAW=0; shift ;;
    --openclaw-config) OPENCLAW_CONFIG="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# ── prerequisite checks ──────────────────────────────────────────────────────
log "checking prerequisites"
command -v node >/dev/null 2>&1 || die "node not found in PATH"
NODE_VERSION=$(node --version | sed 's/^v//; s/\..*//')
[[ "$NODE_VERSION" -ge 18 ]] || die "node >=18 required, found $(node --version)"

if ! command -v claude >/dev/null 2>&1; then
  die "claude CLI not found. Install: npm i -g @anthropic-ai/claude-code"
fi

SERVICE_USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
[[ -n "$SERVICE_USER_HOME" && -d "$SERVICE_USER_HOME" ]] || die "can't resolve home for user $SERVICE_USER"

if [[ ! -f "$SERVICE_USER_HOME/.claude/.credentials.json" ]]; then
  warn "no ~/.claude/.credentials.json for user $SERVICE_USER"
  warn "run: sudo -u $SERVICE_USER claude login"
  warn "continuing install; proxy will fail until login is done"
fi

CLAUDE_BIN=$(command -v claude)
NODE_BIN=$(command -v node)
log "node    : $NODE_BIN"
log "claude  : $CLAUDE_BIN"
log "user    : $SERVICE_USER  (home $SERVICE_USER_HOME)"
log "port    : $PORT"

# ── systemd service install ──────────────────────────────────────────────────
if [[ "$INSTALL_SERVICE" == "1" ]]; then
  if [[ $EUID -ne 0 ]]; then
    die "systemd install needs root. Re-run with sudo, or pass --no-service."
  fi
  log "writing /etc/systemd/system/claude-proxy.service"
  # Use the PATH from the claude binary's directory so the service can find
  # both `claude` and `node` even when systemd has a minimal environment.
  CLAUDE_DIR=$(dirname "$CLAUDE_BIN")
  NODE_DIR=$(dirname "$NODE_BIN")
  cat > /etc/systemd/system/claude-proxy.service <<EOF
[Unit]
Description=Claude Proxy (Anthropic API -> claude CLI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$SERVICE_USER_HOME
Environment=HOME=$SERVICE_USER_HOME
Environment=PATH=$NODE_DIR:$CLAUDE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=CLAUDE_PROXY_PORT=$PORT
Environment=CLAUDE_BIN=$CLAUDE_BIN
ExecStart=$NODE_BIN $REPO_DIR/claude-proxy.js
Restart=always
RestartSec=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=claude-proxy

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable claude-proxy >/dev/null 2>&1
  systemctl restart claude-proxy
  sleep 2
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
    log "service is up: http://127.0.0.1:$PORT/health → ok"
  else
    warn "service started but /health did not respond; check: journalctl -u claude-proxy -n 30"
  fi
else
  log "skipping systemd install (--no-service)"
fi

# ── openclaw config patch ────────────────────────────────────────────────────
if [[ "$PATCH_OPENCLAW" == "1" ]]; then
  if [[ -z "$OPENCLAW_CONFIG" ]]; then
    OPENCLAW_CONFIG="$SERVICE_USER_HOME/.openclaw/openclaw.json"
  fi
  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    warn "openclaw config not found at $OPENCLAW_CONFIG — skipping patch"
    warn "if openclaw is installed, manually merge examples/openclaw-config-snippet.json"
  else
    log "patching $OPENCLAW_CONFIG (baseUrl -> http://127.0.0.1:$PORT)"
    TS=$(date +%Y%m%d-%H%M%S)
    cp "$OPENCLAW_CONFIG" "$OPENCLAW_CONFIG.pre-proxy-$TS"
    node - "$OPENCLAW_CONFIG" "$PORT" <<'NODEJS'
const fs = require('fs');
const [,,path, port] = process.argv;
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.models = cfg.models || {};
cfg.models.providers = cfg.models.providers || {};
cfg.models.providers.anthropic = cfg.models.providers.anthropic || {};
cfg.models.providers.anthropic.baseUrl = `http://127.0.0.1:${port}`;
if (!Array.isArray(cfg.models.providers.anthropic.models)) {
  cfg.models.providers.anthropic.models = [];
}
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log('  models.providers.anthropic.baseUrl = ' + cfg.models.providers.anthropic.baseUrl);
NODEJS
    log "backup saved: $OPENCLAW_CONFIG.pre-proxy-$TS"
    if systemctl is-active openclaw >/dev/null 2>&1; then
      log "restarting openclaw service to pick up new config"
      systemctl restart openclaw
    else
      warn "openclaw service not detected; restart it manually to pick up the change"
    fi
  fi
else
  log "skipping openclaw config patch (--no-openclaw)"
fi

log "done."
log "test it: curl -s http://127.0.0.1:$PORT/health"
