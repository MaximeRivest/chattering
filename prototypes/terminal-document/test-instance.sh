#!/usr/bin/env bash
# A separate test copy of Chattering with Claude Code live switched on
# (CHATTERING_LIVE_TERMINAL=1). It reads the real conversations (~/.claude,
# ~/.pi, ~/.codex) but keeps its own settings, data, cache and notes, its
# own ports (7499; previews 7498) and its own pairings: the running
# Chattering is not touched. Background AI is off in its settings.
#   ./test-instance.sh start|stop|status|token
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../.." && pwd)
base="$HOME/.cache/chattering-live-test"; unit=chattering-live-test
case "${1:-start}" in
  start)
    mkdir -p "$base"/{config,data,cache,notes,delegations,mirror,history}; chmod 700 "$base"
    [ -f "$base/token" ] || head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$base/token"; chmod 600 "$base/token"
    # The first-run question answered: background AI off, welcome seen.
    [ -f "$base/config/settings.json" ] || node -e "
      const { SETTINGS_VERSION } = require('$repo/settings.js');
      require('fs').writeFileSync('$base/config/settings.json', JSON.stringify({ settingsVersion: SETTINGS_VERSION,
        backgroundAi: { decidedAt: new Date().toISOString(), names: false, memory: false }, welcome: { doneAt: new Date().toISOString() } }));"
    systemctl --user stop "$unit" 2>/dev/null || true
    systemd-run --user --unit="$unit" --collect -p RuntimeMaxSec=8h -p WorkingDirectory="$repo" \
      -E PATH="$PATH" -E HOME="$HOME" -E CHATTERING_LIVE_TERMINAL=1 \
      -E PORT=7499 -E CHATTERING_TLS_PORT=0 -E CHATTERING_PREVIEW_PORT=7498 -E CHATTERING_PREVIEW_TLS_PORT=0 -E CHATTERING_PREVIEW_TAILNET_PORT=0 \
      -E CHATTERING_HOST=127.0.0.1 -E CHATTERING_LAN= -E CHATTERING_PUBLIC_URL= -E CHATTERING_HOSTNAME=lambda-live-test \
      -E CHATTERING_NO_SYNC=1 -E CHATTERING_NO_LEDGER=1 -E CHATTERING_NO_FILE_HISTORY=1 -E CHATTERING_NO_CHECKPOINTS=1 -E CHATTERING_LINK_PORT_BASE=7610 \
      -E CHATTERING_CONFIG_DIR="$base/config" -E CHATTERING_DATA_DIR="$base/data" -E CHATTERING_CACHE_DIR="$base/cache" -E CHATTERING_NOTES_DIR="$base/notes" \
      -E CHATTERING_DELEGATION_ROOT="$base/delegations" -E CHATTERING_MIRROR_DIR="$base/mirror" -E CHATTERING_FILE_HISTORY_DIR="$base/history" \
      -E CHATTERING_TOKEN="$(cat "$base/token")" "$(command -v node)" server.js
    echo "started: http://127.0.0.1:7499/?token=$(cat "$base/token")" ;;
  stop) systemctl --user stop "$unit" ;;
  status) systemctl --user is-active "$unit" ;;
  token) cat "$base/token" ;;
  pair)  # a pairing code for a phone, tablet or laptop (10 minutes): link + QR at $base/pair.svg
    curl -s -X POST -H "Authorization: Bearer $(cat "$base/token")" -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:7499/api/anywhere/pair \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);require('fs').writeFileSync('$base/pair.svg',require('$repo/anywhere-home.js').qrSvg(o.url),{mode:0o600});console.log(o.url);console.log('QR: $base/pair.svg (until '+new Date(o.expiresAt).toLocaleTimeString()+')')})" ;;
esac
