import test from 'node:test';
import assert from 'node:assert/strict';
import { Folders, isFoldersRequest } from '../dist/folders.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const A = [1, 2, 3].map(n => `https://a.example/${n}`);
const B = [1, 2].map(n => `https://b.example/${n}`);

// Minimal chrome: one normal window (id 1), tabs with Chrome's discard quirk (new id, url/title lost).
function fixture({ urls = A, active = 1, pinned = [], guard } = {}) {
  const data = { local: {}, session: {}, tabs: [], next: 100, action: {}, listeners: new Set(), createCalls: 0 };
  const reindex = () => data.tabs.forEach((t, i) => { t.index = i; });
  const make = ({ url, active: isActive = false, pinned: isPinned = false, windowId = 1 }) => {
    if (isActive) for (const t of data.tabs) if (t.windowId === windowId) t.active = false;
    const t = { id: data.next++, windowId, index: 0, url: url ?? 'chrome://newtab/', title: url ? `Title ${url}` : 'New Tab',
      active: isActive, pinned: isPinned, discarded: false, status: 'complete', favIconUrl: '' };
    data.tabs.push(t);
    reindex();
    return t;
  };
  const store = name => ({
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter(k => k in data[name]).map(k => [k, structuredClone(data[name][k])]));
    },
    async set(value) { Object.assign(data[name], structuredClone(value)); },
    async remove(key) { for (const k of [key].flat()) delete data[name][k]; }
  });
  const find = id => {
    const found = data.tabs.find(t => t.id === id);
    if (!found) throw new Error('No tab');
    return found;
  };
  const api = {
    runtime: { id: 'self' },
    storage: { local: store('local'), session: store('session') },
    windows: {
      WINDOW_ID_NONE: -1,
      async getLastFocused() { return { id: 1, type: 'normal' }; },
      async get(id) { if (id !== 1) throw new Error('No window'); return { id: 1, type: 'normal' }; }
    },
    action: {
      async setBadgeBackgroundColor({ color }) { data.action.color = color; },
      async setTitle({ title }) { data.action.title = title; }
    },
    tabs: {
      onUpdated: { addListener: fn => data.listeners.add(fn), removeListener: fn => data.listeners.delete(fn) },
      async query({ windowId, active }) {
        return structuredClone(data.tabs.filter(t => (windowId === undefined || t.windowId === windowId) && (!active || t.active)));
      },
      async get(id) { return structuredClone(find(id)); },
      async create({ windowId = 1, url, active = true }) { data.createCalls++; return structuredClone(make({ url, active, windowId })); },
      async remove(id) {
        const gone = find(id);
        data.tabs = data.tabs.filter(t => t !== gone);
        const left = data.tabs.filter(t => t.windowId === gone.windowId);
        if (gone.active && left.length) left.at(-1).active = true;
        reindex();
      },
      async update(id, props) {
        const t = find(id);
        if (props.url !== undefined) Object.assign(t, { url: props.url, title: `Title ${props.url}`, discarded: false, status: 'complete' });
        if (props.active) { for (const o of data.tabs) o.active = false; t.active = true; }
        return structuredClone(t);
      },
      async discard(id) {
        const t = find(id);
        if (t.active) throw new Error('Cannot discard');
        Object.assign(t, { id: data.next++, url: '', title: '', discarded: true, status: 'unloaded' });
        return structuredClone(t);
      }
    }
  };
  for (const url of pinned) make({ url, pinned: true });
  urls.forEach((url, i) => make({ url, active: i === active }));
  const folders = new Folders(api, guard, 5);
  const window = () => data.tabs.filter(t => !t.pinned).map(t => ({ url: t.url, active: t.active, discarded: t.discarded }));
  return { folders, api, data, make, window, request: (message) => folders.request({ windowId: 1, ...message }) };
}

test('first list creates «Основна» from the current tabs, pinned excluded, with colour and title but no badge text', async () => {
  const f = fixture({ pinned: ['https://pinned.example/'] });
  const status = await f.request({ type: 'folders-list' });
  assert.equal(status.folders.length, 1);
  assert.deepEqual(status.folders[0], { id: status.currentId, name: 'Основна', color: f.data.local.folders[0].color, count: 3 });
  const [folder] = f.data.local.folders;
  assert.deepEqual(folder.tabs.map(t => t.url), A);
  assert.equal(folder.activeIndex, 1);
  assert.equal(f.data.action.color, folder.color);
  assert.equal(f.data.action.title, 'Легко · Папка: Основна');
  assert.equal(f.data.session.windowId, 1);
  assert.equal(f.data.tabs.filter(t => t.pinned).length, 1);
});

