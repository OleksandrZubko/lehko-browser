# Lehko Chromium Patches & GN Configuration

This directory contains build-time patches and configuration files applied to Chromium during the GitHub Actions CI build for macOS Apple Silicon (`arm64`). The pinned Chromium version is the `chromium_version` default in `.github/workflows/build-chromium.yml` (currently `156.0.8078.83`).

## Files

1. **`series`**: the patches to apply, in order. `ci/apply-patches.sh` reads it, and the build fails if any patch does not apply cleanly. Builds no longer skip a patch silently.

2. **`args.gn`**:
   - Production flags optimized for low memory and CPU usage.
   - Disables unnecessary Google background daemons (Cast discovery, Lens, On-device models, crash reporting).
   - `symbol_level = 0` to speed up linking and keep the binary slim.
   - Enables proprietary codecs (H.264, AAC, VP9) for full web media compatibility.
   - `google_api_key` is empty, so **Safe Browsing gets no list updates** in this build. A key from a CI secret is required before daily use.

3. **`01-disable-av1.patch`**:
   - Patches `IsDecoderAV1Supported()` in `media/base/supported_types.cc`, so macOS no longer reports AV1 decode support to web pages.
   - Apple Silicon M1/M2 have no AV1 hardware decoder, so sites such as YouTube fall back to hardware-decoded VP9 / H.264. The CPU saving has not been measured in this build yet.

## Checking patches

Before you dispatch a full build (about a day on free runners), confirm that the series applies to the pinned tag:

- In CI, the **Check Lehko patches** workflow runs on every change to `patches/`. It uses a sparse clone that contains only the touched files, so it finishes in minutes.
- Locally, run the same check:

  ```sh
  git clone --depth 1 --filter=blob:none --sparse --branch 156.0.8078.83 https://chromium.googlesource.com/chromium/src.git /tmp/src
  ci/apply-patches.sh --list | git -C /tmp/src sparse-checkout set --no-cone --stdin
  ci/apply-patches.sh /tmp/src --check
  ```

To build unmodified Chromium as the comparison baseline, dispatch **Build Lehko Chromium** with `apply_patches` off.
