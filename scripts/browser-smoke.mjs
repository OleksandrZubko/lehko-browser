// Real Chrome, isolated disposable profile, production extension. Accelerated timestamps are ONLY for functional checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const extension = resolve('dist');
const output = resolve('artifacts');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'lehko-smoke-'));
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><head><title>Fixture ${request.url}</title></head><body><h1>Browser Lab</h1><p>Disposable test page</p><input aria-label="Draft"><script>globalThis.payload = new Uint8Array(1024 * 1024).fill(42)</script></body></html>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const checks = [];
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.env.HEADED !== '1',
    viewport: { width: 900, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check'],
  });
  const browser = context.browser();
  const cdp = await browser.newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  let worker = context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`));
  if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: w => w.url().startsWith(`chrome-extension://${id}/`) });
  await worker.evaluate(async () => {
    const started = Date.now();
    while (!(await chrome.storage.local.get('settings')).settings) {
      if (Date.now() - started > 5000) throw new Error('Worker did not initialize');
      await new Promise(r => setTimeout(r, 20));
    }
  });
  checks.push('MV3 module worker installed and initialized in Chrome Stable');
  const pages = [];
  for (let index = 0; index < 12; index++) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/page/${index}`);
    pages.push(page);
  }
  const draft = await context.newPage();
  await draft.goto(`http://localhost:${port}/draft`);
  await draft.getByLabel('Draft').fill('Незбережена робота');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole('switch', { name: 'Економія вкладок', exact: true }).waitFor({ state: 'visible' });
  await popup.waitForFunction(() => !document.querySelector('#enabled').disabled);
  assert.equal(await popup.locator('#site-title').textContent(), 'Службова сторінка');
  checks.push('Popup initializes through runtime messages, service page cannot be allowlisted');

  // Keep the test UI open as a background tab while the site is the current active tab.
  await pages[11].bringToFront();
  await popup.locator('#refresh').click();
  await popup.waitForFunction(() => document.querySelector('#site-title').textContent === '127.0.0.1');
  assert.equal(await popup.locator('#toggle-site').isDisabled(), true);
  await popup.locator('#safe-site').check();
  await popup.locator('#toggle-site').click();
  await popup.waitForFunction(() => document.querySelector('#host-count').textContent === '(1)');
  checks.push('Host opt-in requires acknowledgement; exact host saved through popup');
  await popup.locator('#timeout').selectOption('30');
  await popup.waitForFunction(() => !document.querySelector('#timeout').disabled);
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).timeoutMinutes, 30);
  await popup.locator('#timeout').selectOption('15');
  await popup.waitForFunction(() => !document.querySelector('#timeout').disabled);
  await popup.getByRole('switch', { name: 'Економія вкладок', exact: true }).uncheck();
  await popup.waitForFunction(() => document.querySelector('#mode-description').textContent.includes('паузі'));
  await popup.getByRole('switch', { name: 'Економія вкладок', exact: true }).check();
  await popup.waitForFunction(() => document.querySelector('#mode-description').textContent.includes('увімкнено'));
  checks.push('Pause/resume and 15/30-minute settings persist');

  const metadata = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const candidates = tabs.filter(t => t.url?.includes('/page/'));
    const pinned = candidates.find(t => t.url.endsWith('/0'));
    const protectedTab = candidates.find(t => t.url.endsWith('/1'));
    await chrome.tabs.update(pinned.id, { pinned: true });
    await chrome.tabs.update(protectedTab.id, { autoDiscardable: false });
    return { pinned: pinned.id, protected: protectedTab.id };
  });
  // The fixture is served from 127.0.0.1, which QA mode keeps loaded; this test exercises the discard policy itself.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'savings-qa', bypass: false }));
  // Wait for activity events to settle, then seed only session timestamps. Production code/timers are unchanged.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  await popup.evaluate(() => {
    window.tabEvents = [];
    chrome.tabs.onUpdated.addListener((id, changes, tab) => window.tabEvents.push({ type: 'updated', id, changes, discarded: tab.discarded }));
    chrome.tabs.onCreated.addListener(tab => window.tabEvents.push({ type: 'created', id: tab.id }));
    chrome.tabs.onActivated.addListener(info => window.tabEvents.push({ type: 'activated', ...info }));
    chrome.tabs.onRemoved.addListener(id => window.tabEvents.push({ type: 'removed', id }));
    chrome.tabs.onReplaced.addListener((added, removed) => window.tabEvents.push({ type: 'replaced', added, removed }));
  });
  const before = await worker.evaluate(async () => {
    const { session } = await chrome.storage.session.get('session');
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      const activity = session.activity[String(tab.id)];
      if (activity) { activity.idleSince = Date.now() - 16 * 60_000; activity.wasActive = tab.active; }
    }
    await chrome.storage.session.set({ session });
    return tabs;
  });
  // Terminate the worker so the next wake reads the seeded session exactly as a normal MV3 restart.
  const pageCdp = await context.newCDPSession(popup);
  const versions = new Map();
  pageCdp.on('ServiceWorker.workerVersionUpdated', ({ versions: changed }) => {
    for (const version of changed) versions.set(version.versionId, version);
  });
  await pageCdp.send('ServiceWorker.enable');
  async function waitUntil(predicate) {
    const started = Date.now();
    while (!await predicate()) {
      if (Date.now() - started > 10_000) throw new Error('Timed out waiting for service-worker lifecycle');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  await waitUntil(() => [...versions.values()].some(v => v.scriptURL === `chrome-extension://${id}/worker.js`));
  const version = [...versions.values()].find(v => v.scriptURL === `chrome-extension://${id}/worker.js`);
  await pageCdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await waitUntil(() => versions.get(version.versionId).runningStatus === 'stopped');
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  // Schedule an immediate alarm via the extension page, exercising the actual registered alarm listener.
  await popup.evaluate(() => chrome.alarms.create('sweep', { when: Date.now() + 100 }));
  await waitUntil(() => popup.evaluate(async () => {
    const { session } = await chrome.storage.session.get('session');
    return session.discardedCount > 0;
  }));
  const result = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'status' });
    return { status: response.status, storage: (await chrome.storage.session.get('session')).session,
      events: window.tabEvents, tabs: await chrome.tabs.query({}) };
  });
  const discarded = result.tabs.filter(t => t.discarded);
  await writeFile(join(output, 'browser-smoke-state.json'), JSON.stringify(result, null, 2));
  assert.equal(discarded.length, 6, 'All six eligible tabs must be processed in a single sweep');
  assert.ok(!discarded.some(t => t.id === metadata.pinned || t.id === metadata.protected || t.active));
  assert.ok(!discarded.some(t => t.url?.includes('localhost')));
  assert.equal(await draft.getByLabel('Draft').inputValue(), 'Незбережена робота');
  checks.push('Real alarm discards eligible tabs; active, pinned, browser-protected, disallowed draft survive');
  checks.push('Session timers recover after actual service-worker termination');

  const sleeping = discarded[0];
  await popup.evaluate(id => chrome.tabs.update(id, { active: true }), sleeping.id);
  await waitUntil(() => popup.evaluate(async id => !(await chrome.tabs.get(id)).discarded, sleeping.id));
  checks.push('A discarded tab reloads on activation');
  // Return to the website for a representative screenshot of the interface.
  await pages[11].bringToFront();
  await popup.locator('#refresh').click();
  await popup.waitForFunction(() => !document.querySelector('#refresh').disabled);
  await popup.locator('details').first().evaluate(el => { el.open = true; });
  await popup.screenshot({ path: join(output, 'popup.png'), fullPage: true });
  await writeFile(join(output, 'browser-smoke.json'), JSON.stringify({
    browser: browser.version(), headless: process.env.HEADED !== '1',
    checks, tabCountBefore: before.length, actualDiscarded: discarded.length,
    functionalClockAcceleration: true, performanceEvidence: false,
  }, null, 2));
  console.log(JSON.stringify({ checks, actualDiscarded: discarded.length, screenshot: 'artifacts/popup.png' }, null, 2));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
