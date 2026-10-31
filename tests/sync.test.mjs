import { argon2id } from 'hash-wasm';
import { KDF_DEFAULT, checkKeyBlob, checkPassphrase, toB64 } from '../dist/sync-crypto.js';
import { Identity as IdentityClass } from '../sync-server/src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { Account, Pair } from '../sync-server/src/index.js';
import { Sync } from '../dist/sync.js';
import { Vault, randomSecret } from '../dist/sync-crypto.js';
import { applyRemote, diffLocal, isSyncableUrl, keyOf, massDeletion, cleanPlain } from '../dist/sync-model.js';
import { Folders } from '../dist/folders.js';

// ---- in-process server: the real Worker and Durable Object classes over node:sqlite ----
function sqlOf(db) {
  return { exec(query, ...binds) {
    const statement = db.prepare(query);
    if (/^\s*(SELECT)/i.test(query)) { const rows = statement.all(...binds); return { toArray: () => rows }; }
    statement.run(...binds);
    return { toArray: () => [] };
  } };
}
function makeNamespace(Class) {
  const objects = new Map();
  return {
    objects,
    idFromName: name => name,
    get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(':memory:');
        const kv = new Map();
        const storage = {
          sql: sqlOf(db),
          transactionSync(job) {
            db.exec('BEGIN');
            try { const value = job(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
          },
          async get(key) { return kv.get(key); },
          async put(values) { for (const [k, v] of Object.entries(values)) kv.set(k, v); },
          async setAlarm() {},
          async deleteAll() {
            kv.clear();
            for (const { name: table } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) db.exec(`DROP TABLE ${table}`);
          }
        };
        objects.set(name, { db, instance: new Class({ storage }) });
      }
      const { instance } = objects.get(name);
      return { fetch: (url, init) => instance.fetch(new Request(url, init)) };
    }
  };
}
function makeServer(invite = 'letmein') {
  const env = { INVITE_CODE: invite, ACCOUNT: makeNamespace(Account), PAIR: makeNamespace(Pair) };
  const http = (url, init) => worker.fetch(new Request(url, init), env);
  return { env, http };
}

// ---- a device: chrome storage and an in-memory folder store ----
function makeDevice(server, name, folders = []) {
  const data = { sync: undefined };
  const opened = [];
  const store = {
    folders,
    async snapshot() { return structuredClone(this.folders); },
    async applyRemote(transform) { this.folders = structuredClone(transform(structuredClone(this.folders))); }
  };
  const api = {
    storage: { local: {
      async get() { return data.sync ? { sync: structuredClone(data.sync) } : {}; },
      async set(value) { data.sync = structuredClone(value.sync); },
      async remove() { data.sync = undefined; }
    }, session: { async get() { return {}; }, async set() {}, async remove() {} } },
    alarms: { async create() {}, async clear() {} },
    tabs: { async query() { return []; }, async create(tab) { opened.push(tab.url); return tab; } }
  };
  const sync = new Sync(api, store, server.http, 1);
  return { name, data, opened, store, sync, api, request: message => sync.request(message) };
}
const folder = (id, name, urls = []) => ({ id, name, color: '#e5484d', activeIndex: 0, tabs: urls.map(url => ({ url, title: url, favIconUrl: '' })) });
const shape = store => store.folders.map(f => ({ id: f.id, name: f.name, urls: f.tabs.map(t => t.url) })).sort((a, b) => a.id < b.id ? -1 : 1);
const URL_BASE = 'https://lehko-sync.test';
const create = device => device.request({ type: 'sync-create', server: URL_BASE, invite: 'letmein', deviceName: device.name });
async function pair(a, b) {
  const { code } = await a.request({ type: 'sync-pair' });
  return b.request({ type: 'sync-join', server: URL_BASE, code, deviceName: b.name });
}
async function settle(...devices) {
  for (let i = 0; i < 4; i++) for (const d of devices) await d.sync.run(true);
}

