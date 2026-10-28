import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyLeanPrefs, leanFlags } from './lib/lean-profile.mjs';

const args = process.argv.slice(2);
const options = new Set(args.filter(arg => arg.startsWith('--')));
const [mode = 'extension', scenario] = args.filter(arg => !arg.startsWith('--'));
const known = new Set(['--reader', '--freeze', '--no-energy-saver', '--energy-saver-always']);
if (!['baseline', 'native', 'extension', 'lean'].includes(mode) || (scenario && !['five', 'twenty'].includes(scenario)) ||
  [...options].some(option => !known.has(option)) || (options.size && mode !== 'lean')) {
  throw new Error('Usage: npm run open:lab -- [baseline|native|extension|lean] [five|twenty] [--reader] [--freeze] [--no-energy-saver|--energy-saver-always]\n' +
    'Lean options apply only to lean. Energy Saver defaults to "on battery".');
}
const profile = resolve(`artifacts/profiles/${mode}`);
await mkdir(profile, { recursive: true });
let running = false;
try { execFileSync('pgrep', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' }); running = true; } catch {}
if (mode === 'lean') {
  if (running) console.log('Lean profile is already running: its preferences were not rewritten. Quit it fully and run again to apply them.');
  else await applyLeanPrefs(profile, { energySaver: options.has('--no-energy-saver') ? 'off' : options.has('--energy-saver-always') ? 'always' : 'battery' });
}
const urls = scenario ? Array.from({ length: scenario === 'five' ? 5 : 20 }, (_, i) => `http://127.0.0.1:8917/page/${i + 1}`) : ['chrome://extensions'];
const child = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  ...(mode === 'lean' ? leanFlags({ reader: options.has('--reader'), freeze: options.has('--freeze') }) : []), ...urls
], { detached: true, stdio: 'ignore' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
console.log(`Chrome Lab (${mode}) PID: ${child.pid}\nProfile: ${profile}\nLoad unpacked extension from: ${resolve('dist')}`);
console.log('If this profile was already running, Chrome forwards URLs to that process; find its existing PID for measurements.');
