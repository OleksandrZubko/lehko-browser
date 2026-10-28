export const KEEP_RECENT = 5;
export const TIMEOUTS = [15, 30, 60] as const;
export type TimeoutMinutes = (typeof TIMEOUTS)[number];
export interface Settings {
  enabled: boolean;
  timeoutMinutes: TimeoutMinutes;
  allowedHosts: string[];
}
export const DEFAULT_SETTINGS: Settings = { enabled: true, timeoutMinutes: 15, allowedHosts: [] };
export interface Activity {
  idleSince: number;
  order: number;
  browserLastAccessed: number;
  wasActive: boolean;
}
export interface Session {
  version: 1;
  startedAt: number;
  sequence: number;
  activity: Record<string, Activity>;
  discardedCount: number;
  errors: number;
  lastSweepAt: number | null;
}
export type Tab = Pick<chrome.tabs.Tab,
  'id' | 'url' | 'pendingUrl' | 'title' | 'active' | 'pinned' | 'audible' |
  'status' | 'discarded' | 'incognito' | 'autoDiscardable' | 'lastAccessed'>;
export type Reason = 'disabled' | 'private' | 'active' | 'pinned' | 'audio' | 'devtools' | 'qa-host' | 'form' | 'loading' |
  'discarded' | 'browser-protected' | 'unsupported' | 'not-allowed' | 'recent' | 'waiting' | 'eligible';
export const REASON_LABELS: Record<Reason, string> = {
  disabled: 'Економію вимкнено', private: 'Приватне вікно', active: 'Активна вкладка',
  pinned: 'Закріплена', audio: 'Відтворює звук', devtools: 'Відкрито DevTools', 'qa-host': 'Локальний або тестовий сайт',
  form: 'Незбережені дані у формі', loading: 'Завантажується',
  discarded: 'Уже вивантажена', 'browser-protected': 'Захищена від автоматичного вивантаження',
  unsupported: 'Службова або непідтримувана сторінка', 'not-allowed': 'Сайт не дозволено',
  recent: 'Серед п’яти останніх вкладок', waiting: 'Ще не минув час', eligible: 'Готова до вивантаження'
};

export function hostname(url?: string): string | null {
  try {
    const parsed = new URL(url ?? '');
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch { return null; }
}

export function validHost(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 253) return false;
  return hostname(`https://${value}/`) === value && !/[\s/@?#*]/.test(value);
}

export function normalizeSettings(value: unknown): Settings {
  const input = value as Partial<Settings> | null;
  return {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : true,
    timeoutMinutes: TIMEOUTS.includes(input?.timeoutMinutes as TimeoutMinutes) ? input!.timeoutMinutes! : 15,
    allowedHosts: Array.isArray(input?.allowedHosts)
      ? [...new Set(input.allowedHosts.filter(validHost))].sort() : []
  };
}

export function newSession(now: number): Session {
  return { version: 1, startedAt: now, sequence: 0, activity: {}, discardedCount: 0, errors: 0, lastSweepAt: null };
}

// Native lastAccessed recovers activations which happened while the worker was asleep.
export function reconcile(session: Session, tabs: Tab[], now: number): void {
  const ids = new Set(tabs.map(tab => String(tab.id)));
  for (const id of Object.keys(session.activity)) if (!ids.has(id)) delete session.activity[id];
  for (const tab of [...tabs].sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0))) {
    if (tab.id === undefined || tab.incognito) continue;
    const key = String(tab.id);
    const previous = session.activity[key];
    const accessed = tab.lastAccessed ?? 0;
    if (!previous) {
      session.activity[key] = { idleSince: now, order: ++session.sequence, browserLastAccessed: accessed, wasActive: tab.active };
    } else if (accessed > previous.browserLastAccessed) {
      previous.idleSince = now;
      previous.order = ++session.sequence;
      previous.browserLastAccessed = accessed;
    }
    const activity = session.activity[key]!;
    if (tab.active || activity.wasActive) activity.idleSince = now;
    activity.wasActive = tab.active;
  }
}

export function recentIds(session: Session, tabs: Tab[]): Set<number> {
  return new Set(tabs.filter(tab => tab.id !== undefined && !tab.incognito && !tab.discarded && hostname(tab.url))
    .sort((a, b) => (session.activity[String(b.id)]?.order ?? 0) - (session.activity[String(a.id)]?.order ?? 0))
    .slice(0, KEEP_RECENT).map(tab => tab.id!));
}

// `shield` adds protections that live outside the policy (open DevTools, local and test hosts).
export function reasonFor(tab: Tab, settings: Settings, session: Session, recent: Set<number>, now: number,
  shield?: (tab: Tab) => Reason | null): Reason {
  if (tab.discarded) return 'discarded';
  if (!settings.enabled) return 'disabled';
  if (tab.incognito) return 'private';
  if (tab.active) return 'active';
  if (tab.pinned) return 'pinned';
  if (tab.audible) return 'audio';
  const shielded = shield?.(tab);
  if (shielded) return shielded;
  if (tab.status !== 'complete' || tab.pendingUrl) return 'loading';
  if (tab.autoDiscardable === false) return 'browser-protected';
  const host = hostname(tab.url);
  if (!host) return 'unsupported';
  if (!settings.allowedHosts.includes(host)) return 'not-allowed';
  if (tab.id === undefined || recent.has(tab.id)) return 'recent';
  const activity = session.activity[String(tab.id)];
  if (!activity || now - activity.idleSince < settings.timeoutMinutes * 60_000) return 'waiting';
  return 'eligible';
}