test('tabs and folders reach a paired device and survive a full round trip', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', [folder('f-1', 'Робота', ['https://a.example/1', 'https://a.example/2'])]);
  const b = makeDevice(server, 'B');
  assert.equal((await create(a)).enabled, true);
  await pair(a, b);
  await settle(a, b);
  assert.deepEqual(shape(b.store), shape(a.store));
  b.store.folders[0].tabs.push({ url: 'https://b.example/new', title: 'n', favIconUrl: '' });
  b.store.folders[0].tabs.reverse();
  await settle(a, b);
  assert.deepEqual(shape(a.store), shape(b.store));
  assert.equal(a.store.folders[0].tabs.length, 3);
});

test('same-named folders merge when a device joins', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', [folder('a-main', 'Основна', ['https://a.example/'])]);
  const b = makeDevice(server, 'B', [folder('b-main', 'Основна', ['https://b.example/'])]);
  await create(a);
  await pair(a, b);
  await settle(a, b);
  assert.equal(b.store.folders.length, 1);
  assert.equal(b.store.folders[0].id, 'a-main');
  assert.deepEqual(shape(a.store), shape(b.store));
  assert.deepEqual(a.store.folders[0].tabs.map(t => t.url).sort(), ['https://a.example/', 'https://b.example/']);
});

test('a folder switch does not delete: only the snapshot is compared', () => {
  const shadow = {};
  const first = diffLocal([folder('f', 'x', ['https://a.example/'])], shadow, () => 'tab-1');
  for (const c of first) shadow[c.key] = { hlc: '1', v: c.v };
  assert.deepEqual(diffLocal([folder('f', 'x', ['https://a.example/'])], shadow, () => 'tab-2'), []);
});

test('a page title change writes nothing; a moved tab writes one record', () => {
  const urls = [1, 2, 3, 4].map(n => `https://a.example/${n}`);
  const shadow = {};
  let id = 0;
  for (const c of diffLocal([folder('f', 'x', urls)], shadow, () => `t${id++}`)) shadow[c.key] = { hlc: '1', v: c.v };
  const retitled = folder('f', 'x', urls);
  retitled.tabs[0].title = '(3) Inbox';
  assert.deepEqual(diffLocal([retitled], shadow, () => 'n'), []);
  const moved = diffLocal([folder('f', 'x', [urls[3], urls[0], urls[1], urls[2]])], shadow, () => 'n');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].v.url, urls[3]);
});

test('non-web tabs stay local and survive remote changes', () => {
  const local = folder('f', 'x', ['chrome://settings/', 'https://a.example/']);
  const shadow = {};
  for (const c of diffLocal([local], shadow, () => 't1')) shadow[c.key] = { hlc: '1', v: c.v };
  assert.equal(Object.values(shadow).filter(i => i.v.k === 'tab').length, 1);
  const after = structuredClone(shadow);
  after['tab:t1'].v = null;
  const [result] = applyRemote([local], shadow, after);
  assert.deepEqual(result.tabs.map(t => t.url), ['chrome://settings/']);
});

test('only http(s) passes in records from other devices', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome://settings/']) {
    assert.equal(isSyncableUrl(url), false);
    assert.equal(cleanPlain({ k: 'send', id: 'x', to: 'y', from: 'z', url, title: '' }), null);
    assert.equal(cleanPlain({ k: 'tab', id: 'x', folderId: 'f', url, title: '', pos: 1 }), null);
  }
});

test('large deletions wait for confirmation in both directions', async () => {
  const server = makeServer();
  const urls = Array.from({ length: 12 }, (_, i) => `https://a.example/${i}`);
  const a = makeDevice(server, 'A', [folder('f', 'x', urls)]);
  const b = makeDevice(server, 'B');
  await create(a);
  await pair(a, b);
  await settle(a, b);

  a.store.folders[0].tabs = [];
  await a.sync.run(true);
  assert.equal((await a.request({ type: 'sync-status' })).held.direction, 'local');
  await b.sync.run(true);
  assert.equal(b.store.folders[0].tabs.length, 12, 'nothing was pushed');

  await a.request({ type: 'sync-confirm' });
  await b.sync.run(true);
  assert.equal((await b.request({ type: 'sync-status' })).held.direction, 'remote');
  assert.equal(b.store.folders[0].tabs.length, 12, 'held on the receiver as well');
  await b.request({ type: 'sync-confirm' });
  assert.equal(b.store.folders[0].tabs.length, 0);
  assert.equal(massDeletion({}, []).held, false);
});