test('switch snapshots and closes the old tabs, recreates the target with only the active tab loaded', async () => {
  const f = fixture({ pinned: ['https://pinned.example/'] });
  const main = (await f.request({ type: 'folders-list' })).currentId;
  const pinnedId = f.data.tabs.find(t => t.pinned).id;
  const work = (await f.request({ type: 'folders-create', name: 'Робота' })).currentId;
  assert.deepEqual(f.window(), [{ url: 'chrome://newtab/', active: true, discarded: false }]);
  assert.equal(f.data.action.title, 'Легко · Папка: Робота');
  for (const [i, url] of B.entries()) f.make({ url, active: i === 0 });
  f.data.tabs.find(t => t.url === 'chrome://newtab/').pinned = false;

  const status = await f.request({ type: 'folders-switch', id: main });
  assert.equal(status.currentId, main);
  const now = f.data.tabs.filter(t => !t.pinned).sort((a, b) => a.index - b.index);
  assert.equal(now.length, 3);
  assert.deepEqual(now.map(t => t.active), [false, true, false]);
  assert.equal(now[1].url, A[1]);
  assert.equal(now[1].discarded, false);
  for (const i of [0, 2]) {
    assert.equal(now[i].discarded, true);
    assert.equal(f.data.session[`lazy:${now[i].id}`].url, A[i], 'lazy map remembers what the discarded tab stands for');
  }
  assert.equal(f.data.tabs.find(t => t.pinned).id, pinnedId, 'pinned tab untouched');
  const stored = f.data.local.folders.find(x => x.id === work);
  assert.deepEqual(stored.tabs.map(t => t.url), ['chrome://newtab/', ...B].slice(0, stored.tabs.length));
  assert.ok(stored.tabs.some(t => t.url === B[0]));
  assert.equal(f.data.local.currentId, main);
  assert.equal(f.data.action.title, 'Легко · Папка: Основна');
});

test('automatic snapshots never replace real pages with blank ones; explicit removals may', async () => {
  const f = fixture();
  await f.request({ type: 'folders-list' });
  for (const t of f.data.tabs) Object.assign(t, { url: 'about:blank', discarded: true, status: 'unloaded', title: '' });
  await f.request({ type: 'folders-list' });
  assert.deepEqual(f.data.local.folders[0].tabs.map(t => t.url), A, 'lazy blank tabs fall back to the stored entries');
  for (const t of f.data.tabs) Object.assign(t, { url: 'chrome://newtab/', discarded: false, status: 'complete' });
  await f.request({ type: 'folders-list' });
  assert.deepEqual(f.data.local.folders[0].tabs.map(t => t.url), A, 'blank tabs do not shrink the folder');
  f.folders.removed(f.data.tabs[0].id, { windowId: 1, isWindowClosing: false }); // explicit removal allows one shrinking snapshot
  await f.request({ type: 'folders-list' });
  assert.ok(f.data.local.folders[0].tabs.every(t => t.url === 'chrome://newtab/'));
});

test('guard blocks switch and create, receives only the tabs to close, and force overrides it', async () => {
  const seen = [];
  const blockers = [{ tabId: 2, title: 'Form', reason: 'незбережена форма' }];
  const f = fixture({ pinned: ['https://pinned.example/'], guard: async tabs => { seen.push(tabs.map(t => t.url)); return blockers; } });
  const main = (await f.request({ type: 'folders-list' })).currentId;
  const before = structuredClone(f.window());

  let status = await f.request({ type: 'folders-create', name: 'Нова' });
  assert.deepEqual(status.blocked, blockers);
  assert.equal(status.currentId, main);
  assert.equal(status.folders.length, 1, 'blocked create adds no folder');
  assert.deepEqual(seen.at(-1), A, 'pinned tabs are never offered to the guard');
  assert.deepEqual(f.window(), before);

  status = await f.request({ type: 'folders-create', name: 'Нова', force: true });
  assert.equal(status.blocked, undefined);
  assert.equal(status.folders.length, 2);
  assert.notEqual(status.currentId, main);
  assert.equal(seen.length, 1, 'force skips the guard');

  status = await f.request({ type: 'folders-switch', id: main });
  assert.deepEqual(status.blocked, blockers);
  assert.notEqual(status.currentId, main);
  assert.equal(f.window().length, 1);
  status = await f.request({ type: 'folders-switch', id: main, force: true });
  assert.equal(status.currentId, main);
  assert.equal(f.window().length, 3);
  assert.equal(seen.length, 2);
});

