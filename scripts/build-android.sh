#!/usr/bin/env bash
# Build the Android app and sign it with Rockfrog's release key (design/85).
#
#   scripts/build-android.sh            → dist/Chattering-android.apk (release, signed)
#   BUILD_HOST=xpswhite scripts/build-android.sh
#
# The Android SDK lives on the laptop, the release key on this machine:
# android/ and anywhere/ are copied there and built (unsigned), the APK
# comes back and is signed here. The key never leaves this machine.
#
# The key: ~/.config/chattering-release/android-release.jks, its password in
# android-release.pass beside it (both 0600). Losing it means no update can
# ever be installed over the app people have; keep an offline copy.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
HOST="${BUILD_HOST:-XPSwhite}"
KEYDIR="${CHATTERING_RELEASE_DIR:-$HOME/.config/chattering-release}"
KS="$KEYDIR/android-release.jks"
[ -f "$KS" ] && [ -f "$KEYDIR/android-release.pass" ] || { echo "no release key in $KEYDIR" >&2; exit 1; }
REMOTE=/tmp/chattering-android-build
OUT="$ROOT/dist/Chattering-android.apk"
mkdir -p "$ROOT/dist"

echo "copying android/ and anywhere/ to $HOST"
ssh -o BatchMode=yes "$HOST" "rm -rf $REMOTE && mkdir -p $REMOTE"
tar -C "$ROOT" --exclude=android/app/build --exclude=android/.gradle --exclude=android/local.properties -cf - android anywhere \
  | ssh -o BatchMode=yes "$HOST" "tar -C $REMOTE -xf -"

echo "building (unsigned release) on $HOST"
ssh -o BatchMode=yes "$HOST" "bash -lc '
  set -euo pipefail
  cd $REMOTE/android
  SDK=\$HOME/Android/Sdk
  echo sdk.dir=\$SDK > local.properties
  export JAVA_HOME=\$(nix build --no-link --print-out-paths nixpkgs#jdk17_headless)/lib/openjdk
  export ANDROID_HOME=\$SDK
  timeout 1500 ./gradlew --no-daemon -q -Pandroid.aapt2FromMavenOverride=\$SDK/build-tools/35.0.0/aapt2 clean assembleRelease > build.log 2>&1 || { tail -40 build.log; exit 1; }
  APK=app/build/outputs/apk/release/app-release-unsigned.apk
  \$SDK/build-tools/35.0.0/zipalign -c -P 16 4 \$APK || { \$SDK/build-tools/35.0.0/zipalign -f -P 16 4 \$APK \$APK.aligned && mv \$APK.aligned \$APK; }
'"
UNSIGNED=$(mktemp --suffix=.apk)
scp -q "$HOST:$REMOTE/android/app/build/outputs/apk/release/app-release-unsigned.apk" "$UNSIGNED"

echo "signing here with the release key"
nix shell nixpkgs#apksigner -c apksigner sign --ks "$KS" --ks-key-alias chattering --ks-pass "file:$KEYDIR/android-release.pass" --out "$OUT" "$UNSIGNED"
rm -f "$UNSIGNED" "$OUT.idsig"
nix shell nixpkgs#apksigner -c apksigner verify --print-certs "$OUT" | grep -E "SHA-256|Signer #1 certificate DN"
sha256sum "$OUT" | tee "$OUT.sha256"
ls -la "$OUT"