test('a sent tab opens once on the addressed device only', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', []), b = makeDevice(server, 'B', []), c = makeDevice(server, 'C', []);
  await create(a);
  await pair(a, b);
  await pair(a, c);
  await settle(a, b, c);
  const { devices } = await a.request({ type: 'sync-status' });
  const target = devices.find(d => d.name === 'B');
  await a.request({ type: 'sync-send', deviceId: target.id, url: 'https://sent.example/', title: 't' });
  await settle(b, c, a, b, c);
  assert.deepEqual(b.opened, ['https://sent.example/']);
  assert.deepEqual(c.opened, []);
  await assert.rejects(a.request({ type: 'sync-send', deviceId: target.id, url: 'javascript:alert(1)', title: '' }));
});

test('the server stores no readable content', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', [folder('f-secret', 'ТаємнаПапка', ['https://secret-host.example/private?token=abc'])]);
  await create(a);
  const [{ db }] = [...server.env.ACCOUNT.objects.values()];
  const dump = JSON.stringify(db.prepare('SELECT * FROM records').all());
  assert.ok(dump.length > 100);
  for (const needle of ['secret-host', 'ТаємнаПапка', 'f-secret', 'token', 'folder:', 'tab:', btoa('secret-host').slice(0, 8)]) assert.equal(dump.includes(needle), false, needle);
  const sizes = db.prepare('SELECT length(data) AS n FROM records').all().map(r => r.n);
  assert.ok(sizes.every(n => (Math.floor(n * 3 / 4) - 28) % 256 === 0), 'ciphertext comes in fixed buckets');
});

test('records tampered with by the server are rejected', async () => {
  const vault = await Vault.open(randomSecret());
  const sealed = await vault.seal('tab:t', '000000000000001.000000.device-id', { k: 'tab' });
  const other = await vault.seal('tab:o', '000000000000001.000000.device-id', { k: 'tab' });
  await vault.open(sealed);
  await assert.rejects(vault.open({ ...sealed, hlc: '000000000000009.000000.device-id' }));
  await assert.rejects(vault.open({ ...sealed, deleted: true }));
  await assert.rejects(vault.open({ ...sealed, id: other.id }));
  await assert.rejects(vault.open({ ...sealed, data: other.data }));
  await assert.rejects((await Vault.open(randomSecret())).open(sealed));
});

test('a server that serves garbage changes nothing and is reported', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', [folder('f', 'x', ['https://a.example/'])]);
  await create(a);
  const [{ db }] = [...server.env.ACCOUNT.objects.values()];
  db.exec(`UPDATE records SET hlc = '999999999999999.000000.attacker-id', seq = seq + 100`);
  const b = makeDevice(server, 'B');
  const { code } = await a.request({ type: 'sync-pair' });
  const status = await b.request({ type: 'sync-join', server: URL_BASE, code, deviceName: 'B' });
  assert.ok(status.skipped >= 1);
  assert.deepEqual(b.store.folders, []);
});

test('authentication: invite, signature, clock', async () => {
  const server = makeServer();
  const device = makeDevice(server, 'A', []);
  await assert.rejects(device.request({ type: 'sync-create', server: URL_BASE, invite: 'wrong', deviceName: 'A' }), /Invite required/);
  assert.equal((await device.request({ type: 'sync-status' })).enabled, false, 'a failed create leaves nothing behind');
  await assert.rejects(device.request({ type: 'sync-create', server: 'http://evil.example', invite: 'x', deviceName: 'A' }), /https/);

  const vault = await Vault.open(randomSecret());
  const body = JSON.stringify({ cursor: 0, changes: [] });
  const post = (headers, payload = body) => server.http(`${URL_BASE}/v1/sync`, { method: 'POST', headers: { 'X-Lehko-Invite': 'letmein', ...headers }, body: payload });
  assert.equal((await post({})).status, 401);
  assert.equal((await post(await vault.sign('POST', '/v1/sync', body, Date.now()), '{"cursor":0,"changes":[]} ')).status, 401, 'body is signed');
  assert.equal((await post(await vault.sign('POST', '/v1/other', body, Date.now()))).status, 401, 'path is signed');
  assert.equal((await post(await vault.sign('POST', '/v1/sync', body, Date.now() - 3_600_000))).status, 401, 'old signature');
  assert.equal((await post(await vault.sign('POST', '/v1/sync', body, Date.now()))).status, 200);
});

