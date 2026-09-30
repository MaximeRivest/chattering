#!/usr/bin/env bash
# Build the Android app and sign it with Rockfrog's release key (design/85).
#
#   scripts/build-android.sh      → dist/Chattering-android.apk (release, signed)
#
# The tools come from android/flake.nix (the script enters that shell by
# itself). The build runs in android/ (its build folders are ignored by
# git); the release key stays in ~/.config/chattering-release: the
# keystore android-release.jks and its password in android-release.pass,
# both 0600. Losing the key means no update can ever be installed over the
# app people have: keep an offline copy.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
if [ -z "${ANDROID_HOME:-}" ] || ! command -v apksigner >/dev/null; then
  exec nix develop "$ROOT/android" -c "$0" "$@"
fi
KEYDIR="${CHATTERING_RELEASE_DIR:-$HOME/.config/chattering-release}"
KS="$KEYDIR/android-release.jks"
[ -f "$KS" ] && [ -f "$KEYDIR/android-release.pass" ] || { echo "no release key in $KEYDIR" >&2; exit 1; }
OUT="$ROOT/dist/Chattering-android.apk"
mkdir -p "$ROOT/dist"

echo "building (release, unsigned)"
cd "$ROOT/android"
echo "sdk.dir=$ANDROID_HOME" > local.properties
LOG=$(mktemp)
if ! ./gradlew --no-daemon -q clean assembleRelease > "$LOG" 2>&1; then tail -40 "$LOG"; rm -f "$LOG"; exit 1; fi
rm -f "$LOG"
APK=app/build/outputs/apk/release/app-release-unsigned.apk
ZIPALIGN="$ANDROID_HOME/build-tools/35.0.0/zipalign"
"$ZIPALIGN" -c -P 16 4 "$APK" >/dev/null || { "$ZIPALIGN" -f -P 16 4 "$APK" "$APK.aligned" && mv "$APK.aligned" "$APK"; }

echo "signing with the release key"
apksigner sign --ks "$KS" --ks-key-alias chattering --ks-pass "file:$KEYDIR/android-release.pass" --out "$OUT" "$APK"
rm -f "$OUT.idsig"
apksigner verify --print-certs "$OUT" | grep -E "Signer #1 certificate (DN|SHA-256)"
(cd "$ROOT/dist" && sha256sum Chattering-android.apk | tee Chattering-android.apk.sha256)
ls -la "$OUT"
