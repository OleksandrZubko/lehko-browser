#!/usr/bin/env bash
# Cleans up unnecessary SDKs and tools on GitHub Actions macOS runner to ensure 60+ GB free disk space
# while strictly preserving and activating the latest full Xcode for compilation.
set -euo pipefail

echo "=== Disk space before cleanup ==="
df -h /

echo "Cleaning up large unused tools and SDKs..."
sudo rm -rf /Users/runner/Library/Android || true
sudo rm -rf /Library/Android || true
sudo rm -rf /opt/homebrew/Caskroom/android-platform-tools || true
sudo rm -rf /Users/runner/.dotnet || true
sudo rm -rf /usr/local/share/dotnet || true
sudo rm -rf /Library/Frameworks/Mono.framework || true

# Find the newest available Xcode and activate it
LATEST_XCODE=$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -n 1 || true)
if [[ -n "$LATEST_XCODE" && -d "$LATEST_XCODE" ]]; then
  echo "Setting active developer directory to: $LATEST_XCODE"
  sudo xcode-select -s "$LATEST_XCODE/Contents/Developer"
  sudo xcodebuild -license accept 2>/dev/null || true

  for xcode_app in /Applications/Xcode*.app; do
    if [[ -d "$xcode_app" && "$xcode_app" != "$LATEST_XCODE" ]]; then
      echo "Removing secondary Xcode to free disk space: $xcode_app..."
      sudo rm -rf "$xcode_app" || true
    fi
  done
else
  echo "Notice: No /Applications/Xcode*.app found, keeping current: $(xcode-select -p)"
fi

echo "=== Active Xcode & SDK Info ==="
echo "Active developer directory: $(xcode-select -p)"
xcodebuild -version || true
xcrun --show-sdk-path --sdk macosx || true

echo "=== Disk space after cleanup ==="
df -h /
