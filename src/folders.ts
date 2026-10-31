import type { FolderData, GroupRef } from './sync-model.js';
import { lazyPageUrl, unwrapLazy } from './lazy-tab.js';

const NEWTAB = 'chrome://newtab/';
const COLORS = ['#e5484d', '#f76b15', '#e5a50a', '#30a46c', '#0091ff', '#7c5cff', '#d6409f', '#6e7781'];
const MAX_NAME = 40;
const SNAPSHOT_DELAY = 1000;
const STARTUP_SETTLE = 2000;
const SLEEP_SETTLE = 3000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface FolderEntry { url: string; title: string; favIconUrl: string; group?: GroupRef; }
interface Folder { id: string; name: string; color: string; tabs: FolderEntry[]; activeIndex: number; pinned?: FolderEntry[]; }
interface State { folders: Folder[]; currentId: string | undefined; }

export interface FolderView { id: string; name: string; color: string; count: number; }
export type Blocker = { tabId: number; title: string; reason: string };
// Receives the tabs about to be closed; returns what makes closing them unsafe (empty = safe).
export type Guard = (tabs: chrome.tabs.Tab[]) => Promise<Blocker[]>;
export interface FoldersStatus { currentId: string | undefined; folders: FolderView[]; blocked?: Blocker[]; }

export type FoldersRequest = { type: 'folders-list'; windowId?: number }
  | { type: 'folders-switch'; id: string; windowId?: number; force?: boolean }
  | { type: 'folders-create'; name: string; windowId?: number; force?: boolean }
  | { type: 'folders-rename'; id: string; name: string; windowId?: number }
  | { type: 'folders-delete'; id: string; windowId?: number }
  | { type: 'folders-move-tab'; id: string; windowId?: number; force?: boolean };

export function isFoldersRequest(message: { type?: unknown }): message is FoldersRequest {
  return typeof message.type === 'string' && message.type.startsWith('folders-');
}

type IdTab = chrome.tabs.Tab & { id: number };
const hasId = (tab: chrome.tabs.Tab): tab is IdTab => tab.id !== undefined;

const toEntry = (t: chrome.tabs.Tab): FolderEntry => {
  const lazy = unwrapLazy(t.url || t.pendingUrl);
  if (lazy) return { url: lazy.url, title: lazy.title, favIconUrl: t.favIconUrl ?? '' };
  return { url: t.url || t.pendingUrl || NEWTAB, title: t.title ?? '', favIconUrl: t.favIconUrl ?? '' };
};
const isRealUrl = (url: string | undefined): boolean => Boolean(url) && !/^(chrome:\/\/newtab\/?|about:blank)$/.test(url!);
const isRealEntry = (entry: FolderEntry | undefined): entry is FolderEntry => isRealUrl(entry?.url);
// No usable URL: never navigated, or a blank tab that Chrome left unloaded (e.g. after a restart).
const isUnusable = (t: chrome.tabs.Tab): boolean =>
  !(t.url || t.pendingUrl) || (t.url === 'about:blank' && !t.pendingUrl && (t.discarded === true || t.status === 'unloaded'));
const isRealTab = (t: chrome.tabs.Tab): boolean => !isUnusable(t) && isRealUrl(t.url || t.pendingUrl);
const realUrl = (t: chrome.tabs.Tab): string | undefined => unwrapLazy(t.url || t.pendingUrl)?.url ?? (t.url || t.pendingUrl);
// A tab discarded before its first navigation commits loses url/title in Chrome (and gets a new id),
// so we remember what it was meant to show, keyed by its current id (session storage, gone on restart).
const lazyKey = (tabId: number) => `lazy:${tabId}`;
const currentOf = (state: State): Folder | undefined => state.folders.find(f => f.id === state.currentId);

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Некоректна назва');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME) throw new Error(`Назва: 1–${MAX_NAME} символів`);
  return name;
}
function cleanId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 64) throw new Error('Некоректний id');
  return value;
}

const view = ({ folders, currentId }: State): FoldersStatus => ({
  currentId,
  folders: folders.map(({ id, name, color, tabs }) => ({ id, name, color, count: tabs.length }))
});

