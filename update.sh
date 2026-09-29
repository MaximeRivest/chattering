#!/usr/bin/env bash
# Update this Chattering checkout and restart the service.
# Run it from the repo: ./update.sh
set -euo pipefail
cd "$(dirname "$0")"
PORT="${CHATTERING_PORT:-7433}"

before="$(git rev-parse --short HEAD)"
git pull --ff-only
after="$(git rev-parse --short HEAD)"

if [ "$before" = "$after" ]; then
  echo "already up to date ($after)"
else
  echo "updated: $before → $after"
  git log --oneline "$before..$after" | sed 's/^/  /'
fi

# The locked runtime (Pi, and the WebRTC component phones connect through,
# design/85): installed again when its lock changed, or when a part is missing.
if [ -f runtime/package-lock.json ] && { ! git diff --quiet "$before" "$after" -- runtime/package-lock.json 2>/dev/null || [ ! -d runtime/node_modules/node-datachannel ]; }; then
  echo "installing the runtime (runtime/package-lock.json)…"
  npm ci --prefix runtime --omit=dev --no-audit --no-fund
fi

# Keep the modes extension in step with the repo copy (install when missing).
PI_EXT_DIR="$HOME/.pi/agent/extensions"
if [ -f extensions/modes.ts ]; then
  mkdir -p "$PI_EXT_DIR"
  if [ ! -f "$PI_EXT_DIR/modes.ts" ]; then
    cp extensions/modes.ts "$PI_EXT_DIR/modes.ts"
    echo "installed pi extension: modes.ts → $PI_EXT_DIR"
  elif ! cmp -s extensions/modes.ts "$PI_EXT_DIR/modes.ts"; then
    echo "note: $PI_EXT_DIR/modes.ts differs from the repo copy — not overwritten."
  fi
fi

# Modes are user-owned. Add defaults only when missing.
mkdir -p "$HOME/.pi/agent/modes"
for mode in extensions/modes/*.json; do
  [ -f "$mode" ] || continue
  dest="$HOME/.pi/agent/modes/$(basename "$mode")"
  if [ ! -f "$dest" ]; then
    cp "$mode" "$dest"
    echo "installed pi mode: $(basename "$mode")"
  fi
done

# Under WSL the Windows side keeps its own copies of the launcher and the
# port-forward script (windows/install.ps1, windows/install-lan-forward.ps1
# put them in %LOCALAPPDATA%\Chattering). The shortcut and the scheduled task
# point at those copies by path, so refreshing the files is the whole update.
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  PS=$(command -v powershell.exe || true)
  [ -n "$PS" ] || PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
  if [ -x "$PS" ]; then
    winlocal=$("$PS" -NoProfile -Command 'Write-Output $env:LOCALAPPDATA' 2>/dev/null | tr -d '\r' || true)
    windest=""
    [ -n "$winlocal" ] && windest=$(wslpath -u "$winlocal" 2>/dev/null || true)
    # Installs made before the rename (2026-09-22) keep %LOCALAPPDATA%\Aiconvo:
    # their shortcut and scheduled task point there, and moving it would need
    # an administrator. Their copies are refreshed in place.
    for folder in Chattering Aiconvo; do
      [ -n "$windest" ] && [ -f "$windest/$folder/config.json" ] || continue
      for script in launch.ps1 lan-forward.ps1; do
        [ -f "$windest/$folder/$script" ] || continue
        if ! cmp -s "windows/$script" "$windest/$folder/$script"; then
          cp "windows/$script" "$windest/$folder/$script"
          echo "updated Windows copy: $folder\\$script"
        fi
      done
    done
  fi
fi

systemctl --user restart chattering

# /health answers before sign-in, so this works whatever the reach setting.
ok=""
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "the server did not come back on port $PORT. See: journalctl --user -u chattering -n 50" >&2
  exit 1
fi
echo "chattering is running → http://localhost:$PORT ($after)"
