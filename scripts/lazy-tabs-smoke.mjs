// Real browser: sleeping folder tabs show their titles, send nothing to the site, and load when opened.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const browser = process.env.CHROME_PATH ?? '/Applications/Lehko.app/Contents/Resources/Chromium.app/Contents/MacOS/Chromium';
const dir = await mkdtemp(join(tmpdir(), 'lehko-lazy-'));
const extension = resolve('dist');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = name => console.log(`PASS ${name}`);
async function until(predicate, label, timeout = 15_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`);
    await sleep(100);
  }
}
const hits = [];
const site = createServer((request, response) => {
  if (request.url !== '/favicon.ico') hits.push(request.url);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Сторінка ${request.url}</title><h1>${request.url}</h1>`);
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const base = `http://lazy.lehko-sync.example:${site.address().port}`;
const context = await chromium.launchPersistentContext(dir, {
  executablePath: browser, headless: process.env.HEADED !== '1', viewport: { width: 1000, height: 700 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP *.lehko-sync.example 127.0.0.1']
});
let failed = false;
try {
  const isOurs = w => w.url().endsWith('/worker.js');
  const worker = context.serviceWorkers().find(isOurs) ?? await context.waitForEvent('serviceworker', { predicate: isOurs });
  await sleep(3000);
  // A second window: a folder switch closes the tabs of the window under test.
  const id = new URL(worker.url()).host;
  const windowId = await worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id);
  const opened = context.waitForEvent('page');
  await worker.evaluate(url => chrome.windows.create({ url }).then(() => {}), `chrome-extension://${id}/welcome.html`);
  const control = await opened;
  await control.waitForLoadState();
  const send = message => control.evaluate(m => chrome.runtime.sendMessage(m), message).then(reply => { assert.ok(reply?.ok, reply?.error); return reply.status; });
  const pages = ['/a', '/b', '/c'].map(p => base + p);
  for (const url of pages) {
    await worker.evaluate(([w, u]) => chrome.tabs.create({ windowId: w, url: u, active: false }).then(() => {}), [windowId, url]);
  }
  await until(async () => {
    const { folders } = await send({ type: 'folders-list', windowId }).then(() => worker.evaluate(() => chrome.storage.local.get('folders')));
    return folders[0].tabs.filter(t => t.url.includes('lazy.lehko') && t.title.startsWith('Сторінка')).length === 3;
  }, 'titles captured');
  const main = (await send({ type: 'folders-list', windowId })).currentId;
  await send({ type: 'folders-create', name: 'Інша', windowId, force: true });
  hits.length = 0;
  await send({ type: 'folders-switch', id: main, windowId, force: true });

  const sleeping = () => worker.evaluate(async () => (await chrome.tabs.query({})).filter(t => t.discarded).map(t => ({ id: t.id, title: t.title, url: t.url })));
  const tabs = await until(async () => {
    const list = (await sleeping()).filter(t => t.url?.includes('lazy.html'));
    return list.length >= 3 && list;
  }, 'tabs asleep');
  for (const page of ['/a', '/b', '/c']) assert.ok(tabs.some(t => t.title === `Сторінка ${page}`), `${page} title: ${JSON.stringify(tabs.map(t => t.title))}`);
  ok('sleeping tabs show their real titles');

  const stored = await worker.evaluate(() => chrome.storage.local.get('folders'));
  assert.equal(JSON.stringify(stored.folders).includes('lazy.html'), false, 'the folder keeps real addresses');
  ok('folders store the real addresses');

  const before = hits.filter(h => ['/a', '/b', '/c'].includes(h));
  assert.ok(before.length <= 1, `only the active tab may load: ${before}`);
  ok('sleeping tabs send nothing to the site');

  const target = tabs.find(t => t.title === 'Сторінка /b');
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }).then(() => {}), target.id);
  await until(async () => hits.includes('/b') && worker.evaluate(async url => (await chrome.tabs.query({ active: true })).some(t => t.url === url), `${base}/b`), 'opened tab loads its page');
  ok('opening a sleeping tab loads its page');

  const back = await until(() => worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url), `${base}/b`), 'tab found');
  const webPage = context.pages().find(p => p.url() === `${base}/b`);
  if (webPage) assert.equal(await webPage.evaluate(() => history.length), 1, 'no placeholder left in Back history');
  assert.ok(back);
  ok('the placeholder stays out of Back history');
} catch (error) {
  failed = true;
  console.error('FAIL', error);
} finally {
  await context.close().catch(() => {});
  site.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
