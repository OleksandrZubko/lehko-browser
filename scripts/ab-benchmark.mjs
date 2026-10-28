// One A/B run on live sites: stock Chrome vs lean profile, each with and without Легко.
// Raw CDP only: automation libraries add switches that disable background throttling.
// Usage: node scripts/ab-benchmark.mjs <run> <stock|stock-ext|lean|lean-ext>
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectCDP } from './lib/raw-cdp.mjs';
import { applyLeanPrefs, leanFlags } from './lib/lean-profile.mjs';

const [run, config] = process.argv.slice(2);
const CONFIGS = ['stock', 'stock-ext', 'lean', 'lean-ext'];
if (!run || !CONFIGS.includes(config)) throw new Error(`Usage: node scripts/ab-benchmark.mjs <run> <${CONFIGS.join('|')}>`);
const lean = config.startsWith('lean'), extension = config.endsWith('-ext');
const SITES = [
  'https://www.pravda.com.ua/', 'https://www.unian.ua/', 'https://www.theverge.com/', 'https://edition.cnn.com/',
  'https://www.bbc.com/news', 'https://www.dailymail.co.uk/home/index.html', 'https://www.reddit.com/r/technology/',
  'https://github.com/microsoft/vscode', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://en.wikipedia.org/wiki/Chromium_(web_browser)'
];
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny, Blender Foundation
const IDLE_S = Number(process.env.AB_IDLE_S ?? 180), VIDEO_S = Number(process.env.AB_VIDEO_S ?? 60), SETTLE_S = 30;
const output = resolve('artifacts/ab');
await mkdir(output, { recursive: true });
const sleep = s => new Promise(r => setTimeout(r, s * 1000));

function processes(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,command='], { encoding: 'utf8' }).split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):([\d.]+)\s+(.*)$/);
    if (!m) return null;
    const cpu = (Number(m[3] ?? 0) * 86400) + Number(m[4] ?? 0) * 3600 + Number(m[5]) * 60 + Number(m[6]);
    return { pid: Number(m[1]), ppid: Number(m[2]), cpu, command: m[7] };
  }).filter(Boolean);
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); grew = true; }
  }
  return rows.filter(row => ids.has(row.pid)).map(row => ({ ...row, role: role(row.command) }));
}
function role(command) {
  const type = command.match(/--type=([\w-]+)/)?.[1];
  if (!type) return 'browser';
  if (type === 'renderer') return command.includes('--extension-process') ? 'extension' : 'renderer';
  if (type === 'utility') return `utility:${command.match(/--utility-sub-type=[\w.]*?(\w+)\.mojom/)?.[1] ?? 'other'}`;
  return type;
}

// CPU seconds over a window. Processes that exit mid-window lose their last slice; reported as `exited`.
async function cpuWindow(root, seconds) {
  const start = new Map(processes(root).map(p => [p.pid, p]));
  const swapBefore = swap();
  let last = new Map(start), exited = 0;
  for (let t = 0; t < seconds; t += 5) {
    await sleep(Math.min(5, seconds - t));
    const now = new Map(processes(root).map(p => [p.pid, p]));
    for (const pid of last.keys()) if (!now.has(pid)) exited++;
    for (const [pid, p] of now) last.set(pid, p);
    for (const pid of [...last.keys()]) if (!now.has(pid)) last.delete(pid);
  }
  const byRole = {};
  let total = 0;
  for (const [pid, p] of last) {
    const used = p.cpu - (start.get(pid)?.cpu ?? 0);
    byRole[p.role] = (byRole[p.role] ?? 0) + used;
    total += used;
  }
  return { seconds, cpuSeconds: total, cpuPercent: total / seconds * 100, byRole, exited, swapBefore, swapAfter: swap() };
}
function swap() { return Number(execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).match(/used = ([\d.]+)M/)?.[1]); }

function footprint(root, name) {
  const list = processes(root);
  const path = join(output, `footprint-${run}-${config}-${name}.json`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync('/usr/bin/footprint', ['--noCategories', '-j', path, ...list.flatMap(p => ['-p', String(p.pid)])],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
      break;
    } catch (error) { if (attempt === 3) throw error; }
  }
  return readFile(path, 'utf8').then(text => {
    const data = JSON.parse(text), roles = new Map(list.map(p => [p.pid, p.role])), byRole = {};
    for (const p of data.processes) if (typeof p.footprint === 'number') {
      const r = roles.get(p.pid) ?? 'unknown';
      byRole[r] = (byRole[r] ?? 0) + p.footprint / 1048576;
    }
    const count = r => list.filter(p => p.role === r).length;
    return { totalMiB: data['total footprint'] / 1048576, byRole, processes: list.length, renderers: count('renderer'), errors: data.errors };
  });
}

