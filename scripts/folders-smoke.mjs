// Real Chrome, disposable profile, built extension from dist/. Drives the worker with the same messages the popup sends.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const extension = resolve('dist');
const profile = await mkdtemp(join(tmpdir(), 'lehko-folders-'));
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Fixture ${request.url}</title><h1>${request.url}</h1>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const ok = name => { checks.push(name); console.log(`PASS ${name}`); };
let context;
let failed = false;

async function until(predicate, label, timeout = 10_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`);
    await sleep(50);
  }
}

const profiles = [profile];

// restore: null = default, 1 = restore last session, 5 = open the New Tab page
async function launch(dir, restore) {
  if (restore !== null) {
    await mkdir(join(dir, 'Default'), { recursive: true });
    const file = join(dir, 'Default', 'Preferences');
    const prefs = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    prefs.session = { ...prefs.session, restore_on_startup: restore };
    await writeFile(file, JSON.stringify(prefs));
  }
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.env.HEADED !== '1',
    viewport: { width: 900, height: 700 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
      ...(restore === 1 ? ['--restore-last-session'] : [])],
  });
  context = ctx;
  const startupUrls = ctx.pages().map(page => page.url());
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  const ours = w => w.url().startsWith(`chrome-extension://${id}/`);
  const worker = ctx.serviceWorkers().find(ours) ?? await ctx.waitForEvent('serviceworker', { predicate: ours });
  return { context: ctx, browserCdp: cdp, id, worker, startupUrls };
}


const windowTabs = (worker, windowId) => worker.evaluate(async windowId => {
  const all = await chrome.tabs.query({ windowId });
  return all.sort((a, b) => a.index - b.index).map(t => ({ id: t.id, index: t.index, url: t.url || t.pendingUrl || '', title: t.title,
    active: t.active, pinned: t.pinned, discarded: t.discarded, status: t.status }));
}, windowId);
const storedOf = worker => worker.evaluate(() => chrome.storage.local.get(['folders', 'currentId']));
const normalWindows = worker => worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).map(w => w.id));

