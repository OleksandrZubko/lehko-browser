# Lehko Chromium Patches & GN Configuration

This directory contains build-time patches and configuration files applied to Chromium during the GitHub Actions CI build for macOS Apple Silicon (`arm64`).

## Files

1. **`args.gn`**:
   - Production flags optimized for low memory and CPU usage.
   - Disables unnecessary Google background daemons (Cast discovery, Lens, On-device models, crash reporting).
   - `symbol_level = 0` to speed up linking and keep the binary slim.
   - Enables proprietary codecs (H.264, AAC, VP9) for full web media compatibility.

2. **`01-disable-av1.patch`**:
   - Patches `media/base/supported_types.cc`.
   - Prevents advertising AV1 codec capabilities to web pages.
   - YouTube and streaming services automatically deliver hardware-accelerated VP9 / H.264 streams, saving 20-25% CPU on Apple Silicon M1/M2/M3 chips and preserving battery life.
