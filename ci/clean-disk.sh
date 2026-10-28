#!/usr/bin/env bash
# Cleans up unnecessary SDKs and tools on GitHub Actions macOS runner to ensure 60+ GB free disk space
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

# Remove unused secondary Xcode versions, keep current default
CURRENT_XCODE=$(xcode-select -p)
echo "Keeping active Xcode: $CURRENT_XCODE"
for xcode_app in /Applications/Xcode_*.app; do
  if [[ -d "$xcode_app" && "$xcode_app" != *"$CURRENT_XCODE"* ]]; then
    echo "Removing $xcode_app..."
    sudo rm -rf "$xcode_app" || true
  fi
done

echo "=== Disk space after cleanup ==="
df -h /
