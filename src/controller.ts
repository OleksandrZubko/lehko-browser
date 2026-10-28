import { DEFAULT_SETTINGS, REASON_LABELS, TIMEOUTS, hostname, newSession, normalizeSettings, reasonFor,
  recentIds, reconcile, validHost, type Session, type Settings, type TimeoutMinutes } from './policy.js';
import type { Protection } from './protection.js';

export interface TabStatus { id: number; title: string; host: string | null; reason: string; }
export interface Status {
  settings: Settings;
  currentHost: string | null;
  session: Pick<Session, 'startedAt' | 'discardedCount' | 'errors' | 'lastSweepAt'>;
  currentlyDiscarded: number;
  tabs: TabStatus[];
}
export type Request = { type: 'status' } | { type: 'settings'; enabled?: boolean; timeoutMinutes?: TimeoutMinutes }
  | { type: 'host'; host: string; allowed: boolean };

export class Controller {
  private tail: Promise<unknown> = Promise.resolve();
  private state?: Session;
  // Events invalidate in-flight decisions immediately, before queued storage work runs.
  private revision = 0;
  private tabRevisions = new Map<number, number>();
  constructor(private api: typeof chrome, private now = () => Date.now(), private protection?: Protection) {}

  invalidate(tabId?: number): void {
    if (tabId === undefined) this.revision++;
    else this.tabRevisions.set(tabId, (this.tabRevisions.get(tabId) ?? 0) + 1);
  }

  private run<T>(task: (session: Session, settings: Settings) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (!this.state) {
        const stored = (await this.api.storage.session.get('session')).session as Session | undefined;
        this.state = stored?.version === 1 ? stored : newSession(this.now());
      }
      const settings = normalizeSettings((await this.api.storage.local.get('settings')).settings);
      await this.protection?.load();
      try { return await task(this.state, settings); }
      finally { await this.api.storage.session.set({ session: this.state }); }
    });
    this.tail = result.catch(() => {});
    return result;
  }

  initialize(): Promise<void> {
    return this.run(async (session, settings) => {
      await this.api.storage.local.set({ settings });
      if (!await this.api.alarms.get('sweep')) await this.api.alarms.create('sweep', { periodInMinutes: 1 });
      reconcile(session, await this.api.tabs.query({}), this.now());
    });
  }

  reset(): Promise<void> {
    this.invalidate();
    return this.run(async () => {
      this.state = newSession(this.now());
      this.tabRevisions.clear();
      reconcile(this.state, await this.api.tabs.query({}), this.now());
    });
  }

  activity(tabId: number, activated: boolean): Promise<void> {
    this.invalidate(activated ? undefined : tabId);
    return this.run(async session => {
      reconcile(session, await this.api.tabs.query({}), this.now());
      const activity = session.activity[String(tabId)];
      if (activity) {
        activity.idleSince = this.now();
        if (activated) activity.order = ++session.sequence;
      }
    });
  }

  removed(tabId: number): Promise<void> {
    this.invalidate(tabId);
    return this.run(async session => { delete session.activity[String(tabId)]; });
  }

  sweep(): Promise<void> {
    return this.run(async (session, settings) => {
      const revision = this.revision;
      const tabRevisions = new Map(this.tabRevisions);
      const tabs = await this.api.tabs.query({});
      reconcile(session, tabs, this.now());
      const recent = recentIds(session, tabs);
      // Oldest first; the recent set is not recomputed after discards to avoid changing the budget mid-sweep.
      const shield = this.protection?.shield;
      const candidates = tabs.filter(tab => reasonFor(tab, settings, session, recent, this.now(), shield) === 'eligible')
        .sort((a, b) => session.activity[String(a.id)]!.order - session.activity[String(b.id)]!.order);
      for (const candidate of candidates) {
        if (revision !== this.revision) break;
        if ((tabRevisions.get(candidate.id!) ?? 0) !== (this.tabRevisions.get(candidate.id!) ?? 0)) continue;
        try {
          const latest = await this.api.tabs.get(candidate.id!);
          if (revision !== this.revision) break;
          if ((tabRevisions.get(candidate.id!) ?? 0) !== (this.tabRevisions.get(candidate.id!) ?? 0)) continue;
          // URL equality also protects a navigation whose event has not arrived yet.
          if (latest.url !== candidate.url || (latest.lastAccessed ?? 0) > (candidate.lastAccessed ?? 0)) continue;
          if (reasonFor(latest, settings, session, recent, this.now(), shield) !== 'eligible') continue;
          if (await this.protection?.dirty(candidate.id!)) continue;
          const result = await this.api.tabs.discard(candidate.id!);
          if (result?.discarded) session.discardedCount++;
        } catch {
          // A tab may close, become active, or be rejected by Chromium. Continue with the others.
          session.errors++;
        }
      }
      session.lastSweepAt = this.now();
    });
  }

  request(message: Request): Promise<Status> {
    if (message.type !== 'status') this.invalidate();
    return this.run(async (session, settings) => {
      if (message.type === 'settings') {
        if (message.enabled !== undefined) {
          if (typeof message.enabled !== 'boolean') throw new Error('Неправильний стан перемикача.');
          settings.enabled = message.enabled;
        }
        if (message.timeoutMinutes !== undefined) {
          if (!TIMEOUTS.includes(message.timeoutMinutes)) throw new Error('Оберіть 15, 30 або 60 хвилин.');
          settings.timeoutMinutes = message.timeoutMinutes;
        }
        // A policy change gives existing tabs a full grace period.
        for (const activity of Object.values(session.activity)) activity.idleSince = this.now();
      } else if (message.type === 'host') {
        if (!validHost(message.host) || typeof message.allowed !== 'boolean') throw new Error('Неправильна адреса сайту.');
        settings.allowedHosts = settings.allowedHosts.filter(host => host !== message.host);
        if (message.allowed) settings.allowedHosts.push(message.host);
        settings.allowedHosts.sort();
        for (const activity of Object.values(session.activity)) activity.idleSince = this.now();
      } else if (message.type !== 'status') throw new Error('Невідома команда.');
      if (message.type !== 'status') await this.api.storage.local.set({ settings });
      const tabs = await this.api.tabs.query({});
      reconcile(session, tabs, this.now());
      const current = (await this.api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      const recent = recentIds(session, tabs);
      return {
        settings: structuredClone(settings), currentHost: current ? hostname(current.url) : null,
        session: { startedAt: session.startedAt, discardedCount: session.discardedCount,
          errors: session.errors, lastSweepAt: session.lastSweepAt },
        currentlyDiscarded: tabs.filter(tab => tab.discarded).length,
        tabs: tabs.filter(tab => tab.id !== undefined && !tab.incognito).map(tab => ({
          id: tab.id!, title: tab.title || 'Без назви', host: hostname(tab.url),
          reason: REASON_LABELS[reasonFor(tab, settings, session, recent, this.now(), this.protection?.shield)]
        }))
      };
    });
  }
}

export { DEFAULT_SETTINGS };
