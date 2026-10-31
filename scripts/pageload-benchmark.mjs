// Stage 0 "ceiling": what 8 ad-heavy news pages cost to open with no blocker, with Легко, with
// uBO Lite and in Brave with default Shields. Each run gets a fresh copy of a warmed-up template
// profile; CDP is used only for setup and is disconnected before the measured phase. The pages are
// opened the way a user opens them, by handing URLs to the running browser (`--new-window`).
//
//   node scripts/pageload-benchmark.mjs prepare              template profiles after component updates
//   node scripts/pageload-benchmark.mjs record               record the live set for the fixture set
//   node scripts/pageload-benchmark.mjs run <set> <config> <repeat>
//   node scripts/pageload-benchmark.mjs diag <set> <config>  CDP pass: frames tagged by AdTagging
//   node scripts/pageload-benchmark.mjs series [repeats] [config,...] [set,...]  rotating order, then diag
//   node scripts/pageload-benchmark.mjs report               summary.json and Markdown tables
//
// Sets: `fixtures` (recorded pages replayed locally, primary) and `live`. BRAVE_PATH and UBOL_PATH
// point at Brave's binary and an unpacked uBO Lite, UG_PATH at ungoogled-chromium's inner binary;
// nothing is downloaded by this script. CEILING_SERIES keeps a later series' runs in its own folder.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHROME, footprint, launchChrome, processes, sleep, swapMiB, waitExit } from './lib/bench.mjs';
import { startRecording, startReplay } from './lib/replay.mjs';

// The same pages, in the same order, as the 29.10 A/B/A in the main Chrome.
const SITES = [
  'https://edition.cnn.com/', 'https://www.foxnews.com/', 'https://www.dailymail.co.uk/home/index.html',
  'https://www.theguardian.com/international', 'https://www.yahoo.com/', 'https://tsn.ua/',
  'https://www.unian.ua/', 'https://www.pravda.com.ua/'
];
const BROWSERS = { chrome: CHROME, brave: process.env.BRAVE_PATH,
  ug: process.env.UG_PATH ?? '/Applications/Lehko.app/Contents/Resources/Chromium.app/Contents/MacOS/Chromium',
  cr: process.env.CR_PATH };
const CONFIGS = {
  // Our own CI build of plain Chromium, to choose the base for a fork against ug.
  cr: { browser: 'cr' },
  'cr-lehko': { browser: 'cr', extension: process.env.LEHKO_EXT ?? resolve('dist') },
  clean: { browser: 'chrome' },
  lehko: { browser: 'chrome', extension: resolve('dist') },
  ubol: { browser: 'chrome', extension: process.env.UBOL_PATH },
  brave: { browser: 'brave' },
  ug: { browser: 'ug' },
  'ug-lehko': { browser: 'ug', extension: process.env.LEHKO_EXT ?? resolve('dist') },
  'brave-lehko': { browser: 'brave', extension: resolve('dist') },
  // Shields without cosmetic filtering: separates hidden page elements from the rest of Brave.
  'brave-lehko-nocosmetic': { browser: 'brave', extension: resolve('dist'), flags: ['--disable-features=BraveAdblockCosmeticFiltering'] },
  'ug-ubol': { browser: 'ug', extension: process.env.UBOL_PATH }
};
const SETS = ['fixtures', 'live'];
// Phase timing of the 29.10 collector: 45 s to load, then a 60 s CPU window.
const SETTLE_S = 30, LOAD_S = 45, STEADY_S = 60, PREPARE_S = Number(process.env.PREPARE_S ?? 240);
const base = resolve('artifacts/ceiling'), templates = join(base, 'templates'), recording = join(base, 'recording');
const output = join(base, process.env.CEILING_SERIES ?? '');

function binary(config) {
  const path = BROWSERS[CONFIGS[config].browser];
  if (!path || !existsSync(path)) throw new Error(`No binary for ${config}: set BRAVE_PATH / UG_PATH`);
  if ('extension' in CONFIGS[config] && !existsSync(join(CONFIGS[config].extension ?? '', 'manifest.json')))
    throw new Error(`No unpacked extension for ${config}: run npm run build / set UBOL_PATH`);
  return path;
}

