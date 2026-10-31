// Pure sync logic: no chrome.*, no network, no crypto. Local folders stay as they are; a shadow copy of what the
// account holds is compared with them, so a folder switch (tabs closed, snapshot kept) is never seen as a deletion.
export interface GroupRef { title: string; color: string; }
export interface SyncEntry { url: string; title: string; favIconUrl: string; group?: GroupRef; }
// `pinned` stays on this device for now: it is kept through merges but not sent.
export interface FolderData { id: string; name: string; color: string; tabs: SyncEntry[]; activeIndex: number; pinned?: SyncEntry[]; }

export interface FolderRecord { k: 'folder'; id: string; name: string; color: string; order: number; }
export interface TabRecord { k: 'tab'; id: string; folderId: string; url: string; title: string; favIconUrl: string; pos: number; group?: GroupRef; }
export interface DeviceTab { url: string; title: string; }
export interface DeviceRecord { k: 'device'; id: string; name: string; at: number; tabs: DeviceTab[]; }
export interface SendRecord { k: 'send'; id: string; to: string; from: string; url: string; title: string; }
export type Plain = FolderRecord | TabRecord | DeviceRecord | SendRecord;

export interface ShadowItem { hlc: string; v: Plain | null; }
export type Shadow = Record<string, ShadowItem>;
export interface Change { key: string; v: Plain | null; }

const GROUP_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
const MAX_URL = 4096;
const MAX_TITLE = 300;
const MIN_GAP = 1e-9;

export const keyOf = (v: { k: string; id: string }): string => `${v.k}:${v.id}`;
const shortTitle = (title: unknown): string => typeof title === 'string' ? title.slice(0, MAX_TITLE) : '';

// Only web pages travel between devices: chrome://, file:, data: and javascript: URLs never leave or enter.
export function isSyncableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > MAX_URL) return false;
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

// ---- hybrid logical clock: ordering survives clock skew and ties break on the device id ----
export interface Clock { ms: number; counter: number; }
export function formatHlc(clock: Clock, deviceId: string): string {
  return `${String(clock.ms).padStart(15, '0')}.${String(clock.counter).padStart(6, '0')}.${deviceId}`;
}
export function tick(clock: Clock, now: number): Clock {
  return now > clock.ms ? { ms: now, counter: 0 } : { ms: clock.ms, counter: clock.counter + 1 };
}
export function observe(clock: Clock, hlc: string): Clock {
  const [ms, counter] = hlc.split('.').map(Number) as [number, number];
  return ms > clock.ms || (ms === clock.ms && counter > clock.counter) ? { ms, counter } : clock;
}

// ---- validation of decrypted records: a paired device is trusted with data, not with arbitrary schemes ----
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
function cleanGroup(value: unknown): GroupRef | undefined {
  const group = value as GroupRef | undefined;
  if (!group || !isText(group.title, 200) || !GROUP_COLORS.has(group.color)) return undefined;
  return { title: group.title, color: group.color };
}
export function cleanPlain(value: unknown): Plain | null {
  const v = value as Record<string, unknown> | null;
  if (!v || !isText(v.id, 64) || !v.id) return null;
  if (v.k === 'folder' && isText(v.name, 40) && v.name && isText(v.color, 16) && /^#[0-9a-f]{6}$/i.test(v.color) && Number.isFinite(v.order)) {
    return { k: 'folder', id: v.id, name: v.name, color: v.color, order: v.order as number };
  }
  if (v.k === 'tab' && isText(v.folderId, 64) && isSyncableUrl(v.url) && Number.isFinite(v.pos)) {
    const group = cleanGroup(v.group);
    return { k: 'tab', id: v.id, folderId: v.folderId, url: v.url, title: shortTitle(v.title),
      favIconUrl: isSyncableUrl(v.favIconUrl) ? v.favIconUrl : '', pos: v.pos as number, ...(group ? { group } : {}) };
  }
  if (v.k === 'device' && isText(v.name, 60) && Number.isFinite(v.at) && Array.isArray(v.tabs)) {
    const tabs = (v.tabs as DeviceTab[]).filter(t => isSyncableUrl(t?.url)).map(t => ({ url: t.url, title: shortTitle(t.title) }));
    return { k: 'device', id: v.id, name: v.name, at: v.at as number, tabs };
  }
  if (v.k === 'send' && isText(v.to, 64) && isText(v.from, 60) && isSyncableUrl(v.url)) {
    return { k: 'send', id: v.id, to: v.to, from: v.from, url: v.url, title: shortTitle(v.title) };
  }
  return null;
}

// ---- reading the shadow ----
const liveOf = <K extends Plain['k']>(shadow: Shadow, k: K): Extract<Plain, { k: K }>[] =>
  Object.values(shadow).flatMap(item => item.v?.k === k ? [item.v as Extract<Plain, { k: K }>] : []);
