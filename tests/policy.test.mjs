import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname, normalizeSettings, newSession, reconcile, reasonFor, recentIds } from '../dist/policy.js';
import { tab } from './helpers.mjs';

const settings = { enabled: true, timeoutMinutes: 15, allowedHosts: ['example.com'] };
function fixture() {
  const session = newSession(1_000_000);
  const tabs = Array.from({ length: 10 }, (_, i) => tab(i + 1));
  reconcile(session, tabs, 1_000_000);
  return { session, tabs, recent: recentIds(session, tabs), now: 1_900_000 };
}

test('host matching is exact; rejects service URLs and malformed input', () => {
  assert.equal(hostname('https://Example.COM:8443/a?q=x'), 'example.com');
  assert.equal(hostname('chrome://extensions'), null);
  assert.equal(hostname('file:///tmp/a'), null);
  assert.equal(hostname('not a url'), null);
  const normalized = normalizeSettings({ enabled: 'yes', timeoutMinutes: 2,
    allowedHosts: ['example.com', 'example.com', '*.example.com', 'a/b', 'foo:30', '', 'Example.COM', 'sub.example.com'] });
  assert.deepEqual(normalized, { enabled: true, timeoutMinutes: 15, allowedHosts: ['example.com', 'sub.example.com'] });
});

test('defaults fail closed: no sites are allowed', () => {
  for (const input of [null, undefined, {}, 'bad']) assert.deepEqual(normalizeSettings(input), {
    enabled: true, timeoutMinutes: 15, allowedHosts: []
  });
});

for (const [patch, expected] of [
  [{ active: true }, 'active'], [{ pinned: true }, 'pinned'], [{ audible: true }, 'audio'],
  [{ audible: true, mutedInfo: { muted: true } }, 'audio'], [{ status: 'loading' }, 'loading'],
  [{ status: undefined }, 'loading'], [{ pendingUrl: 'https://other.test' }, 'loading'],
  [{ discarded: true }, 'discarded'], [{ incognito: true }, 'private'],
  [{ autoDiscardable: false }, 'browser-protected'], [{ url: 'chrome://settings' }, 'unsupported'],
  [{ url: 'https://sub.example.com' }, 'not-allowed'], [{ url: 'https://example.com.evil.test' }, 'not-allowed']
]) {
  test(`protects ${JSON.stringify(patch)} (${expected})`, () => {
    const f = fixture();
    assert.equal(reasonFor(tab(1, patch), settings, f.session, f.recent, f.now), expected);
  });
}

test('protects five most recent tabs across all windows', () => {
  const f = fixture();
  assert.deepEqual([...f.recent], [10, 9, 8, 7, 6]);
  assert.equal(reasonFor(tab(6, { windowId: 2 }), settings, f.session, f.recent, f.now), 'recent');
  assert.equal(reasonFor(tab(5), settings, f.session, f.recent, f.now), 'eligible');
});

test('does not discard before 15 minutes, and does at the boundary', () => {
  const f = fixture();
  assert.equal(reasonFor(tab(1), settings, f.session, f.recent, f.now - 1), 'waiting');
  assert.equal(reasonFor(tab(1), settings, f.session, f.recent, f.now), 'eligible');
  assert.equal(reasonFor(tab(1), { ...settings, enabled: false }, f.session, f.recent, f.now), 'disabled');
});

test('leaving a long-active tab starts a full new idle interval', () => {
  const f = fixture();
  const active = tab(1, { active: true });
  reconcile(f.session, [active], f.now);
  reconcile(f.session, [{ ...active, active: false }], f.now + 300_000);
  assert.equal(f.session.activity['1'].idleSince, f.now + 300_000);
});

test('new native access times recover usage missed during worker sleep', () => {
  const f = fixture();
  f.tabs[0].lastAccessed = f.now;
  reconcile(f.session, f.tabs, f.now);
  assert.equal(f.session.activity['1'].idleSince, f.now);
  assert.equal([...recentIds(f.session, f.tabs)][0], 1);
});

test('closed tabs are removed and private tabs are not tracked', () => {
  const f = fixture();
  reconcile(f.session, [tab(3), tab(11, { incognito: true })], f.now);
  assert.deepEqual(Object.keys(f.session.activity), ['3']);
});
