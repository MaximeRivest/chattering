#!/usr/bin/env bash
# Install Chattering as a systemd user service on this machine.
# Works on Ubuntu and on WSL2 (with systemd enabled).
# Run it from the repo checkout: ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(pwd)"
PORT="${CHATTERING_PORT:-7433}"

# Validate Node and optional limits before any installation or systemd calls.
NODE_BIN="$(command -v node || true)"
NODE_MAJOR="$("${NODE_BIN:-false}" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node 22 or newer is required (found: ${NODE_BIN:-none})." >&2
  echo "Install with nvm:" >&2
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash" >&2
  echo "  source ~/.nvm/nvm.sh && nvm install 22" >&2
  echo "Then re-run ./setup.sh" >&2
  exit 1
fi
"$NODE_BIN" "$REPO/scripts/systemd-unit.js" --check

# --- 1. systemd user manager -------------------------------------------------
if ! systemctl --user show-environment >/dev/null 2>&1; then
  if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "systemd is not active in this WSL distro." >&2
    echo "Fix: add these lines to /etc/wsl.conf (sudo):" >&2
    echo "  [boot]" >&2
    echo "  systemd=true" >&2
    echo "Then run 'wsl --shutdown' in Windows, start WSL again, and re-run ./setup.sh" >&2
  else
    echo "The systemd user manager is not available. Log in as a normal user session." >&2
  fi
  exit 1
fi

# --- 3. optional tools -------------------------------------------------------
command -v pi >/dev/null 2>&1 \
  || echo "note: 'pi' is not installed — headless sends, notes, and memory builds stay off until it is."
command -v alacritty >/dev/null 2>&1 \
  || echo "note: 'alacritty' is not installed — agent terminal windows need it (sudo apt install alacritty)."
if grep -qi microsoft /proc/version 2>/dev/null; then
  ldconfig -p 2>/dev/null | grep -q libxkbcommon-x11 \
    || echo "note: on WSL, alacritty also needs: sudo apt install libxkbcommon-x11-0"
fi
command -v git >/dev/null 2>&1 \
  || echo "note: 'git' is not installed — repo views stay empty."

# --- 3b. pi extensions this UI depends on -----------------------------------
# The modes extension makes prompt modes first-class (composer mode button,
# /mode over RPC). Install it when missing; never clobber a local edit.
PI_EXT_DIR="$HOME/.pi/agent/extensions"
if [ -f "$REPO/extensions/modes.ts" ]; then
  mkdir -p "$PI_EXT_DIR"
  if [ ! -f "$PI_EXT_DIR/modes.ts" ]; then
    cp "$REPO/extensions/modes.ts" "$PI_EXT_DIR/modes.ts"
    echo "installed pi extension: modes.ts → $PI_EXT_DIR"
  elif ! cmp -s "$REPO/extensions/modes.ts" "$PI_EXT_DIR/modes.ts"; then
    echo "note: $PI_EXT_DIR/modes.ts differs from $REPO/extensions/modes.ts — not overwritten."
  fi
fi
# The prompt-capture extension records the system prompt each turn and
# adds /sysprompt. Same rule: install when missing, never clobber.
if [ -f "$REPO/extensions/prompt-capture.ts" ]; then
  mkdir -p "$PI_EXT_DIR"
  if [ ! -f "$PI_EXT_DIR/prompt-capture.ts" ]; then
    cp "$REPO/extensions/prompt-capture.ts" "$PI_EXT_DIR/prompt-capture.ts"
    echo "installed pi extension: prompt-capture.ts → $PI_EXT_DIR"
  elif ! cmp -s "$REPO/extensions/prompt-capture.ts" "$PI_EXT_DIR/prompt-capture.ts"; then
    echo "note: $PI_EXT_DIR/prompt-capture.ts differs from $REPO/extensions/prompt-capture.ts — not overwritten."
  fi
fi

