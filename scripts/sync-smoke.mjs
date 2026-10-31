// Real browser, real Worker runtime: two disposable profiles sync through `wrangler dev` on this machine.
// CHROME_PATH picks the browser (default: ungoogled-chromium inside Lehko.app). MEASURE=1 adds the idle worker and RSS check.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { connectCDP } from './lib/raw-cdp.mjs';

const browserPath = process.env.CHROME_PATH ?? '/Applications/Lehko.app/Contents/Resources/Chromium.app/Contents/MacOS/Chromium';
const extension = resolve('dist');
// SYNC_SERVER + SYNC_INVITE run against a deployed server instead; the test account is wiped afterwards.
const SERVER = process.env.SYNC_SERVER ?? 'http://127.0.0.1:8787';
const INVITE = process.env.SYNC_INVITE ?? 'local-dev-invite';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = name => console.log(`PASS ${name}`);
async function until(predicate, label, timeout = 40_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`);
    await sleep(200);
  }
}

const wrangler = process.env.SYNC_SERVER ? undefined : spawn(join('node_modules', '.bin', 'wrangler'), ['dev', '--port', '8787', '--ip', '127.0.0.1'], { cwd: 'sync-server', stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let wranglerLog = '';
wrangler?.stdout.on('data', d => { wranglerLog += d; });
wrangler?.stderr.on('data', d => { wranglerLog += d; });

const fixture = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Page ${request.headers.host}${request.url}</title><h1>${request.url}</h1>`);
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const port = fixture.address().port;
// Public-looking hosts: the folder guard protects local addresses from being closed.
const page = n => `http://p${n}.lehko-sync.example/`;

const contexts = [], dirs = [];
async function launch(name) {
  const dir = await mkdtemp(join(tmpdir(), `lehko-sync-${name}-`));
  dirs.push(dir);
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: browserPath, headless: process.env.HEADED !== '1', viewport: { width: 900, height: 700 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, `--host-resolver-rules=MAP *.lehko-sync.example 127.0.0.1:${port}`, '--no-first-run', '--no-default-browser-check']
  });
  contexts.push(context);
  const isOurs = w => w.url().startsWith('chrome-extension://') && w.url().endsWith('/worker.js');
  const worker = context.serviceWorkers().find(isOurs) ?? await context.waitForEvent('serviceworker', { predicate: isOurs });
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const send = message => popup.evaluate(m => chrome.runtime.sendMessage(m), message).then(reply => {
    if (!reply?.ok) throw new Error(reply?.error ?? 'no reply');
    return reply.status;
  });
  return { name, context, worker, popup, send, id, dir };
}
const stored = device => device.worker.evaluate(() => chrome.storage.local.get(['folders', 'currentId']));
const urlsOf = async device => (await stored(device)).folders.flatMap(f => f.tabs.map(t => t.url)).filter(u => u.includes('lehko-sync')).sort();
const openTab = (device, url) => device.worker.evaluate(u => chrome.tabs.create({ url: u, active: false }).then(() => {}), url);
const windowUrls = device => device.worker.evaluate(async () => (await chrome.tabs.query({})).map(t => t.url || t.pendingUrl || ''));