test('a pairing code works once and is useless to a stranger', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', []), b = makeDevice(server, 'B', []), c = makeDevice(server, 'C', []);
  await create(a);
  const { code } = await a.request({ type: 'sync-pair' });
  await assert.rejects(c.request({ type: 'sync-join', server: URL_BASE, code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-Z', deviceName: 'C' }), /не знайдено/);
  await b.request({ type: 'sync-join', server: URL_BASE, code, deviceName: 'B' });
  await assert.rejects(c.request({ type: 'sync-join', server: URL_BASE, code, deviceName: 'C' }), /не знайдено/);
});

test('tombstones expire: a device behind them rebuilds and drops what is gone', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', [folder('f', 'x', ['https://a.example/1', 'https://a.example/2'])]);
  const b = makeDevice(server, 'B');
  await create(a);
  await pair(a, b);
  await settle(a, b);
  a.store.folders[0].tabs.pop();
  await a.sync.run(true);
  const [{ db }] = [...server.env.ACCOUNT.objects.values()];
  db.exec(`UPDATE records SET at = 0 WHERE deleted = 1`);
  db.exec(`UPDATE meta SET value = 0 WHERE key = 'pruned_at'`);
  await a.sync.run(true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM records WHERE deleted = 1').get().n, 0);
  await b.sync.run(true);
  assert.deepEqual(b.store.folders[0].tabs.map(t => t.url), ['https://a.example/1']);
});

test('wipe removes everything from the server', async () => {
  const server = makeServer();
  const a = makeDevice(server, 'A', [folder('f', 'x', ['https://a.example/'])]);
  await create(a);
  const [{ db }] = [...server.env.ACCOUNT.objects.values()];
  assert.ok(db.prepare('SELECT count(*) AS n FROM records').get().n > 0);
  await a.request({ type: 'sync-wipe' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n, 0);
  assert.equal((await a.request({ type: 'sync-status' })).enabled, false);
});

// ---- convergence under random interleavings ----
function mulberry(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randomOp(store, rand, serial) {
  const pick = list => list[Math.floor(rand() * list.length)];
  const target = pick(store.folders);
  const roll = rand();
  if (!target || roll < 0.04) { store.folders.push(folder(`f${serial}xxxxxxxx`, `Папка ${serial}`)); return; }
  if (roll < 0.06 && store.folders.length > 1) { store.folders = store.folders.filter(f => f !== target); return; }
  if (roll < 0.1) { target.name = `Нова ${serial}`; return; }
  if (roll < 0.5) { target.tabs.splice(Math.floor(rand() * (target.tabs.length + 1)), 0, { url: `https://x.example/${serial}`, title: 't', favIconUrl: '' }); return; }
  if (!target.tabs.length) return;
  const at = Math.floor(rand() * target.tabs.length);
  if (roll < 0.75) { target.tabs.splice(at, 1); return; }
  if (roll < 0.9) { const [tab] = target.tabs.splice(at, 1); target.tabs.splice(Math.floor(rand() * (target.tabs.length + 1)), 0, tab); return; }
  if (roll < 0.95) target.tabs[at].group = { title: `g${serial % 3}`, color: 'blue' };
  else delete target.tabs[at].group;
}
async function runOnce(device) {
  await device.sync.run(true);
  if ((await device.request({ type: 'sync-status' })).held) await device.request({ type: 'sync-confirm' });
}

test('devices converge after thousands of random operations', { timeout: 300_000 }, async () => {
  let operations = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const rand = mulberry(seed);
    const server = makeServer();
    const devices = [makeDevice(server, 'A', [folder('start-folder', 'Основна')]), makeDevice(server, 'B'), makeDevice(server, 'C')];
    await create(devices[0]);
    await pair(devices[0], devices[1]);
    await pair(devices[0], devices[2]);
    for (let step = 0; step < 2000; step++) {
      const device = devices[Math.floor(rand() * devices.length)];
      randomOp(device.store, rand, operations++);
      if (rand() < 0.05) await runOnce(devices[Math.floor(rand() * devices.length)]);
    }
    for (let round = 0; round < 6; round++) for (const d of devices) await runOnce(d);
    const expected = devices[0].store.folders.map(f => ({ ...f, activeIndex: 0, tabs: f.tabs.map(({ url, group }) => ({ url, group })) }));
    for (const d of devices.slice(1)) {
      assert.deepEqual(d.store.folders.map(f => ({ ...f, activeIndex: 0, tabs: f.tabs.map(({ url, group }) => ({ url, group })) })), expected, `seed ${seed}`);
    }
    // Stable: another round changes nothing on the server.
    const account = [...server.env.ACCOUNT.objects.values()][0].db;
    const seq = () => account.prepare(`SELECT value FROM meta WHERE key = 'seq'`).get().value;
    const stable = seq();
    for (const d of devices) await d.sync.run(true);
    assert.equal(seq(), stable, `seed ${seed}: echo-free`);
  }
  assert.ok(operations >= 10_000);
});

// ---- the real Folders class against a fake window ----
function windowFixture(urls) {
  const data = { local: {}, session: { booted: true, windowId: 1 }, tabs: [], next: 100 };
  const reindex = () => data.tabs.forEach((t, i) => { t.index = i; });
  const make = (url, active = false) => {
    const t = { id: data.next++, windowId: 1, index: 0, url, title: url, active, pinned: false, discarded: false, status: 'complete', favIconUrl: '', groupId: -1 };
    data.tabs.push(t); reindex(); return t;
  };
  urls.forEach((url, i) => make(url, i === 0));
  const store = name => ({
    async get(keys) { const list = [keys].flat(); return Object.fromEntries(list.filter(k => k in data[name]).map(k => [k, structuredClone(data[name][k])])); },
    async set(value) { Object.assign(data[name], structuredClone(value)); },
    async remove(key) { for (const k of [key].flat()) delete data[name][k]; }
  });
  const find = id => { const t = data.tabs.find(x => x.id === id); if (!t) throw new Error('No tab'); return t; };
  const groups = new Map();
  const api = {
    storage: { local: store('local'), session: store('session') },
    windows: { WINDOW_ID_NONE: -1, async getLastFocused() { return { id: 1, type: 'normal' }; }, async get() { return { id: 1, type: 'normal' }; } },
    action: { async setBadgeBackgroundColor() {}, async setTitle() {} },
    tabGroups: {
      async get(id) { const g = groups.get(id); if (!g) throw new Error('No group'); return g; },
      async update(id, props) { Object.assign(groups.get(id), props); }
    },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async query({ windowId, active } = {}) { return structuredClone(data.tabs.filter(t => (windowId === undefined || t.windowId === windowId) && (!active || t.active))); },
      async get(id) { return structuredClone(find(id)); },
      async create({ url, active = false, index }) {
        const t = make(url, active);
        if (index !== undefined) { data.tabs.splice(data.tabs.indexOf(t), 1); data.tabs.splice(index, 0, t); reindex(); }
        return structuredClone(t);
      },
      async remove(id) { const t = find(id); data.tabs = data.tabs.filter(x => x !== t); reindex(); },
      async update(id) { return structuredClone(find(id)); },
      async discard(id) { const t = find(id); Object.assign(t, { id: data.next++, url: '', title: '', discarded: true, status: 'unloaded' }); return structuredClone(t); },
      async move(id, { index }) { const t = find(id); data.tabs.splice(data.tabs.indexOf(t), 1); data.tabs.splice(index, 0, t); reindex(); },
      async group({ tabIds, groupId, createProperties: _ }) { const id = groupId ?? data.next++; if (!groups.has(id)) groups.set(id, { title: '', color: 'grey' }); find(tabIds).groupId = id; return id; },
      async ungroup(id) { find(id).groupId = -1; }
    }
  };
  const guard = async tabs => tabs.filter(t => t.url === 'https://protected.example/').map(t => ({ tabId: t.id, title: t.title, reason: 'form' }));
  const folders = new Folders(api, guard, 5);
  return { data, folders, api, groups, urls: () => data.tabs.map(t => t.url || 'lazy') };
}

test('remote changes reach the open window: added lazily, removed, reordered, grouped', async () => {
  const f = windowFixture(['https://a.example/1', 'https://a.example/2', 'https://a.example/3']);
  await f.folders.request({ type: 'folders-list', windowId: 1 });
  const [current] = await f.folders.snapshot();
  await f.folders.applyRemote(folders => {
    folders[0].tabs = [
      { url: 'https://a.example/3', title: '3', favIconUrl: '', group: { title: 'Гр', color: 'blue' } },
      { url: 'https://a.example/1', title: '1', favIconUrl: '' },
      { url: 'https://new.example/', title: 'new', favIconUrl: '' }];
    return folders;
  });
  const tabs = f.data.tabs;
  assert.equal(tabs.length, 3);
  assert.equal(tabs[0].url, 'https://a.example/3');
  assert.equal(tabs[1].url, 'https://a.example/1');
  assert.equal(tabs[2].discarded, true, 'new tab does not load');
  assert.equal(f.groups.get(tabs[0].groupId).title, 'Гр');
  const [after] = await f.folders.snapshot();
  assert.equal(after.id, current.id);
  assert.deepEqual(after.tabs.map(t => t.url), ['https://a.example/3', 'https://a.example/1', 'https://new.example/']);
});

test('remote changes never close the active tab or a guarded tab', async () => {
  const f = windowFixture(['https://active.example/', 'https://protected.example/', 'https://plain.example/']);
  await f.folders.request({ type: 'folders-list', windowId: 1 });
  await f.folders.applyRemote(folders => { folders[0].tabs = [{ url: 'https://other.example/', title: '', favIconUrl: '' }]; return folders; });
  const urls = f.urls();
  assert.ok(urls.includes('https://active.example/'));
  assert.ok(urls.includes('https://protected.example/'));
  assert.ok(!urls.includes('https://plain.example/'));
  assert.ok((await f.folders.snapshot())[0].tabs.some(t => t.url === 'https://active.example/'), 'kept tabs stay in the folder');
});

test('a remote delete does not close the folder open on this device', async () => {
  const f = windowFixture(['https://a.example/']);
  await f.folders.request({ type: 'folders-list', windowId: 1 });
  await f.folders.applyRemote(() => []);
  assert.equal((await f.folders.snapshot()).length, 1);
  assert.deepEqual(f.urls(), ['https://a.example/']);
  assert.ok(keyOf({ k: 'tab', id: 'x' }));
});

// ---- Google sign-in, with a local stand-in for Google's keys and consent screen ----

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const EXT = 'a'.repeat(32);
const kid = `test-${Math.random()}`;
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).includes('googleapis.com/oauth2/v3/certs')
  ? new Response(JSON.stringify({ keys: [{ ...publicJwk, kid }] })) : realFetch(url, init);

const part = value => toB64(new TextEncoder().encode(JSON.stringify(value)));
async function googleToken(claims = {}, key = privateKey, header = { alg: 'RS256', kid }) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${part(header)}.${part({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-user-1', email: 'me@example.com', email_verified: true, iat: now, exp: now + 3600, ...claims })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body));
  return `${body}.${toB64(new Uint8Array(signature))}`;
}
function googleServer() {
  const server = makeServer();
  Object.assign(server.env, { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_ALLOWED_EMAILS: 'me@example.com', IDENTITY: makeNamespace(IdentityClass) });
  return server;
}

// The whole browser flow: start → Google → callback → chromiumapp.org.
function googleDevice(server, name, folders = [], claims = {}, redirectHost = 'ch40m1umapp.qjz9zk') {
  const device = makeDevice(server, name, folders);
  const session = {};
  const api = device.api;
  api.runtime = { id: EXT };
  api.action = {};
  api.storage.session = {
    async get(key) { return key in session ? { [key]: structuredClone(session[key]) } : {}; },
    async set(value) { Object.assign(session, structuredClone(value)); },
    async remove(key) { delete session[key]; }
  };
  api.identity = { getRedirectURL: () => `https://${EXT}.${redirectHost}/`, async launchWebAuthFlow({ url }) {
    const toGoogle = await server.http(url, { redirect: 'manual' });
    const google = new URL(toGoogle.headers.get('Location'));
    assert.equal(google.origin, 'https://accounts.google.com');
    assert.equal(google.searchParams.get('scope'), 'openid email');
    const token = await googleToken({ nonce: google.searchParams.get('nonce'), ...claims });
    const form = new URLSearchParams({ id_token: token, state: google.searchParams.get('state') });
    const back = await server.http(google.searchParams.get('redirect_uri'), { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(back.status, 303);
    assert.equal(new URL(back.headers.get('Location')).host, `${EXT}.${redirectHost}`);
    return back.headers.get('Location');
  } };
  return Object.assign(device, { session });
}
const PASS = 'довга фраза синхронізації 42';
async function kekFor(passphrase, salt, params) {
  const hash = await argon2id({ password: passphrase.normalize('NFKC'), salt, parallelism: 1, iterations: params.iterations, memorySize: params.memoryKiB, hashLength: 32, outputType: 'binary' });
  return toB64(hash);
}
const saltBytes = salt => Uint8Array.from(atob(salt.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function googleSetup(device, passphrase = PASS) {
  await device.request({ type: 'sync-google-login', server: URL_BASE });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return device.request({ type: 'sync-google-setup', kek: await kekFor(passphrase, salt, KDF_DEFAULT), salt: toB64(salt), params: KDF_DEFAULT, deviceName: device.name });
}
async function googleUnlock(device, passphrase = PASS) {
  const { google } = await device.request({ type: 'sync-google-login', server: URL_BASE });
  return device.request({ type: 'sync-google-unlock', kek: await kekFor(passphrase, saltBytes(google.blob.salt), google.blob), deviceName: device.name });
}

test('Google + passphrase: a second device gets the data with no code and no invite', { timeout: 30_000 }, async () => {
  const server = googleServer();
  const a = googleDevice(server, 'A', [folder('f', 'Робота', ['https://a.example/1'])]);
  const b = googleDevice(server, 'B');
  const created = await googleSetup(a);
  assert.equal(created.enabled, true);
  assert.equal(created.linked, true);
  await assert.rejects(googleUnlock(b, 'зовсім інша фраза 123'), /Неправильна фраза/);
  assert.equal((await b.request({ type: 'sync-status' })).enabled, false, 'a wrong passphrase enables nothing');
  await googleUnlock(b);
  await settle(a, b);
  assert.deepEqual(shape(b.store), shape(a.store));
    assert.equal([...server.env.IDENTITY.objects.keys()].some(k => k.includes('google-user-1')), false, 'only a hash of the subject');
});

test('an existing chain can be linked; a stored key is never overwritten', { timeout: 30_000 }, async () => {
  const server = googleServer();
  const a = googleDevice(server, 'A', [folder('f', 'x', ['https://a.example/'])]);
  await create(a);
  const linked = await googleSetup(a);
  assert.equal(linked.linked, true);
  const c = googleDevice(server, 'C');
  await c.request({ type: 'sync-google-login', server: URL_BASE });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await assert.rejects(c.request({ type: 'sync-google-setup', kek: await kekFor(PASS, salt, KDF_DEFAULT), salt: toB64(salt), params: KDF_DEFAULT, deviceName: 'C' }), /ключ уже збережено/);
  const token = await googleToken();
  const put = await server.http(`${URL_BASE}/v1/identity`, { method: 'POST', body: JSON.stringify({ token, op: 'put', blob: '{"evil":1}' }) });
  assert.equal(put.status, 409);
});

test('wipe also removes the wrapped key', { timeout: 30_000 }, async () => {
  const server = googleServer();
  const a = googleDevice(server, 'A', []);
  await googleSetup(a);
  await a.request({ type: 'sync-wipe' });
  const b = googleDevice(server, 'B');
  assert.equal((await b.request({ type: 'sync-google-login', server: URL_BASE })).google.hasKey, false);
});

test('tokens: wrong signature, audience, issuer, expiry, e-mail and algorithm are refused', async () => {
  const server = googleServer();
  const ask = async token => (await server.http(`${URL_BASE}/v1/identity`, { method: 'POST', body: JSON.stringify({ token, op: 'get' }) })).status;
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  assert.equal(await ask(await googleToken()), 200);
  assert.equal(await ask(await googleToken({}, other.privateKey)), 401, 'signature');
  assert.equal(await ask(await googleToken({ aud: 'other-app' })), 401, 'audience');
  assert.equal(await ask(await googleToken({ iss: 'https://evil.example' })), 401, 'issuer');
  assert.equal(await ask(await googleToken({ exp: 1000 })), 401, 'expired');
  assert.equal(await ask(await googleToken({ email: 'other@example.com' })), 403, 'not allowed');
  assert.equal(await ask(await googleToken({ email_verified: false })), 403, 'unverified');
  assert.equal(await ask(await googleToken({}, privateKey, { alg: 'none', kid })), 401, 'alg none');
  assert.equal(await ask('garbage'), 401);
  const closed = makeServer();
  assert.equal((await closed.http(`${URL_BASE}/v1/identity`, { method: 'POST', body: JSON.stringify({ token: await googleToken(), op: 'get' }) })).status, 503, 'fails closed without config');
});

test('sign-in response is bound to the request and delivered only to chromiumapp.org', async () => {
  const server = googleServer();
  const a = googleDevice(server, 'A', [], { nonce: 'attacker-chosen-nonce' });
  await assert.rejects(a.request({ type: 'sync-google-login', server: URL_BASE }), /не збігається/);
  for (const redirect of ['https://evil.example/', `https://${EXT}.evil.example/`, `https://${EXT}.chromiumapp.org.evil.example/`, `http://${EXT}.chromiumapp.org/`]) {
    const bad = await server.http(`${URL_BASE}/v1/google/start?redirect=${encodeURIComponent(redirect)}&state=${'s'.repeat(20)}&nonce=${'n'.repeat(20)}`, { redirect: 'manual' });
    assert.equal(bad.status, 400, redirect);
  }
  const unknown = new URLSearchParams({ id_token: 'x.y.z', state: `${EXT}.x.${'s'.repeat(20)}` });
  assert.equal((await server.http(`${URL_BASE}/v1/google/callback`, { method: 'POST', body: unknown })).status, 400);
  const stock = googleDevice(server, 'Stock', [], {}, 'chromiumapp.org');
  assert.equal((await stock.request({ type: 'sync-google-login', server: URL_BASE })).google.hasKey, false);
  const form = new URLSearchParams({ id_token: 'x.y.z', state: 'evil.example/#.ssssssssssssssssssss' });
  assert.equal((await server.http(`${URL_BASE}/v1/google/callback`, { method: 'POST', body: form })).status, 400);
});

test('a server cannot weaken the passphrase derivation; weak phrases are refused', () => {
  const blob = { v: 1, salt: toB64(new Uint8Array(16)), data: 'x', ...KDF_DEFAULT };
  assert.ok(checkKeyBlob(blob));
  assert.throws(() => checkKeyBlob({ ...blob, memoryKiB: 8 }));
  assert.throws(() => checkKeyBlob({ ...blob, iterations: 1 }));
  assert.throws(() => checkKeyBlob({ ...blob, memoryKiB: 10_000_000 }));
  assert.throws(() => checkPassphrase('short'));
  assert.throws(() => checkPassphrase('aaaaaaaaaaaaaaaaaaaa'));
  assert.ok(checkPassphrase(PASS));
});

test('pinned tabs survive remote changes and a join merge', async () => {
  const server = makeServer();
  const local = { ...folder('f', 'Основна', ['https://a.example/']), pinned: [{ url: 'https://pin.example/', title: 'p', favIconUrl: '' }] };
  const a = makeDevice(server, 'A', [folder('f-a', 'Основна', ['https://b.example/'])]);
  const b = makeDevice(server, 'B', [local]);
  await create(a);
  await pair(a, b);
  await settle(a, b);
  assert.deepEqual(b.store.folders[0].pinned.map(t => t.url), ['https://pin.example/']);
  a.store.folders[0].tabs.push({ url: 'https://new.example/', title: 'n', favIconUrl: '' });
  await settle(a, b);
  assert.ok(b.store.folders[0].tabs.some(t => t.url === 'https://new.example/'));
  assert.deepEqual(b.store.folders[0].pinned.map(t => t.url), ['https://pin.example/']);
  assert.equal(a.store.folders[0].pinned, undefined, 'not sent to other devices yet');
});
