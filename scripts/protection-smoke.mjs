// Real Chrome, disposable profiles: QA bypass on *.test, and folder switches refused for a tab with a dirty form
// or open DevTools. The form check needs host access, so this test loads a copy of dist/ with it granted upfront.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const AD = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Form ${request.url}</title><script src="${AD}"></script><input id="field" value="початкове">`);
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const port = server.address().port;
const extension = await mkdtemp(join(tmpdir(), 'lehko-protection-ext-'));
await cp(resolve('dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const checks = [];

async function launch(extraArgs, { headless = process.env.HEADED !== '1' } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'lehko-protection-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
      `--host-resolver-rules=MAP shop.test 127.0.0.1, MAP shop.example 127.0.0.1`, ...extraArgs],
  });
  // Anything that gets past the rules is answered here instead of reaching the network.
  await context.route(url => url.href.startsWith(AD), route => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/popup.html`);
  await control.getByRole('switch', { name: 'Блокувати рекламу' }).waitFor();
  // Pinned tabs belong to no folder, so a switch never closes the page this test talks through.
  await control.evaluate(async () => chrome.tabs.update((await chrome.tabs.getCurrent()).id, { pinned: true }));
  const send = request => control.evaluate(r => chrome.runtime.sendMessage(r), request);
  return { context, profile, send };
}

let session;
try {
  session = await launch([]);
  const { context, send } = session;
  async function ad(host) {
    const page = await context.newPage();
    let state = 'not requested';
    page.on('requestfailed', request => { if (request.url() === AD) state = request.failure()?.errorText; });
    page.on('requestfinished', request => { if (request.url() === AD) state = 'loaded'; });
    await page.goto(`http://${host}:${port}/`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    return { page, state };
  }
  const local = await ad('shop.test');
  const other = await ad('shop.example');
  assert.equal(local.state, 'loaded');
  assert.equal(other.state, 'net::ERR_BLOCKED_BY_CLIENT');
  checks.push('QA bypass: ad script loads on shop.test, blocked on shop.example');

  await local.page.close();
  await other.page.fill('#field', 'незбережений текст');
  await other.page.bringToFront();
  let reply = await send({ type: 'folders-create', name: 'Особисте' });
  assert.ok(reply.ok, JSON.stringify(reply));
  assert.deepEqual(reply.status.blocked?.map(b => b.reason), ['Незбережені дані у формі'], JSON.stringify(reply));
  assert.equal(reply.status.folders.length, 1);
  await other.page.fill('#field', 'початкове');
  reply = await send({ type: 'folders-create', name: 'Особисте' });
  assert.ok(reply.ok && !reply.status.blocked && reply.status.folders.length === 2, JSON.stringify(reply));
  checks.push('Folder switch refused while a form holds unsaved text; allowed once the field is back to its served value');
  await context.close();
  await rm(session.profile, { recursive: true, force: true });

  // DevTools windows need a headed browser.
  session = await launch(['--auto-open-devtools-for-tabs'], { headless: false });
  const page = await session.context.newPage();
  await page.goto(`http://shop.example:${port}/devtools`);
  await page.bringToFront();
  const targets = await session.context.browser().newBrowserCDPSession();
  for (let i = 0; i < 80; i++) {
    const { targetInfos } = await targets.send('Target.getTargets');
    if (targetInfos.some(t => t.url.endsWith('/devtools.html'))) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
  const answer = await session.send({ type: 'folders-create', name: 'Інше' });
  const blocked = answer.status?.blocked;
  assert.ok(blocked?.some(b => b.reason === 'Відкрито DevTools' && b.title.includes('/devtools')), JSON.stringify(answer));
  checks.push('Folder switch refused for a tab with DevTools open (devtools_page port)');
} finally {
  await session?.context.close().catch(() => {});
  if (session) await rm(session.profile, { recursive: true, force: true });
  await rm(extension, { recursive: true, force: true });
  server.close();
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));
