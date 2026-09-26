#!/bin/sh
# Install Chattering on macOS or Linux, for the person running this (no
# administrator rights, nothing outside the home folder):
#
#   curl -fsSL https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.sh | sh
#
# It downloads the release for this system from GitHub, checks its SHA-256
# against the release's SHA256SUMS, unpacks it beside earlier versions
# (they are kept: chattering-app rollback), adds the commands chattering-app
# (start, stop, update) and chattering (search your conversations), a menu
# entry, and starts Chattering in the browser.
#
#   CHATTERING_VERSION=0.1.0   a given release instead of the latest
#   CHATTERING_NO_START=1      install without starting
#   CHATTERING_DOWNLOAD_BASE   where the files are (a mirror, or a test)
set -eu

REPO="${CHATTERING_REPO:-MaximeRivest/chattering}"
say() { printf '%s\n' "$*"; }
die() { printf 'chattering install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is needed and was not found"; }
need tar
if command -v curl >/dev/null 2>&1; then get() { curl -fsSL "$1" -o "$2"; }; head_url() { curl -fsSLI -o /dev/null -w '%{url_effective}' "$1"; }
elif command -v wget >/dev/null 2>&1; then get() { wget -qO "$2" "$1"; }; head_url() { wget -S --spider "$1" 2>&1 | sed -n 's/^ *Location: //p' | tail -1; }
else die "curl or wget is needed"; fi

case "$(uname -s)" in
  Darwin) OS=macos; APP_HOME="$HOME/Library/Application Support/Chattering/program" ;;
  Linux) OS=linux; APP_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/chattering-program" ;;
  *) die "this system ($(uname -s)) has no Chattering download; on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "this processor ($(uname -m)) has no Chattering download" ;;
esac

VERSION="${CHATTERING_VERSION:-}"
if [ -z "$VERSION" ]; then
  # The latest release, from the page GitHub redirects to (no API quota).
  VERSION="$(head_url "https://github.com/$REPO/releases/latest" | sed -n 's#.*/tag/v\{0,1\}##p')"
  [ -n "$VERSION" ] || die "could not find the latest release of $REPO"
fi
NAME="chattering-$VERSION-$OS-$ARCH"
BASE="${CHATTERING_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/v$VERSION}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
say "Downloading Chattering $VERSION for $OS ($ARCH)…"
get "$BASE/$NAME.tar.gz" "$TMP/$NAME.tar.gz" || die "no download at $BASE/$NAME.tar.gz"
get "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "the release has no SHA256SUMS"
WANT="$(awk -v n="$NAME.tar.gz" '$2 == n { print $1 }' "$TMP/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP/$NAME.tar.gz" | awk '{print $1}')"
else GOT="$(shasum -a 256 "$TMP/$NAME.tar.gz" | awk '{print $1}')"; fi
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || die "the download does not match its checksum; nothing was installed"

mkdir -p "$APP_HOME/versions" "$APP_HOME/bin"
tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
rm -rf "$APP_HOME/versions/$VERSION"
mv "$TMP/$NAME" "$APP_HOME/versions/$VERSION"
[ "$OS" = macos ] && xattr -dr com.apple.quarantine "$APP_HOME/versions/$VERSION" 2>/dev/null || true
if [ -f "$APP_HOME/current.txt" ]; then cp "$APP_HOME/current.txt" "$APP_HOME/previous.txt"; fi
printf '%s\n' "$VERSION" > "$APP_HOME/current.txt"
ln -sfn "versions/$VERSION" "$APP_HOME/current"

# The commands: small scripts that run the current version with its own Node.
for pair in "chattering-app:launcher.js" "chattering:chattering"; do
  cmd="${pair%%:*}"; entry="${pair#*:}"
  cat > "$APP_HOME/bin/$cmd" <<EOF
#!/bin/sh
exec "$APP_HOME/current/runtime/node/bin/node" "$APP_HOME/current/$entry" "\$@"
EOF
  chmod +x "$APP_HOME/bin/$cmd"
done
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
for cmd in chattering-app chattering; do
  if [ -e "$BIN/$cmd" ] && [ ! -L "$BIN/$cmd" ]; then say "Left $BIN/$cmd alone (not ours); use $APP_HOME/bin/$cmd"; continue; fi
  ln -sfn "$APP_HOME/bin/$cmd" "$BIN/$cmd"
done

# A menu entry: a nicety, never a reason to fail (some desktops keep that
# folder read-only, as NixOS with Home Manager does).
menu_entry() {
if [ "$OS" = linux ]; then
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  cat > "$APPS/chattering.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Chattering
Comment=Conversations with AI agents, by Rockfrog
Exec="$APP_HOME/bin/chattering-app"
Icon=$APP_HOME/current/icons/icon-512.png
Terminal=false
Categories=Development;Utility;
EOF
else
  APPDIR="$HOME/Applications/Chattering.app"
  mkdir -p "$APPDIR/Contents/MacOS"
  cat > "$APPDIR/Contents/MacOS/Chattering" <<EOF
#!/bin/sh
exec "$APP_HOME/bin/chattering-app"
EOF
  chmod +x "$APPDIR/Contents/MacOS/Chattering"
  cat > "$APPDIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Chattering</string>
<key>CFBundleIdentifier</key><string>dev.rockfrog.chattering</string>
<key>CFBundleExecutable</key><string>Chattering</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
fi
}
( set -e; menu_entry ) 2>/dev/null || say "No menu entry was added (that folder is not writable here); the chattering-app command works."

say "Chattering $VERSION is installed in $APP_HOME."
case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH to use the chattering-app and chattering commands." ;; esac
if [ "${CHATTERING_NO_START:-}" != 1 ]; then "$APP_HOME/bin/chattering-app"; fi
