#!/usr/bin/env bash
# Packages Chromium into Lehko.app and creates Lehko-arm64.dmg
# Bakes in the extension, initial lean preferences, and memory-saving launch flags
set -euo pipefail

SRC_APP="${1:-chromium_src/out/Release/Chromium.app}"
OUTPUT_DMG="${2:-Lehko-arm64.dmg}"
EXT_DIR="${3:-dist}"

if [[ ! -d "$SRC_APP" ]]; then
  echo "Error: Source app $SRC_APP does not exist"
  exit 1
fi

STAGING_DIR="$(mktemp -d /tmp/lehko-dmg-XXXXXX)"
trap 'rm -rf "$STAGING_DIR"' EXIT

TARGET_APP="$STAGING_DIR/Lehko.app"
echo "Copying $SRC_APP to $TARGET_APP..."
cp -R "$SRC_APP" "$TARGET_APP"

CONTENTS="$TARGET_APP/Contents"
RESOURCES="$CONTENTS/Resources"
MACOS="$CONTENTS/MacOS"

# 1. Embed the built Lehko extension into Resources
if [[ -d "$EXT_DIR" ]]; then
  echo "Embedding built extension from $EXT_DIR into $RESOURCES/extension..."
  rm -rf "$RESOURCES/extension"
  cp -R "$EXT_DIR" "$RESOURCES/extension"
else
  echo "Warning: Extension directory $EXT_DIR not found!"
fi

# 2. Write initial_preferences for first-run lean defaults
echo "Writing initial_preferences..."
cat << 'EOF' > "$RESOURCES/initial_preferences"
{
  "distribution": {
    "skip_first_run_ui": true,
    "show_welcome_page": false,
    "import_bookmarks": false,
    "import_history": false,
    "import_search_engine": false
  },
  "background_mode": { "enabled": false },
  "net": { "network_prediction_options": 2 },
  "performance_tuning": {
    "high_efficiency_mode": { "state": 1, "aggressiveness": 2 },
    "battery_saver_mode": { "state": 2 }
  }
}
EOF

# 3. Rename binary and create launcher wrapper with lean flags & extension
echo "Creating launcher wrapper..."
BIN_NAME="Chromium"
if [[ -f "$MACOS/Chromium" ]]; then
  BIN_NAME="Chromium"
elif [[ -f "$MACOS/Lehko" ]]; then
  BIN_NAME="Lehko"
fi

mv "$MACOS/$BIN_NAME" "$MACOS/${BIN_NAME}-bin"

cat << 'EOF' > "$MACOS/$BIN_NAME"
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$(cd "$DIR/../Resources" && pwd)"
BIN="$DIR/Chromium-bin"
[[ -f "$BIN" ]] || BIN="$DIR/Lehko-bin"

# Lean runtime flags + auto-load built-in extension
FLAGS=(
  "--load-extension=$RESOURCES/extension"
  "--disable-features=SpareRendererForSitePerProcess,MediaRouter,OnDeviceModelBackgroundDownload,LensOverlay,Compose,OptimizationHints"
  "--enable-features=CompressParkableStrings,MemorySaverModeRenderTuning"
  "--autoplay-policy=document-user-activation-required"
  "--no-pings"
)

exec "$BIN" "${FLAGS[@]}" "$@"
EOF
chmod +x "$MACOS/$BIN_NAME"

# 4. Update Info.plist display name
echo "Updating Info.plist display name..."
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Lehko" "$CONTENTS/Info.plist" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Lehko" "$CONTENTS/Info.plist" 2>/dev/null || true

/usr/libexec/PlistBuddy -c "Set :CFBundleName Lehko" "$CONTENTS/Info.plist" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Add :CFBundleName string Lehko" "$CONTENTS/Info.plist" 2>/dev/null || true

# 5. Ad-hoc codesign the entire bundle
echo "Ad-hoc codesigning Lehko.app..."
codesign --force --deep --sign - "$TARGET_APP" || true

# 6. Create DMG installer
echo "Creating $OUTPUT_DMG..."
ln -s /Applications "$STAGING_DIR/Applications"
rm -f "$OUTPUT_DMG"
hdiutil create -volname "Lehko" -srcfolder "$STAGING_DIR" -ov -format UDZO "$OUTPUT_DMG"

echo "=== Successfully created $OUTPUT_DMG with embedded extension & lean flags ==="
ls -lh "$OUTPUT_DMG"