let failed = false;
try {
  await until(async () => (await fetch(`${SERVER}/nope`).catch(() => null))?.status === 404, 'wrangler dev', 60_000);
  ok('Worker runtime is up');

  // Worker security through the real runtime (Ed25519, SQLite Durable Object).
  assert.equal((await fetch(`${SERVER}/v1/sync`, { method: 'POST', body: '{}' })).status, 401);
  ok('unsigned request is rejected');

  const a = await launch('a'), b = await launch('b');
  await a.send({ type: 'folders-list' });
  await assert.rejects(a.send({ type: 'sync-create', server: SERVER, invite: 'wrong', deviceName: 'A' }), /Invite/);
  ok('wrong invite is rejected');
  await openTab(a, page(1));
  await openTab(a, page(2));
  await until(async () => (await urlsOf(a)).length === 2, 'folder snapshot on A');
  assert.equal((await a.send({ type: 'sync-create', server: SERVER, invite: INVITE, deviceName: 'Пристрій A' })).enabled, true);
  ok('account created');

  const { code } = await a.send({ type: 'sync-pair' });
  await b.send({ type: 'folders-list' });
  await b.send({ type: 'sync-join', server: SERVER, code, deviceName: 'Пристрій B' });
  await b.send({ type: 'sync-now' });
  await until(async () => (await urlsOf(b)).length === 2, 'folder arrives on B');
  // Lazy tabs have no URL until activated, so the window is checked by count.
  await until(async () => (await windowUrls(b)).filter(u => u === '' || u.includes('lehko-sync')).length === 2, 'tabs open in the window on B');
  ok('folder tabs reach the second device');

  await openTab(b, page(3));
  await until(async () => (await urlsOf(b)).length === 3, 'snapshot on B');
  await b.send({ type: 'sync-now' });
  await a.send({ type: 'sync-now' });
  await until(async () => (await urlsOf(a)).includes(page(3)), 'tab from B reaches A');
  ok('a tab opened on B reaches A');

  await a.worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    const group = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(group, { title: 'Спільна', color: 'green' });
  }, page(2));
  await until(async () => (await stored(a)).folders.some(f => f.tabs.some(t => t.group?.title === 'Спільна')), 'group captured on A');
  await a.send({ type: 'sync-now' });
  await b.send({ type: 'sync-now' });
  await until(async () => b.worker.evaluate(async url => {
    const groups = await chrome.tabGroups.query({ title: 'Спільна' });
    const tabs = await chrome.tabs.query({});
    return groups.length === 1 && groups[0].color === 'green' && tabs.some(t => t.groupId === groups[0].id);
  }, page(2)), 'group reaches the window on B');
  ok('a tab group reaches the other window');

  await a.send({ type: 'sync-now' });
  const seen = await b.send({ type: 'sync-now' });
  const deviceA = seen.devices.find(d => d.name === 'Пристрій A');
  assert.ok(deviceA?.tabs.some(t => t.url === page(1)));
  ok('open tabs of the other device are listed');

  const status = await a.send({ type: 'sync-now' });
  const deviceB = status.devices.find(d => d.name === 'Пристрій B');
  await a.send({ type: 'sync-send', deviceId: deviceB.id, url: page(9), title: 'Sent' });
  await b.send({ type: 'sync-now' });
  await until(async () => (await windowUrls(b)).includes(page(9)), 'sent tab opens on B');
  ok('a sent tab opens on the addressed device');

  const kdf = await a.popup.evaluate(async () => {
    const started = performance.now();
    const hash = await hashwasm.argon2id({ password: 'x'.repeat(16), salt: new Uint8Array(16), parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'hex' });
    return { hash, ms: Math.round(performance.now() - started), flow: typeof chrome.identity?.launchWebAuthFlow };
  });
  assert.equal(kdf.hash.length, 64);
  assert.equal(kdf.flow, 'function');
  ok(`Argon2id runs under the extension CSP (${kdf.ms} ms); identity API is present`);

  await a.popup.reload();
  await a.popup.locator('#sync-details summary').click();
  await until(() => a.popup.locator('.sync-device').count(), 'popup device list');
  await a.popup.screenshot({ path: join(process.env.SHOT_DIR ?? tmpdir(), 'sync-popup.png'), fullPage: false });
  ok('popup shows the linked devices');

  assert.equal((await a.send({ type: 'sync-status' })).lastError, undefined);
  assert.equal((await b.send({ type: 'sync-status' })).lastError, undefined);
  ok('no sync errors on either device');

  // The sent tab joined B's folder after the last pull: a device hears of it on its next sync, not at once.
  await until(async () => {
    await b.send({ type: 'sync-now' });
    await a.send({ type: 'sync-now' });
    return (await urlsOf(a)).length === (await urlsOf(b)).length;
  }, 'same size');
  assert.deepEqual(await urlsOf(a), await urlsOf(b));
  ok('both devices hold the same folder content');

  if (process.env.SYNC_SERVER) {
    assert.equal((await a.send({ type: 'sync-wipe' })).enabled, false);
    ok('test account wiped from the deployed server');
  }

  if (process.env.MEASURE === '1') {
    for (const context of contexts) await context.close();
    contexts.length = 0;
    const run = async (dir, label) => {
      const debugPort = 9300 + Math.floor(Math.random() * 500);
      const child = spawn(browserPath, [`--user-data-dir=${dir}`, `--remote-debugging-port=${debugPort}`, `--load-extension=${extension}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
      try {
        const list = async () => { try { return await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); } catch { return []; } };
        const workerOf = async () => (await list()).find(t => t.type === 'service_worker' && t.url.endsWith('/worker.js'));
        await until(workerOf, `${label}: worker starts`);
        // Listing targets does not attach to them, so nothing here keeps the worker awake.
        const started = Date.now();
        let asleep;
        while (Date.now() - started < 100_000) {
          if (!await workerOf()) { asleep = Date.now() - started; break; }
          await sleep(1000);
        }
        // Same moment in every run: RSS right after startup is mostly the browser settling.
        await sleep(Math.max(0, 110_000 - (Date.now() - started)));
        const rssKb = execFileSync('sh', ['-c', `ps -axo rss=,command= | grep -F -- "--user-data-dir=${dir}" | grep -v grep | awk '{s+=$1} END {print s}'`]).toString().trim();
        console.log(`MEASURE ${label}: worker asleep after ${asleep === undefined ? 'NEVER (100 s)' : `${Math.round(asleep / 1000)} s`}, browser RSS ${Math.round(Number(rssKb) / 1024)} MB`);
      } finally {
        const exited = new Promise(r => child.once('exit', r));
        child.kill();
        await exited;
        await sleep(3000); // helpers of this run must not be counted in the next one
      }
    };
    const off = await mkdtemp(join(tmpdir(), 'lehko-sync-off-'));
    dirs.push(off);
    for (let i = 1; i <= 4; i++) {
      await run(off, `sync off #${i}`);
      await run(dirs[0], `sync on  #${i}`);
    }
  }
} catch (error) {
  failed = true;
  console.error('FAIL', error);
  console.error(wranglerLog.slice(-1500));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  fixture.close();
  try { if (wrangler) process.kill(-wrangler.pid); } catch { /* already gone */ }
  await sleep(500);
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