test('guard also covers moving the active tab, and is skipped for no-op switches', async () => {
  const seen = [];
  const f = fixture({ guard: async tabs => { seen.push(tabs.map(t => t.url)); return [{ tabId: tabs[0].id, title: 'x', reason: 'r' }]; } });
  const main = (await f.request({ type: 'folders-list' })).currentId;
  const other = (await f.request({ type: 'folders-create', name: 'Інша', force: true })).currentId;
  await f.request({ type: 'folders-switch', id: main, force: true });
  seen.length = 0;
  await f.request({ type: 'folders-switch', id: main });
  assert.deepEqual(seen, [], 'switching to the current folder closes nothing');
  const blocked = await f.request({ type: 'folders-move-tab', id: other });
  assert.deepEqual(seen, [[A[1]]], 'only the active tab is checked');
  assert.equal(blocked.blocked.length, 1);
  assert.equal(f.window().length, 3);
  const moved = await f.request({ type: 'folders-move-tab', id: other, force: true });
  assert.equal(moved.blocked, undefined);
  assert.equal(f.window().length, 2);
  assert.equal(moved.folders.find(x => x.id === other).count, 2, 'the blank tab «Інша» was saved with, plus the moved one');
  assert.equal(f.data.local.folders.find(x => x.id === other).tabs.at(-1).url, A[1]);
});

test('without a guard nothing is blocked', async () => {
  const f = fixture();
  await f.request({ type: 'folders-list' });
  const status = await f.request({ type: 'folders-create', name: 'Нова' });
  assert.equal('blocked' in status, false);
});

test('the current folder cannot be deleted; another one can', async () => {
  const f = fixture();
  const main = (await f.request({ type: 'folders-list' })).currentId;
  const other = (await f.request({ type: 'folders-create', name: 'Інша' })).currentId;
  await assert.rejects(f.request({ type: 'folders-delete', id: other }), /поточн/);
  const status = await f.request({ type: 'folders-delete', id: main });
  assert.deepEqual(status.folders.map(x => x.id), [other]);
  assert.equal(f.data.local.folders.length, 1);
  await assert.rejects(f.request({ type: 'folders-delete', id: main }), /не знайдено/);
});

test('names are trimmed and collapsed; invalid names, ids and windows are refused', async () => {
  const f = fixture();
  const main = (await f.request({ type: 'folders-list' })).currentId;
  const status = await f.request({ type: 'folders-rename', id: main, name: '  Нова   назва  ' });
  assert.equal(status.folders[0].name, 'Нова назва');
  assert.equal(f.data.action.title, 'Легко · Папка: Нова назва');
  await assert.rejects(f.request({ type: 'folders-rename', id: main, name: '   ' }), /Назва: 1–40/);
  await assert.rejects(f.request({ type: 'folders-rename', id: main, name: 'x'.repeat(41) }), /Назва: 1–40/);
  await f.request({ type: 'folders-rename', id: main, name: 'x'.repeat(40) });
  await assert.rejects(f.request({ type: 'folders-rename', id: main, name: 7 }), /Некоректна назва/);
  await assert.rejects(f.request({ type: 'folders-create', name: 7 }), /Некоректна назва/);
  await assert.rejects(f.request({ type: 'folders-rename', id: 'nope', name: 'x' }), /не знайдено/);
  await assert.rejects(f.request({ type: 'folders-switch', id: 42 }), /Некоректний id/);
  await assert.rejects(f.request({ type: 'folders-switch', id: '' }), /Некоректний id/);
  await assert.rejects(f.request({ type: 'folders-switch', id: 'y'.repeat(65) }), /Некоректний id/);
  await assert.rejects(f.request({ type: 'folders-switch', id: 'nope' }), /не знайдено/);
  await assert.rejects(f.request({ type: 'folders-switch', id: main, windowId: 'abc' }), /Некоректне вікно/);
  await assert.rejects(f.request({ type: 'folders-switch', id: main, windowId: 9 }), /Вікно недоступне/);
  await assert.rejects(f.folders.request({ type: 'folders-nope' }), /Невідома команда/);
  await assert.rejects(f.request({ type: 'folders-move-tab', id: main }), /вже в цій папці/);
});

