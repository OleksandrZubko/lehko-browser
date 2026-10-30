#!/usr/bin/env bash
# Applies patches/series to a Chromium src checkout, or with --check only verifies that
# every patch applies cleanly. Any patch that does not apply fails the run: a silently
# skipped patch would cost a full day-long build that does not contain our change.
#
# Usage: ci/apply-patches.sh <chromium-src-dir> [--check]
#        ci/apply-patches.sh --list   # prints the files the series touches
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "$0")/../patches" && pwd)"
# Portable to the bash 3.2 that ships with macOS (no mapfile).
PATCHES=()
while IFS= read -r line; do
  PATCHES+=("$line")
done < <(sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$PATCH_DIR/series" | grep -v '^$')

if [[ "${1:-}" == "--list" ]]; then
  for p in "${PATCHES[@]}"; do
    sed -n 's|^+++ b/||p' "$PATCH_DIR/$p" | cut -f1
  done | sort -u
  exit 0
fi

SRC="${1:?usage: apply-patches.sh <chromium-src-dir> [--check]}"
MODE="${2:-apply}"
cd "$SRC"

for p in "${PATCHES[@]}"; do
  echo "Checking $p..."
  if git apply --check -p1 "$PATCH_DIR/$p" 2>/dev/null; then
    if [[ "$MODE" != "--check" ]]; then
      git apply -p1 "$PATCH_DIR/$p"
      echo "Applied $p"
    else
      echo "Can apply $p"
    fi
  elif git apply --reverse --check -p1 "$PATCH_DIR/$p" 2>/dev/null; then
    echo "Already applied $p"
  else
    echo "Failed to check or apply $p:"
    git apply --check -p1 "$PATCH_DIR/$p"
    exit 1
  fi
done
echo "${#PATCHES[@]} patch(es) OK"