const profile = await mkdtemp(join(tmpdir(), `lehko-ab-${config}-`));
if (lean) await applyLeanPrefs(profile, { energySaver: 'always' }); // as measured in the first series
const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', ...(lean ? leanFlags() : []), 'about:blank'
], { stdio: 'ignore' });
const result = { run, config, startedAt: new Date().toISOString(), sites: [] };
try {
  let port;
  for (let i = 0; i < 150 && !port; i++) { await sleep(0.2); try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {} }
  const browser = await connectCDP((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  result.chrome = (await browser.send('Browser.getVersion')).product;
  if (extension) {
    result.extensionId = (await browser.send('Extensions.loadUnpacked', { path: resolve('dist') })).id;
    await sleep(3);
  }
  await sleep(10);

  const loads = new Map();
  browser.on('Page.loadEventFired', (_, sessionId) => loads.get(sessionId)?.());
  async function open(url, { setup, foreground = false } = {}) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', background: !foreground });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    if (setup) await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: setup }, sessionId);
    const started = Date.now();
    const loaded = new Promise(ok => { loads.set(sessionId, ok); setTimeout(ok, 25000); });
    await browser.send('Page.navigate', { url }, sessionId);
    await loaded;
    return { targetId, sessionId, loadMs: Date.now() - started };
  }

  const startLoad = Date.now();
  const loadCpu = processes(chrome.pid).reduce((n, p) => n + p.cpu, 0);
  let last;
  for (const url of SITES) {
    last = await open(url);
    result.sites.push({ url, loadMs: last.loadMs });
    await browser.send('Target.detachFromTarget', { sessionId: last.sessionId });
  }
  result.loadPhase = { seconds: (Date.now() - startLoad) / 1000,
    cpuSeconds: processes(chrome.pid).reduce((n, p) => n + p.cpu, 0) - loadCpu };
  // Wikipedia in front, the nine heavier pages behind it.
  await browser.send('Target.activateTarget', { targetId: last.targetId });
  await sleep(SETTLE_S);
  result.idle = await cpuWindow(chrome.pid, IDLE_S);
  result.idleFootprint = await footprint(chrome.pid, 'idle');
  console.log(JSON.stringify({ run, config, idleCpu: result.idle.cpuPercent.toFixed(2), footprintMiB: result.idleFootprint.totalMiB.toFixed(1), renderers: result.idleFootprint.renderers }));

  // Records which codec the player asks for; for lean-ext also the AV1 override from dist/no-av1.js.
  const recorder = `(() => { const add = MediaSource.prototype.addSourceBuffer; globalThis.__codecs = [];
    MediaSource.prototype.addSourceBuffer = function (type) { globalThis.__codecs.push(type); return add.call(this, type); }; })();`;
  const setup = lean && extension ? recorder + await readFile(resolve('dist/no-av1.js'), 'utf8') : recorder;
  const video = await open(VIDEO, { setup, foreground: true });
  await sleep(8);
  const play = async () => (await browser.send('Runtime.evaluate', { userGesture: true, awaitPromise: true, returnByValue: true,
    expression: `(async () => { const v = document.querySelector('video'); if (!v) return 'no video'; try { await v.play(); return 'playing'; } catch (e) { return e.name; } })()` }, video.sessionId)).result.value;
  result.videoStart = await play();
  await sleep(10);
  result.video = await cpuWindow(chrome.pid, VIDEO_S);
  result.videoState = (await browser.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const v = document.querySelector('video');
    const q = v?.getVideoPlaybackQuality(); return { codecs: globalThis.__codecs, paused: v?.paused, time: v?.currentTime, height: v?.videoHeight,
    dropped: q?.droppedVideoFrames, frames: q?.totalVideoFrames, url: location.hostname }; })()` }, video.sessionId)).result.value;
  result.videoFootprint = await footprint(chrome.pid, 'video');
  console.log(JSON.stringify({ run, config, videoCpu: result.video.cpuPercent.toFixed(2), codecs: result.videoState.codecs, height: result.videoState.height, dropped: result.videoState.dropped }));
  try { await browser.send('Browser.close'); } catch {}
  browser.close();
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await new Promise(ok => { if (chrome.exitCode !== null) ok(); else { chrome.once('exit', ok); setTimeout(() => { chrome.kill('SIGKILL'); ok(); }, 10000); } });
  result.finishedAt = new Date().toISOString();
  await writeFile(join(output, `run-${run}-${config}.json`), JSON.stringify(result, null, 1));
  await rm(profile, { recursive: true, force: true });
}
