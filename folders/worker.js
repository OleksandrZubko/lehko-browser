const NEWTAB = 'chrome://newtab/';
const COLORS = ['#e5484d', '#f76b15', '#e5a50a', '#30a46c', '#0091ff', '#7c5cff', '#d6409f', '#6e7781'];
const MAX_NAME = 40;
const SNAPSHOT_DELAY = 1000;
const STARTUP_SETTLE = 2000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- lock: one mutation at a time; events are ignored while a mutation runs ----
let chain = Promise.resolve();
let busy = 0;
function locked(job, { quiet = false } = {}) {
  const run = chain.then(async () => {
    if (!quiet) busy++;
    try { return await job(); } finally { if (!quiet) busy--; }
  });
  chain = run.catch(() => {});
  return run;
}

// ---- storage ----
async function read() {
  const { folders, currentId } = await chrome.storage.local.get(['folders', 'currentId']);
  return { folders: Array.isArray(folders) ? folders : [], currentId };
}
const write = ({ folders, currentId }) => chrome.storage.local.set({ folders, currentId });
const currentOf = state => state.folders.find(f => f.id === state.currentId);
const getTracked = async () => (await chrome.storage.session.get('windowId')).windowId;
const setTracked = windowId => chrome.storage.session.set({ windowId });

// ---- tabs ----
async function folderTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.filter(t => !t.pinned).sort((a, b) => a.index - b.index);
}
const toEntry = t => ({ url: t.url || t.pendingUrl || NEWTAB, title: t.title ?? '', favIconUrl: t.favIconUrl ?? '' });
const isRealUrl = url => Boolean(url) && !/^(chrome:\/\/newtab\/?|about:blank)$/.test(url);
const isRealEntry = entry => isRealUrl(entry?.url);
// No usable URL: never navigated, or a blank tab that Chrome left unloaded (e.g. after a restart).
const isUnusable = t => !(t.url || t.pendingUrl) || (t.url === 'about:blank' && !t.pendingUrl && (t.discarded || t.status === 'unloaded'));
const isRealTab = t => !isUnusable(t) && isRealUrl(t.url || t.pendingUrl);

// A tab discarded before its first navigation commits loses url/title in Chrome (and gets a new id),
// so we remember what it was meant to show, keyed by its current id (session storage, gone on restart).
const lazyKey = tabId => `lazy:${tabId}`;
// Source order for a tab without a usable URL: session map, then the folder's stored entry at the same index, then new tab.
async function entriesOf(tabs, previous = []) {
  const keys = tabs.filter(isUnusable).map(t => lazyKey(t.id));
  const lazy = keys.length ? await chrome.storage.session.get(keys) : {};
  return tabs.map((t, i) => isUnusable(t) ? lazy[lazyKey(t.id)] ?? previous[i] ?? toEntry(t) : toEntry(t));
}

// Explicit tab removals (not startup or other automatic snapshots) may turn a folder with real pages into blank ones.
let shrinkAllowed = false;
const takeShrink = () => { const value = shrinkAllowed; shrinkAllowed = false; return value; };

// Returns false (folder untouched) when an automatic snapshot would replace real pages with only blank ones.
async function capture(tabs, folder, allowShrink = false) {
  const entries = await entriesOf(tabs, folder.tabs);
  if (!allowShrink && folder.tabs.some(isRealEntry) && !entries.some(isRealEntry)) return false;
  folder.tabs = entries;
  const active = tabs.findIndex(t => t.active);
  const last = Math.max(0, folder.tabs.length - 1);
  folder.activeIndex = active >= 0 ? active : Math.min(folder.activeIndex ?? 0, last);
  return true;
}

const isBooted = async () => (await chrome.storage.session.get('booted')).booted === true;

// Once per browser session (session storage is empty after a restart or an extension reload/update): the stored folder
// is the truth, the window is not. Session restore drops never-loaded tabs and "open New Tab" brings none back, so if every
// real page in the window already belongs to the stored current folder, rebuild the folder instead of snapshotting
// the window over it. Pages the folder does not know about (user's own startup pages) are left alone and get snapshotted.
async function reconcileAfterRestart(state, windowId) {
  const folder = currentOf(state);
  if (!folder?.tabs.some(isRealEntry)) return;
  const tabs = await folderTabs(windowId);
  const known = new Set(folder.tabs.map(t => t.url));
  if (!tabs.filter(isRealTab).every(t => known.has(t.url || t.pendingUrl))) return;
  await openFolderTabs(windowId, folder, new Set(tabs.map(t => t.id)));
  await removeTabs(tabs.map(t => t.id));
}

async function ensureState(windowId) {
  const state = await read();
  if (!await isBooted()) {
    await reconcileAfterRestart(state, windowId);
    await chrome.storage.session.set({ booted: true });
  }
  if (!state.folders.length) {
    const folder = { id: crypto.randomUUID(), name: 'Основна', color: COLORS[0], tabs: [], activeIndex: 0 };
    await capture(await folderTabs(windowId), folder);
    state.folders.push(folder);
  }
  if (!currentOf(state)) state.currentId = state.folders[0].id;
  return state;
}

