// YouTube playback A/B: waits out pre-roll ads, then measures 60 s of the main video only.
// Usage: node scripts/ab-video.mjs <run> <stock|stock-ext|lean|lean-ext|lean-ext-noes>
// lean-ext-noes = lean-ext with Energy Saver off, to separate its 30 fps cap from the rest.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectCDP } from './lib/raw-cdp.mjs';
import { applyLeanPrefs, leanFlags } from './lib/lean-profile.mjs';

const [run, config] = process.argv.slice(2);
const CONFIGS = ['stock', 'stock-ext', 'lean', 'lean-ext', 'lean-ext-noes'];
if (!run || !CONFIGS.includes(config)) throw new Error(`Usage: node scripts/ab-video.mjs <run> <${CONFIGS.join('|')}>`);
const lean = config.startsWith('lean'), extension = config.includes('-ext');
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny, Blender Foundation
const MEASURE_S = Number(process.env.AB_VIDEO_S ?? 60);
const output = resolve('artifacts/ab-video');
await mkdir(output, { recursive: true });
const sleep = s => new Promise(r => setTimeout(r, s * 1000));

function processes(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,command='], { encoding: 'utf8' }).split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):([\d.]+)\s+(.*)$/);
    return m && { pid: Number(m[1]), ppid: Number(m[2]), command: m[7],
      cpu: Number(m[3] ?? 0) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5]) * 60 + Number(m[6]) };
  }).filter(Boolean);
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); grew = true; }
  }
  return rows.filter(row => ids.has(row.pid)).map(row => {
    const type = row.command.match(/--type=([\w-]+)/)?.[1];
    return { ...row, role: !type ? 'browser' : type === 'renderer' && row.command.includes('--extension-process') ? 'extension'
      : type === 'utility' ? `utility:${row.command.match(/--utility-sub-type=[\w.]*?(\w+)\.mojom/)?.[1] ?? 'other'}` : type };
  });
}

const profile = await mkdtemp(join(tmpdir(), `lehko-video-${config}-`));
if (lean) await applyLeanPrefs(profile, { energySaver: config === 'lean-ext-noes' ? 'off' : 'always' });
const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', ...(lean ? leanFlags() : []), 'about:blank'
], { stdio: 'ignore' });
const result = { run, config, startedAt: new Date().toISOString() };
try {
  let port;
  for (let i = 0; i < 150 && !port; i++) { await sleep(0.2); try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {} }
  const browser = await connectCDP((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  result.chrome = (await browser.send('Browser.getVersion')).product;
  if (extension) { await browser.send('Extensions.loadUnpacked', { path: resolve('dist') }); await sleep(3); }
  await sleep(10);

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  const recorder = `(() => { const add = MediaSource.prototype.addSourceBuffer; globalThis.__codecs = [];
    MediaSource.prototype.addSourceBuffer = function (type) { globalThis.__codecs.push(type); return add.call(this, type); }; })();`;
  // lean-ext stands for the extension with the user's YouTube grant; the grant prompt cannot be automated.
  const av1 = lean && extension ? await readFile(resolve('dist/no-av1.js'), 'utf8') : '';
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: recorder + av1 }, sessionId);
  await browser.send('Page.navigate', { url: VIDEO }, sessionId);
  await sleep(8);
  const evaluate = async (expression, userGesture = false) =>
    (await browser.send('Runtime.evaluate', { expression, userGesture, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  const state = `(() => { const p = document.querySelector('#movie_player'), v = document.querySelector('#movie_player video.html5-main-video');
    const q = v?.getVideoPlaybackQuality(); return { ad: !!p?.classList.contains('ad-showing') || !!p?.classList.contains('ad-interrupting'),
    duration: v?.duration ?? 0, time: v?.currentTime ?? 0, paused: v?.paused,
    height: v?.videoHeight, dropped: q?.droppedVideoFrames ?? 0, frames: q?.totalVideoFrames ?? 0, codecs: globalThis.__codecs,
    host: location.hostname, title: document.title, videos: document.querySelectorAll('video').length,
    classes: p?.className, error: document.querySelector('.ytp-error, .ytp-error-content')?.textContent?.trim().slice(0, 120),
    vid: p?.getVideoData?.()?.video_id, state: p?.getPlayerState?.() }; })()`;
  result.playStart = await evaluate(`(async () => { const p = document.querySelector('#movie_player'); p?.playVideo?.();
    const v = document.querySelector('#movie_player video'); try { await v?.play(); return 'playing'; } catch (e) { return e?.name ?? 'no video'; } })()`, true);
  // Wait for ads to finish and the main video to advance; up to 120 s.
  let adSeconds = 0, s;
  for (let t = 0; t < 120; t++) {
    s = await evaluate(state);
    // The 10-minute main video is the only media longer than 300 s on the page; ads are short.
    if (s.ad || s.duration < 300) adSeconds++;
    if (!s.ad && s.duration > 300 && s.time > 3 && !s.paused) break;
    else if (s.paused && t % 10 === 9) await evaluate(`document.querySelector('#movie_player')?.playVideo?.()`, true);
    await sleep(1);
  }
  result.adSeconds = adSeconds;
  if (s.ad || s.duration < 300 || s.time <= 3 || s.paused) throw new Error(`Main video did not start: ${JSON.stringify(s)}`);
  const before = await evaluate(state);
  const start = new Map(processes(chrome.pid).map(p => [p.pid, p]));
  const samples = [];
  for (let t = 0; t < MEASURE_S; t += 5) { await sleep(Math.min(5, MEASURE_S - t)); samples.push(await evaluate(state)); }
  const after = samples.at(-1);
  result.samples = samples.map(({ codecs, ...rest }) => rest);
  if (samples.some(x => x.ad || x.duration < 300 || x.paused)) throw new Error(`Ad or pause during window: ${JSON.stringify(result.samples)}`);
  const byRole = {};
  let total = 0;
  for (const p of processes(chrome.pid)) {
    const used = p.cpu - (start.get(p.pid)?.cpu ?? 0);
    byRole[p.role] = (byRole[p.role] ?? 0) + used;
    total += used;
  }
  result.cpu = { seconds: MEASURE_S, cpuSeconds: total, cpuPercent: total / MEASURE_S * 100, byRole };
  result.playback = { codecs: after.codecs, height: after.height, advanced: after.time - before.time, adDuringWindow: after.ad,
    frames: after.frames - before.frames, dropped: after.dropped - before.dropped };
  const list = processes(chrome.pid), path = join(output, `footprint-${run}-${config}.json`);
  execFileSync('/usr/bin/footprint', ['--noCategories', '-j', path, ...list.flatMap(p => ['-p', String(p.pid)])],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  result.footprintMiB = JSON.parse(await readFile(path, 'utf8'))['total footprint'] / 1048576;
  console.log(JSON.stringify({ run, config, cpu: result.cpu.cpuPercent.toFixed(1), ...result.playback, adSeconds, footprintMiB: result.footprintMiB.toFixed(0) }));
  try { await browser.send('Browser.close'); } catch {}
  browser.close();
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ run, config, error: result.error }));
  process.exitCode = 1;
} finally {
  await new Promise(ok => { if (chrome.exitCode !== null) ok(); else { chrome.once('exit', ok); setTimeout(() => { chrome.kill('SIGKILL'); ok(); }, 10000); } });
  result.finishedAt = new Date().toISOString();
  await writeFile(join(output, `run-${run}-${config}.json`), JSON.stringify(result, null, 1));
  await rm(profile, { recursive: true, force: true });
}
