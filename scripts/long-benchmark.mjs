// Long background session: Chromium-internal memory/CPU mechanisms on top of Легко's blocking.
// 16 tabs (some same-site), 12 minutes in the background with CDP disconnected, then every tab is
// brought back to measure resume latency. Usage: node scripts/long-benchmark.mjs <run> <config>
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cpuBetween, footprint, launchChrome, processes, sleep, swapMiB, waitExit } from './lib/bench.mjs';

// `stock` is the only config without the Легко extension: the honest no-CDP baseline.
export const CONFIGS = {
  stock: [],
  ext: [],
  lowend: ['--enable-low-end-device-mode'],
  freeze: ['--enable-features=InfiniteTabsFreezing,MemoryPurgeOnFreeze'],
  parkable: ['--enable-features=CompressParkableStrings,MemorySaverModeRenderTuning'],
  share: ['--enable-features=ProcessPerSiteUpToMainFrameThreshold:ProcessPerSiteMainFrameThreshold/8'],
  // Splits `freeze`: which half costs the steady renderer CPU, and does it stack with `parkable`.
  freezeonly: ['--enable-features=InfiniteTabsFreezing'],
  combo: ['--enable-features=InfiniteTabsFreezing,MemoryPurgeOnFreeze,CompressParkableStrings,MemorySaverModeRenderTuning']
};
const [run, config] = process.argv.slice(2);
if (!run || !(config in CONFIGS)) throw new Error(`Usage: node scripts/long-benchmark.mjs <run> <${Object.keys(CONFIGS).join('|')}>`);
const SITES = [
  'https://www.pravda.com.ua/', 'https://www.unian.ua/', 'https://www.theverge.com/', 'https://edition.cnn.com/',
  'https://www.bbc.com/news', 'https://www.dailymail.co.uk/home/index.html', 'https://www.reddit.com/r/technology/',
  'https://github.com/microsoft/vscode', 'https://github.com/nodejs/node', 'https://github.com/denoland/deno',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript', 'https://en.wikipedia.org/wiki/WebKit',
  'https://en.wikipedia.org/wiki/V8_(JavaScript_engine)', 'https://en.wikipedia.org/wiki/Blink_(browser_engine)',
  'https://github.com/brave/brave-core', 'https://en.wikipedia.org/wiki/Chromium_(web_browser)'
];
const CHECKPOINTS_MIN = (process.env.LONG_CHECKPOINTS ?? '2,6,12').split(',').map(Number);
const output = resolve('artifacts/long');
await mkdir(output, { recursive: true });

// Display sleep hides the window: rAF stops and every resume times out. Hold the display awake while this script runs.
spawn('/usr/bin/caffeinate', ['-d', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();

const profile = await mkdtemp(join(tmpdir(), `lehko-long-${config}-`));
const { chrome, connect } = await launchChrome(profile, CONFIGS[config]);
const result = { run, config, extension: config !== 'stock', flags: CONFIGS[config], startedAt: new Date().toISOString(), sites: [], checkpoints: [], resume: [] };
try {
  let browser = await connect();
  result.chrome = (await browser.send('Browser.getVersion')).product;
  if (config !== 'stock') await browser.send('Extensions.loadUnpacked', { path: resolve('dist') });
  await sleep(10);
  const loads = new Map();
  browser.on('Page.loadEventFired', (_, sessionId) => loads.get(sessionId)?.());
  const targets = [];
  const loadStart = processes(chrome.pid);
  for (const url of SITES) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    const started = Date.now();
    const loaded = new Promise(ok => { loads.set(sessionId, ok); setTimeout(ok, 25000); });
    await browser.send('Page.navigate', { url }, sessionId);
    await loaded;
    result.sites.push({ url, loadMs: Date.now() - started });
    targets.push(targetId);
    await browser.send('Target.detachFromTarget', { sessionId });
  }
  result.load = cpuBetween(loadStart, processes(chrome.pid), 1);
  await browser.send('Target.activateTarget', { targetId: targets.at(-1) });
  // Disconnect for the measured background period: a live CDP client costs browser-process CPU.
  browser.close();
  const t0 = Date.now(), swapStart = swapMiB();
  let previous = processes(chrome.pid), previousAt = t0;
  for (const minute of CHECKPOINTS_MIN) {
    await sleep((t0 + minute * 60000 - Date.now()) / 1000);
    const now = processes(chrome.pid);
    const cpu = cpuBetween(previous, now, (Date.now() - previousAt) / 1000);
    const memory = await footprint(chrome.pid, join(output, `footprint-${run}-${config}-${minute}m.json`));
    result.checkpoints.push({ minute, cpu, memory, swapMiB: swapMiB() });
    console.log(JSON.stringify({ run, config, minute, cpu: cpu.cpuPercent.toFixed(1), renderersCpu: ((cpu.byRole.renderer ?? 0) / cpu.seconds * 100).toFixed(1),
      footprintMiB: memory.totalMiB.toFixed(0), rendererMiB: (memory.byRole.renderer ?? 0).toFixed(0), renderers: memory.renderers }));
    previous = processes(chrome.pid);
    previousAt = Date.now();
  }
  result.swapDeltaMiB = swapMiB() - swapStart;

  // Bring every background tab back: time until it paints two frames; discarded tabs reload.
  browser = await connect();
  for (const targetId of targets.slice(0, -1)) {
    const started = Date.now();
    await browser.send('Target.activateTarget', { targetId });
    let state, sessionId;
    try {
      ({ sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true }));
      state = (await browser.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression:
        `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r({ discarded: document.wasDiscarded, ready: document.readyState, visibility: document.visibilityState }))))` },
      sessionId)).result.value;
    } catch (error) {
      state = { error: error.message };
      // Stall probe: a page that answers without rAF is alive but produces no frames (hidden or frozen);
      // one that does not answer at all has a hung renderer main thread.
      if (sessionId) {
        const probeStarted = Date.now();
        try {
          state.probe = (await browser.send('Runtime.evaluate', { returnByValue: true, expression:
            `({ discarded: document.wasDiscarded, ready: document.readyState, visibility: document.visibilityState, focus: document.hasFocus() })` },
          sessionId)).result.value;
        } catch (probeError) { state.probe = { error: probeError.message }; }
        state.probe.ms = Date.now() - probeStarted;
        try { state.target = (await browser.send('Target.getTargetInfo', { targetId })).targetInfo; } catch {}
      }
    }
    if (sessionId) try { await browser.send('Target.detachFromTarget', { sessionId }); } catch {}
    result.resume.push({ ms: Date.now() - started, ...state });
    await sleep(1);
  }
  const ms = result.resume.map(r => r.ms).sort((a, b) => a - b);
  result.resumeSummary = { p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)],
    discarded: result.resume.filter(r => r.discarded).length };
  console.log(JSON.stringify({ run, config, resume: result.resumeSummary, swapDeltaMiB: result.swapDeltaMiB }));
  try { await browser.send('Browser.close'); } catch {}
  browser.close();
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ run, config, error: result.error }));
  process.exitCode = 1;
} finally {
  await waitExit(chrome);
  result.finishedAt = new Date().toISOString();
  await writeFile(join(output, `run-${run}-${config}.json`), JSON.stringify(result, null, 1));
  await rm(profile, { recursive: true, force: true });
}