test('moving the last tab opens a replacement first; pinned tabs cannot be moved', async () => {
  const f = fixture({ urls: [A[0]], active: 0, pinned: ['https://pinned.example/'] });
  await f.request({ type: 'folders-list' });
  await f.request({ type: 'folders-create', name: 'Інша' });
  const main = f.data.local.folders[0].id;
  await f.request({ type: 'folders-move-tab', id: main });
  assert.equal(f.window().length, 1);
  assert.equal(f.data.local.folders[0].tabs.length, 2, 'moved into «Основна»');
  f.data.tabs.forEach(t => { t.active = t.pinned; });
  await assert.rejects(f.request({ type: 'folders-move-tab', id: main }), /Закріплені/);
});

test('first request after a browser restart rebuilds the stored folder instead of snapshotting the window over it', async () => {
  const f = fixture({ urls: [A[1]], active: 0 });
  f.data.local = { currentId: 'main', folders: [{ id: 'main', name: 'Основна', color: '#e5484d', activeIndex: 1,
    tabs: A.map(url => ({ url, title: '', favIconUrl: '' })) }] };
  const status = await f.request({ type: 'folders-list' });
  assert.equal(status.folders[0].count, 3);
  assert.deepEqual(f.window().map(t => t.url), A.map((url, i) => i === 1 ? url : ''));
  assert.deepEqual(f.window().map(t => t.discarded), [true, false, true]);
  assert.deepEqual(f.data.local.folders[0].tabs.map(t => t.url), A);
  assert.equal(f.data.session.booted, true);
});

test('a page the folder does not know about is left alone and snapshotted after a restart', async () => {
  const f = fixture({ urls: ['https://own.example/'], active: 0 });
  f.data.local = { currentId: 'main', folders: [{ id: 'main', name: 'Основна', color: '#e5484d', activeIndex: 0,
    tabs: A.map(url => ({ url, title: '', favIconUrl: '' })) }] };
  await f.request({ type: 'folders-list' });
  assert.deepEqual(f.window().map(t => t.url), ['https://own.example/']);
  assert.deepEqual(f.data.local.folders[0].tabs.map(t => t.url), ['https://own.example/']);
});

test('activating a lazy tab navigates it to what it stood for; events refresh the snapshot after the debounce', async () => {
  const f = fixture();
  const main = (await f.request({ type: 'folders-list' })).currentId;
  const other = (await f.request({ type: 'folders-create', name: 'Інша' })).currentId;
  await f.request({ type: 'folders-switch', id: main });
  await f.request({ type: 'folders-switch', id: other });
  await f.request({ type: 'folders-switch', id: main });
  const lazy = f.data.tabs.find(t => t.discarded);
  assert.ok(f.data.session[`lazy:${lazy.id}`]);
  const wanted = f.data.session[`lazy:${lazy.id}`].url;
  f.data.tabs.forEach(t => { t.active = t === lazy; });
  f.folders.activated({ tabId: lazy.id, windowId: 1 });
  await sleep(60);
  assert.equal(lazy.url, wanted);
  assert.equal(lazy.discarded, false);
  assert.equal(f.data.session[`lazy:${lazy.id}`], undefined);
  assert.equal(f.data.local.folders.find(x => x.id === main).activeIndex, f.data.tabs.findIndex(t => t === lazy));
  f.folders.removed(lazy.id, { windowId: 1, isWindowClosing: true });
});

test('events from other windows are ignored once a window is tracked; closing it clears the tracking', async () => {
  const f = fixture();
  await f.request({ type: 'folders-list' });
  f.data.local.folders[0].name = 'Marker';
  f.folders.created({ windowId: 2 });
  await sleep(40);
  assert.equal(f.data.local.folders[0].name, 'Marker');
  await f.folders.windowRemoved(2);
  assert.equal(f.data.session.windowId, 1);
  await f.folders.windowRemoved(1);
  assert.equal(f.data.session.windowId, undefined);
});

test('init seeds the first folder and tracks the focused window', async () => {
  const f = fixture();
  await f.folders.init();
  assert.equal(f.data.local.folders[0].name, 'Основна');
  assert.equal(f.data.session.windowId, 1);
});

test('isFoldersRequest matches only the folders- prefix', () => {
  assert.equal(isFoldersRequest({ type: 'folders-list' }), true);
  assert.equal(isFoldersRequest({ type: 'savings-status' }), false);
  assert.equal(isFoldersRequest({ type: 'status' }), false);
  assert.equal(isFoldersRequest({}), false);
});
