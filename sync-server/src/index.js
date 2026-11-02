// Легко Sync: stores encrypted records, and the key to them for Google accounts. See sync-server/README.md.
import { AccountStore, HttpError } from './store.js';

const MAX_BODY = 2_000_000;
const MAX_SKEW_MS = 5 * 60_000;
const PAIR_TTL_MS = 10 * 60_000;
const CHANNEL = /^[A-Za-z0-9_-]{32,64}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Lehko-Key, X-Lehko-Time, X-Lehko-Sig, X-Lehko-Invite, X-Lehko-Google',
  'Access-Control-Max-Age': '86400'
};

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const fromB64 = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const toB64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const sha256 = async data => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const encoder = new TextEncoder();

async function readBody(request) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY) throw new HttpError(413, 'Body too large');
  const body = await request.text();
  if (body.length > MAX_BODY) throw new HttpError(413, 'Body too large');
  return body;
}

// Returns the account id: the hash of the public key that signed "lehko-v1 method path time sha256(body)".
async function authenticate(request, path, body, now) {
  const key = request.headers.get('X-Lehko-Key'), time = request.headers.get('X-Lehko-Time'), sig = request.headers.get('X-Lehko-Sig');
  if (!key || !time || !sig) throw new HttpError(401, 'Missing signature');
  if (!/^\d{1,16}$/.test(time) || Math.abs(now - Number(time)) > MAX_SKEW_MS) throw new HttpError(401, 'Clock skew');
  let valid = false, raw;
  try {
    raw = fromB64(key);
    const hash = toB64(await sha256(encoder.encode(body)));
    const publicKey = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
    valid = await crypto.subtle.verify('Ed25519', publicKey, fromB64(sig), encoder.encode(`lehko-v1 ${request.method} ${path} ${time} ${hash}`));
  } catch { valid = false; }
  if (!valid) throw new HttpError(401, 'Bad signature');
  return toB64(await sha256(raw));
}

async function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([sha256(encoder.encode(given)), sha256(encoder.encode(expected))]);
  return a.every((byte, i) => byte === b[i]);
}

// ---- Google sign-in: it is the only thing that guards the account key of that Google account ----
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const OPAQUE = /^[A-Za-z0-9_-]{16,64}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const MAX_KEY_BLOB = 4096;
// ungoogled-chromium's domain substitution renames the identity redirect host in the browser binary.
// The browser reports its own form; only these two, for a syntactically valid extension id, are accepted.
const REDIRECT_HOSTS = { c: 'chromiumapp.org', u: 'ch40m1umapp.qjz9zk' };
const REDIRECT = /^https:\/\/([a-p]{32})\.(chromiumapp\.org|ch40m1umapp\.qjz9zk)\/$/;
const googleKeys = new Map();

async function googleKey(kid, now) {
  const cached = googleKeys.get(kid);
  if (cached && cached.until > now) return cached.key;
  const response = await fetch(GOOGLE_KEYS);
  if (!response.ok) throw new HttpError(503, 'Google keys unavailable');
  const { keys } = await response.json();
  const jwk = keys?.find(k => k.kid === kid && k.kty === 'RSA');
  if (!jwk) throw new HttpError(401, 'Unknown token key');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  googleKeys.set(kid, { key, until: now + 3_600_000 });
  return key;
}

// Fails closed: no client id or no allowed e-mail list means nobody signs in. Returns the hashed subject.
async function verifyGoogle(token, env, now) {
  const allowed = (env.GOOGLE_ALLOWED_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!env.GOOGLE_CLIENT_ID || !allowed.length) throw new HttpError(503, 'Google sign-in is not configured');
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new HttpError(401, 'Bad token');
  let header, claims, signature;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64(parts[1])));
    signature = fromB64(parts[2]);
  } catch { throw new HttpError(401, 'Bad token'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new HttpError(401, 'Bad token');
  const key = await googleKey(header.kid, now);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`));
  const seconds = now / 1000;
  if (!valid || !GOOGLE_ISSUERS.has(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || typeof claims.sub !== 'string' ||
    !(claims.exp > seconds) || !(claims.iat < seconds + 300)) throw new HttpError(401, 'Bad token');
  if (claims.email_verified !== true || !allowed.includes(String(claims.email).toLowerCase())) throw new HttpError(403, 'This Google account is not allowed');
  return toB64(await sha256(encoder.encode(`lehko-identity ${claims.sub}`)));
}

function googleStart(url, env) {
  const state = url.searchParams.get('state'), nonce = url.searchParams.get('nonce');
  const redirect = REDIRECT.exec(url.searchParams.get('redirect') ?? '');
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured');
  if (!redirect || !OPAQUE.test(state ?? '') || !OPAQUE.test(nonce ?? '')) throw new HttpError(400, 'Invalid sign-in request');
  const target = new URL(GOOGLE_AUTH);
  for (const [name, value] of Object.entries({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/v1/google/callback`, response_type: 'id_token', response_mode: 'form_post',
    scope: 'openid email', state: `${redirect[1]}.${redirect[2] === REDIRECT_HOSTS.u ? 'u' : 'c'}.${state}`, nonce, prompt: 'select_account'
  })) target.searchParams.set(name, value);
  return Response.redirect(target.toString(), 302);
}

