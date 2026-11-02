import { Vault, fromB64, newPairing, openPairing, pairingFromCode, randomId, randomSecret, sealPairing, toB64, type SealedRecord } from './sync-crypto.js';
import { unwrapLazy } from './lazy-tab.js';
import { applyRemote, cleanPlain, diffLocal, formatHlc, isSyncableUrl, keyOf, massDeletion, mergeOnJoin, observe, tick,
  type Change, type Clock, type DeviceRecord, type DeviceTab, type FolderData, type Plain, type SendRecord, type Shadow } from './sync-model.js';

export const SYNC_ALARM = 'lehko-sync';
const ALARM_MINUTES = 5;
const DEBOUNCE_MS = 5000;
const FOCUS_THROTTLE_MS = 60_000;
const HEARTBEAT_MS = 3_600_000;
const DEVICE_VISIBLE_MS = 30 * 86_400_000;
const MAX_DEVICE_TABS = 300;
const BATCH = 400;
const MAX_ROUNDS = 200;

// Only what sync needs from Folders: its state stays the single owner of tabs.
export interface FolderStore {
  snapshot(): Promise<FolderData[]>;
  applyRemote(transform: (folders: FolderData[]) => FolderData[], aliases?: Record<string, string>): Promise<void>;
}

interface Held { direction: 'local' | 'remote'; deleted: number; total: number; }
interface SyncState {
  server: string; secret: string; deviceId: string; deviceName: string; invite?: string;
  cursor: number; shadow: Shadow; clock: Clock; joined: boolean; outbox: Change[];
  lastSync?: number; lastError?: string; held?: Held; allowMass?: boolean; skipped?: number;
  linked?: boolean; googleToken?: string;
}
// A signed-in Google session: the wipe reuses its token instead of asking to sign in again.
interface GoogleSession { server: string; token: string; expires: number; }
export interface SyncDevice { id: string; name: string; at: number; tabs: DeviceTab[]; }
export interface SyncStatus {
  enabled: boolean; server?: string; deviceName?: string; lastSync?: number; lastError?: string;
  held?: Held; skipped?: number; devices: SyncDevice[]; code?: string; linked?: boolean;
}
export type SyncRequest = { type: 'sync-status' }
  | { type: 'sync-create'; server: string; invite: string; deviceName: string }
  | { type: 'sync-join'; server: string; code: string; deviceName: string }
  | { type: 'sync-google-login'; server: string; deviceName?: string }
  | { type: 'sync-pair' } | { type: 'sync-now' } | { type: 'sync-confirm' } | { type: 'sync-reject' }
  | { type: 'sync-leave' } | { type: 'sync-wipe' }
  | { type: 'sync-send'; deviceId: string; url: string; title: string }
  | { type: 'sync-open'; url: string };

export function isSyncRequest(message: { type?: unknown }): message is SyncRequest {
  return typeof message.type === 'string' && message.type.startsWith('sync-');
}

function cleanServer(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Некоректна адреса сервера');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Некоректна адреса сервера'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Потрібна адреса https://');
  return url.origin;
}
function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  if (!name) throw new Error('Вкажіть назву пристрою');
  return name;
}

export class Sync {
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFocus = 0;
  private lastRun = 0;
  private wantPull = false;
  private vault: { secret: string; vault: Vault } | undefined;

  constructor(private api: typeof chrome, private folders: FolderStore, private http: typeof fetch = (...args) => fetch(...args),
    private debounce = DEBOUNCE_MS) {}

