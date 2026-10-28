import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const profile = await mkdtemp(join(tmpdir(), 'lehko-metrics-'));
const output = resolve('artifacts/collector-smoke.json');
await mkdir(resolve('artifacts'), { recursive: true });
// This exact artifact belongs only to this tooling test. The general collector never overwrites runs.
await rm(output, { force: true });
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  await context.pages()[0].close();
  for (let i = 0; i < 5; i++) {
    const page = await context.newPage();
    await page.goto(`data:text/html,<title>Collector check ${i}</title><h1>Tooling check only</h1>`);
  }
  const cdp = await context.browser().newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const pid = processInfo.find(info => info.type === 'browser').id;
  await new Promise((resolvePromise, reject) => {
    const child = spawn('python3', ['scripts/collect_metrics.py',
      '--pid', String(pid), '--profile', profile, '--mode', 'baseline', '--scenario', 'five', '--repeat', '1',
      '--experiment', 'collector-smoke-only', '--conditions', 'headless; five data pages; no extensions; tooling validation only',
      '--duration', '10', '--interval', '2', '--output', output], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Collector exited ${code}`)));
  });
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(result.samples.length >= 5);
  assert.ok(result.summary.rss_mib_mean > 0);
  assert.ok(result.summary.process_count_max >= 5);
  console.log(JSON.stringify({ purpose: 'Collector validation, not a comparison', summary: result.summary }, null, 2));
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