export class Folders {
  // One mutation at a time; events are ignored while a mutation runs.
  private chain: Promise<unknown> = Promise.resolve();
  private busy = 0;
  // Explicit tab removals (not startup or other automatic snapshots) may turn a folder with real pages into blank ones.
  private shrinkAllowed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sleeping = new Set<Promise<void>>();
  constructor(private api: typeof chrome, private guard?: Guard, private delay = SNAPSHOT_DELAY) {}

  private locked<T>(job: () => Promise<T>, { quiet = false } = {}): Promise<T> {
    const run = this.chain.then(async () => {
      if (!quiet) this.busy++;
      try { return await job(); } finally { if (!quiet) this.busy--; }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  // ---- storage ----
  private async read(): Promise<State> {
    const { folders, currentId } = await this.api.storage.local.get(['folders', 'currentId']);
    return { folders: Array.isArray(folders) ? folders as Folder[] : [], currentId: currentId as string | undefined };
  }
  private write({ folders, currentId }: State): Promise<void> { return this.api.storage.local.set({ folders, currentId }); }
  private async getTracked(): Promise<number | undefined> { return (await this.api.storage.session.get('windowId')).windowId as number | undefined; }
  private setTracked(windowId: number): Promise<void> { return this.api.storage.session.set({ windowId }); }
  private async isBooted(): Promise<boolean> { return (await this.api.storage.session.get('booted')).booted === true; }

  // ---- tabs ----
  private async folderTabs(windowId: number): Promise<IdTab[]> {
    const tabs = await this.api.tabs.query({ windowId });
    return tabs.filter(hasId).filter(t => !t.pinned).sort((a, b) => a.index - b.index);
  }

  private async pinnedTabs(windowId: number): Promise<IdTab[]> {
    const tabs = await this.api.tabs.query({ windowId });
    return tabs.filter(hasId).filter(t => t.pinned).sort((a, b) => a.index - b.index);
  }

  // Pinned tabs belong to the current folder, like the others. An empty list is dropped from storage.
  private async capturePinned(windowId: number, folder: Folder): Promise<void> {
    const entries = await this.entriesOf(await this.pinnedTabs(windowId), folder.pinned ?? []);
    if (entries.length) folder.pinned = entries; else delete folder.pinned;
  }

  private async openPinned(windowId: number, entries: FolderEntry[]): Promise<void> {
    for (const entry of entries) {
      try {
        await this.openLazy(windowId, entry, { pinned: true });
      } catch { /* URL cannot be re-created: skip it */ }
    }
  }

  // After a restart without session restore the window has no pinned tabs, so the folder brings its own back.
  private async restorePinned(windowId: number, folder: Folder | undefined): Promise<void> {
    if (!folder?.pinned?.length) return;
    const open = await this.entriesOf(await this.pinnedTabs(windowId), folder.pinned);
    const pool = open.map(entry => entry.url);
    const missing = folder.pinned.filter(entry => {
      const at = pool.indexOf(entry.url);
      if (at < 0) return true;
      pool.splice(at, 1);
      return false;
    });
    await this.openPinned(windowId, missing);
  }

  // Source order for a tab without a usable URL: session map, then the folder's stored entry at the same index, then new tab.
  private async entriesOf(tabs: IdTab[], previous: FolderEntry[] = []): Promise<FolderEntry[]> {
    const keys = tabs.filter(isUnusable).map(t => lazyKey(t.id));
    const lazy: Record<string, FolderEntry | undefined> = keys.length ? await this.api.storage.session.get(keys) : {};
    const groups = await this.groupsOf(tabs);
    return tabs.map((t, i) => {
      const { group: _stale, ...entry } = isUnusable(t) ? lazy[lazyKey(t.id)] ?? previous[i] ?? toEntry(t) : toEntry(t);
      const group = groups.get(t.groupId ?? -1);
      return group ? { ...entry, group } : entry;
    });
  }

  private async groupsOf(tabs: IdTab[]): Promise<Map<number, GroupRef>> {
    const map = new Map<number, GroupRef>();
    if (!this.api.tabGroups) return map;
    for (const id of new Set(tabs.map(t => t.groupId ?? -1))) {
      if (id < 0) continue;
      const group = await this.api.tabGroups.get(id).catch(() => null);
      if (group) map.set(id, { title: group.title ?? '', color: group.color });
    }
    return map;
  }

  // Puts tabs into the groups their entries name, reusing a group of the window with the same title and colour.
  private async applyGroups(windowId: number, tabs: IdTab[], entries: FolderEntry[]): Promise<void> {
    if (!this.api.tabGroups || !entries.some(e => e.group) && !tabs.some(t => (t.groupId ?? -1) >= 0)) return;
    const current = await this.groupsOf(tabs);
    const same = (a?: GroupRef, b?: GroupRef) => a?.title === b?.title && a?.color === b?.color;
    const created = new Map<string, number>();
    for (const [i, tab] of tabs.entries()) {
      const wanted = entries[i]?.group;
      if (same(current.get(tab.groupId ?? -1), wanted)) continue;
      try {
        if (!wanted) { await this.api.tabs.ungroup(tab.id); continue; }
        const key = `${wanted.color}|${wanted.title}`;
        let groupId = created.get(key) ?? [...current].find(([, group]) => same(group, wanted))?.[0];
        groupId = await this.api.tabs.group(groupId === undefined ? { tabIds: tab.id, createProperties: { windowId } } : { tabIds: tab.id, groupId });
        if (!created.has(key) && ![...current.keys()].includes(groupId)) {
          created.set(key, groupId);
          await this.api.tabGroups.update(groupId, { title: wanted.title, color: wanted.color as chrome.tabGroups.Color });
        }
      } catch { /* the tab went away meanwhile: the next snapshot records what is really there */ }
    }
  }

  private takeShrink(): boolean { const value = this.shrinkAllowed; this.shrinkAllowed = false; return value; }

  // Returns false (folder untouched) when an automatic snapshot would replace real pages with only blank ones.
  private async capture(tabs: IdTab[], folder: Folder, allowShrink = false): Promise<boolean> {
    const entries = await this.entriesOf(tabs, folder.tabs);
    if (!allowShrink && folder.tabs.some(isRealEntry) && !entries.some(isRealEntry)) return false;
    folder.tabs = entries;
    const active = tabs.findIndex(t => t.active);
    const last = Math.max(0, folder.tabs.length - 1);
    folder.activeIndex = active >= 0 ? active : Math.min(folder.activeIndex ?? 0, last);
    return true;
  }

  // Once per browser session (session storage is empty after a restart or an extension reload/update): the stored folder
  // is the truth, the window is not. Session restore drops never-loaded tabs and "open New Tab" brings none back, so if every
  // real page in the window already belongs to the stored current folder, rebuild the folder instead of snapshotting
  // the window over it. Pages the folder does not know about (user's own startup pages) are left alone and get snapshotted.
  private async reconcileAfterRestart(state: State, windowId: number): Promise<void> {
    const folder = currentOf(state);
    if (!folder?.tabs.some(isRealEntry)) return;
    const tabs = await this.folderTabs(windowId);
    const known = new Set(folder.tabs.map(t => t.url));
    if (!tabs.filter(isRealTab).every(t => known.has(realUrl(t)!))) return;
    await this.openFolderTabs(windowId, folder, new Set(tabs.map(t => t.id)));
    await this.removeTabs(tabs.map(t => t.id));
  }

  private async ensureState(windowId: number): Promise<State> {
    const state = await this.read();
    if (!await this.isBooted()) {
      await this.restorePinned(windowId, currentOf(state));
      await this.reconcileAfterRestart(state, windowId);
      await this.api.storage.session.set({ booted: true });
    }
    if (!state.folders.length) {
      const folder: Folder = { id: crypto.randomUUID(), name: 'Основна', color: COLORS[0]!, tabs: [], activeIndex: 0 };
      await this.capture(await this.folderTabs(windowId), folder);
      await this.capturePinned(windowId, folder);
      state.folders.push(folder);
    }
    const first = state.folders[0];
    if (!currentOf(state) && first) state.currentId = first.id;
    return state;
  }

  // Chrome rejects discard() while a fresh tab is still initialising: retry once on its first update event.
  private async discardLazily(tabId: number, entry: FolderEntry): Promise<void> {
    const attempt = async () => {
      const tab = await this.api.tabs.discard(tabId);
      if (!tab?.id) throw new Error('not discarded');
      await this.api.storage.session.set({ [lazyKey(tab.id)]: entry });
      return tab;
    };
    try { await attempt(); return; } catch { /* retry below */ }
    const retry = (id: number) => {
      if (id !== tabId) return;
      this.api.tabs.onUpdated.removeListener(retry);
      attempt().then(tab => this.touched(tab.windowId), () => {});
    };
    this.api.tabs.onUpdated.addListener(retry);
  }

  // Opens a sleeping tab: the placeholder keeps the title in the tab strip and sends nothing to the site.
  private async openLazy(windowId: number, entry: FolderEntry, extra: { pinned?: boolean; index?: number } = {}): Promise<void> {
    if (!isRealEntry(entry) || !this.api.runtime?.getURL) {
      const plain = await this.api.tabs.create({ windowId, url: entry.url, active: false, ...extra });
      if (plain.id !== undefined) await this.discardLazily(plain.id, entry);
      return;
    }
    const url = lazyPageUrl(this.api.runtime.getURL('lazy.html'), entry);
    const tab = await this.api.tabs.create({ windowId, url, active: false, ...extra });
    if (tab.id === undefined) return;
    if (tab.status === 'complete') { await this.discardPlaceholder(tab.id, url, entry); return; }
    const id = tab.id;
    const asleep = new Promise<void>(done => {
      const loaded = (changed: number, info: { status?: string }) => {
        if (changed !== id || info.status !== 'complete') return;
        this.api.tabs.onUpdated.removeListener(loaded);
        void this.discardPlaceholder(id, url, entry).catch(() => {}).finally(done);
      };
      this.api.tabs.onUpdated.addListener(loaded);
    }).finally(() => this.sleeping.delete(asleep));
    this.sleeping.add(asleep);
  }

  // Discarding gives a tab a new id. A mutation must read the window after that, or it would try to close ids that no longer exist.
  private async settleSleeping(): Promise<void> {
    if (this.sleeping.size) await Promise.race([Promise.allSettled([...this.sleeping]), sleep(SLEEP_SETTLE)]);
  }

  // The tab may already be open and on its real page by now: then there is nothing to put to sleep.
  private async discardPlaceholder(tabId: number, url: string, entry: FolderEntry): Promise<void> {
    const tab = await this.api.tabs.get(tabId).catch(() => null);
    if (!tab || tab.active || (tab.url !== url && tab.url !== '')) return;
    await this.discardLazily(tabId, entry);
  }

  private async openFolderTabs(windowId: number, folder: Folder, oldIds: Set<number>): Promise<void> {
    const entries = folder.tabs.length ? folder.tabs : [{ url: NEWTAB, title: '', favIconUrl: '' }];
    const wanted = Math.min(Math.max(folder.activeIndex ?? 0, 0), entries.length - 1);
    const created: number[] = [];
    for (const [i, entry] of entries.entries()) {
      try {
        if (i === wanted) await this.api.tabs.create({ windowId, url: entry.url, active: true });
        else await this.openLazy(windowId, entry);
        created.push(i);
      } catch { /* URL cannot be re-created: skip it */ }
    }
    if (!created.length) { await this.api.tabs.create({ windowId, active: true }); return; }
    if (!created.includes(wanted)) {
      // discard() gives tabs new ids, so look the first new tab up again
      const [fresh] = (await this.folderTabs(windowId)).filter(t => !oldIds.has(t.id));
      if (fresh) await this.api.tabs.update(fresh.id, { active: true });
    }
    const opened = (await this.folderTabs(windowId)).filter(t => !oldIds.has(t.id));
    await this.applyGroups(windowId, opened, created.map(i => entries[i]!));
  }

  // ---- changes from other devices ----
  snapshot(): Promise<FolderData[]> {
    return this.locked(async () => (await this.read()).folders, { quiet: true });
  }

  // Brings the open window to the folder's new content. The user's active tab and tabs the guard protects are never closed;
  // if they are not in the target, the capture below keeps them and the next diff sends them back.
  private async reconcileWindow(windowId: number, folder: Folder): Promise<void> {
    const pinned = (await this.api.tabs.query({ windowId })).filter(t => t.pinned).length;
    const tabs = await this.folderTabs(windowId);
    const entries = await this.entriesOf(tabs, folder.tabs);
    const pool = new Map<string, IdTab[]>();
    tabs.forEach((tab, i) => { const url = entries[i]!.url; pool.set(url, [...pool.get(url) ?? [], tab]); });
    const missing: { index: number; entry: FolderEntry }[] = [];
    folder.tabs.forEach((entry, index) => { if (!pool.get(entry.url)?.shift()) missing.push({ index, entry }); });
    const extra = [...pool.values()].flat().filter(t => !t.active);
    const closable: number[] = [];
    for (const tab of extra) if (!(await this.blockers([tab], false)).length) closable.push(tab.id);
    for (const { index, entry } of missing) {
      try {
        await this.openLazy(windowId, entry, { index: pinned + index });
      } catch { /* URL cannot be opened here: the next snapshot drops it */ }
    }
    await this.removeTabs(closable);

    // Same order as the target, or both devices would keep rewriting each other's positions.
    let live = await this.folderTabs(windowId);
    let urls = (await this.entriesOf(live, folder.tabs)).map(e => e.url);
    for (const [i, entry] of folder.tabs.entries()) {
      if (urls[i] === entry.url) continue;
      const at = urls.indexOf(entry.url, i + 1);
      if (at < 0) continue;
      await this.api.tabs.move(live[at]!.id, { index: pinned + i }).catch(() => {});
      live = await this.folderTabs(windowId);
      urls = (await this.entriesOf(live, folder.tabs)).map(e => e.url);
    }
    const liveEntries = await this.entriesOf(live, folder.tabs);
    await this.applyGroups(windowId, live, liveEntries.map((entry, i) => folder.tabs[i]?.url === entry.url ? folder.tabs[i]! : entry));
    await this.capture(await this.folderTabs(windowId), folder, true);
    await this.capturePinned(windowId, folder);
  }

  applyRemote(transform: (folders: FolderData[]) => FolderData[], aliases: Record<string, string> = {}): Promise<void> {
    return this.locked(async () => {
      await this.settleSleeping();
      const state = await this.read();
      const before = currentOf(state);
      const currentId = state.currentId !== undefined ? aliases[state.currentId] ?? state.currentId : undefined;
      const next = transform(state.folders) as Folder[];
      // The folder open on this device is not closed by a remote delete: it stays, and the next diff restores it.
      if (before && currentId !== undefined && !next.some(f => f.id === currentId)) next.push(before);
      state.folders = next;
      state.currentId = currentId ?? next[0]?.id;
      const folder = currentOf(state);
      const tracked = await this.getTracked();
      const win = tracked === undefined ? null : await this.api.windows.get(tracked).catch(() => null);
      if (folder && before && win?.id !== undefined && win.type === 'normal' && await this.isBooted()) await this.reconcileWindow(win.id, folder);
      await this.write(state);
      if (state.folders.length) await this.applyAction(state);
    });
  }

  private removeTabs(ids: number[]): Promise<unknown> { return Promise.allSettled(ids.map(id => this.api.tabs.remove(id))); }

  private async applyAction(state: State): Promise<void> {
    const folder = currentOf(state);
    if (!folder) return;
    // The badge text belongs to the blocked-request counter: only colour and title show the folder.
    await Promise.all([
      this.api.action.setBadgeBackgroundColor({ color: folder.color }),
      this.api.action.setTitle({ title: `Легко · Папка: ${folder.name}` })
    ]);
  }

  private async blockers(tabs: chrome.tabs.Tab[], force: boolean): Promise<Blocker[]> {
    if (force || !this.guard || !tabs.length) return [];
    return this.guard(tabs);
  }

  // ---- mutations (always called under the lock) ----
  private async refresh(windowId: number): Promise<State> {
    const state = await this.ensureState(windowId);
    const folder = currentOf(state);
    if (folder) {
      await this.capture(await this.folderTabs(windowId), folder, this.takeShrink());
      await this.capturePinned(windowId, folder);
    }
    await this.write(state);
    await this.applyAction(state);
    return state;
  }

  private async switchTo(state: State, id: string, windowId: number, force: boolean): Promise<Blocker[]> {
    const target = state.folders.find(f => f.id === id);
    if (!target) throw new Error('Папку не знайдено');
    if (id === state.currentId) return [];
    const old = await this.folderTabs(windowId);
    const oldPinned = await this.pinnedTabs(windowId);
    const blocked = await this.blockers([...oldPinned, ...old], force);
    if (blocked.length) return blocked;
    const folder = currentOf(state);
    if (folder) {
      await this.capture(old, folder, this.takeShrink());
      await this.capturePinned(windowId, folder);
    }
    await this.write(state);
    await this.openFolderTabs(windowId, target, new Set(old.map(t => t.id)));
    await this.openPinned(windowId, target.pinned ?? []);
    await this.removeTabs([...oldPinned, ...old].map(t => t.id));
    state.currentId = id;
    await this.write(state);
    await this.applyAction(state);
    return [];
  }

  private async moveActiveTab(state: State, id: string, windowId: number, force: boolean): Promise<Blocker[]> {
    const target = state.folders.find(f => f.id === id);
    if (!target) throw new Error('Папку не знайдено');
    if (id === state.currentId) throw new Error('Вкладка вже в цій папці');
    const [active] = await this.api.tabs.query({ windowId, active: true });
    if (!active || !hasId(active) || active.pinned) throw new Error('Спочатку відкріпіть вкладку');
    const blocked = await this.blockers([active], force);
    if (blocked.length) return blocked;
    const current = currentOf(state);
    const tabs = await this.folderTabs(windowId);
    const at = tabs.findIndex(t => t.id === active.id);
    const [entry] = await this.entriesOf([active], current?.tabs[at] ? [current.tabs[at]] : []); // before removal drops its session entry
    if (tabs.length === 1) await this.api.tabs.create({ windowId, active: true });
    await this.api.tabs.remove(active.id);
    if (entry) target.tabs.push(entry);
    if (current) await this.capture(await this.folderTabs(windowId), current, true);
    await this.write(state);
    return [];
  }

  private async cleanWindow(value: unknown): Promise<number> {
    if (value === undefined) {
      const id = (await this.api.windows.getLastFocused()).id;
      if (id === undefined) throw new Error('Вікно недоступне');
      return id;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('Некоректне вікно');
    const win = await this.api.windows.get(value).catch(() => null);
    if (win?.type !== 'normal' || win.id === undefined) throw new Error('Вікно недоступне');
    return win.id;
  }

  // Runs `job(state, windowId)` under the lock, persists/reports the resulting state.
  private mutation(windowId: unknown, job: (state: State, windowId: number) => Promise<Blocker[]> | Blocker[]): Promise<FoldersStatus> {
    return this.locked(async () => {
      await this.settleSleeping();
      const id = await this.cleanWindow(windowId);
      const state = await this.ensureState(id);
      await this.setTracked(id);
      const blocked = await job(state, id);
      await this.write(state);
      await this.applyAction(state);
      return blocked.length ? { ...view(state), blocked } : view(state);
    });
  }

  async request(message: FoldersRequest): Promise<FoldersStatus> {
    const force = (message as { force?: unknown }).force === true;
    switch (message.type) {
      case 'folders-list':
        return this.locked(async () => {
          const windowId = await this.cleanWindow(message.windowId);
          await this.setTracked(windowId);
          return view(await this.refresh(windowId));
        }, { quiet: true });
      case 'folders-switch': {
        const id = cleanId(message.id);
        return this.mutation(message.windowId, (state, windowId) => this.switchTo(state, id, windowId, force));
      }
      case 'folders-create': {
        const name = cleanName(message.name);
        return this.mutation(message.windowId, async (state, windowId) => {
          const blocked = await this.blockers([...await this.pinnedTabs(windowId), ...await this.folderTabs(windowId)], force);
          if (blocked.length) return blocked;
          const used = new Set(state.folders.map(f => f.color));
          const color = COLORS.find(c => !used.has(c)) ?? COLORS[state.folders.length % COLORS.length]!;
          const folder: Folder = { id: crypto.randomUUID(), name, color, tabs: [], activeIndex: 0 };
          state.folders.push(folder);
          return this.switchTo(state, folder.id, windowId, true); // already checked above
        });
      }
      case 'folders-rename': {
        const id = cleanId(message.id), name = cleanName(message.name);
        return this.mutation(message.windowId, state => {
          const folder = state.folders.find(f => f.id === id);
          if (!folder) throw new Error('Папку не знайдено');
          folder.name = name;
          return [];
        });
      }
      case 'folders-delete': {
        const id = cleanId(message.id);
        return this.mutation(message.windowId, state => {
          if (!state.folders.some(f => f.id === id)) throw new Error('Папку не знайдено');
          if (id === state.currentId) throw new Error('Не можна видалити поточну папку');
          state.folders = state.folders.filter(f => f.id !== id);
          return [];
        });
      }
      case 'folders-move-tab': {
        const id = cleanId(message.id);
        return this.mutation(message.windowId, (state, windowId) => this.moveActiveTab(state, id, windowId, force));
      }
      default: throw new Error('Невідома команда.');
    }
  }

  // ---- keeping the current folder's snapshot fresh ----
  private async touched(windowId: number | undefined): Promise<void> {
    if (this.busy || windowId === undefined || !Number.isInteger(windowId) || windowId === this.api.windows.WINDOW_ID_NONE) return;
    const tracked = await this.getTracked();
    if (tracked !== undefined && tracked !== windowId) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.locked(async () => {
        const win = await this.api.windows.get(windowId).catch(() => null);
        if (win?.type !== 'normal' || !await this.isBooted()) return; // before the startup reconcile the window is not trustworthy
        if (await this.getTracked() === undefined) await this.setTracked(windowId);
        await this.refresh(windowId);
      }, { quiet: true }).catch(() => {});
    }, this.delay);
  }

  // Wakes a lazy tab: navigates a URL-less tab to what it stood for (session map, else the folder's stored entry by index).
  private async wake(tabId: number): Promise<void> {
    const key = lazyKey(tabId);
    const tab = await this.api.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    // Selecting a discarded tab does not always restore it (a window in the background, for one).
    // The placeholder then replaces itself with the site, which keeps it out of Back history.
    if (tab.discarded && unwrapLazy(tab.url)) await this.api.tabs.reload(tabId).catch(() => {});
    else if (isUnusable(tab)) {
      let entry = (await this.api.storage.session.get(key))[key] as FolderEntry | undefined;
      if (!entry) {
        const current = currentOf(await this.read());
        const at = (await this.folderTabs(tab.windowId)).findIndex(t => t.id === tabId);
        entry = current?.tabs[at];
      }
      if (isRealEntry(entry)) await this.api.tabs.update(tabId, { url: entry.url }).catch(() => {});
    }
    await this.api.storage.session.remove(key);
  }

  // ---- event handlers (the worker registers the listeners) ----
  created(tab: chrome.tabs.Tab): void { void this.touched(tab.windowId).catch(() => {}); }
  removed(tabId: number, info: { windowId: number; isWindowClosing: boolean }): void {
    void this.api.storage.session.remove(lazyKey(tabId)).catch(() => {});
    if (info.isWindowClosing) return;
    this.shrinkAllowed = true;
    void this.touched(info.windowId).catch(() => {});
  }
  updated(_tabId: number, change: { url?: string; title?: string; pinned?: boolean; favIconUrl?: string; groupId?: number }, tab: chrome.tabs.Tab): void {
    if ('url' in change || 'title' in change || 'pinned' in change || 'favIconUrl' in change || 'groupId' in change) void this.touched(tab.windowId).catch(() => {});
  }
  groupChanged(group: { windowId: number }): void { void this.touched(group.windowId).catch(() => {}); }
  moved(_tabId: number, info: { windowId: number }): void { void this.touched(info.windowId).catch(() => {}); }
  activated(info: { tabId: number; windowId: number }): void {
    void this.touched(info.windowId).catch(() => {});
    void this.wake(info.tabId).catch(() => {});
  }
  attached(_tabId: number, info: { newWindowId: number }): void { void this.touched(info.newWindowId).catch(() => {}); }
  detached(_tabId: number, info: { oldWindowId: number }): void { void this.touched(info.oldWindowId).catch(() => {}); }
  async windowRemoved(id: number): Promise<void> {
    if (await this.getTracked() === id) await this.api.storage.session.remove('windowId');
  }

  // Startup / (re)install: the first locked operation of the browser session runs the reconcile in ensureState().
  async init({ settle = false }: { settle?: boolean } = {}): Promise<void> {
    if (settle) await sleep(STARTUP_SETTLE); // let Chrome finish restoring the session
    for (let attempt = 0; attempt < 5; attempt++) {
      const win = await this.api.windows.getLastFocused().catch(() => null);
      if (win?.type === 'normal' && win.id !== undefined) {
        const fallback = win.id;
        await this.locked(async () => {
          const windowId = await this.getTracked() ?? fallback;
          await this.setTracked(windowId);
          await this.refresh(windowId);
        }).catch(() => {});
        return;
      }
      await sleep(STARTUP_SETTLE);
    }
  }
}