// Display sleep hides the window and stops rendering: hold the display awake while this script runs.
spawn('/usr/bin/caffeinate', ['-d', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();

// CPU seconds by role over a window, sampled every 5 s so processes that exit mid-window keep
// what they used up to their last sample. Processes born inside the window count from zero.
async function cpuWindow(root, seconds) {
  const first = new Map(processes(root).map(p => [p.pid, p.cpu])), last = new Map();
  const started = Date.now();
  let peakRenderers = 0;
  while (Date.now() - started < seconds * 1000) {
    await sleep(Math.min(5, seconds - (Date.now() - started) / 1000));
    const now = processes(root);
    peakRenderers = Math.max(peakRenderers, now.filter(p => p.role === 'renderer').length);
    for (const p of now) last.set(p.pid, p);
  }
  const byRole = {};
  let total = 0;
  for (const [pid, p] of last) {
    const used = p.cpu - (first.get(pid) ?? 0);
    byRole[p.role] = (byRole[p.role] ?? 0) + used;
    total += used;
  }
  const exited = [...first.keys()].filter(pid => !processes(root).some(p => p.pid === pid)).length;
  return { seconds: (Date.now() - started) / 1000, cpuSeconds: total, cpuPercent: total / seconds * 100, byRole, peakRenderers, exited };
}

// A fresh profile per run: an APFS copy of the template, so blocklist components are already there.
async function freshProfile(config) {
  const template = join(templates, CONFIGS[config].browser);
  if (!existsSync(template)) throw new Error(`No template profile for ${CONFIGS[config].browser}: run prepare`);
  const profile = await mkdtemp(join(tmpdir(), `lehko-ceiling-${config}-`));
  await cp(template, profile, { recursive: true });
  return profile;
}

// Starts the browser, loads the extension if any and closes everything but one blank tab.
async function start(set, config, profile) {
  const replay = set === 'fixtures' ? await startReplay(recording) : null;
  const { chrome, connect } = await launchChrome(profile, [...replay?.flags ?? [], ...CONFIGS[config].flags ?? []], binary(config));
  const browser = await connect();
  const info = { product: (await browser.send('Browser.getVersion')).product };
  if (CONFIGS[config].extension) {
    info.extensionId = (await browser.send('Extensions.loadUnpacked', { path: CONFIGS[config].extension })).id;
    await sleep(5);
  }
  const pages = (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
  info.closedOnStart = pages.slice(1).map(t => new URL(t.url).protocol);
  for (const page of pages.slice(1)) await browser.send('Target.closeTarget', { targetId: page.targetId });
  return { replay, chrome, browser, connect, info };
}

async function stop({ replay, chrome, connect }, profile) {
  try { const browser = await connect(); await browser.send('Browser.close').catch(() => {}); browser.close(); } catch {}
  await waitExit(chrome);
  await replay?.close();
  await rm(profile, { recursive: true, force: true });
}

// The user's way of opening pages: a second process hands the URLs to the running browser and exits.
function openPages(config, profile) {
  return new Promise((ok, fail) => {
    const opener = spawn(binary(config), [`--user-data-dir=${profile}`, '--new-window', ...SITES], { stdio: 'ignore' });
    opener.once('exit', ok);
    opener.once('error', fail);
  });
}

async function run(set, config, repeat) {
  const dir = join(output, set);
  await mkdir(dir, { recursive: true });
  const profile = await freshProfile(config);
  const session = await start(set, config, profile);
  const result = { set, config, repeat, ...session.info, startedAt: new Date().toISOString() };
  try {
    // No CDP client from here on: a connected client costs browser-process CPU (docs/AB_REPORT.md).
    session.browser.close();
    await sleep(SETTLE_S);
    const pid = session.chrome.pid;
    // Everything below is measured from this root down the ppid tree; it must be our own browser.
    if (!processes(pid)[0]?.command.includes(`--user-data-dir=${profile}`)) throw new Error(`Root ${pid} is not the benchmark browser`);
    result.before = { ...(await footprint(pid, join(dir, `footprint-${config}-${repeat}-before.json`))), swapMiB: swapMiB() };
    await openPages(config, profile);
    result.load = await cpuWindow(pid, LOAD_S);
    result.steady = await cpuWindow(pid, STEADY_S);
    result.after = { ...(await footprint(pid, join(dir, `footprint-${config}-${repeat}-after.json`))), swapMiB: swapMiB() };
    result.footprintDeltaMiB = result.after.totalMiB - result.before.totalMiB;
    result.renderersDelta = result.after.renderers - result.before.renderers;
    result.cpuSeconds = result.load.cpuSeconds + result.steady.cpuSeconds;
    result.replay = session.replay?.stats;
    console.log(JSON.stringify({ set, config, repeat, footprintDeltaMiB: Math.round(result.footprintDeltaMiB), renderersDelta: result.renderersDelta,
      cpuSeconds: result.cpuSeconds.toFixed(1), steadyCpu: result.steady.cpuPercent.toFixed(0), replay: result.replay }));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(result.error);
    process.exitCode = 1;
  } finally {
    await stop(session, profile);
    result.finishedAt = new Date().toISOString();
    await writeFile(join(dir, `run-${config}-${repeat}.json`), JSON.stringify(result, null, 1));
  }
  return result;
}

// Same opening as a measured run; after the load window CDP walks every page and OOPIF frame tree
// and keeps the frames Chromium's AdTagging marked as ads, i.e. what got past the blocker.
async function diag(set, config) {
  const dir = join(output, set);
  await mkdir(dir, { recursive: true });
  const profile = await freshProfile(config);
  const session = await start(set, config, profile);
  const result = { set, config, ...session.info, startedAt: new Date().toISOString(), frames: [] };
  try {
    session.browser.close();
    await sleep(SETTLE_S);
    await openPages(config, profile);
    await sleep(LOAD_S + STEADY_S);
    const browser = await session.connect();
    const targets = (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' || t.type === 'iframe');
    // An OOPIF's own renderer holds its real URL and ad status; its parent only sees a placeholder.
    const frames = new Map(), parentOf = new Map(), pageOf = new Map();
    const walk = (node, target, parent) => {
      const { frame } = node;
      if (parent) parentOf.set(frame.id, parent);
      else if (target.type === 'page') pageOf.set(frame.id, target.url);
      if (!frames.has(frame.id) || (target.type === 'iframe' && frame.id === target.targetId)) {
        let host = '';
        try { host = new URL(frame.url).host; } catch {}
        frames.set(frame.id, { host, url: frame.url.slice(0, 200), target: target.type, ad: frame.adFrameStatus?.adFrameType ?? 'none',
          explanations: frame.adFrameStatus?.explanations ?? [] });
      }
      for (const child of node.childFrames ?? []) walk(child, target, frame.id);
    };
    for (const target of targets) {
      try {
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const { frameTree } = await browser.send('Page.getFrameTree', {}, sessionId);
        walk(frameTree, target, target.type === 'iframe' ? target.parentFrameId : null);
        await browser.send('Target.detachFromTarget', { sessionId });
      } catch {}
    }
    browser.close();
    const top = id => { for (let i = 0; i < 20 && !pageOf.has(id) && parentOf.has(id); i++) id = parentOf.get(id); return pageOf.get(id) ?? ''; };
    result.frames = [...frames].map(([id, f]) => ({ page: top(id), ...f }));
    result.renderers = processes(session.chrome.pid).filter(p => p.role === 'renderer').length;
    const ads = result.frames.filter(f => f.ad !== 'none');
    result.summary = { frames: result.frames.length, adFrames: ads.length, adRoots: ads.filter(f => f.ad === 'root').length,
      adHosts: Object.fromEntries(Object.entries(ads.reduce((n, f) => ({ ...n, [f.host]: (n[f.host] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])) };
    console.log(JSON.stringify({ set, config, ...result.summary, renderers: result.renderers }));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(result.error);
    process.exitCode = 1;
  } finally {
    await stop(session, profile);
    await writeFile(join(dir, `diag-${config}.json`), JSON.stringify(result, null, 1));
  }
}

// Fresh profile, PREPARE_S on the live network so the component updater fetches AdTagging's
// ruleset (Chrome) and the Shields lists (Brave). Every run copies this state.
async function prepare(name) {
  const profile = join(templates, name);
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  const { chrome, connect } = await launchChrome(profile, [], BROWSERS[name]);
  const browser = await connect();
  const product = (await browser.send('Browser.getVersion')).product;
  await sleep(PREPARE_S);
  const pages = (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page').map(t => t.url);
  await browser.send('Browser.close').catch(() => {});
  browser.close();
  await waitExit(chrome);
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) await rm(join(profile, lock), { force: true });
  const entries = await readdir(profile);
  console.log(JSON.stringify({ name, product, pages, subresourceFilter: entries.includes('Subresource Filter'), entries }));
}

async function record() {
  const profile = await freshProfile('clean');
  await rm(recording, { recursive: true, force: true });
  const { chrome, connect } = await launchChrome(profile, [], CHROME);
  try {
    const browser = await connect();
    const recorder = await startRecording(browser, recording);
    for (const url of SITES) {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await recorder.attach(sessionId);
      await browser.send('Page.navigate', { url }, sessionId);
    }
    await sleep(LOAD_S + STEADY_S);
    console.log(JSON.stringify({ recorded: await recorder.stop() }));
    await browser.send('Browser.close').catch(() => {});
    browser.close();
  } finally {
    await waitExit(chrome);
    await rm(profile, { recursive: true, force: true });
  }
}

// Every set × repeat runs all configs, the order rotated by one each repeat.
async function series(repeats, names = Object.keys(CONFIGS), sets = SETS) {
  for (const set of sets) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (let i = 0; i < names.length; i++) await run(set, names[(i + repeat - 1) % names.length], repeat);
    }
    for (const config of names) await diag(set, config);
  }
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
// Process roles folded into the groups the report compares; an MV3 service worker lives in `extension`.
const GROUPS = ['browser', 'renderer', 'gpu', 'network', 'extension', 'other'];
const groupOf = role => role === 'gpu-process' ? 'gpu' : role === 'utility:network' ? 'network' : GROUPS.includes(role) ? role : 'other';
const cpuGroup = (byRole, group) => Object.entries(byRole).filter(([role]) => groupOf(role) === group).reduce((n, [, s]) => n + s, 0);
async function report() {
  const summary = {};
  for (const set of SETS) {
    const dir = join(output, set);
    if (!existsSync(dir)) continue;
    const files = (await readdir(dir)).filter(f => /^run-.*\.json$/.test(f));
    const runs = await Promise.all(files.map(async f => JSON.parse(await readFile(join(dir, f), 'utf8'))));
    summary[set] = {};
    for (const config of Object.keys(CONFIGS)) {
      // Repeat 0 is a smoke run and stays out of the summary.
      const ok = runs.filter(r => r.config === config && r.repeat > 0 && !r.error).sort((a, b) => a.repeat - b.repeat);
      if (!ok.length) continue;
      const stat = pick => { const xs = ok.map(pick); return { mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs), all: xs }; };
      summary[set][config] = {
        runs: ok.length, product: ok[0].product,
        footprintDeltaMiB: stat(r => r.footprintDeltaMiB), renderersDelta: stat(r => r.renderersDelta),
        cpuSeconds: stat(r => r.cpuSeconds), loadCpuSeconds: stat(r => r.load.cpuSeconds), steadyCpuPercent: stat(r => r.steady.cpuPercent),
        rendererCpuSeconds: stat(r => (r.load.byRole.renderer ?? 0) + (r.steady.byRole.renderer ?? 0)),
        browserCpuSeconds: stat(r => (r.load.byRole.browser ?? 0) + (r.steady.byRole.browser ?? 0)),
        cpuByGroup: Object.fromEntries(['load', 'steady'].map(phase => [phase,
          Object.fromEntries(GROUPS.map(g => [g, stat(r => cpuGroup(r[phase].byRole, g))]))])),
        swapDeltaMiB: stat(r => r.after.swapMiB - r.before.swapMiB)
      };
    }
    const diags = (await readdir(dir)).filter(f => /^diag-.*\.json$/.test(f));
    for (const f of diags) {
      const d = JSON.parse(await readFile(join(dir, f), 'utf8'));
      if (summary[set][d.config] && d.summary) summary[set][d.config].diag = { ...d.summary, renderers: d.renderers };
    }
  }
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 1));
  const fmt = s => `${s.mean.toFixed(0)} (${s.min.toFixed(0)}–${s.max.toFixed(0)})`;
  for (const [set, configs] of Object.entries(summary)) {
    console.log(`\n## ${set}: steady CPU by process, s / 60 s\n\n| config | ${GROUPS.join(' | ')} |\n|---|${GROUPS.map(() => '---:').join('|')}|`);
    for (const [config, s] of Object.entries(configs))
      console.log(`| ${config} | ${GROUPS.map(g => s.cpuByGroup.steady[g].mean.toFixed(1)).join(' | ')} |`);
    console.log(`\n## ${set}\n\n| config | footprint Δ, MiB | renderers Δ | CPU 0–105 s, s | load CPU, s | steady CPU, % core | ad frames |\n|---|---:|---:|---:|---:|---:|---:|`);
    for (const [config, s] of Object.entries(configs))
      console.log(`| ${config} | ${fmt(s.footprintDeltaMiB)} | ${fmt(s.renderersDelta)} | ${fmt(s.cpuSeconds)} | ${fmt(s.loadCpuSeconds)} | ${fmt(s.steadyCpuPercent)} | ${s.diag?.adFrames ?? '–'} |`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'prepare') { for (const name of args.length ? args : Object.keys(BROWSERS)) await prepare(name); }
else if (command === 'record') await record();
else if (command === 'run' && SETS.includes(args[0]) && args[1] in CONFIGS && args[2]) await run(args[0], args[1], Number(args[2]));
else if (command === 'diag' && SETS.includes(args[0]) && args[1] in CONFIGS) await diag(args[0], args[1]);
else if (command === 'series') await series(Number(args[0] ?? 3), args[1]?.split(','), args[2]?.split(','));
else if (command === 'report') await report();
else throw new Error('Usage: node scripts/pageload-benchmark.mjs prepare [chrome|brave|ug] | record | run <fixtures|live> <config> <repeat> | diag <set> <config> | series [repeats] | report');
