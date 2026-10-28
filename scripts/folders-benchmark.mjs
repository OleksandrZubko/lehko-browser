// Folders vs open tabs: the same 16 sites, 10 of them work tabs and 6 personal. `stock` and `ext` keep all 16 open;
// `folders` keeps the 10 work tabs in an inactive folder. Then 6 minutes in the background with CDP disconnected,
// and for `folders` the time to switch back to work. Usage: node scripts/folders-benchmark.mjs <run> <stock|ext|folders>
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cpuBetween, footprint, launchChrome, processes, sleep, waitExit } from './lib/bench.mjs';

const CONFIGS = ['stock', 'ext', 'folders'];
const [run, config] = process.argv.slice(2);
if (!run || !CONFIGS.includes(config)) throw new Error(`Usage: node scripts/folders-benchmark.mjs <run> <${CONFIGS.join('|')}>`);
const WORK = [
  'https://github.com/microsoft/vscode', 'https://github.com/nodejs/node', 'https://github.com/denoland/deno',
  'https://github.com/brave/brave-core', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://en.wikipedia.org/wiki/WebKit', 'https://en.wikipedia.org/wiki/V8_(JavaScript_engine)',
  'https://en.wikipedia.org/wiki/Blink_(browser_engine)', 'https://en.wikipedia.org/wiki/Chromium_(web_browser)',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'
];
const PERSONAL = ['https://www.pravda.com.ua/', 'https://www.unian.ua/', 'https://www.theverge.com/',
  'https://www.bbc.com/news', 'https://www.reddit.com/r/technology/', 'https://www.dailymail.co.uk/home/index.html'];
const CHECKPOINTS_MIN = (process.env.FOLDERS_CHECKPOINTS ?? '2,6').split(',').map(Number);
const output = resolve('artifacts/folders');
await mkdir(output, { recursive: true });

// Display sleep hides the window: rAF stops. Hold the display awake while this script runs.
spawn('/usr/bin/caffeinate', ['-d', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
const profile = await mkdtemp(join(tmpdir(), `lehko-folders-${config}-`));
const { chrome, connect } = await launchChrome(profile, []);
const result = { run, config, startedAt: new Date().toISOString(), checkpoints: [] };
try {
  let browser = await connect();
  result.chrome = (await browser.send('Browser.getVersion')).product;
  const loads = new Map();
  browser.on('Page.loadEventFired', (_, sessionId) => loads.get(sessionId)?.());
  async function open(url) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    const loaded = new Promise(ok => { loads.set(sessionId, ok); setTimeout(ok, 25000); });
    await browser.send('Page.navigate', { url }, sessionId);
    await loaded;
    await browser.send('Target.detachFromTarget', { sessionId });
    return targetId;
  }
  let send = async () => {};
  if (config !== 'stock') {
    const { id } = await browser.send('Extensions.loadUnpacked', { path: resolve('dist') });
    await sleep(3);
    // A pinned extension page to talk to the worker; pinned tabs belong to no folder.
    const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html`, background: true });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await sleep(2);
    send = async request => {
      const { result: value } = await browser.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true,
        expression: `chrome.runtime.sendMessage(${JSON.stringify(request)})` }, sessionId);
      if (!value.value?.ok) throw new Error(`Extension: ${JSON.stringify(value.value)}`);
      return value.value.status;
    };
    await browser.send('Runtime.evaluate', { awaitPromise: true,
      expression: 'chrome.tabs.getCurrent().then(t => chrome.tabs.update(t.id, { pinned: true }))' }, sessionId);
  }
  // The start tab would otherwise become part of the work folder.
  for (const target of (await browser.send('Target.getTargets')).targetInfos) {
    if (target.type === 'page' && target.url === 'about:blank') await browser.send('Target.closeTarget', { targetId: target.targetId });
  }
  const loadStart = processes(chrome.pid);
  let last;
  for (const url of WORK) last = await open(url);
  // The work folder remembers its last tab as active; that is the one reloaded on the way back.
  await browser.send('Target.activateTarget', { targetId: last });
  if (config === 'folders') {
    await send({ type: 'folders-list' });
    result.folderCreate = await send({ type: 'folders-create', name: 'Особисте' });
  }
  for (const url of PERSONAL) last = await open(url);
  await browser.send('Target.activateTarget', { targetId: last });
  // A new folder starts with a New Tab page; the other configs have none.
  for (const target of (await browser.send('Target.getTargets')).targetInfos) {
    if (target.type === 'page' && target.url.startsWith('chrome://newtab')) await browser.send('Target.closeTarget', { targetId: target.targetId });
  }
  result.load = cpuBetween(loadStart, processes(chrome.pid), 1);
  const status = config === 'folders' ? await send({ type: 'folders-list' }) : null;
  result.folders = status?.folders;
  const pages = (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.url.startsWith('http'));
  result.openTabs = pages.length;
  browser.close();

  const t0 = Date.now();
  let previous = processes(chrome.pid), previousAt = t0;
  for (const minute of CHECKPOINTS_MIN) {
    await sleep((t0 + minute * 60000 - Date.now()) / 1000);
    const now = processes(chrome.pid);
    const cpu = cpuBetween(previous, now, (Date.now() - previousAt) / 1000);
    const memory = await footprint(chrome.pid, join(output, `footprint-${run}-${config}-${minute}m.json`));
    result.checkpoints.push({ minute, cpu, memory });
    console.log(JSON.stringify({ run, config, minute, cpu: cpu.cpuPercent.toFixed(1), footprintMiB: memory.totalMiB.toFixed(0),
      rendererMiB: (memory.byRole.renderer ?? 0).toFixed(0), renderers: memory.renderers, openTabs: result.openTabs }));
    previous = processes(chrome.pid);
    previousAt = Date.now();
  }

  if (config === 'folders') {
    // Switch back to work: until the restored active tab has finished loading; the other 9 stay discarded.
    browser = await connect();
    const popup = (await browser.send('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.url.startsWith('chrome-extension://'));
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    const work = result.folders.find(folder => folder.name === 'Основна');
    const started = Date.now();
    const { result: switched } = await browser.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true,
      expression: `chrome.runtime.sendMessage(${JSON.stringify({ type: 'folders-switch', id: work.id })})` }, sessionId);
    result.switchMessageMs = Date.now() - started;
    await browser.send('Runtime.evaluate', { awaitPromise: true, expression: `(async () => {
      for (;;) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.status === 'complete' && tab.url.startsWith('http')) return;
        await new Promise(r => setTimeout(r, 25));
      }
    })()` }, sessionId);
    result.switchLoadedMs = Date.now() - started;
    result.switchOk = switched.value?.ok === true;
    await sleep(5);
    result.afterSwitch = await footprint(chrome.pid, join(output, `footprint-${run}-${config}-switched.json`));
    console.log(JSON.stringify({ run, config, switchMessageMs: result.switchMessageMs, switchLoadedMs: result.switchLoadedMs,
      afterSwitchMiB: result.afterSwitch.totalMiB.toFixed(0) }));
    try { await browser.send('Browser.close'); } catch {}
    browser.close();
  } else {
    browser = await connect();
    try { await browser.send('Browser.close'); } catch {}
    browser.close();
  }
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