const byPos = (a: TabRecord, b: TabRecord): number => a.pos - b.pos || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sameGroup = (a?: GroupRef, b?: GroupRef): boolean => a?.title === b?.title && a?.color === b?.color;

function tabsByFolder(shadow: Shadow): Map<string, TabRecord[]> {
  const map = new Map<string, TabRecord[]>();
  for (const tab of liveOf(shadow, 'tab')) map.set(tab.folderId, [...map.get(tab.folderId) ?? [], tab]);
  for (const list of map.values()) list.sort(byPos);
  return map;
}

// Longest increasing run of positions: these tabs keep their pos, so a single move rewrites a single record.
function stableIndexes(positions: (number | undefined)[]): Set<number> {
  const length: number[] = [], back: number[] = [];
  let best = -1;
  positions.forEach((pos, i) => {
    length[i] = 0; back[i] = -1;
    if (pos === undefined) return;
    length[i] = 1;
    for (let j = 0; j < i; j++) {
      const other = positions[j];
      if (other !== undefined && other < pos && length[j]! + 1 > length[i]!) { length[i] = length[j]! + 1; back[i] = j; }
    }
    if (best < 0 || length[i]! > length[best]!) best = i;
  });
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = back[i]!) keep.add(i);
  return keep;
}

function assignPositions(positions: (number | undefined)[]): number[] {
  const keep = stableIndexes(positions);
  const result: number[] = [];
  let i = 0;
  while (i < positions.length) {
    if (keep.has(i)) { result[i] = positions[i]!; i++; continue; }
    let end = i;
    while (end < positions.length && !keep.has(end)) end++;
    const count = end - i;
    const prev = i > 0 ? result[i - 1] : undefined;
    const next = end < positions.length ? positions[end] : undefined;
    const lo = prev ?? (next !== undefined ? next - count - 1 : 0);
    const hi = next ?? lo + count + 1;
    const step = (hi - lo) / (count + 1);
    if (step < MIN_GAP) return positions.map((_, n) => n + 1); // gaps exhausted: renumber this folder once
    for (let n = 0; n < count; n++) result[i + n] = lo + step * (n + 1);
    i = end;
  }
  return result;
}

// ---- local state → changes ----
export function diffLocal(folders: FolderData[], shadow: Shadow, newId: () => string): Change[] {
  const changes: Change[] = [];
  const folderRecords = liveOf(shadow, 'folder');
  let nextOrder = Math.max(0, ...folderRecords.map(f => f.order)) + 1;
  const tabs = tabsByFolder(shadow);
  const localIds = new Set(folders.map(f => f.id));
  const used = new Set<string>();

  for (const folder of folders) {
    const known = shadow[keyOf({ k: 'folder', id: folder.id })]?.v as FolderRecord | null | undefined;
    if (!known || known.name !== folder.name || known.color !== folder.color) {
      const v: FolderRecord = { k: 'folder', id: folder.id, name: folder.name, color: folder.color, order: known?.order ?? nextOrder++ };
      changes.push({ key: keyOf(v), v });
    }
    const pool = new Map<string, TabRecord[]>();
    for (const record of tabs.get(folder.id) ?? []) pool.set(record.url, [...pool.get(record.url) ?? [], record]);
    const entries = folder.tabs.filter(e => isSyncableUrl(e.url));
    const matched = entries.map(e => pool.get(e.url)?.shift());
    const positions = assignPositions(matched.map(m => m?.pos));
    entries.forEach((entry, i) => {
      const record = matched[i];
      if (record) used.add(record.id);
      const pos = positions[i]!;
      // Title and icon are cosmetic and differ per device: rewriting them would make the devices chase each other.
      if (record && record.pos === pos && sameGroup(record.group, entry.group)) return;
      const { group: _old, ...rest } = record ?? { k: 'tab' as const, id: newId(), folderId: folder.id, url: entry.url, title: shortTitle(entry.title),
        favIconUrl: isSyncableUrl(entry.favIconUrl) ? entry.favIconUrl : '', pos };
      const v: TabRecord = { ...rest, pos, ...(entry.group ? { group: entry.group } : {}) };
      changes.push({ key: keyOf(v), v });
    });
  }
  for (const record of liveOf(shadow, 'tab')) if (!used.has(record.id)) changes.push({ key: keyOf(record), v: null });
  for (const record of folderRecords) if (!localIds.has(record.id)) changes.push({ key: keyOf(record), v: null });
  // Parents first: a page boundary must not deliver a tab before its folder.
  return changes.sort((a, b) => Number(a.key.startsWith('tab:')) - Number(b.key.startsWith('tab:')));
}

