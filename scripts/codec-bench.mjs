// Local video playback cost: the same 720p60 clip in AV1 and VP9, played in a visible tab.
// `prepare` records the clips once (stock Chrome, MediaRecorder) into artifacts/codec/;
// a run plays them and measures process CPU time and dropped frames.
// Usage: node scripts/codec-bench.mjs prepare | node scripts/codec-bench.mjs <run> <stock|lean|lean-noes>
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectCDP } from './lib/raw-cdp.mjs';
import { applyLeanPrefs, leanFlags } from './lib/lean-profile.mjs';

const [run, config = 'stock'] = process.argv.slice(2);
const prepare = run === 'prepare';
if (!run || !['stock', 'lean', 'lean-noes'].includes(config)) throw new Error('Usage: node scripts/codec-bench.mjs prepare | <run> <stock|lean|lean-noes>');
const CLIPS = { vp9: 'video/webm;codecs=vp9', av1: 'video/webm;codecs=av01' };
const PLAY_S = Number(process.env.CODEC_PLAY_S ?? 30);
const output = resolve('artifacts/codec');
await mkdir(output, { recursive: true });
const sleep = s => new Promise(r => setTimeout(r, s * 1000));

const server = createServer(async (request, response) => {
  const clip = request.url?.match(/^\/clip\/(vp9|av1)$/)?.[1];
  if (clip && request.method === 'POST') {
    const parts = [];
    for await (const part of request) parts.push(part);
    await writeFile(join(output, `${clip}.webm`), Buffer.concat(parts));
    response.end('ok');
  } else if (clip) {
    response.writeHead(200, { 'Content-Type': 'video/webm' });
    response.end(await readFile(join(output, `${clip}.webm`)));
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>codec bench</title><body style="margin:0;background:#000">');
  }
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

function processes(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,command='], { encoding: 'utf8' }).split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):([\d.]+)\s+(.*)$/);
    return m && { pid: Number(m[1]), ppid: Number(m[2]), command: m[7],
      cpu: Number(m[3] ?? 0) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5]) * 60 + Number(m[6]) };
  }).filter(Boolean);
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); grew = true; }
  }
  return rows.filter(row => ids.has(row.pid)).map(row => {
    const type = row.command.match(/--type=([\w-]+)/)?.[1];
    return { ...row, role: !type ? 'browser' : type === 'utility' ? `utility:${row.command.match(/--utility-sub-type=[\w.]*?(\w+)\.mojom/)?.[1] ?? 'other'}` : type };
  });
}

const profile = await mkdtemp(join(tmpdir(), `lehko-codec-${config}-`));
const lean = !prepare && config.startsWith('lean');
if (lean) await applyLeanPrefs(profile, { energySaver: config === 'lean' ? 'always' : 'off' });
// Occluded windows stop presenting frames on macOS; keep the test tab "visible" in every config.
const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows', '--window-size=1400,900', ...(lean ? leanFlags() : []), `${origin}/`
], { stdio: 'ignore' });
const result = { run, config, startedAt: new Date().toISOString(), clips: {} };
try {
  let port;
  for (let i = 0; i < 150 && !port; i++) { await sleep(0.2); try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {} }
  await sleep(3);
  const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.startsWith(origin));
  const cdp = await connectCDP(page.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const { result: value, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return value.value;
  };
  result.chrome = await evaluate('navigator.userAgent');
  result.support = await evaluate(`(async () => {
    const out = {};
    for (const codec of ['av01.0.04M.08', 'vp09.00.10.08']) for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software'])
      out[codec + ' ' + hardwareAcceleration] = (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1280, codedHeight: 720, hardwareAcceleration })).supported;
    return out; })()`);
  if (prepare) {
    // 10 s of moving shapes and text at 60 fps; recorded once and reused by every config.
    for (const [name, mime] of Object.entries(CLIPS)) {
      result.clips[name] = await evaluate(`(async () => {
        if (!MediaRecorder.isTypeSupported(${JSON.stringify(mime)})) return { error: 'unsupported' };
        const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 }); document.body.append(c);
        const g = c.getContext('2d'), rec = new MediaRecorder(c.captureStream(60), { mimeType: ${JSON.stringify(mime)}, videoBitsPerSecond: 6e6 });
        const parts = []; rec.ondataavailable = e => parts.push(e.data); rec.start(1000);
        const t0 = performance.now(); let frames = 0;
        await new Promise(done => (function draw() {
          const t = (performance.now() - t0) / 1000; frames++;
          const grad = g.createLinearGradient(0, 0, 1280, 720); grad.addColorStop(0, 'hsl(' + (t * 40 % 360) + ',70%,40%)'); grad.addColorStop(1, '#123');
          g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);
          for (let i = 0; i < 60; i++) { g.fillStyle = 'hsl(' + (i * 6) + ',80%,60%)'; g.fillRect((i * 97 + t * (60 + i * 7)) % 1300 - 20, (i * 53 + t * 40 * (i % 5 + 1)) % 740 - 20, 40 + i % 7 * 6, 40 + i % 5 * 8); }
          g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('frame ' + frames + ' t=' + t.toFixed(2), 40, 80);
          t < 10 ? requestAnimationFrame(draw) : done(); })());
        rec.stop(); await new Promise(r => rec.onstop = r); c.remove();
        const blob = new Blob(parts, { type: ${JSON.stringify(mime)} });
        await fetch('/clip/${name}', { method: 'POST', body: blob });
        return { bytes: blob.size, drawnFrames: frames }; })()`);
    }
  } else {
    await sleep(5);
    for (const name of Object.keys(CLIPS)) {
      await evaluate(`(async () => { document.body.replaceChildren(); const v = Object.assign(document.createElement('video'),
        { src: '/clip/${name}', loop: true, muted: true, playsInline: true }); v.style.width = '1280px'; document.body.append(v);
        await v.play(); await new Promise(r => setTimeout(r, 3000)); })()`);
      const before = await evaluate(`(() => { const q = document.querySelector('video').getVideoPlaybackQuality(); return { frames: q.totalVideoFrames, dropped: q.droppedVideoFrames }; })()`);
      const start = new Map(processes(chrome.pid).map(p => [p.pid, p]));
      await sleep(PLAY_S);
      const byRole = {};
      let total = 0;
      for (const p of processes(chrome.pid)) {
        const used = p.cpu - (start.get(p.pid)?.cpu ?? 0);
        byRole[p.role] = (byRole[p.role] ?? 0) + used;
        total += used;
      }
      const after = await evaluate(`(() => { const v = document.querySelector('video'), q = v.getVideoPlaybackQuality();
        return { frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, height: v.videoHeight, paused: v.paused }; })()`);
      result.clips[name] = { cpuPercent: total / PLAY_S * 100, byRole, frames: after.frames - before.frames, dropped: after.dropped - before.dropped,
        fps: (after.frames - before.frames) / PLAY_S, height: after.height, paused: after.paused };
      console.log(JSON.stringify({ run, config, clip: name, cpu: result.clips[name].cpuPercent.toFixed(1), fps: result.clips[name].fps.toFixed(1), dropped: result.clips[name].dropped }));
    }
  }
  await cdp.send('Browser.close').catch(() => {});
  cdp.close();
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await new Promise(ok => { if (chrome.exitCode !== null) ok(); else { chrome.once('exit', ok); setTimeout(() => { chrome.kill('SIGKILL'); ok(); }, 10000); } });
  server.close();
  result.finishedAt = new Date().toISOString();
  await writeFile(join(output, `run-${run}-${config}.json`), JSON.stringify(result, null, 1));
  await rm(profile, { recursive: true, force: true });
}