# Install missing prompt modes without replacing user-owned definitions.
mkdir -p "$HOME/.pi/agent/modes"
for mode in "$REPO"/extensions/modes/*.json; do
  [ -f "$mode" ] || continue
  dest="$HOME/.pi/agent/modes/$(basename "$mode")"
  if [ ! -f "$dest" ]; then
    cp "$mode" "$dest"
    echo "installed pi mode: $(basename "$mode")"
  fi
done

# --- 3c. the `chattering` command ---------------------------------------------
# Agents and people query the records from any folder with it. A symlink,
# so `git pull` updates it. Only a foreign file at that path is left alone.
mkdir -p "$HOME/.local/bin"
CLI_LINK="$HOME/.local/bin/chattering"
if [ -L "$CLI_LINK" ] || [ ! -e "$CLI_LINK" ]; then
  ln -sfn "$REPO/chattering" "$CLI_LINK"
  chmod +x "$REPO/chattering"
  echo "installed command: chattering → $CLI_LINK"
else
  echo "note: $CLI_LINK exists and is not a symlink — not replaced."
fi

# --- 4. systemd user unit ----------------------------------------------------
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
# The service PATH must reach node's bin dir (nvm installs pi there too).
NODE_DIR="$(dirname "$(readlink -f "$NODE_BIN")")"
# On WSL, agent terminals (alacritty) need the WSLg display sockets, and
# Windows interop (powershell.exe for sound extensions) needs the interop
# socket plus the Windows PowerShell dir on PATH.
DISPLAY_LINES=""
WIN_PATH=""
if grep -qi microsoft /proc/version 2>/dev/null; then
  DISPLAY_LINES='Environment=DISPLAY=:0'
  # Force X11: with systemd on WSL, the WSLg wayland socket is not in
  # XDG_RUNTIME_DIR. Alacritty also needs libxkbcommon-x11-0 (apt).
  if [ -S /run/WSL/1_interop ]; then
    DISPLAY_LINES="${DISPLAY_LINES}"$'\n'"Environment=WSL_INTEROP=/run/WSL/1_interop"
  fi
  # WSLg exposes PulseAudio here; paplay-based sound extensions need it.
  if [ -S /mnt/wslg/PulseServer ]; then
    DISPLAY_LINES="${DISPLAY_LINES}"$'\n'"Environment=PULSE_SERVER=unix:/mnt/wslg/PulseServer"
  fi
  WIN_PATH=":/mnt/c/Windows/System32/WindowsPowerShell/v1.0:/mnt/c/Windows/System32"
  command -v paplay >/dev/null 2>&1 \
    || echo "note: 'paplay' is missing — sound extensions need: sudo apt install pulseaudio-utils"
fi
UNIT_CONTENT="$("$NODE_BIN" "$REPO/scripts/systemd-unit.js" \
  "$NODE_BIN" "$REPO" "$PORT" "$HOME" "$NODE_DIR" "$WIN_PATH" "$DISPLAY_LINES")"
printf '%s\n' "$UNIT_CONTENT" > "$UNIT_DIR/chattering.service"
systemctl --user daemon-reload
systemctl --user enable --now chattering
# Keep the user manager (and this service) alive without an open shell.
loginctl enable-linger "$USER" 2>/dev/null || true

# --- 5. health check ---------------------------------------------------------
ok=""
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "The server did not answer on port $PORT. See: journalctl --user -u chattering -n 50" >&2
  exit 1
fi

if grep -qi microsoft /proc/version 2>/dev/null; then
  PORT="$PORT" bash "$REPO/windows/install-from-wsl.sh"
fi

echo
echo "Chattering is running → http://localhost:$PORT"
echo
echo "Next steps:"
echo "  1. Open http://localhost:$PORT in Chrome or Edge."
if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "     Use the Windows desktop Chattering shortcut. It starts WSL automatically."
fi
echo "  2. Install it as an app: browser menu → 'Install Chattering' (or 'Install app')."
echo "     This gives an own window, own icon, and a launcher entry."
echo "  3. Optional: settings → semantic search. Enable it, set the server URL,"
echo "     and keep the namespace (default: your username). One namespace per user."
