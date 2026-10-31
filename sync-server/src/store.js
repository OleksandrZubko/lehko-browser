// Storage of one sync account: opaque records ordered by a monotonic seq. The server never merges content;
// it only keeps the record with the highest HLC, so every client converges on the same value.
export const LIMITS = {
  maxChanges: 500,
  maxRecordChars: 90_000,
  maxAccountChars: 50_000_000,
  maxAccountRecords: 20_000,
  pagePerPull: 500,
  pageChars: 1_500_000,
  tombstoneMs: 90 * 86_400_000,
  pruneEveryMs: 86_400_000
};

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const HLC = /^\d{15}\.\d{6}\.[A-Za-z0-9_-]{8,32}$/;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function checkChange(change) {
  if (!change || typeof change !== 'object' || !ID.test(change.id ?? '') || !HLC.test(change.hlc ?? '') ||
    typeof change.data !== 'string' || !change.data || change.data.length > LIMITS.maxRecordChars ||
    typeof change.deleted !== 'boolean') throw new HttpError(400, 'Invalid change');
}

export class AccountStore {
  // sql.exec(query, ...binds) returns an object with toArray(), like Durable Object SQLite.
  constructor(sql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hlc TEXT NOT NULL,
      data TEXT NOT NULL, deleted INTEGER NOT NULL, at INTEGER NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS records_seq ON records (seq)`);
  }

  get(key) { return this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]?.value ?? 0; }
  set(key, value) { this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value); }
  exists() { return this.get('created') !== 0; }

  commit(changes, now) {
    if (!Array.isArray(changes) || changes.length > LIMITS.maxChanges) throw new HttpError(400, 'Invalid changes');
    changes.forEach(checkChange);
    let seq = this.get('seq'), chars = this.get('chars'), count = this.get('count');
    for (const { id, hlc, data, deleted } of changes) {
      const old = this.sql.exec(`SELECT hlc, length(data) AS size FROM records WHERE id = ?`, id).toArray()[0];
      if (old && old.hlc >= hlc) continue;
      chars += data.length - (old?.size ?? 0);
      if (!old) count++;
      if (chars > LIMITS.maxAccountChars || count > LIMITS.maxAccountRecords) throw new HttpError(413, 'Account quota exceeded');
      seq++;
      this.sql.exec(`INSERT INTO records (id, seq, hlc, data, deleted, at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hlc = excluded.hlc, data = excluded.data, deleted = excluded.deleted, at = excluded.at`,
      id, seq, hlc, data, deleted ? 1 : 0, now);
    }
    this.set('seq', seq);
    this.set('chars', chars);
    this.set('count', count);
  }

  // Tombstones older than the window disappear; a client behind them must rebuild from zero (reset).
  prune(now) {
    if (now - this.get('pruned_at') < LIMITS.pruneEveryMs) return;
    this.set('pruned_at', now);
    const cutoff = now - LIMITS.tombstoneMs;
    const [gone] = this.sql.exec(`SELECT max(seq) AS seq, count(*) AS count, coalesce(sum(length(data)), 0) AS chars
      FROM records WHERE deleted = 1 AND at < ?`, cutoff).toArray();
    if (!gone?.count) return;
    this.sql.exec(`DELETE FROM records WHERE deleted = 1 AND at < ?`, cutoff);
    this.set('pruned_seq', Math.max(this.get('pruned_seq'), gone.seq));
    this.set('chars', this.get('chars') - gone.chars);
    this.set('count', this.get('count') - gone.count);
  }

  pull(cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, 'Invalid cursor');
    const reset = cursor > 0 && cursor < this.get('pruned_seq');
    const from = reset ? 0 : cursor;
    const rows = this.sql.exec(`SELECT id, seq, hlc, data, deleted FROM records WHERE seq > ? ORDER BY seq LIMIT ?`,
      from, LIMITS.pagePerPull + 1).toArray();
    const page = [];
    let chars = 0;
    for (const row of rows.slice(0, LIMITS.pagePerPull)) {
      chars += row.data.length;
      if (page.length && chars > LIMITS.pageChars) break;
      page.push({ id: row.id, seq: row.seq, hlc: row.hlc, data: row.data, deleted: row.deleted === 1 });
    }
    return { changes: page, cursor: page.at(-1)?.seq ?? from, more: page.length < rows.length, reset };
  }

  sync({ cursor, changes = [] }, now, { inviteOk = false } = {}) {
    if (!this.exists()) {
      if (!inviteOk) throw new HttpError(403, 'Invite required');
      this.set('created', now);
    }
    this.commit(changes, now);
    this.prune(now);
    return this.pull(cursor);
  }
}
