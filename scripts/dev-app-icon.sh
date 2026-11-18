#!/usr/bin/env bash
# Give the dev Electron.app bundle the double0 icon and name, so macOS surfaces
# that read the BUNDLE - notification banners, Finder, the Dock label - show our
# branding instead of "Electron". (The dock/app-switcher icon is already set at
# runtime via app.dock.setIcon; notifications and the Dock name ignore that.)
# The dev bundle is by definition the local environment, so it gets the RED
# icon (build/icon-dev.png, derived by scripts/derive-dev-icon.py) - the same
# one src/main/app-icon.ts picks at runtime - and stays distinguishable from
# the installed release in the Dock. Packaged builds don't need this -
# electron-builder stamps build/icon.png + productName.
#
# Runs from postinstall (via scripts/dev-app-icon.mjs): reinstalling the
# electron package restores the stock bundle, and this re-applies the logo.
# No-op off macOS, under CI (a build runner never launches the dev bundle, and
# codesign under a locked login keychain could block on a prompt) or before
# electron's dist download exists.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0
[ -z "${CI:-}" ] || exit 0
APP="node_modules/electron/dist/Electron.app"
ICNS="$APP/Contents/Resources/electron.icns"
SRC="build/icon-dev.png"
# postinstall can run before electron's own install script has downloaded the
# dist zip - then the stock bundle would appear later, unpatched and unsigned
# (macOS 26 silently drops notifications from it). Fetch it now instead.
if [ ! -f "$ICNS" ] && [ -f "node_modules/electron/install.js" ]; then
  node node_modules/electron/install.js || true
fi
{ [ -f "$ICNS" ] && [ -f "$SRC" ]; } || exit 0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ICONSET="$TMP/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$TMP/icon.icns"

# Swap the icon and bundle name, then re-seal: editing the bundle breaks its
# code signature and macOS would refuse to launch it. Sign with a real Apple
# Development identity when the keychain has one - macOS 26's UserNotifications
# framework refuses banners (and even the permission prompt) for ad-hoc-signed
# apps, and a stable team identity keeps the granted permission across
# re-signs. Ad-hoc is the fallback for machines without a certificate. If
# signing fails, put everything back so the bundle stays runnable.
# Sorted pick: keychain enumeration order is not stable, and the notification
# permission is keyed to the signing identity - flapping between certs would
# shed it on every reinstall.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null |
  awk -F'"' '/Apple Development/ { print $2 }' | sort | head -n 1)"
IDENTITY="${IDENTITY:--}"
PLIST="$APP/Contents/Info.plist"
cp "$ICNS" "$TMP/electron.icns.bak"
cp "$PLIST" "$TMP/Info.plist.bak"
rm -f "$ICNS"
cp "$TMP/icon.icns" "$ICNS"
for key in CFBundleName CFBundleDisplayName; do
  /usr/libexec/PlistBuddy -c "Set :$key double0" "$PLIST" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :$key string double0" "$PLIST"
done
if ! codesign --force --deep --sign "$IDENTITY" "$APP" >/dev/null 2>&1; then
  rm -f "$ICNS"
  cp "$TMP/electron.icns.bak" "$ICNS"
  cp "$TMP/Info.plist.bak" "$PLIST"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
  echo "dev-app-icon: re-signing failed; kept the stock Electron icon + name" >&2
  exit 1
fi
touch "$APP"
echo "dev-app-icon: Electron.app patched + signed ($IDENTITY)"
