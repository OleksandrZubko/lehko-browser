#!/usr/bin/env bash
# Wraps a Chromium.app (an ungoogled-chromium release or our own build) into Lehko.app and a DMG.
# The extension, lean prefs and lean flags come from dist/ and scripts/lib/lean-profile.mjs, so the
# DMG matches what the benchmarks measured.
#
# Usage: ci/package-dmg.sh [Chromium.app] [output.dmg] [extension dir]
set -euo pipefail

SRC_APP="${1:-chromium_src/src/out/Release/Chromium.app}"
OUTPUT_DMG="${2:-Lehko-arm64.dmg}"
EXT_DIR="${3:-dist}"
CI_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$CI_DIR")"

[[ -d "$SRC_APP" ]] || { echo "Error: source app $SRC_APP does not exist"; exit 1; }
[[ -f "$EXT_DIR/manifest.json" ]] || { echo "Error: no built extension in $EXT_DIR (run npm run build)"; exit 1; }

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lehko-dmg-XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT

TARGET_APP="$STAGING_DIR/Lehko.app"
CONTENTS="$TARGET_APP/Contents"
RESOURCES="$CONTENTS/Resources"
LEHKO="$RESOURCES/lehko"
BROWSER="$(basename "$SRC_APP")"
VERSION="$(plutil -extract version raw "$EXT_DIR/manifest.json")"
BROWSER_VERSION="$(plutil -extract CFBundleShortVersionString raw "$SRC_APP/Contents/Info.plist")"

# Lehko.app is a launcher around the untouched browser: its vendor signature stays intact, so
# ungoogled-chromium keeps its notarization, and Keychain access and camera/microphone grants
# survive updates. Modifying the bundle would force an ad-hoc re-sign and lose all three.
echo "Embedding $BROWSER $BROWSER_VERSION..."
mkdir -p "$CONTENTS/MacOS" "$LEHKO"
ditto "$SRC_APP" "$RESOURCES/$BROWSER"
cp "$SRC_APP/Contents/Resources/app.icns" "$RESOURCES/app.icns"

echo "Embedding extension, lean prefs and flags..."
cp -R "$EXT_DIR" "$LEHKO/extension"
cp "$CI_DIR/merge-prefs.js" "$LEHKO/merge-prefs.js"
node --input-type=module -e "
  import { writeFileSync } from 'node:fs';
  import { leanFlags, leanPrefs } from '$REPO_DIR/scripts/lib/lean-profile.mjs';
  writeFileSync('$LEHKO/flags.txt', leanFlags().join('\n') + '\n');
  writeFileSync('$LEHKO/prefs.json', JSON.stringify(leanPrefs()));
"

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>lehko</string>
  <key>CFBundleIdentifier</key><string>ua.lehko.browser</string>
  <key>CFBundleName</key><string>Легко</string>
  <key>CFBundleDisplayName</key><string>Легко</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF

cat > "$CONTENTS/MacOS/lehko" <<EOF
#!/bin/zsh
# Легко $VERSION: $BROWSER $BROWSER_VERSION with the lean profile and the built-in Легко extension.
set -eu
resources="\${0:A:h:h}/Resources"
lehko="\$resources/lehko"
data="\$HOME/Library/Application Support/Lehko Browser"
profile="\$data/Profile"
# A fixed copy outside the bundle: the unpacked extension ID depends on its path, and its data on the ID.
extension="\$data/extension"
mkdir -p "\$profile/Default" "\$extension"
# Chromium rewrites its prefs on exit, so they are applied and the extension refreshed only while closed.
if ! pgrep -qf -- "--user-data-dir=\$profile"; then
  /usr/bin/osascript -l JavaScript "\$lehko/merge-prefs.js" "\$profile" "\$lehko/prefs.json"
  /usr/bin/rsync -a --delete "\$lehko/extension/" "\$extension/"
fi
args=(--user-data-dir="\$profile" --no-first-run --no-default-browser-check --load-extension="\$extension" \${(f)"\$(<"\$lehko/flags.txt")"})
# -n: a second process for the same profile hands off to the running one and exits.
open -na "\$resources/$BROWSER" --args \$args "\$@"
EOF
chmod +x "$CONTENTS/MacOS/lehko"

# Signs only the launcher bundle ad-hoc; the embedded browser keeps its own signature.
echo "Ad-hoc signing Lehko.app..."
# codesign refuses bundles with extended attributes such as quarantine from the download;
# the embedded browser's signatures are inside its binaries, so clearing them is safe.
xattr -cr "$TARGET_APP"
codesign --force --sign - "$TARGET_APP"
codesign --verify --strict "$TARGET_APP"

echo "Creating $OUTPUT_DMG..."
ln -s /Applications "$STAGING_DIR/Applications"
rm -f "$OUTPUT_DMG"
hdiutil create -volname "Легко" -srcfolder "$STAGING_DIR" -ov -format UDZO "$OUTPUT_DMG"
ls -lh "$OUTPUT_DMG"
