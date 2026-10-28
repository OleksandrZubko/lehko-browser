import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../dist/controller.js';
import { fakeChrome, tab } from './helpers.mjs';

async function fixture() {
  const { api, data } = fakeChrome();
  let now = 1_000_000;
  const controller = new Controller(api, () => now);
  await controller.initialize();
  await controller.request({ type: 'host', host: 'example.com', allowed: true });
  return { controller, api, data, advance: (ms = 900_000) => { now += ms; }, now: () => now };
}

test('installs default settings and a single one-minute alarm', async () => {
  const f = await fixture();
  await f.controller.initialize();
  assert.deepEqual(f.data.alarms, { sweep: { periodInMinutes: 1 } });
  assert.equal(f.data.local.settings.timeoutMinutes, 15);
});

test('only discards allowed old tabs, oldest first; preserves five recent tabs', async () => {
  const f = await fixture();
  await f.controller.sweep();
  assert.deepEqual(f.data.calls, []);
  f.advance();
  await f.controller.sweep();
  assert.deepEqual(f.data.calls, [1, 2, 3, 4, 5]);
  const status = await f.controller.request({ type: 'status' });
  assert.equal(status.session.discardedCount, 5);
  assert.equal(status.currentlyDiscarded, 5);
  await f.controller.sweep();
  assert.equal(f.data.calls.length, 5);
});

test('active tabs in every window are protected', async () => {
  const f = await fixture();
  f.data.tabs[0].active = true;
  f.data.tabs[1].active = true;
  f.data.tabs[1].windowId = 2;
  f.advance();
  await f.controller.sweep();
  assert.deepEqual(f.data.calls, [3, 4, 5]);
});

test('a change to active/pinned/url/access time immediately before discard is rechecked', async () => {
  for (const patch of [{ active: true }, { pinned: true }, { audible: true }, { url: 'https://other.test' },
    { status: 'loading' }, { lastAccessed: 9_000_000 }]) {
    const f = await fixture();
    f.data.getHook = id => { if (id === 1) Object.assign(f.data.tabs[0], patch); };
    f.advance();
    await f.controller.sweep();
    assert.ok(!f.data.calls.includes(1), JSON.stringify(patch));
    assert.ok(f.data.calls.includes(2));
  }
});

test('in-flight activity invalidates an entire sweep before discard', async () => {
  const f = await fixture();
  f.advance();
  f.data.getHook = () => f.controller.invalidate();
  await f.controller.sweep();
  assert.deepEqual(f.data.calls, []);
});

test('Chromium replacement events from a discard do not cancel other candidates', async () => {
  const f = await fixture();
  f.advance();
  f.data.discardHook = id => {
    // Chrome may replace the discarded WebContents and emit onReplaced during tabs.discard.
    void f.controller.removed(id);
    void f.controller.activity(id + 100, false);
  };
  await f.controller.sweep();
  await f.controller.request({ type: 'status' });
  assert.deepEqual(f.data.calls, [1, 2, 3, 4, 5]);
  assert.equal(f.data.session.session.discardedCount, 5);
});

test('a navigation invalidates only its own candidate during a sweep', async () => {
  const f = await fixture();
  f.advance();
  f.data.getHook = id => { if (id === 1) f.controller.invalidate(id); };
  await f.controller.sweep();
  assert.deepEqual(f.data.calls, [2, 3, 4, 5]);
});

test('closed or rejected tabs do not stop other candidates', async () => {
  const f = await fixture();
  f.advance();
  f.data.getHook = id => { if (id === 1) throw new Error('closed'); };
  f.data.discardHook = id => { if (id === 2) throw new Error('protected'); };
  await f.controller.sweep();
  assert.deepEqual(f.data.calls, [2, 3, 4, 5]);
  assert.equal(f.data.session.session.discardedCount, 3);
  assert.equal(f.data.session.session.errors, 2);
});

test('worker recreation preserves timers and counters from session storage', async () => {
  const f = await fixture();
  f.advance(500_000);
  const replacement = new Controller(f.api, f.now);
  await replacement.initialize();
  f.advance(400_000);
  await replacement.sweep();
  assert.equal(f.data.calls.length, 5);
  const third = new Controller(f.api, f.now);
  assert.equal((await third.request({ type: 'status' })).session.discardedCount, 5);
});

test('browser restart resets timers and session counters, preserving local settings', async () => {
  const f = await fixture();
  f.advance();
  await f.controller.sweep();
  for (const t of f.data.tabs) t.discarded = false;
  f.data.session = {};
  const replacement = new Controller(f.api, f.now);
  await replacement.reset();
  await replacement.initialize();
  await replacement.sweep();
  const status = await replacement.request({ type: 'status' });
  assert.equal(status.session.discardedCount, 0);
  assert.deepEqual(status.settings.allowedHosts, ['example.com']);
  assert.equal(f.data.calls.length, 5);
});

test('pause and removing host permission immediately stop future discards', async () => {
  for (const request of [{ type: 'settings', enabled: false }, { type: 'host', host: 'example.com', allowed: false }]) {
    const f = await fixture();
    f.advance();
    await f.controller.request(request);
    await f.controller.sweep();
    assert.deepEqual(f.data.calls, []);
  }
});

test('settings changes give a full grace period; invalid input cannot enable unknown policies', async () => {
  const f = await fixture();
  f.advance();
  await f.controller.request({ type: 'settings', timeoutMinutes: 30 });
  f.advance(1_799_999);
  await f.controller.sweep();
  assert.equal(f.data.calls.length, 0);
  f.advance(1);
  await f.controller.sweep();
  assert.equal(f.data.calls.length, 5);
  await assert.rejects(f.controller.request({ type: 'host', host: '*.example.com', allowed: true }));
  await assert.rejects(f.controller.request({ type: 'settings', timeoutMinutes: 1 }));
  await assert.rejects(f.controller.request({ type: 'unknown' }));
});

test('activation and navigation reset idle tracking', async () => {
  const f = await fixture();
  f.advance();
  await f.controller.activity(1, true);
  await f.controller.activity(2, false);
  await f.controller.sweep();
  assert.ok(!f.data.calls.includes(1));
  assert.ok(!f.data.calls.includes(2));
  assert.ok(f.data.calls.includes(3));
});

test('simultaneous sweeps serialize and do not double count', async () => {
  const f = await fixture();
  f.advance();
  await Promise.all([f.controller.sweep(), f.controller.sweep(), f.controller.request({ type: 'status' })]);
  assert.equal(f.data.calls.length, 5);
  assert.equal(f.data.session.session.discardedCount, 5);
});

test('only five eligible normal tabs means no automatic discards', async () => {
  const { api, data } = fakeChrome(Array.from({ length: 5 }, (_, i) => tab(i + 1)));
  let now = 100;
  const c = new Controller(api, () => now);
  await c.initialize();
  await c.request({ type: 'host', host: 'example.com', allowed: true });
  now += 999_999;
  await c.sweep();
  assert.equal(data.calls.length, 0);
});
