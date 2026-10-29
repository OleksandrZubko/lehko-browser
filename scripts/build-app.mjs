// Builds artifacts/Легко.app: a launcher for the installed Chrome Stable with the lean profile and the
// Легко extension. Chrome keeps its own updates and Safe Browsing; no Chromium download or build.
//
// With --cft [path] it builds artifacts/Легко Browser.app instead: a self-contained browser around a
// Chrome for Testing build, which still accepts --load-extension, so the extension is built in and
// needs no Developer mode. Chrome for Testing has no auto-update: rebuild on each stable release.
import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { leanFlags, leanPrefs } from './lib/lean-profile.mjs';

const CFT_DEFAULT = 'artifacts/chrome-for-testing/156.0.8078.73/chrome-mac-arm64/Google Chrome for Testing.app';
const cftIndex = process.argv.indexOf('--cft');
const cft = cftIndex < 0 ? null
  : resolve(process.argv[cftIndex + 1] && !process.argv[cftIndex + 1].startsWith('--') ? process.argv[cftIndex + 1] : CFT_DEFAULT);
if (cft) await access(join(cft, 'Contents', 'Info.plist')).catch(() => {
  throw new Error(`Chrome for Testing not found at ${cft}`);
});

const manifest = (await import('../dist/manifest.json', { with: { type: 'json' } })).default;
const name = cft ? 'Легко Browser' : 'Легко';
const app = resolve(`artifacts/${name}.app`);
const contents = join(app, 'Contents'), resources = join(contents, 'Resources');
await rm(app, { recursive: true, force: true });
await mkdir(join(contents, 'MacOS'), { recursive: true });
await cp(resolve('dist'), join(resources, 'extension'), { recursive: true });
await writeFile(join(resources, 'prefs.json'), JSON.stringify(leanPrefs()));
await writeFile(join(resources, 'flags.txt'), leanFlags().join('\n') + '\n');
// cp -c clones on APFS, so the embedded browser takes no extra disk space.
if (cft) await promisify(execFile)('cp', ['-cR', cft, join(resources, basename(cft))]);

await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>lehko</string>
  <key>CFBundleIdentifier</key><string>${cft ? 'ua.lehko.browser' : 'ua.lehko.launcher'}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${manifest.version}</string>
  <key>CFBundleVersion</key><string>${manifest.version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);

// Merges the lean prefs into Local State / Preferences. JXA ships with macOS, so the app needs no Node.
await writeFile(join(resources, 'prefs.js'), `ObjC.import('Foundation');
function read(path) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  return text.isNil() ? null : ObjC.unwrap(text);
}
function deep(target, source) {
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deep(target[key], value);
    } else target[key] = value;
  }
}
function merge(path, patch) {
  let data = {};
  try { data = JSON.parse(read(path) || '{}'); } catch (error) {}
  deep(data, patch);
  $(JSON.stringify(data)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}
function run(argv) {
  const prefs = JSON.parse(read(argv[1]));
  merge(argv[0] + '/Local State', prefs.localState);
  merge(argv[0] + '/Default/Preferences', prefs.preferences);
}
`);

const launcher = join(contents, 'MacOS', 'lehko');
await writeFile(launcher, cft ? cftLauncher() : `#!/bin/zsh
# Легко ${manifest.version}: Chrome Stable with the lean profile and the Легко extension.
set -eu
chrome_app="/Applications/Google Chrome.app"
resources="\${0:A:h:h}/Resources"
data="$HOME/Library/Application Support/Lehko"
profile="$data/Profile"
if [[ ! -d "$chrome_app" ]]; then
  osascript -e 'display alert "Легко" message "Потрібен Google Chrome у папці «Програми»."'
  exit 1
fi
first_run=0
[[ -d "$profile" ]] || first_run=1
mkdir -p "$profile/Default" "$data/extension"
# Chrome rewrites its prefs on exit, so they are applied and the extension refreshed only while closed.
if ! pgrep -qf -- "--user-data-dir=$profile"; then
  /usr/bin/osascript -l JavaScript "$resources/prefs.js" "$profile" "$resources/prefs.json"
  /usr/bin/rsync -a --delete "$resources/extension/" "$data/extension/"
fi
args=(--user-data-dir="$profile" --no-first-run --no-default-browser-check \${(f)"$(<"$resources/flags.txt")"})
# -n: a second process for the same profile hands off to the running one and exits.
if (( first_run )); then
  open -na "$chrome_app" --args $args chrome://extensions
  osascript -e "set p to \\"$data/extension\\"" \\
    -e 'set r to display dialog "Один раз: увімкніть Developer mode, натисніть Load unpacked і виберіть папку" & return & p buttons {"Скопіювати шлях", "Готово"} default button 1 with title "Легко"' \\
    -e 'if button returned of r is "Скопіювати шлях" then set the clipboard to p'
else
  open -na "$chrome_app" --args $args
fi
`);
await chmod(launcher, 0o755);

function cftLauncher() {
  return `#!/bin/zsh
# ${name} ${manifest.version}: Chrome for Testing with the lean profile and the built-in Легко extension.
set -eu
resources="\${0:A:h:h}/Resources"
browser="$resources/${basename(cft)}"
data="$HOME/Library/Application Support/Lehko"
profile="$data/Browser"
extension="$data/browser-extension"
mkdir -p "$profile/Default" "$extension"
# Chrome rewrites its prefs on exit, so they are applied and the extension refreshed only while closed.
if ! pgrep -qf -- "--user-data-dir=$profile"; then
  /usr/bin/osascript -l JavaScript "$resources/prefs.js" "$profile" "$resources/prefs.json"
  /usr/bin/rsync -a --delete "$resources/extension/" "$extension/"
fi
args=(--user-data-dir="$profile" --no-first-run --no-default-browser-check --load-extension="$extension" \${(f)"$(<"$resources/flags.txt")"})
# -n: a second process for the same profile hands off to the running one and exits.
open -na "$browser" --args $args "$@"
`;
}
console.log(`Built ${app}\nInstall: cp -R "${app}" ~/Applications/`);
