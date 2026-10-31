// Record live pages once through CDP Fetch, then replay them from a local server so every
// configuration loads the same bytes. Chrome is pointed at the server with --host-resolver-rules;
// URLs stay unchanged, so DNR rules, Brave Shields and AdTagging see the real hostnames.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createSecureServer } from 'node:http2';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';

const MAX_BODY = 20 * 1048576;

// Attaches to every page, OOPIF and worker and pauses each response long enough to copy its body.
export async function startRecording(browser, dir) {
  await mkdir(join(dir, 'bodies'), { recursive: true });
  const entries = [], pending = new Set();
  const attach = async sessionId => {
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] }, sessionId).catch(() => {});
    await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
    await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  };
  browser.on('Target.attachedToTarget', ({ sessionId }) => { attach(sessionId); });
  browser.on('Fetch.requestPaused', (event, sessionId) => {
    const task = (async () => {
      const { requestId, request, responseStatusCode: status, responseHeaders = [], resourceType } = event;
      if (status && !(status >= 300 && status < 400) && status !== 204) {
        try {
          const { body, base64Encoded } = await browser.send('Fetch.getResponseBody', { requestId }, sessionId);
          const bytes = Buffer.from(body, base64Encoded ? 'base64' : 'utf8');
          if (bytes.length <= MAX_BODY) {
            const hash = createHash('sha1').update(bytes).digest('hex');
            await writeFile(join(dir, 'bodies', hash), bytes);
            entries.push({ method: request.method, url: request.url, status, headers: responseHeaders, body: hash, size: bytes.length, resourceType });
          }
        } catch {}
      } else if (status) entries.push({ method: request.method, url: request.url, status, headers: responseHeaders, body: null, size: 0, resourceType });
      await browser.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  return {
    attach,
    async stop() {
      await Promise.allSettled([...pending]);
      await writeFile(join(dir, 'index.json'), JSON.stringify({ recordedAt: new Date().toISOString(), entries }));
      return entries.length;
    }
  };
}

// Self-signed certificate; Chrome trusts only its SPKI hash, and only for the benchmark profile.
async function certificate(dir) {
  const key = join(dir, 'replay-key.pem'), cert = join(dir, 'replay-cert.pem');
  if (!existsSync(cert)) execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
    '-subj', '/CN=lehko-replay', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const der = execFileSync('/usr/bin/openssl', ['x509', '-in', cert, '-pubkey', '-noout'], { encoding: 'utf8' });
  const spki = createHash('sha256').update(execFileSync('/usr/bin/openssl', ['pkey', '-pubin', '-outform', 'der'], { input: der })).digest('base64');
  return { key: await readFile(key), cert: await readFile(cert), spki };
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'content-encoding', 'alt-svc', 'content-security-policy-report-only', 'report-to', 'nel']);

// Exact URL first; otherwise the recorded request to the same host and path whose query shares the
// most parameters (ad tags add cache-busters and timestamps on every load), as Web Page Replay does.
function matcher(entries) {
  const exact = new Map(), loose = new Map();
  for (const entry of entries) {
    const url = new URL(entry.url);
    if (!/^https?:$/.test(url.protocol)) continue;
    const key = `${entry.method} ${url.host}${url.pathname}`;
    if (!exact.has(`${key}${url.search}`)) exact.set(`${key}${url.search}`, entry);
    if (!loose.has(key)) loose.set(key, []);
    loose.get(key).push({ params: new Set([...url.searchParams].map(([k, v]) => `${k}=${v}`)), entry });
  }
  return (method, host, path, search) => {
    for (const m of method === 'HEAD' ? ['HEAD', 'GET'] : [method]) {
      const key = `${m} ${host}${path}`;
      const hit = exact.get(`${key}${search}`);
      if (hit) return { entry: hit, how: 'exact' };
      const candidates = loose.get(key);
      if (candidates) {
        const wanted = [...new URLSearchParams(search)].map(([k, v]) => `${k}=${v}`);
        let best = candidates[0], score = -1;
        for (const c of candidates) {
          const s = wanted.filter(p => c.params.has(p)).length;
          if (s > score) { best = c; score = s; }
        }
        return { entry: best.entry, how: 'fuzzy' };
      }
    }
    return null;
  };
}

export async function startReplay(dir) {
  const { entries } = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
  const find = matcher(entries), bodies = new Map(), stats = { exact: 0, fuzzy: 0, missing: 0, preflight: 0 };
  const body = async hash => {
    if (!bodies.has(hash)) bodies.set(hash, await readFile(join(dir, 'bodies', hash)));
    return bodies.get(hash);
  };
  const handler = async (req, res) => {
    const host = String(req.headers[':authority'] ?? req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url, `https://${host}`);
    const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true' };
    if (req.method === 'OPTIONS') {
      stats.preflight++;
      res.writeHead(204, { ...cors, 'access-control-allow-methods': req.headers['access-control-request-method'] ?? 'GET, POST',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*', 'access-control-max-age': '600' });
      return res.end();
    }
    req.resume();
    const hit = find(req.method, url.host, url.pathname, url.search);
    if (!hit) { stats.missing++; res.writeHead(404, { ...cors, 'content-type': 'text/plain' }); return res.end(); }
    stats[hit.how]++;
    const headers = {};
    for (const { name, value } of hit.entry.headers) {
      const key = name.toLowerCase();
      if (HOP.has(key) || key.startsWith(':')) continue;
      headers[key] = key in headers ? [].concat(headers[key], value) : value;
    }
    const bytes = hit.entry.body ? await body(hit.entry.body) : Buffer.alloc(0);
    const status = hit.entry.status;
    if (![204, 304].includes(status)) headers['content-length'] = String(bytes.length);
    try { res.writeHead(status, headers); } catch { res.writeHead(status, { 'content-length': String(bytes.length) }); }
    res.end(req.method === 'HEAD' || [204, 304].includes(status) ? undefined : bytes);
  };
  const handle = (req, res) => handler(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  const { key, cert, spki } = await certificate(dir);
  const tls = createSecureServer({ key, cert, allowHTTP1: true }, handle), plain = createHttpServer(handle);
  tls.on('sessionError', () => {});
  // One port for both schemes: the first byte of a TLS connection is a handshake record (22).
  const front = createNetServer(socket => {
    socket.on('error', () => {});
    socket.once('data', chunk => {
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === 22 ? tls : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  await new Promise(ok => front.listen(0, '127.0.0.1', ok));
  const port = front.address().port;
  return {
    port, stats, entries: entries.length,
    flags: [`--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost`, `--ignore-certificate-errors-spki-list=${spki}`, '--disable-quic'],
    close: () => new Promise(ok => { front.close(ok); tls.close(); plain.close(); })
  };
}
