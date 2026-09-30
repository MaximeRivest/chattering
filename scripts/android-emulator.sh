#!/usr/bin/env bash
# A headless Android 15 emulator for testing the app (design/85), with the
# tools from android/flake.nix. Its phone lives in ~/.cache/chattering-android.
#
#   scripts/android-emulator.sh start     boot it (a user service), wait until ready
#   scripts/android-emulator.sh install   install dist/Chattering-android.apk
#   scripts/android-emulator.sh shot F    a screenshot to F (png)
#   scripts/android-emulator.sh stop
#   scripts/android-emulator.sh adb …     adb, pointed at it
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
if [ -z "${ANDROID_HOME:-}" ]; then exec nix develop "$ROOT/android" -c "$0" "$@"; fi
STATE="${XDG_CACHE_HOME:-$HOME/.cache}/chattering-android"
export ANDROID_USER_HOME="$STATE/user" ANDROID_AVD_HOME="$STATE/avd" ANDROID_EMULATOR_HOME="$STATE/user"
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
AVD=chattering-phone
PORT=5584
SERIAL="emulator-$PORT"
UNIT=chattering-android-emulator
A() { adb -s "$SERIAL" "$@"; }

case "${1:-}" in
  start)
    if [ ! -d "$ANDROID_AVD_HOME/$AVD.avd" ]; then
      # (avdmanager complains that the image has no devices.xml; the profile comes from its own list.)
      echo no | avdmanager -s create avd -n "$AVD" -k "system-images;android-35;google_apis;x86_64" -d pixel_6 >/dev/null 2>&1
      # A phone-sized screen and enough memory for a WebView app.
      printf 'hw.ramSize=4096\nhw.keyboard=yes\ndisk.dataPartition.size=4G\n' >> "$ANDROID_AVD_HOME/$AVD.avd/config.ini"
    fi
    if ! systemctl --user is-active --quiet "$UNIT"; then
      systemctl --user reset-failed "$UNIT" 2>/dev/null || true
      systemd-run --user --unit="$UNIT" --collect \
        -E ANDROID_HOME -E ANDROID_SDK_ROOT="$ANDROID_HOME" -E ANDROID_USER_HOME -E ANDROID_AVD_HOME -E ANDROID_EMULATOR_HOME \
        "$(command -v emulator)" -avd "$AVD" -port "$PORT" -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect >/dev/null
    fi
    adb start-server >/dev/null 2>&1
    for i in $(seq 1 120); do
      [ "$(A shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && { echo "ready ($SERIAL, after ~$((i * 2))s)"; exit 0; }
      sleep 2
    done
    echo "the emulator did not boot; journalctl --user -u $UNIT" >&2; exit 1 ;;
  install)
    A install -r "$ROOT/dist/Chattering-android.apk" ;;
  shot)
    A exec-out screencap -p > "${2:?file}" ;;
  stop)
    systemctl --user stop "$UNIT" 2>/dev/null || true ;;
  adb)
    shift; A "$@" ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