// Chrome rejects discard() while a fresh tab is still initialising: retry once on its first update event.
async function discardLazily(tabId, entry) {
  const attempt = async () => {
    const tab = await chrome.tabs.discard(tabId);
    if (!tab) throw new Error('not discarded');
    await chrome.storage.session.set({ [lazyKey(tab.id)]: entry });
    return tab;
  };
  try { await attempt(); return; } catch {}
  const retry = id => {
    if (id !== tabId) return;
    chrome.tabs.onUpdated.removeListener(retry);
    attempt().then(tab => touched(tab.windowId), () => {});
  };
  chrome.tabs.onUpdated.addListener(retry);
}

async function openFolderTabs(windowId, folder, oldIds) {
  const entries = folder.tabs.length ? folder.tabs : [{ url: NEWTAB }];
  const wanted = Math.min(Math.max(folder.activeIndex ?? 0, 0), entries.length - 1);
  const created = [];
  for (const [i, entry] of entries.entries()) {
    try {
      const tab = await chrome.tabs.create({ windowId, url: entry.url, active: i === wanted });
      created.push({ tab, i });
      if (i !== wanted) await discardLazily(tab.id, entry);
    } catch { /* URL cannot be re-created: skip it */ }
  }
  if (!created.length) return chrome.tabs.create({ windowId, active: true });
  if (!created.some(c => c.i === wanted)) {
    // discard() gives tabs new ids, so look the first new tab up again
    const [fresh] = (await folderTabs(windowId)).filter(t => !oldIds.has(t.id));
    if (fresh) await chrome.tabs.update(fresh.id, { active: true });
  }
}

const removeTabs = ids => Promise.allSettled(ids.map(id => chrome.tabs.remove(id)));

async function applyAction(state) {
  const folder = currentOf(state);
  if (!folder) return;
  const [first, ...rest] = Array.from(folder.name.trim());
  await Promise.all([
    chrome.action.setBadgeText({ text: (first?.toLocaleUpperCase('uk') ?? '') + rest.slice(0, 1).join('') }),
    chrome.action.setBadgeBackgroundColor({ color: folder.color }),
    chrome.action.setBadgeTextColor?.({ color: '#ffffff' }),
    chrome.action.setTitle({ title: `Папка: ${folder.name}` }),
  ]);
}

// ---- mutations (always called under the lock) ----
async function refresh(windowId) {
  const state = await ensureState(windowId);
  await capture(await folderTabs(windowId), currentOf(state), takeShrink());
  await write(state);
  await applyAction(state);
  return state;
}

async function switchTo(state, id, windowId) {
  const target = state.folders.find(f => f.id === id);
  if (!target) throw new Error('Папку не знайдено');
  if (id === state.currentId) return state;
  const old = await folderTabs(windowId);
  await capture(old, currentOf(state), takeShrink());
  await write(state);
  await openFolderTabs(windowId, target, new Set(old.map(t => t.id)));
  await removeTabs(old.map(t => t.id));
  state.currentId = id;
  await write(state);
  await applyAction(state);
  return state;
}

async function moveActiveTab(state, id, windowId) {
  const target = state.folders.find(f => f.id === id);
  if (!target) throw new Error('Папку не знайдено');
  if (id === state.currentId) throw new Error('Вкладка вже в цій папці');
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (!active || active.pinned) throw new Error('Закріплені вкладки не належать папкам');
  const tabs = await folderTabs(windowId);
  const at = tabs.findIndex(t => t.id === active.id);
  const [entry] = await entriesOf([active], [currentOf(state).tabs[at]]); // before removal drops its session entry
  if (tabs.length === 1) await chrome.tabs.create({ windowId, active: true });
  await chrome.tabs.remove(active.id);
  target.tabs.push(entry);
  await capture(await folderTabs(windowId), currentOf(state), true);
  await write(state);
  return state;
}

// ---- input validation ----
function cleanName(value) {
  if (typeof value !== 'string') throw new Error('Некоректна назва');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME) throw new Error(`Назва: 1–${MAX_NAME} символів`);
  return name;
}
function cleanId(value) {
  if (typeof value !== 'string' || !value || value.length > 64) throw new Error('Некоректний id');
  return value;
}
async function cleanWindow(value) {
  if (value === undefined) return (await chrome.windows.getLastFocused()).id;
  if (!Number.isInteger(value)) throw new Error('Некоректне вікно');
  const win = await chrome.windows.get(value).catch(() => null);
  if (win?.type !== 'normal') throw new Error('Вікно недоступне');
  return win.id;
}

const view = ({ folders, currentId }) => ({
  currentId,
  folders: folders.map(({ id, name, color, tabs }) => ({ id, name, color, count: tabs.length })),
});