  private locked<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.catch(() => {});
    return run;
  }

  private async read(): Promise<SyncState | undefined> { return (await this.api.storage.local.get('sync')).sync as SyncState | undefined; }
  private write(state: SyncState): Promise<void> { return this.api.storage.local.set({ sync: state }); }
  private async vaultOf(state: SyncState): Promise<Vault> {
    if (this.vault?.secret !== state.secret) this.vault = { secret: state.secret, vault: await Vault.open(fromB64(state.secret)) };
    return this.vault.vault;
  }

  // ---- transport ----
  private async post(state: SyncState, path: string, method: string, payload: string, extra: Record<string, string> = {}): Promise<unknown> {
    const vault = await this.vaultOf(state);
    const response = await this.http(`${state.server}${path}`, {
      method, body: payload,
      headers: { 'Content-Type': 'application/json', ...await vault.sign(method, path, payload, Date.now()), ...extra }
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Сервер відповів ${response.status}`);
    return data;
  }

  private async exchange(state: SyncState, changes: SealedRecord[], cursor: number) {
    const extra: Record<string, string> = state.invite ? { 'X-Lehko-Invite': state.invite } : state.googleToken ? { 'X-Lehko-Google': state.googleToken } : {};
    return await this.post(state, '/v1/sync', 'POST', JSON.stringify({ cursor, changes }), extra) as
      { changes: SealedRecord[]; cursor: number; more: boolean; reset: boolean };
  }

  // ---- open tabs of this device ----
  private async deviceRecord(state: SyncState): Promise<DeviceRecord> {
    const tabs = await this.api.tabs.query({});
    const real = tabs.map(t => unwrapLazy(t.url || t.pendingUrl) ?? { url: t.url || t.pendingUrl, title: t.title ?? '' });
    const list = real.filter(t => isSyncableUrl(t.url)).slice(0, MAX_DEVICE_TABS)
      .map(t => ({ url: t.url!, title: t.title.slice(0, 120) }));
    return { k: 'device', id: state.deviceId, name: state.deviceName, at: Date.now(), tabs: list };
  }
  private deviceChange(state: SyncState, record: DeviceRecord): Change | undefined {
    const known = state.shadow[keyOf(record)]?.v as DeviceRecord | null | undefined;
    // Titles change constantly while a page runs: only URLs count as a change, titles refresh with the heartbeat.
    const urls = (tabs: DeviceTab[]) => JSON.stringify(tabs.map(t => t.url));
    const same = known && known.name === record.name && urls(known.tabs) === urls(record.tabs);
    if (same && Date.now() - known.at < HEARTBEAT_MS) return undefined;
    return { key: keyOf(record), v: record };
  }

  // ---- one cycle ----
  private async stamp(state: SyncState, vault: Vault, changes: Change[]): Promise<SealedRecord[]> {
    const sealed: SealedRecord[] = [];
    for (const { key, v } of changes) {
      state.clock = tick(state.clock, Date.now());
      const hlc = formatHlc(state.clock, state.deviceId);
      sealed.push(await vault.seal(key, hlc, v));
      state.shadow[key] = { hlc, v };
    }
    return sealed;
  }

  // Applies a downloaded page to `next`; bad records are counted, never applied, and never stop the others.
  private async absorb(state: SyncState, vault: Vault, next: Shadow, records: SealedRecord[]): Promise<void> {
    for (const record of records) {
      try {
        const { logical, value } = await vault.open(record);
        state.clock = observe(state.clock, record.hlc);
        if ((next[logical]?.hlc ?? '') >= record.hlc) continue;
        const plain = value === null ? null : cleanPlain(value);
        if (value !== null && (!plain || keyOf(plain) !== logical)) throw new Error('Некоректний запис');
        next[logical] = { hlc: record.hlc, v: plain };
      } catch { state.skipped = (state.skipped ?? 0) + 1; }
    }
  }

  private async cycle(state: SyncState, pull: boolean): Promise<void> {
    const vault = await this.vaultOf(state);
    // First contact: take the account's data before offering ours, so equal folders merge instead of doubling.
    if (!state.joined) {
      let cursor = state.cursor;
      const remote: Shadow = {};
      for (let round = 0; ; round++) {
        if (round > MAX_ROUNDS) throw new Error('Забагато сторінок');
        const page = await this.exchange(state, [], cursor);
        await this.absorb(state, vault, remote, page.changes);
        cursor = page.cursor;
        if (!page.more) break;
      }
      const local = await this.folders.snapshot();
      const merged = mergeOnJoin(local, remote);
      if (Object.keys(remote).length) await this.folders.applyRemote(() => merged.folders, merged.aliases);
      state.shadow = remote;
      state.cursor = cursor;
      state.joined = true;
      delete state.invite;
      delete state.googleToken;
    }

    const changes = diffLocal(await this.folders.snapshot(), state.shadow, randomId);
    const check = massDeletion(state.shadow, changes.filter(c => !c.v).map(c => c.key));
    if (check.held && !state.allowMass) {
      state.held = { direction: 'local', deleted: check.deleted, total: check.total };
      return;
    }
    const device = this.deviceChange(state, await this.deviceRecord(state));
    const outgoing = [...changes, ...state.outbox, ...(device ? [device] : [])];
    // Page titles rewrite the folders on every load: with nothing to send, the network waits for the next pull.
    if (!outgoing.length && !pull) return;
    state.outbox = [];
    const sealed = await this.stamp(state, vault, outgoing);

    const before = structuredClone(state.shadow);
    const next = structuredClone(state.shadow);
    const incoming: string[] = [];
    let cursor = state.cursor;
    let reset = false;
    const seen = new Set<string>();
    for (let round = 0, sent = 0; ; round++) {
      if (round > MAX_ROUNDS) throw new Error('Забагато сторінок');
      const batch = sealed.slice(sent, sent + BATCH);
      sent += batch.length;
      const page = await this.exchange(state, batch, cursor);
      reset ||= page.reset;
      const previous = structuredClone(next);
      await this.absorb(state, vault, next, page.changes);
      for (const key of Object.keys(next)) if (next[key]!.hlc !== previous[key]?.hlc) incoming.push(key);
      if (reset) for (const record of page.changes) seen.add(record.id);
      cursor = page.cursor;
      if (!page.more && sent >= sealed.length) break;
    }
    // The server forgot tombstones older than our cursor: whatever it no longer returns is gone.
    if (reset) {
      for (const key of Object.keys(next)) {
        if (!seen.has(await vault.serverId(key))) { next[key] = { hlc: next[key]!.hlc, v: null }; incoming.push(key); }
      }
    }

    const remoteCheck = massDeletion(before, incoming.filter(key => !next[key]?.v));
    if (remoteCheck.held && !state.allowMass) {
      state.held = { direction: 'remote', deleted: remoteCheck.deleted, total: remoteCheck.total };
      state.shadow = before;
      return;
    }
    delete state.allowMass;
    delete state.held;

    const touched = incoming.some(key => key.startsWith('folder:') || key.startsWith('tab:'));
    if (touched) await this.folders.applyRemote(folders => applyRemote(folders, before, next));
    state.shadow = next;
    state.cursor = cursor;
    await this.deliver(state, incoming);
    state.lastSync = Date.now();
  }

  // Sent tabs: progress is saved before opening, so a crash can lose a delivery but cannot reopen it on every start.
  private async deliver(state: SyncState, incoming: string[]): Promise<void> {
    const mine: SendRecord[] = [];
    for (const key of incoming) {
      const v = state.shadow[key]?.v as Plain | null | undefined;
      if (v?.k === 'send' && v.to === state.deviceId) { mine.push(v); state.outbox.push({ key, v: null }); }
    }
    if (!mine.length) return;
    await this.write(state);
    for (const send of mine) await this.api.tabs.create({ url: send.url, active: false }).catch(() => {});
  }

  run(pull = true): Promise<void> {
    this.wantPull ||= pull;
    return this.locked(async () => {
      const state = await this.read();
      if (!state) return;
      const wanted = this.wantPull;
      this.wantPull = false;
      // Work on a copy: a failed cycle leaves the stored shadow and cursor as they were, and is simply redone.
      const work = structuredClone(state);
      this.lastRun = Date.now();
      try {
        await this.cycle(work, wanted);
        delete work.lastError;
        await this.write(work);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : 'Синхронізація не виконана';
        await this.write(state);
      }
    });
  }

  // ---- triggers: never a persistent connection, so the worker can sleep ----
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.run(false).catch(() => {}); }, this.debounce);
  }
  focused(): void {
    const now = Date.now();
    if (now - this.lastFocus < FOCUS_THROTTLE_MS || now - this.lastRun < FOCUS_THROTTLE_MS) return;
    this.lastFocus = now;
    this.wantPull = true;
    this.schedule();
  }
  async init(): Promise<void> {
    if (!await this.read()) return;
    await this.api.alarms.create(SYNC_ALARM, { periodInMinutes: ALARM_MINUTES });
    this.wantPull = true;
    this.schedule();
  }

  // ---- popup ----
  private async status(code?: string): Promise<SyncStatus> {
    const state = await this.read();
    if (!state) return { enabled: false, devices: [] };
    const devices = Object.values(state.shadow).flatMap(item => {
      const v = item.v;
      if (v?.k !== 'device' || v.id === state.deviceId || Date.now() - v.at > DEVICE_VISIBLE_MS) return [];
      return [{ id: v.id, name: v.name, at: v.at, tabs: v.tabs }];
    }).sort((a, b) => b.at - a.at);
    return { enabled: true, server: state.server, deviceName: state.deviceName, devices, ...(state.linked ? { linked: true } : {}),
      ...(state.lastSync ? { lastSync: state.lastSync } : {}), ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(state.held ? { held: state.held } : {}), ...(state.skipped ? { skipped: state.skipped } : {}), ...(code ? { code } : {}) };
  }

  private fresh(server: string, secret: Uint8Array, deviceName: string, joined: boolean, invite?: string): SyncState {
    return { server, secret: toB64(secret), deviceId: randomId(), deviceName, cursor: 0, shadow: {}, clock: { ms: 0, counter: 0 },
      joined, outbox: [], ...(invite ? { invite } : {}) };
  }

  // ---- Google: the sign-in alone gets the account secret from the server ----
  private async googleSession(): Promise<GoogleSession | undefined> {
    const { syncGoogle } = await this.api.storage.session.get('syncGoogle') as { syncGoogle?: GoogleSession };
    if (!syncGoogle) return undefined;
    if (syncGoogle.expires > Date.now()) return syncGoogle;
    await this.api.storage.session.remove('syncGoogle');
    return undefined;
  }

  private async identity(server: string, token: string, op: 'claim' | 'delete', secret?: string): Promise<{ secret?: string }> {
    const response = await this.http(`${server}/v1/identity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, op, ...(secret ? { secret } : {}) })
    });
    const data = await response.json().catch(() => ({})) as { secret?: string; error?: string };
    if (!response.ok) throw new Error(data.error ?? `Сервер відповів ${response.status}`);
    return data;
  }

  private async googleSignIn(server: string): Promise<GoogleSession> {
    const state = randomId(), nonce = randomId();
    const start = new URL(`${server}/v1/google/start`);
    for (const [name, value] of Object.entries({ redirect: this.api.identity.getRedirectURL(), state, nonce })) start.searchParams.set(name, value);
    const redirected = await this.api.identity.launchWebAuthFlow({ url: start.toString(), interactive: true });
    if (!redirected) throw new Error('Вхід скасовано');
    const answer = new URLSearchParams(new URL(redirected).hash.slice(1));
    if (answer.get('state') !== state) throw new Error('Відповідь входу не збігається із запитом');
    const token = answer.get('id_token');
    if (!token) throw new Error('Вхід скасовано');
    const claims = JSON.parse(new TextDecoder().decode(fromB64(token.split('.')[1] ?? ''))) as { nonce?: string; exp?: number };
    if (claims.nonce !== nonce) throw new Error('Відповідь входу не збігається із запитом');
    const session: GoogleSession = { server, token, expires: (claims.exp ?? 0) * 1000 };
    await this.api.storage.session.set({ syncGoogle: session });
    return session;
  }

  private async start(state: SyncState): Promise<void> {
    await this.write(state);
    await this.api.alarms.create(SYNC_ALARM, { periodInMinutes: ALARM_MINUTES });
  }

  async request(message: SyncRequest): Promise<SyncStatus> {
    switch (message.type) {
      case 'sync-status': return this.status();
      case 'sync-create': {
        if (await this.read()) throw new Error('Синхронізацію вже ввімкнено');
        const invite = typeof message.invite === 'string' ? message.invite.trim() : '';
        if (!invite) throw new Error('Вкажіть інвайт-код');
        await this.start(this.fresh(cleanServer(message.server), randomSecret(), cleanName(message.deviceName), false, invite));
        await this.run();
        const state = await this.read();
        if (state?.lastError && !state.lastSync) { const failed = state.lastError; await this.stop(); throw new Error(failed); }
        return this.status();
      }
      case 'sync-join': {
        if (await this.read()) throw new Error('Синхронізацію вже ввімкнено');
        const server = cleanServer(message.server);
        const pair = await pairingFromCode(String(message.code ?? ''));
        const response = await this.http(`${server}/v1/pair/${pair.channel}`, { method: 'GET' });
        const data = await response.json().catch(() => ({})) as { blob?: string };
        if (!response.ok || !data.blob) throw new Error('Код не знайдено або він застарів');
        const secret = await openPairing(pair, data.blob);
        await this.start(this.fresh(server, secret, cleanName(message.deviceName), false));
        await this.run();
        return this.status();
      }
      // Google is the only lock: the server keeps the account secret and hands it to this account's every sign-in.
      case 'sync-google-login': {
        const current = await this.read();
        const server = current?.server ?? cleanServer(message.server);
        const { token } = await this.googleSignIn(server);
        const { secret } = await this.identity(server, token, 'claim', current?.secret ?? toB64(randomSecret()));
        if (!secret) throw new Error('Сервер не повернув ключ');
        if (current) {
          if (secret !== current.secret) throw new Error('Цей акаунт Google уже має інші дані. Вийдіть на цьому пристрої й увійдіть знову.');
          await this.locked(async () => {
            const state = await this.read();
            if (state) { state.linked = true; await this.write(state); }
          });
        } else {
          const state = this.fresh(server, fromB64(secret), cleanName(message.deviceName), false);
          state.googleToken = token;
          state.linked = true;
          await this.start(state);
          await this.run();
          const started = await this.read();
          if (started?.lastError && !started.lastSync) { const failed = started.lastError; await this.stop(); throw new Error(failed); }
        }
        await this.api.action.openPopup?.().catch(() => {}); // the sign-in window closed the popup
        return this.status();
      }
      case 'sync-pair': {
        const state = await this.read();
        if (!state) throw new Error('Синхронізацію не ввімкнено');
        const pair = await newPairing();
        await this.post(state, `/v1/pair/${pair.channel}`, 'PUT', await sealPairing(pair, fromB64(state.secret)));
        return this.status(pair.code);
      }
      case 'sync-now': await this.run(); return this.status();
      case 'sync-confirm':
      case 'sync-reject': {
        await this.locked(async () => {
          const state = await this.read();
          if (!state?.held) return;
          delete state.held;
          if (message.type === 'sync-confirm') state.allowMass = true;
          await this.write(state);
        });
        if (message.type === 'sync-confirm') await this.run();
        return this.status();
      }
      case 'sync-leave': await this.stop(); return this.status();
      case 'sync-wipe': {
        const state = await this.read();
        if (!state) throw new Error('Синхронізацію не ввімкнено');
        // The stored key goes too, or the next sign-in would open an account that no longer exists.
        const session = state.linked ? await this.googleSession() ?? await this.googleSignIn(state.server) : undefined;
        await this.post(state, '/v1/wipe', 'POST', '{}');
        if (session) await this.identity(state.server, session.token, 'delete');
        await this.api.storage.session.remove('syncGoogle');
        await this.stop();
        return this.status();
      }
      case 'sync-send': {
        if (!isSyncableUrl(message.url)) throw new Error('Цю вкладку не можна надіслати');
        await this.locked(async () => {
          const state = await this.read();
          if (!state) throw new Error('Синхронізацію не ввімкнено');
          const v: SendRecord = { k: 'send', id: randomId(), to: String(message.deviceId), from: state.deviceName, url: message.url, title: String(message.title ?? '').slice(0, 300) };
          state.outbox.push({ key: keyOf(v), v });
          await this.write(state);
        });
        await this.run();
        return this.status();
      }
      case 'sync-open': {
        if (!isSyncableUrl(message.url)) throw new Error('Цю адресу не можна відкрити');
        await this.api.tabs.create({ url: message.url });
        return this.status();
      }
      default: throw new Error('Невідома команда.');
    }
  }

  private async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.vault = undefined;
    await this.api.alarms.clear(SYNC_ALARM);
    await this.api.storage.local.remove('sync');
  }
}
