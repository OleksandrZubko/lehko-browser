const NEWTAB = 'chrome://newtab/';
const COLORS = ['#e5484d', '#f76b15', '#e5a50a', '#30a46c', '#0091ff', '#7c5cff', '#d6409f', '#6e7781'];
const MAX_NAME = 40;
const SNAPSHOT_DELAY = 1000;
const STARTUP_SETTLE = 2000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface FolderEntry { url: string; title: string; favIconUrl: string; }
interface Folder { id: string; name: string; color: string; tabs: FolderEntry[]; activeIndex: number; }
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

const toEntry = (t: chrome.tabs.Tab): FolderEntry => ({ url: t.url || t.pendingUrl || NEWTAB, title: t.title ?? '', favIconUrl: t.favIconUrl ?? '' });
const isRealUrl = (url: string | undefined): boolean => Boolean(url) && !/^(chrome:\/\/newtab\/?|about:blank)$/.test(url!);
const isRealEntry = (entry: FolderEntry | undefined): entry is FolderEntry => isRealUrl(entry?.url);
// No usable URL: never navigated, or a blank tab that Chrome left unloaded (e.g. after a restart).
const isUnusable = (t: chrome.tabs.Tab): boolean =>
  !(t.url || t.pendingUrl) || (t.url === 'about:blank' && !t.pendingUrl && (t.discarded === true || t.status === 'unloaded'));
const isRealTab = (t: chrome.tabs.Tab): boolean => !isUnusable(t) && isRealUrl(t.url || t.pendingUrl);
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

  // Source order for a tab without a usable URL: session map, then the folder's stored entry at the same index, then new tab.
  private async entriesOf(tabs: IdTab[], previous: FolderEntry[] = []): Promise<FolderEntry[]> {
    const keys = tabs.filter(isUnusable).map(t => lazyKey(t.id));
    const lazy: Record<string, FolderEntry | undefined> = keys.length ? await this.api.storage.session.get(keys) : {};
    return tabs.map((t, i) => isUnusable(t) ? lazy[lazyKey(t.id)] ?? previous[i] ?? toEntry(t) : toEntry(t));
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
    if (!tabs.filter(isRealTab).every(t => known.has((t.url || t.pendingUrl)!))) return;
    await this.openFolderTabs(windowId, folder, new Set(tabs.map(t => t.id)));
    await this.removeTabs(tabs.map(t => t.id));
  }

  private async ensureState(windowId: number): Promise<State> {
    const state = await this.read();
    if (!await this.isBooted()) {
      await this.reconcileAfterRestart(state, windowId);
      await this.api.storage.session.set({ booted: true });
    }
    if (!state.folders.length) {
      const folder: Folder = { id: crypto.randomUUID(), name: 'Основна', color: COLORS[0]!, tabs: [], activeIndex: 0 };
      await this.capture(await this.folderTabs(windowId), folder);
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

  private async openFolderTabs(windowId: number, folder: Folder, oldIds: Set<number>): Promise<void> {
    const entries = folder.tabs.length ? folder.tabs : [{ url: NEWTAB, title: '', favIconUrl: '' }];
    const wanted = Math.min(Math.max(folder.activeIndex ?? 0, 0), entries.length - 1);
    const created: number[] = [];
    for (const [i, entry] of entries.entries()) {
      try {
        const tab = await this.api.tabs.create({ windowId, url: entry.url, active: i === wanted });
        created.push(i);
        if (i !== wanted && tab.id !== undefined) await this.discardLazily(tab.id, entry);
      } catch { /* URL cannot be re-created: skip it */ }
    }
    if (!created.length) { await this.api.tabs.create({ windowId, active: true }); return; }
    if (!created.includes(wanted)) {
      // discard() gives tabs new ids, so look the first new tab up again
      const [fresh] = (await this.folderTabs(windowId)).filter(t => !oldIds.has(t.id));
      if (fresh) await this.api.tabs.update(fresh.id, { active: true });
    }
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
    if (folder) await this.capture(await this.folderTabs(windowId), folder, this.takeShrink());
    await this.write(state);
    await this.applyAction(state);
    return state;
  }

  private async switchTo(state: State, id: string, windowId: number, force: boolean): Promise<Blocker[]> {
    const target = state.folders.find(f => f.id === id);
    if (!target) throw new Error('Папку не знайдено');
    if (id === state.currentId) return [];
    const old = await this.folderTabs(windowId);
    const blocked = await this.blockers(old, force);
    if (blocked.length) return blocked;
    const folder = currentOf(state);
    if (folder) await this.capture(old, folder, this.takeShrink());
    await this.write(state);
    await this.openFolderTabs(windowId, target, new Set(old.map(t => t.id)));
    await this.removeTabs(old.map(t => t.id));
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
    if (!active || !hasId(active) || active.pinned) throw new Error('Закріплені вкладки не належать папкам');
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
          const blocked = await this.blockers(await this.folderTabs(windowId), force);
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
    if (isUnusable(tab)) {
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
  updated(_tabId: number, change: { url?: string; title?: string; pinned?: boolean; favIconUrl?: string }, tab: chrome.tabs.Tab): void {
    if ('url' in change || 'title' in change || 'pinned' in change || 'favIconUrl' in change) void this.touched(tab.windowId).catch(() => {});
  }
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
