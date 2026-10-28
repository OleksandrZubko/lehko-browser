// Real Chrome, disposable profile: static rulesets load, block, pause per site, strict frames,
// manual discard, and the AV1 override. Ad requests are answered locally, never sent out.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const AD = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
const TRACKER = 'https://www.google-analytics.com/analytics.js';
const profile = await mkdtemp(join(tmpdir(), 'lehko-savings-'));
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const frame = request.url === '/frame' ? `<iframe src="http://localhost:${port}/inner"></iframe>` : '';
  response.end(`<!doctype html><title>Fixture</title><script src="${AD}"></script><script src="${TRACKER}"></script>${frame}`);
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const port = server.address().port;
const checks = [];
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.env.HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check'],
  });
  // Anything that gets past the rules is answered here instead of reaching the network.
  await context.route(url => !url.href.startsWith(`http://127.0.0.1:${port}`) && !url.href.startsWith(`http://localhost:${port}`) &&
    url.protocol.startsWith('http'), route => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve('dist') });
  let worker = context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`));
  if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: w => w.url().startsWith(`chrome-extension://${id}/`) });
  await worker.evaluate(async () => {
    const started = Date.now();
    while (!(await chrome.storage.local.get('savings')).savings) {
      if (Date.now() - started > 5000) throw new Error('Savings did not initialize');
      await new Promise(r => setTimeout(r, 20));
    }
  });
  assert.deepEqual((await worker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).sort(), ['ads', 'privacy']);
  const available = await worker.evaluate(() => chrome.declarativeNetRequest.getAvailableStaticRuleCount());
  checks.push(`Static rulesets ads + privacy enabled; ${available} static rules still available`);

  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/popup.html`);
  await control.getByRole('switch', { name: 'Блокувати рекламу' }).waitFor();
  const send = request => control.evaluate(r => chrome.runtime.sendMessage(r), request);

  async function outcome(path = '/') {
    const page = await context.newPage();
    const failed = new Map();
    page.on('requestfailed', request => failed.set(request.url(), request.failure()?.errorText));
    page.on('requestfinished', request => failed.set(request.url(), 'loaded'));
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await page.close();
    return { ad: failed.get(AD) ?? 'loaded', tracker: failed.get(TRACKER) ?? 'loaded', frame: failed.get(`http://localhost:${port}/inner`) ?? 'not requested' };
  }

  // The fixture lives on 127.0.0.1, which the QA bypass lets through by default.
  let result = await outcome();
  assert.equal(result.ad, 'loaded');
  assert.equal(result.tracker, 'loaded');
  await send({ type: 'savings-qa', bypass: false });
  checks.push('QA bypass: nothing blocked on 127.0.0.1 by default');

  result = await outcome();
  assert.equal(result.ad, 'net::ERR_BLOCKED_BY_CLIENT');
  assert.equal(result.tracker, 'net::ERR_BLOCKED_BY_CLIENT');
  checks.push('Ad script (EasyList) and analytics (EasyPrivacy) blocked by the browser');

  await send({ type: 'savings-pause', host: '127.0.0.1', paused: true });
  result = await outcome();
  assert.equal(result.ad, 'loaded');
  assert.equal(result.tracker, 'loaded');
  await send({ type: 'savings-pause', host: '127.0.0.1', paused: false });
  assert.equal((await outcome()).ad, 'net::ERR_BLOCKED_BY_CLIENT');
  checks.push('Per-site pause lets everything load; resuming blocks again');

  await send({ type: 'savings', rulesets: { privacy: false } });
  assert.equal((await outcome()).tracker, 'loaded');
  await send({ type: 'savings', rulesets: { privacy: true } });
  checks.push('Ruleset switch takes effect without reload of the extension');

  assert.equal((await outcome('/frame')).frame, 'loaded');
  await send({ type: 'savings', rulesets: { frames: true } });
  assert.equal((await outcome('/frame')).frame, 'net::ERR_BLOCKED_BY_CLIENT');
  await send({ type: 'savings', rulesets: { frames: false } });
  checks.push('Strict mode blocks third-party iframes; off by default');

  const tabs = [];
  for (let i = 0; i < 3; i++) { const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/tab${i}`); tabs.push(page); }
  await tabs[2].bringToFront();
  const discard = await send({ type: 'savings-discard-others' });
  assert.ok(discard.ok && discard.status.discarded >= 2, JSON.stringify(discard));
  const states = await worker.evaluate(() => chrome.tabs.query({ url: 'http://127.0.0.1/*' }).then(t => t.map(x => [x.url, x.active, x.discarded])));
  assert.ok(states.every(([, active, discarded]) => active || discarded), JSON.stringify(states));
  checks.push(`Manual "free memory now" discarded ${discard.status.discarded} background tabs, kept the active one`);

  const video = await context.newPage();
  await video.addInitScript({ content: await readFile(resolve('dist/no-av1.js'), 'utf8') });
  await video.goto(`http://localhost:${port}/video`);
  const codecs = await video.evaluate(async () => ({
    av1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.05M.08"'),
    vp9: MediaSource.isTypeSupported('video/webm; codecs="vp9"'),
    h264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'),
    canPlayAv1: document.createElement('video').canPlayType('video/mp4; codecs="av01.0.05M.08"'),
    decodingAv1: (await navigator.mediaCapabilities.decodingInfo({ type: 'media-source',
      video: { contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 1920, height: 1080, bitrate: 4e6, framerate: 30 } })).supported
  }));
  assert.deepEqual(codecs, { av1: false, vp9: true, h264: true, canPlayAv1: '', decodingAv1: false });
  checks.push('AV1 override hides AV1 and leaves VP9/H.264 untouched');
  console.log(JSON.stringify({ ok: true, chrome: context.browser().version(), checks }, null, 2));
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
