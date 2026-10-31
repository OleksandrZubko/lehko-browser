// Real browser: the popup opens the side panel, and the panel switches folders and follows outside changes.
// CHROME_PATH picks the browser (default: ungoogled-chromium inside Lehko.app).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { connectCDP } from './lib/raw-cdp.mjs';

const browser = process.env.CHROME_PATH ?? '/Applications/Lehko.app/Contents/Resources/Chromium.app/Contents/MacOS/Chromium';
const extension = resolve('dist');
const dir = await mkdtemp(join(tmpdir(), 'lehko-panel-'));
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
const PORT = 9710;
const context = await chromium.launchPersistentContext(dir, {
  executablePath: browser, headless: process.env.HEADED !== '1', viewport: { width: 1100, height: 700 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`]
});
let failed = false;
try {
  const isOurs = w => w.url().endsWith('/worker.js');
  const worker = context.serviceWorkers().find(isOurs) ?? await context.waitForEvent('serviceworker', { predicate: isOurs });
  const id = new URL(worker.url()).host;
  await sleep(3000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const button = popup.locator('#folders-open-panel');
  await until(() => button.isVisible(), 'open button');
  await button.click();
  const contexts = await until(() => worker.evaluate(async () => {
    const found = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return found.length ? found.map(c => c.documentUrl) : null;
  }), 'side panel context');
  assert.ok(contexts[0].includes('folders-panel.html'), contexts[0]);
  ok('the popup button opens the side panel');

  // Automation libraries do not list side panels as pages, so this talks to its target directly.
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const cdp = await connectCDP(webSocketDebuggerUrl);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find(t => t.url.includes('folders-panel.html'));
  assert.ok(target, 'panel target');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const inPanel = async expression => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  const currentName = () => inPanel(`document.querySelector('.folder.current .folder-name')?.textContent`);

  await until(() => inPanel(`document.querySelectorAll('.folder').length`), 'folder list in the panel');
  await inPanel(`document.querySelector('#folders-footer button').click()`);
  await inPanel(`(() => { const input = document.querySelector('#folders-footer input'); input.value = 'Збоку'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await until(async () => await currentName() === 'Збоку', 'new folder is current');
  assert.ok(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length));
  ok('the panel creates and switches folders and stays open');

  await worker.evaluate(async () => {
    const { folders } = await chrome.storage.local.get('folders');
    folders.push({ id: 'from-outside', name: 'Ззовні', color: '#0091ff', tabs: [], activeIndex: 0 });
    await chrome.storage.local.set({ folders });
  });
  await until(() => inPanel(`[...document.querySelectorAll('.folder-name')].some(n => n.textContent === 'Ззовні')`), 'outside change shown');
  ok('the panel follows changes from outside');

  await inPanel(`[...document.querySelectorAll('.folder')].find(f => f.textContent.includes('Основна')).click()`);
  await until(async () => await currentName() === 'Основна', 'switch back');
  ok('the panel switches back');
  cdp.close();
} catch (error) {
  failed = true;
  console.error('FAIL', error);
} finally {
  await context.close().catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