// Share of live folder content an update would delete; large ones wait for confirmation.
export function massDeletion(shadow: Shadow, deletedKeys: string[]): { deleted: number; total: number; held: boolean } {
  const isContent = (key: string) => key.startsWith('tab:') || key.startsWith('folder:');
  const total = Object.entries(shadow).filter(([key, item]) => isContent(key) && item.v).length;
  const deleted = deletedKeys.filter(key => isContent(key) && shadow[key]?.v).length;
  return { deleted, total, held: deleted > 5 && deleted / Math.max(total, 1) > 0.3 };
}

// ---- remote state → local folders ----
const entryOf = (t: TabRecord): SyncEntry => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, ...(t.group ? { group: t.group } : {}) });

// Moves one folder from `before` to `after`, keeping what changed locally in the meantime and non-web tabs.
export function applyTabDelta(entries: SyncEntry[], before: TabRecord[], after: TabRecord[]): SyncEntry[] {
  const count = (list: TabRecord[]) => {
    const map = new Map<string, number>();
    for (const t of list) map.set(t.url, (map.get(t.url) ?? 0) + 1);
    return map;
  };
  const beforeCount = count(before), afterCount = count(after);
  const remove = new Map<string, number>();
  for (const [url, n] of beforeCount) { const gone = n - (afterCount.get(url) ?? 0); if (gone > 0) remove.set(url, gone); }
  const add = new Map<string, number>();
  for (const [url, n] of afterCount) { const fresh = n - (beforeCount.get(url) ?? 0); if (fresh > 0) add.set(url, fresh); }

  const kept = entries.filter(entry => {
    const left = remove.get(entry.url) ?? 0;
    if (!left) return true;
    remove.set(entry.url, left - 1);
    return false;
  });
  const pool = new Map<string, SyncEntry[]>();
  for (const entry of kept) if (isSyncableUrl(entry.url)) pool.set(entry.url, [...pool.get(entry.url) ?? [], entry]);
  const ordered: SyncEntry[] = [];
  for (const record of after) {
    const existing = pool.get(record.url)?.shift();
    if (existing) {
      const { group: _old, ...rest } = existing;
      ordered.push({ ...rest, ...(record.group ? { group: record.group } : {}) });
      continue;
    }
    const left = add.get(record.url) ?? 0;
    if (left) { add.set(record.url, left - 1); ordered.push(entryOf(record)); }
  }
  // Tabs opened here after the last diff, then non-web tabs: both are local until the next diff decides.
  const rest = [...pool.values()].flat();
  return [...ordered, ...rest, ...kept.filter(e => !isSyncableUrl(e.url))];
}

export function applyRemote(folders: FolderData[], before: Shadow, after: Shadow): FolderData[] {
  const beforeTabs = tabsByFolder(before), afterTabs = tabsByFolder(after);
  const records = liveOf(after, 'folder').sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const local = new Map(folders.map(f => [f.id, f]));
  const known = new Set(Object.keys(before).filter(key => key.startsWith('folder:') && before[key]!.v));
  const result = records.map(record => {
    const folder = local.get(record.id);
    const tabs = applyTabDelta(folder?.tabs ?? [], beforeTabs.get(record.id) ?? [], afterTabs.get(record.id) ?? []);
    return { id: record.id, name: record.name, color: record.color, tabs, activeIndex: folder?.activeIndex ?? 0, ...(folder?.pinned ? { pinned: folder.pinned } : {}) };
  });
  const ids = new Set(result.map(f => f.id));
  // A folder created here since the last diff is not a remote deletion: only known folders can be removed.
  for (const folder of folders) if (!ids.has(folder.id) && !known.has(`folder:${folder.id}`)) result.push(folder);
  return result;
}

// First pull on a joining device: folders with the same name are the same folder ("Основна" exists everywhere).
export function mergeOnJoin(folders: FolderData[], remote: Shadow): { folders: FolderData[]; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};
  const records = liveOf(remote, 'folder');
  const tabs = tabsByFolder(remote);
  const merged = new Map<string, FolderData>();
  for (const record of records) {
    merged.set(record.id, { id: record.id, name: record.name, color: record.color, tabs: (tabs.get(record.id) ?? []).map(entryOf), activeIndex: 0 });
  }
  const own: FolderData[] = [];
  for (const folder of folders) {
    const record = records.find(r => r.id === folder.id) ?? records.find(r => r.name === folder.name);
    if (!record) { own.push(folder); continue; }
    if (record.id !== folder.id) aliases[folder.id] = record.id;
    const target = merged.get(record.id)!;
    const seen = new Set(target.tabs.map(t => t.url));
    target.tabs = [...target.tabs, ...folder.tabs.filter(t => !seen.has(t.url))];
    if (folder.pinned) target.pinned = [...target.pinned ?? [], ...folder.pinned];
  }
  const ordered = records.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)).map(r => merged.get(r.id)!);
  return { folders: [...ordered, ...own], aliases };
}
