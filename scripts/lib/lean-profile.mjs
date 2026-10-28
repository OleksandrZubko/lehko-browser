// Lean Chrome profile: built-in savings switched to their strongest setting plus
// switches for features this lab does not use. Pref names and values were checked
// against Chrome 156 through chrome.settingsPrivate on chrome://settings/performance.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEAN_FEATURES_OFF = [
  'SpareRendererForSitePerProcess', // no idle pre-started renderer process
  'MediaRouter',                    // Cast discovery and its background polling
  'OnDeviceModelBackgroundDownload',// no multi-GB on-device AI model download
  'LensOverlay', 'Compose', 'OptimizationHints'
];

// Long background session (docs/LONG_REPORT.md): −3% footprint, background CPU and tab resume unchanged.
export const LEAN_FEATURES_ON = [
  'CompressParkableStrings',      // compress large JS source strings of background tabs
  'MemorySaverModeRenderTuning'   // renderer-side Memory Saver tuning
];

// Freezes background tabs: less renderer CPU; −11% footprint in 6 of 7 runs, none in the last one. One tab
// in 105 did not repaint within 30 s after returning to it. Opt-in until both are explained.
// MemoryPurgeOnFreeze is left out on purpose: it more than doubled steady renderer CPU.
const FREEZE_FEATURES = ['InfiniteTabsFreezing'];

export function leanFlags({ reader = false, freeze = false } = {}) {
  return [
    `--disable-features=${LEAN_FEATURES_OFF.join(',')}`,
    `--enable-features=${[...LEAN_FEATURES_ON, ...(freeze ? FREEZE_FEATURES : [])].join(',')}`,
    '--autoplay-policy=document-user-activation-required',
    '--no-pings',
    // Interpreter-only V8: less memory, slower JavaScript. Opt-in for reading.
    ...(reader ? ['--js-flags=--lite-mode'] : [])
  ];
}

async function merge(file, patch) {
  let data = {};
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch {}
  const deep = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) deep(target[key] ??= {}, value);
      else target[key] = value;
    }
  };
  deep(data, patch);
  await writeFile(file, JSON.stringify(data));
}

// Energy Saver 'always' caps rendering at 30 fps: 12.5% dropped frames on 60 fps video (docs/AB_REPORT.md).
const ENERGY_SAVER = { always: 3, battery: 2, off: 0 };
export function leanPrefs({ energySaver = 'battery' } = {}) {
  if (!(energySaver in ENERGY_SAVER)) throw new Error(`energySaver must be one of ${Object.keys(ENERGY_SAVER).join(', ')}`);
  return {
    localState: {
      background_mode: { enabled: false },
      performance_tuning: {
        high_efficiency_mode: { state: 1, aggressiveness: 2 }, // Memory Saver: Maximum
        battery_saver_mode: { state: ENERGY_SAVER[energySaver] }
      }
    },
    preferences: { net: { network_prediction_options: 2 } } // no preloading
  };
}

// Must run while the profile is closed: Chrome rewrites both files on exit.
export async function applyLeanPrefs(profile, options) {
  const prefs = leanPrefs(options);
  await mkdir(join(profile, 'Default'), { recursive: true });
  await merge(join(profile, 'Local State'), prefs.localState);
  await merge(join(profile, 'Default', 'Preferences'), prefs.preferences);
}
