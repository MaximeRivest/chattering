#!/usr/bin/env bash
# Publish the Android app built by scripts/build-android.sh (design/85).
#
#   scripts/publish-android.sh
#
# Uploads dist/Chattering-android.apk and its checksum to the GitHub release
# "android" (the address the pairing pages and the app's update offer link
# to never changes), and rewrites that release's title and notes from the
# file itself: the version, its SHA-256, the signing certificate and the
# commit. Uploading alone left the page saying "0.3.2" over a 0.3.5 file, so
# nobody could tell a new version was there. Also copies the APK to the
# checkout's chattering.apk, which this computer serves at /chattering.apk.
#
# Refuses an APK whose version is not package.json's androidApp (the one
# computers offer, app.html androidAppUpdate), or one not signed with the
# release key (it would not install over the app people have).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
if [ -z "${ANDROID_HOME:-}" ] || ! command -v apksigner >/dev/null; then
  exec nix develop "$ROOT/android" -c "$0" "$@"
fi
REPO=MaximeRivest/chattering
APK=dist/Chattering-android.apk
CERT=7358d6f47c732793ce0f305604404d73971e532447684a51078287037ffe7dbf
[ -f "$APK" ] || { echo "no $APK: run scripts/build-android.sh first" >&2; exit 1; }

WANT=$(node -p "require('./package.json').androidApp")
HAVE=$("$ANDROID_HOME/build-tools/35.0.0/aapt2" dump badging "$APK" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)
[ "$HAVE" = "$WANT" ] || { echo "$APK is $HAVE, package.json androidApp is $WANT: rebuild" >&2; exit 1; }
apksigner verify --print-certs "$APK" | grep -q "SHA-256 digest: $CERT" || { echo "$APK is not signed with the release key" >&2; exit 1; }

COMMIT=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain android anywhere package.json)" ] || echo "note: android/, anywhere/ or package.json has uncommitted changes; the notes name $COMMIT" >&2
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
(cd dist && sha256sum Chattering-android.apk > Chattering-android.apk.sha256)
CERT_COLONS=$(echo "$CERT" | tr a-f A-F | sed 's/../&:/g; s/:$//')

NOTES=$(mktemp)
trap 'rm -f "$NOTES"' EXIT
cat > "$NOTES" <<EOF
**Chattering for Android $WANT (alpha).** Your Chattering on your phone, from anywhere, over an encrypted link to your own computer.

**Install**
1. Download \`Chattering-android.apk\` below on your Android phone and open it. Android asks you to allow installs from your browser, and may warn that the app is unknown: it is not on the Play Store yet.
2. On your computer: Chattering → Settings → Machines → **Add a device**.
3. Scan the code with the phone's camera. Without the app, the page offers it: the first tap downloads it and copies the code; install it and open it, and it offers to pair (or tap the page's button again). With the app, the code opens in it; the app can also scan codes itself.

**Updating:** download the same file again and open it: it installs over the app you have and keeps your pairing and settings. From 0.3.6 the app tells you itself when your computer knows a newer one (and Settings → this device shows it). Had an earlier test build signed with another key? Uninstall it first: Android refuses to update across keys.

**Check what you installed**
- Version: $WANT
- APK SHA-256: \`$SHA\`
- Signing certificate SHA-256: \`$CERT_COLONS\` (\`apksigner verify --print-certs Chattering-android.apk\`)
- Built from commit $COMMIT (\`scripts/build-android.sh\`).

**Not yet in this alpha:** downloads and background notifications over the encrypted link (both work with a direct server address); updates are not automatic.
EOF

gh release upload android "$APK" dist/Chattering-android.apk.sha256 --clobber -R "$REPO"
gh release edit android -R "$REPO" --title "Chattering for Android $WANT (alpha)" --notes-file "$NOTES"
cp "$APK" chattering.apk
echo "published Chattering for Android $WANT ($SHA)"