// Runs `job(state, windowId)` under the lock, persists/reports the resulting state.
const mutation = (msg, job) => locked(async () => {
  const windowId = await cleanWindow(msg.windowId);
  const state = await ensureState(windowId);
  await setTracked(windowId);
  await job(state, windowId);
  await write(state);
  await applyAction(state);
  return view(state);
});

const handlers = {
  list: msg => locked(async () => {
    const windowId = await cleanWindow(msg.windowId);
    await setTracked(windowId);
    return view(await refresh(windowId));
  }, { quiet: true }),

  switch: msg => {
    const id = cleanId(msg.id);
    return mutation(msg, (state, windowId) => switchTo(state, id, windowId));
  },

  create: msg => {
    const name = cleanName(msg.name);
    return mutation(msg, async (state, windowId) => {
      const used = new Set(state.folders.map(f => f.color));
      const color = COLORS.find(c => !used.has(c)) ?? COLORS[state.folders.length % COLORS.length];
      const folder = { id: crypto.randomUUID(), name, color, tabs: [], activeIndex: 0 };
      state.folders.push(folder);
      await switchTo(state, folder.id, windowId);
    });
  },

  rename: msg => {
    const id = cleanId(msg.id), name = cleanName(msg.name);
    return mutation(msg, state => {
      const folder = state.folders.find(f => f.id === id);
      if (!folder) throw new Error('Папку не знайдено');
      folder.name = name;
    });
  },

  delete: msg => {
    const id = cleanId(msg.id);
    return mutation(msg, state => {
      if (!state.folders.some(f => f.id === id)) throw new Error('Папку не знайдено');
      if (id === state.currentId) throw new Error('Не можна видалити поточну папку');
      state.folders = state.folders.filter(f => f.id !== id);
    });
  },

  moveTab: msg => {
    const id = cleanId(msg.id);
    return mutation(msg, (state, windowId) => moveActiveTab(state, id, windowId));
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string' || !Object.hasOwn(handlers, msg.type)) return false;
  Promise.resolve().then(() => handlers[msg.type](msg))
    .then(state => respond({ ok: true, state }), error => respond({ ok: false, error: error.message }));
  return true;
});

// ---- keeping the current folder's snapshot fresh ----
let timer;
async function touched(windowId) {
  if (busy || !Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const tracked = await getTracked();
  if (tracked !== undefined && tracked !== windowId) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    locked(async () => {
      const win = await chrome.windows.get(windowId).catch(() => null);
      if (win?.type !== 'normal' || !await isBooted()) return; // before the startup reconcile the window is not trustworthy
      if (await getTracked() === undefined) await setTracked(windowId);
      await refresh(windowId);
    }, { quiet: true }).catch(() => {});
  }, SNAPSHOT_DELAY);
}

chrome.tabs.onCreated.addListener(tab => touched(tab.windowId));
chrome.tabs.onRemoved.addListener((tabId, info) => {
  chrome.storage.session.remove(lazyKey(tabId));
  if (info.isWindowClosing) return;
  shrinkAllowed = true;
  touched(info.windowId);
});
chrome.tabs.onUpdated.addListener((_, change, tab) => {
  if ('url' in change || 'title' in change || 'pinned' in change || 'favIconUrl' in change) touched(tab.windowId);
});
chrome.tabs.onMoved.addListener((_, info) => touched(info.windowId));
// Wakes a lazy tab: navigates a URL-less tab to what it stood for (session map, else the folder's stored entry by index).
async function wake(tabId) {
  const key = lazyKey(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (isUnusable(tab)) {
    let { [key]: entry } = await chrome.storage.session.get(key);
    if (!entry) {
      const current = currentOf(await read());
      const at = (await folderTabs(tab.windowId)).findIndex(t => t.id === tabId);
      entry = current?.tabs[at];
    }
    if (isRealEntry(entry)) await chrome.tabs.update(tabId, { url: entry.url }).catch(() => {});
  }
  await chrome.storage.session.remove(key);
}

chrome.tabs.onActivated.addListener(info => {
  touched(info.windowId);
  wake(info.tabId);
});
chrome.tabs.onAttached.addListener((_, info) => touched(info.newWindowId));
chrome.tabs.onDetached.addListener((_, info) => touched(info.oldWindowId));
chrome.windows.onRemoved.addListener(async id => { if (await getTracked() === id) chrome.storage.session.remove('windowId'); });

// Startup / (re)install: the first locked operation of the browser session runs the reconcile in ensureState().
async function init({ settle = false } = {}) {
  if (settle) await sleep(STARTUP_SETTLE); // let Chrome finish restoring the session
  for (let attempt = 0; attempt < 5; attempt++) {
    const win = await chrome.windows.getLastFocused().catch(() => null);
    if (win?.type === 'normal') {
      await locked(async () => {
        const windowId = await getTracked() ?? win.id;
        await setTracked(windowId);
        await refresh(windowId);
      }).catch(() => {});
      return;
    }
    await sleep(STARTUP_SETTLE);
  }
}
chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init({ settle: true }));