// Browser restart: current folder = 1 loaded + 2 lazy tabs, plus another saved folder.
// restore 1 = Chrome restores the last session, 5 = Chrome opens the New Tab page.
async function restartScenario(restore) {
  const label = restore === 1 ? 'restart with session restore' : 'restart without session restore';
  const dir = await mkdtemp(join(tmpdir(), 'lehko-folders-restart-'));
  profiles.push(dir);
  const R = [1, 2, 3].map(n => `${base}/r/${n}`);
  const OTHER = `${base}/o/1`;

  let session = await launch(dir, restore);
  const { id } = session;
  const pages = [context.pages()[0]];
  await pages[0].goto(R[0]);
  for (const url of R.slice(1)) { const page = await context.newPage(); await page.goto(url); pages.push(page); }
  const windowId = (await session.worker.evaluate(() => chrome.tabs.query({ url: '*://127.0.0.1/r/1' })))[0].windowId;
  const uiOpened = context.waitForEvent('page');
  await session.browserCdp.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html?windowId=${windowId}`, newWindow: true });
  const ui = await uiOpened;
  await ui.waitForSelector('#folders-list li');
  const send = async message => {
    const reply = await ui.evaluate(m => chrome.runtime.sendMessage(m), { windowId, ...message });
    assert.equal(reply?.ok, true, `${message.type}: ${reply?.error}`);
    assert.equal(reply.status.blocked, undefined, 'no guard is wired: nothing is ever blocked');
    return reply.status;
  };

  let state = await send({ type: 'folders-list' });
  const mainId = state.currentId;
  state = await send({ type: 'folders-create', name: 'Інша' });
  await session.worker.evaluate(async ([windowId, url]) => {
    const [blank] = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned);
    await chrome.tabs.update(blank.id, { url });
  }, [windowId, OTHER]);
  await until(async () => (await windowTabs(session.worker, windowId)).every(t => t.status === 'complete' && t.url === OTHER), 'other folder loaded');
  await send({ type: 'folders-switch', id: mainId });
  await until(async () => (await windowTabs(session.worker, windowId)).length === 3, 'main restored');
  await sleep(1500);
  await send({ type: 'folders-list' });
  await sleep(1500);
  const before = await storedOf(session.worker);
  const urlsOf = (data, name) => data.folders.find(f => f.name === name).tabs.map(t => t.url);
  assert.deepEqual(urlsOf(before, 'Основна'), R);
  assert.deepEqual(urlsOf(before, 'Інша'), [OTHER]);
  const lazyBefore = (await windowTabs(session.worker, windowId)).filter(t => t.discarded || t.status === 'unloaded').length;
  assert.equal(lazyBefore, 2, 'two lazy tabs before restart');

  await ui.close();
  await context.close();
  session = await launch(dir, restore);
  assert.equal(session.id, id, 'unpacked extension keeps its id across relaunch');
  const worker = session.worker;

  // wait for the startup reconcile, then for a debounced snapshot to have had its chance to do damage
  const [win] = await normalWindows(worker);
  const rebuilt = await until(async () => {
    const t = await windowTabs(worker, win);
    return t.length === 3 && t.every(x => !x.url.includes('about:blank')) && t;
  }, `${label}: current folder re-opened`, 20_000);
  await sleep(2500);
  const now = await windowTabs(worker, win);
  assert.equal(now.length, 3, 'exactly the 3 folder tabs, no leftovers');
  assert.deepEqual((await normalWindows(worker)).length, 1);
  const active = before.folders.find(f => f.id === mainId).activeIndex;
  const restored = session.startupUrls.filter(u => u.startsWith(base));
  assert.deepEqual(restored, restore === 1 ? [R[active]] : [], 'Chrome restored only the loaded tab (or nothing without restore); lazy tabs were dropped');
  assert.equal(now[active].url, R[active], 'previously active tab loaded');
  assert.equal(now[active].active, true);
  for (const i of [0, 1, 2].filter(i => i !== active)) {
    assert.ok(now[i].discarded || now[i].status === 'unloaded', `tab ${i} is lazy after restart`);
  }
  const after = await storedOf(worker);
  assert.deepEqual(urlsOf(after, 'Основна'), R, 'current folder keeps all 3 URLs');
  assert.deepEqual(after.folders.find(f => f.name === 'Інша'), before.folders.find(f => f.name === 'Інша'), 'other folder untouched');
  assert.equal(after.currentId, mainId);

  // a formerly lazy tab (no session-map entry survived the restart) loads its real URL on activation
  const lazyIndex = [0, 1, 2].find(i => i !== active);
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), now[lazyIndex].id);
  await until(async () => {
    const t = (await windowTabs(worker, win))[lazyIndex];
    return t.url === R[lazyIndex] && t.status === 'complete';
  }, `${label}: lazy tab loads real URL`);
  await sleep(1500);
  assert.deepEqual(urlsOf(await storedOf(worker), 'Основна'), R);
  ok(`${label}: current folder kept all 3 URLs, re-opened with 1 loaded + 2 lazy, lazy tab loads on activation`);

  // a second, session-less run of the same code path: wipe session storage (what a restart does) with blank tabs present
  await worker.evaluate(async windowId => {
    await chrome.storage.session.clear();
    for (const t of await chrome.tabs.query({ windowId })) if (!t.pinned) await chrome.tabs.update(t.id, { url: 'about:blank' });
  }, win);
  await sleep(2500);
  assert.deepEqual(urlsOf(await storedOf(worker), 'Основна'), R, 'blank tabs never overwrite a folder');
  ok(`${label}: automatic snapshots of blank tabs never shrink the folder`);
  await context.close();

}

try {
  const { browserCdp, id, worker } = await launch(profile, null);
  // ---- helpers ----
  const tabs = filter => worker.evaluate(async ([windowId, filter]) => {
    const all = await chrome.tabs.query({ windowId });
    return all.sort((a, b) => a.index - b.index).filter(t => filter === 'all' || (filter === 'pinned') === t.pinned)
      .map(t => ({ id: t.id, url: t.url || t.pendingUrl, title: t.title, active: t.active, pinned: t.pinned, discarded: t.discarded, status: t.status }));
  }, [mainWindow, filter]);
  const stored = () => worker.evaluate(() => chrome.storage.local.get(['folders', 'currentId']));
  const folderUrls = (data, name) => data.folders.find(f => f.name === name).tabs.map(t => t.url);
  // Badge text belongs to the blocked-request counter: a folder only sets the background colour and the title.
  const badge = async () => {
    const raw = await worker.evaluate(async () => ({ color: await chrome.action.getBadgeBackgroundColor({}), text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }));
    assert.doesNotMatch(raw.text, /[А-ЯІЇЄҐа-яіїєґ]/, 'badge text is never a folder name');
    return { color: `#${raw.color.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('')}`, title: raw.title };
  };
  let mainWindow;
  let ui;
  const send = async message => {
    const reply = await ui.evaluate(m => chrome.runtime.sendMessage(m), { windowId: mainWindow, ...message });
    return reply;
  };
  const sendOk = async message => {
    const reply = await send(message);
    assert.equal(reply?.ok, true, `${message.type} failed: ${reply?.error}`);
    return reply.status;
  };
  const sendFails = async message => {
    const reply = await send(message);
    assert.equal(reply?.ok, false, `${message.type} should have been refused`);
    return reply.error;
  };

  // ---- window under test: [pinned] + 3 fixture tabs, /a/2 active ----
  const first = context.pages()[0];
  await first.goto(`${base}/pinned`);
  await first.evaluate(() => { globalThis.marker = 'untouched'; });
  const a = [];
  for (const n of [1, 2, 3]) { const p = await context.newPage(); await p.goto(`${base}/a/${n}`); a.push(p); }
  const pinnedId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://127.0.0.1/pinned' });
    await chrome.tabs.update(tab.id, { pinned: true });
    return tab.id;
  });
  mainWindow = await worker.evaluate(id => chrome.tabs.get(id).then(t => t.windowId), pinnedId);
  await worker.evaluate(async windowId => {
    const [tab] = await chrome.tabs.query({ windowId, url: '*://127.0.0.1/a/2' });
    await chrome.tabs.update(tab.id, { active: true });
  }, mainWindow);
  const A = [1, 2, 3].map(n => `${base}/a/${n}`);

  // Extension page in a separate window so it is not part of the folders under test.
  const uiPagePromise = context.waitForEvent('page');
  await browserCdp.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html?windowId=${mainWindow}`, newWindow: true });
  ui = await uiPagePromise;
  await ui.waitForSelector('#folders-list li');
  assert.notEqual(await ui.evaluate(() => chrome.windows.getCurrent().then(w => w.id)), mainWindow);

  // ---- first run ----
  let state = await sendOk({ type: 'folders-list' });
  assert.equal(state.folders.length, 1);
  assert.equal(state.folders[0].name, 'Основна');
  assert.equal(state.folders[0].count, 3);
  assert.equal(state.currentId, state.folders[0].id);
  let data = await stored();
  assert.deepEqual(folderUrls(data, 'Основна'), A);
  assert.equal(data.folders[0].activeIndex, 1);
  assert.deepEqual(await badge(), { color: '#e5484d', title: 'Легко · Папка: Основна' });
  ok('first run: folder "Основна" captures the 3 open tabs (pinned excluded), active index 1, badge colour and title set, badge text untouched');

  // ---- create "Робота" ----
  const mainId = state.currentId;
  state = await sendOk({ type: 'folders-create', name: 'Робота' });
  const workId = state.currentId;
  assert.notEqual(workId, mainId);
  let now = await tabs('unpinned');
  assert.equal(now.length, 1);
  assert.match(now[0].url, /^chrome:\/\/newtab/);
  assert.equal((await tabs('pinned')).length, 1);
  data = await stored();
  assert.deepEqual(folderUrls(data, 'Основна'), A);
  assert.deepEqual(await badge(), { color: '#f76b15', title: 'Легко · Папка: Робота' });
  ok('create "Робота": window has 1 new tab, old tabs closed, "Основна" saved with 3 tabs');

  // ---- fill "Робота" with 3 tabs, /b/3 active ----
  const B = [1, 2, 3].map(n => `${base}/b/${n}`);
  await worker.evaluate(async ([windowId, urls]) => {
    const [blank] = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned);
    await chrome.tabs.update(blank.id, { url: urls[0] });
    await chrome.tabs.create({ windowId, url: urls[1], active: false });
    await chrome.tabs.create({ windowId, url: urls[2], active: true });
  }, [mainWindow, B]);
  await until(async () => (await tabs('unpinned')).every(t => t.status === 'complete' && t.title?.startsWith('Fixture')), 'Робота tabs loaded');
  await sleep(1600); // debounced snapshot
  data = await stored();
  assert.deepEqual(folderUrls(data, 'Робота'), B);
  assert.equal(data.folders.find(f => f.name === 'Робота').activeIndex, 2);
  assert.equal(data.folders.find(f => f.name === 'Робота').tabs[0].title, 'Fixture /b/1');
  ok('debounced snapshot keeps the current folder fresh (3 tabs, titles, active index)');

  // ---- switch back to "Основна" ----
  // A tab discarded before it commits reports url '' in Chrome; the worker must still know what it stands for.
  state = await sendOk({ type: 'folders-switch', id: mainId });
  assert.equal(state.currentId, mainId);
  now = await until(async () => {
    const t = await tabs('unpinned');
    return t.length === 3 && t;
  }, 'Основна restored: 3 tabs');
  assert.equal(now.filter(t => t.active).length, 1);
  assert.equal(now[1].active, true, 'previously active tab is active');
  assert.equal(now[1].url, A[1]);
  await until(async () => (await tabs('unpinned')).filter((_, i) => i !== 1).every(t => t.discarded || t.status === 'unloaded'), 'lazy tabs discarded', 8000);
  now = await tabs('unpinned');
  assert.equal(now[1].discarded, false);
  for (const i of [0, 2]) assert.ok(now[i].discarded || now[i].status === 'unloaded', `tab ${i} is lazy`);
  data = await stored();
  assert.deepEqual(folderUrls(data, 'Робота'), B);
  assert.equal(data.currentId, mainId);
  assert.equal(data.folders.find(f => f.id === workId).tabs[2].title, 'Fixture /b/3');
  ok('switch back: "Основна" restored in order; only the active tab loaded, the others discarded; "Робота" saved with 3 tabs');

  // snapshotting while tabs are discarded must not lose their URLs/titles
  await sendOk({ type: 'folders-list' });
  await sleep(1500);
  data = await stored();
  assert.deepEqual(folderUrls(data, 'Основна'), A);
  assert.equal(data.folders.find(f => f.id === mainId).activeIndex, 1);
  assert.deepEqual(data.folders.find(f => f.id === mainId).tabs.map(t => t.title), A.map((_, i) => `Fixture /a/${i + 1}`));
  ok('re-snapshot with discarded tabs keeps their URLs and titles');

  // activating a lazy tab loads its real URL
  await worker.evaluate(async windowId => {
    const [first] = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned).sort((x, y) => x.index - y.index);
    await chrome.tabs.update(first.id, { active: true });
  }, mainWindow);
  now = await until(async () => {
    const t = await tabs('unpinned');
    return t[0].url === A[0] && t[0].status === 'complete' && !t[0].discarded && t;
  }, 'lazy tab loads on activation');
  assert.equal(now[0].title, 'Fixture /a/1');
  await worker.evaluate(async windowId => {
    const [, second] = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned).sort((x, y) => x.index - y.index);
    await chrome.tabs.update(second.id, { active: true });
  }, mainWindow);
  ok('lazy tab loads its real URL when activated');

  // ---- pinned untouched ----
  const pinned = await tabs('pinned');
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, pinnedId);
  assert.equal(pinned[0].discarded, false);
  assert.equal(await first.evaluate(() => globalThis.marker), 'untouched');
  ok('pinned tab survived all switches (same id, not reloaded)');

  // ---- two simultaneous switches never overlap ----
  const [r1, r2] = await Promise.all([send({ type: 'folders-switch', id: workId }), send({ type: 'folders-switch', id: mainId })]);
  assert.ok(r1.ok && r2.ok);
  now = await until(async () => (await tabs('unpinned')).length === 3 && (await tabs('unpinned')), 'serialised switches end in last requested folder');
  assert.equal((await stored()).currentId, mainId);
  assert.equal((await tabs('pinned')).length, 1);
  ok('concurrent switches are serialised (no duplicated or leaked tabs)');

  // ---- moveTab ----
  await worker.evaluate(async windowId => {
    const third = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned).sort((x, y) => x.index - y.index)[2];
    await chrome.tabs.update(third.id, { active: true });
  }, mainWindow);
  state = await sendOk({ type: 'folders-move-tab', id: workId });
  now = await until(async () => (await tabs('unpinned')).length === 2 && (await tabs('unpinned')), 'tab moved out of window');
  data = await stored();
  assert.deepEqual(folderUrls(data, 'Робота'), [...B, A[2]]);
  assert.deepEqual(folderUrls(data, 'Основна'), A.slice(0, 2));
  assert.equal(state.folders.find(f => f.id === workId).count, 4);
  await sendFails({ type: 'folders-move-tab', id: mainId });
  ok('moveTab: active tab moved into another folder; moving into the current folder is refused');

  // ---- moveTab of the last tab keeps the window alive ----
  state = await sendOk({ type: 'folders-create', name: 'Порожня' });
  const emptyId = state.currentId;
  now = await tabs('unpinned');
  assert.equal(now.length, 1);
  await sendOk({ type: 'folders-move-tab', id: mainId });
  now = await tabs('unpinned');
  assert.equal(now.length, 1, 'a replacement new tab exists');
  assert.equal((await stored()).folders.find(f => f.id === mainId).tabs.length, 3);
  ok('moveTab of the last non-pinned tab opens a new tab first (window survives)');

  // ---- rename / delete / validation ----
  state = await sendOk({ type: 'folders-rename', id: workId, name: '  Нова   назва  ' });
  assert.equal(state.folders.find(f => f.id === workId).name, 'Нова назва');
  state = await sendOk({ type: 'folders-rename', id: emptyId, name: 'Щось' });
  assert.deepEqual(await badge(), { color: '#e5a50a', title: 'Легко · Папка: Щось' });
  await sendFails({ type: 'folders-rename', id: workId, name: '   ' });
  await sendFails({ type: 'folders-rename', id: workId, name: 'x'.repeat(41) });
  await sendFails({ type: 'folders-rename', id: 'nope', name: 'x' });
  await sendFails({ type: 'folders-switch', id: 42 });
  await sendFails({ type: 'folders-create', name: 7 });
  await sendFails({ type: 'folders-switch', id: mainId, windowId: 'abc' });
  ok('rename (trim/collapse, badge follows) and input validation');

  const refusal = await sendFails({ type: 'folders-delete', id: emptyId });
  assert.match(refusal, /поточн/);
  state = await sendOk({ type: 'folders-delete', id: workId });
  assert.equal(state.folders.some(f => f.id === workId), false);
  assert.equal((await stored()).folders.some(f => f.id === workId), false);
  await sendFails({ type: 'folders-delete', id: workId });
  ok('delete: current folder refused, other folder deleted');

  // ---- popup UI ----
  await ui.reload();
  await ui.waitForSelector('#folders-list li');
  const rows = await ui.locator('#folders-list li').count();
  assert.equal(rows, 2);
  assert.equal(await ui.locator('#folders-list li.current .folder-mark').textContent(), '●');
  assert.equal(await ui.locator('#folders-list li:not(.current) .folder-mark').textContent(), '○');
  assert.equal(await ui.locator('#folders-list li.current button[title^="Поточну"]').isDisabled(), true);
  const other = ui.locator('#folders-list li:not(.current)');
  await other.hover();
  await other.locator('button[title="Перейменувати"]').click();
  await ui.locator('#folders-list input').fill('Через UI');
  await ui.keyboard.press('Enter');
  await ui.waitForSelector('#folders-list .folder-name:text("Через UI")');
  await ui.locator('#folders-footer button').click();
  await ui.keyboard.type('Ескейп');
  await ui.keyboard.press('Escape');
  await ui.waitForSelector('#folders-footer button');
  await other.hover();
  await other.locator('button[title="Видалити"]').click();
  await ui.waitForSelector('.folder-confirm');
  await ui.locator('.folder-confirm button:text("Ні")').click();
  assert.equal(await ui.locator('#folders-list li').count(), 2);
  // No guard is wired yet, so stub one unforced create reply to see the blocked panel; «Все одно перемкнути» must resend with force.
  await ui.evaluate(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      if (message.type !== 'folders-create' || message.force) return real(message);
      const reply = await real({ type: 'folders-list', windowId: message.windowId });
      return { ...reply, status: { ...reply.status, blocked: [{ tabId: 1, title: 'Форма замовлення', reason: 'незбережена форма' }] } };
    };
  });
  await ui.locator('#folders-footer button').click();
  await ui.keyboard.type('З попапа');
  await ui.keyboard.press('Enter');
  await ui.waitForSelector('#folders-blocked:not([hidden])');
  const panel = await ui.locator('#folders-blocked').textContent();
  assert.match(panel, /Форма замовлення/);
  assert.match(panel, /незбережена форма/);
  assert.equal((await stored()).folders.some(f => f.name === 'З попапа'), false, 'blocked create changed nothing');
  await ui.locator('#folders-blocked button:text("Все одно перемкнути")').click();
  await until(async () => (await stored()).folders.some(f => f.name === 'З попапа'), 'folder created from popup UI');
  await until(async () => (await stored()).folders.find(f => f.name === 'З попапа').id === (await stored()).currentId, 'popup create switched');
  ok('popup UI: list, ●/○, disabled delete on current, inline rename (Enter/Esc), delete confirm, blocked panel + forced create');

  await context.close();
  await restartScenario(5);
  await restartScenario(1);
  console.log(`\nALL ${checks.length} CHECKS PASSED`);
} catch (error) {
  failed = true;
  console.error('FAIL', error);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  for (const dir of profiles) await rm(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