// Hands the token only to the identity redirect host, which the browser gives to that extension's launchWebAuthFlow and to no site.
async function googleCallback(request) {
  const form = await request.formData();
  const [ext, kind, state, extra] = String(form.get('state') ?? '').split('.');
  if (extra !== undefined || !EXTENSION_ID.test(ext ?? '') || !Object.hasOwn(REDIRECT_HOSTS, kind ?? '') || !OPAQUE.test(state ?? '')) throw new HttpError(400, 'Invalid sign-in response');
  const token = String(form.get('id_token') ?? '');
  const fragment = /^[A-Za-z0-9._-]+$/.test(token) ? `id_token=${token}&state=${state}` : `error=denied&state=${state}`;
  return new Response(null, { status: 303, headers: { Location: `https://${ext}.${REDIRECT_HOSTS[kind]}/#${fragment}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

async function rpc(stub, payload) {
  const response = await stub.fetch('https://do/', { method: 'POST', body: JSON.stringify(payload) });
  return response;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(request.url);
    const now = Date.now();
    try {
      if (pathname === '/v1/sync' && request.method === 'POST') {
        const body = await readBody(request);
        const account = await authenticate(request, pathname, body, now);
        let input;
        try { input = JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON'); }
        let inviteOk = await sameSecret(request.headers.get('X-Lehko-Invite'), env.INVITE_CODE);
        const google = request.headers.get('X-Lehko-Google');
        if (!inviteOk && google) inviteOk = Boolean(await verifyGoogle(google, env, now));
        return await rpc(env.ACCOUNT.get(env.ACCOUNT.idFromName(account)), { op: 'sync', input, inviteOk, now });
      }
      if (pathname === '/v1/wipe' && request.method === 'POST') {
        const body = await readBody(request);
        const account = await authenticate(request, pathname, body, now);
        return await rpc(env.ACCOUNT.get(env.ACCOUNT.idFromName(account)), { op: 'wipe' });
      }
      if (pathname === '/v1/google/start' && request.method === 'GET') return googleStart(new URL(request.url), env);
      if (pathname === '/v1/google/callback' && request.method === 'POST') return await googleCallback(request);
      if (pathname === '/v1/identity' && request.method === 'POST') {
        const body = await readBody(request);
        let input;
        try { input = JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON'); }
        const subject = await verifyGoogle(input.token, env, now);
        if (!['get', 'put', 'delete', 'claim'].includes(input.op)) throw new HttpError(400, 'Invalid operation');
        if (input.op === 'put' && (typeof input.blob !== 'string' || !input.blob || input.blob.length > MAX_KEY_BLOB)) throw new HttpError(400, 'Invalid key blob');
        if (input.op === 'claim' && (typeof input.secret !== 'string' || !input.secret || input.secret.length > MAX_KEY_BLOB)) throw new HttpError(400, 'Invalid key');
        return await rpc(env.IDENTITY.get(env.IDENTITY.idFromName(subject)), { op: input.op, blob: input.blob, secret: input.secret });
      }
      const channel = /^\/v1\/pair\/([^/]+)$/.exec(pathname)?.[1];
      if (channel && CHANNEL.test(channel)) {
        const stub = env.PAIR.get(env.PAIR.idFromName(channel));
        if (request.method === 'GET') return await rpc(stub, { op: 'take', now });
        if (request.method === 'PUT') {
          const body = await readBody(request);
          const account = await authenticate(request, pathname, body, now);
          const known = await rpc(env.ACCOUNT.get(env.ACCOUNT.idFromName(account)), { op: 'exists' });
          if (!(await known.json()).exists) throw new HttpError(403, 'Unknown account');
          return await rpc(stub, { op: 'put', blob: body, now });
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('sync failure', error instanceof Error ? error.name : 'unknown'); // never log request data
      return json({ error: 'Server error' }, 500);
    }
  }
};

export class Account {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new AccountStore(ctx.storage.sql);
  }
  async fetch(request) {
    const { op, input, inviteOk, now } = await request.json();
    try {
      if (op === 'exists') return json({ exists: this.store.exists() });
      if (op === 'wipe') {
        await this.ctx.storage.deleteAll();
        this.store = new AccountStore(this.ctx.storage.sql);
        return json({ wiped: true });
      }
      return json(this.ctx.storage.transactionSync(() => this.store.sync(input ?? {}, now, { inviteOk })));
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      throw error;
    }
  }
}

// The account secret of a Google account, readable by the server. `blob` and the get and put operations serve builds
// that still wrap the secret with a passphrase.
export class Identity {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const { op, blob, secret } = await request.json();
    // The first device's secret wins, so that every later sign-in joins the same chain.
    if (op === 'claim') {
      const claimed = await this.ctx.storage.get('secret');
      if (claimed) return json({ secret: claimed });
      await this.ctx.storage.put({ secret });
      return json({ secret });
    }
    const stored = await this.ctx.storage.get('blob');
    if (op === 'get') return json({ blob: stored ?? null });
    if (op === 'delete') { await this.ctx.storage.deleteAll(); return json({ ok: true }); }
    if (stored) return json({ error: 'A key is already stored' }, 409);
    await this.ctx.storage.put({ blob });
    return json({ ok: true });
  }
}

// One-time mailbox for a pairing blob, sealed with a key derived from the code the server never sees.
export class Pair {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const { op, blob, now } = await request.json();
    if (op === 'put') {
      if (await this.ctx.storage.get('blob')) return json({ error: 'Channel in use' }, 409);
      await this.ctx.storage.put({ blob, expires: now + PAIR_TTL_MS });
      await this.ctx.storage.setAlarm(now + PAIR_TTL_MS);
      return json({ ok: true });
    }
    const [blobValue, expires] = [await this.ctx.storage.get('blob'), await this.ctx.storage.get('expires')];
    await this.ctx.storage.deleteAll();
    if (!blobValue || now > expires) return json({ error: 'Code not found' }, 404);
    return json({ blob: blobValue });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
