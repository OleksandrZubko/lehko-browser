#!/usr/bin/env bash
# Packages Chromium.app / Lehko.app into a distributable DMG installer
set -euo pipefail

APP_PATH="${1:-out/Release/Chromium.app}"
OUTPUT_DMG="${2:-Lehko-arm64.dmg}"
APP_NAME="Lehko.app"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: $APP_PATH does not exist"
  exit 1
fi

STAGING_DIR="$(mktemp -d /tmp/lehko-dmg-XXXXXX)"
trap 'rm -rf "$STAGING_DIR"' EXIT

echo "Staging $APP_NAME into $STAGING_DIR..."
cp -R "$APP_PATH" "$STAGING_DIR/$APP_NAME"

# Ad-hoc sign the app bundle
echo "Ad-hoc signing $APP_NAME..."
codesign --force --deep --sign - "$STAGING_DIR/$APP_NAME" || true

# Add Applications symlink
ln -s /Applications "$STAGING_DIR/Applications"

echo "Creating $OUTPUT_DMG..."
rm -f "$OUTPUT_DMG"
hdiutil create -volname "Lehko" -srcfolder "$STAGING_DIR" -ov -format UDZO "$OUTPUT_DMG"

echo "=== Successfully created $OUTPUT_DMG ==="
ls -lh "$OUTPUT_DMG"
