// Real browser, no setup step: hovering the left edge of a page slides the folder panel out, also under a strict CSP.
// CHROME_PATH picks the browser (default: ungoogled-chromium inside Lehko.app).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const browser = process.env.CHROME_PATH ?? '/Applications/Lehko.app/Contents/Resources/Chromium.app/Contents/MacOS/Chromium';
const extension = resolve('dist');
const dir = await mkdtemp(join(tmpdir(), 'lehko-edge-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = name => console.log(`PASS ${name}`);
async function until(predicate, label, timeout = 10_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`);
    await sleep(100);
  }
}
const site = createServer((request, response) => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (request.url.startsWith('/strict')) headers['Content-Security-Policy'] = "default-src 'none'; frame-src 'none'; style-src 'none'";
  response.writeHead(200, headers);
  response.end(`<!doctype html><title>${request.url}</title><h1>Сторінка</h1>`);
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const base = `http://lehko-edge.example:${site.address().port}`;
const context = await chromium.launchPersistentContext(dir, {
  executablePath: browser, headless: process.env.HEADED !== '1', viewport: { width: 1100, height: 700 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP lehko-edge.example 127.0.0.1']
});
const panelFrame = page => page.frames().find(f => f.url().includes('folders-panel.html'));
const hover = async page => { await page.mouse.move(400, 300); await page.mouse.move(1, 300, { steps: 4 }); };
let failed = false;
try {
  const isOurs = w => w.url().endsWith('/worker.js');
  const worker = context.serviceWorkers().find(isOurs) ?? await context.waitForEvent('serviceworker', { predicate: isOurs });
  await sleep(3000);
  const page = await context.newPage();
  await page.goto(`${base}/one`);
  await sleep(500);
  assert.equal(panelFrame(page), undefined, 'no frame before the first hover');
  ok('nothing loads until the first hover');

  await hover(page);
  const frame = await until(() => panelFrame(page), 'panel frame appears');
  await until(() => frame.locator('.folder').count(), 'folders listed in the panel');
  const name = await frame.locator('.folder.current .folder-name').textContent();
  assert.equal(name, 'Основна');
  ok('hovering the edge shows the folders, with no setup step');

  const box = await page.evaluate(() => document.elementFromPoint(150, 300)?.tagName);
  assert.notEqual(box, 'H1');
  await page.mouse.move(800, 300);
  await until(async () => (await page.evaluate(() => document.elementFromPoint(150, 300)?.tagName)) !== 'DIV', 'panel slides away', 3000);
  ok('leaving the panel hides it');

  const width = await page.evaluate(() => innerWidth);
  await page.mouse.move(400, 300);
  await page.mouse.move(width - 1, 300, { steps: 4 });
  await until(async () => (await page.evaluate(w => document.elementFromPoint(w - 150, 300)?.tagName, width)) === 'DIV', 'panel slides out on the right', 3000);
  ok('hovering the right edge shows the panel on that side');
  await page.mouse.move(400, 300);
  await until(async () => (await page.evaluate(w => document.elementFromPoint(w - 150, 300)?.tagName, width)) !== 'DIV', 'right panel slides away', 3000);
  ok('leaving the right panel hides it');
  await sleep(400);

  await hover(page);
  await until(async () => (await page.evaluate(() => document.elementFromPoint(150, 300)?.tagName)) === 'DIV', 'panel slides out again', 3000);
  await sleep(250);
  // The pointer stays over the frame, as when it left for the toolbar: only the frame's own report can close the panel.
  await page.mouse.move(150, 300);
  await frame.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
  await until(async () => (await page.evaluate(() => document.elementFromPoint(150, 300)?.tagName)) !== 'DIV', 'panel closes on the report from its frame', 3000);
  ok('leaving the frame without the page noticing hides it');

  await hover(page);
  await until(async () => (await page.evaluate(() => document.elementFromPoint(150, 300)?.tagName)) === 'DIV', 'panel slides out again', 3000);
  await sleep(250); // the slide animation
  await frame.locator('#folders-footer button').click({ timeout: 8000 });
  await frame.locator('#folders-footer input').fill('Збоку');
  await frame.locator('#folders-footer input').press('Enter');
  await until(() => worker.evaluate(async () => {
    const { folders, currentId } = await chrome.storage.local.get(['folders', 'currentId']);
    return folders.find(f => f.id === currentId)?.name === 'Збоку';
  }), 'folder created from the page panel');
  ok('the panel on a page creates and switches folders');

  const strict = await context.newPage();
  await strict.goto(`${base}/strict`);
  await sleep(300);
  await strict.bringToFront();
  await hover(strict);
  const strictFrame = await until(() => panelFrame(strict), 'panel under strict CSP');
  await until(() => strictFrame.locator('.folder').count(), 'folders under strict CSP');
  ok('the panel works under a strict page CSP');

  await worker.evaluate(() => chrome.storage.local.set({ folderEdge: false }));
  const off = await context.newPage();
  await off.goto(`${base}/off`);
  await off.bringToFront();
  await sleep(300);
  await hover(off);
  await sleep(800);
  assert.equal(panelFrame(off), undefined);
  ok('the switch in the popup turns it off');
} catch (error) {
  failed = true;
  console.error('FAIL', error);
} finally {
  await context.close().catch(() => {});
  site.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
