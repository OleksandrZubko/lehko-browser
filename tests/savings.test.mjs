import test from 'node:test';
import assert from 'node:assert/strict';
import { Savings, normalizeSavings, pauseRules, qaRules, manuallyDiscardable, isSavingsRequest } from '../dist/savings.js';
import { fakeChrome, tab } from './helpers.mjs';

const DEV = 'a'.repeat(32), OTHER = 'b'.repeat(32), SELF = 'p'.repeat(32);

function fixture({ tabs, granted = false } = {}) {
  const { api, data } = fakeChrome(tabs);
  Object.assign(data, { rulesets: null, dynamic: [], scripts: [], badge: null, granted,
    extensions: [{ id: DEV, name: 'React Developer Tools', type: 'extension', enabled: true, installType: 'normal' },
      { id: OTHER, name: 'Bitwarden', type: 'extension', enabled: true, installType: 'normal' },
      { id: SELF, name: 'Легко', type: 'extension', enabled: true, installType: 'development' }] });
  Object.assign(api, {
    runtime: { id: SELF },
    declarativeNetRequest: {
      async updateEnabledRulesets(options) { data.rulesets = options; },
      async getDynamicRules() { return structuredClone(data.dynamic); },
      async updateDynamicRules({ removeRuleIds, addRules }) {
        data.dynamic = data.dynamic.filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules);
      },
      async setExtensionActionOptions(options) { data.badge = options; }
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) { return data.scripts.filter(script => ids.includes(script.id)); },
      async registerContentScripts(scripts) { data.scripts.push(...scripts); },
      async unregisterContentScripts({ ids }) { data.scripts = data.scripts.filter(script => !ids.includes(script.id)); }
    },
    permissions: { async contains() { return data.granted; } },
    management: {
      async getAll() { return structuredClone(data.extensions); },
      async setEnabled(id, enabled) { data.extensions.find(item => item.id === id).enabled = enabled; }
    }
  });
  return { savings: new Savings(api), data };
}

test('defaults: ads and privacy on, strict frames off, badge counter on', async () => {
  const f = fixture();
  await f.savings.initialize();
  assert.deepEqual(f.data.rulesets, { enableRulesetIds: ['ads', 'privacy'], disableRulesetIds: ['frames'] });
  assert.deepEqual(f.data.badge, { displayActionCountAsBadgeText: true });
  assert.deepEqual(f.data.dynamic, qaRules(normalizeSavings({})));
  assert.equal(f.data.local.savings.noAv1, false);
});

test('toggles a ruleset and persists it', async () => {
  const f = fixture();
  const status = await f.savings.request({ type: 'savings', rulesets: { frames: true, ads: false } });
  assert.deepEqual(f.data.rulesets, { enableRulesetIds: ['privacy', 'frames'], disableRulesetIds: ['ads'] });
  assert.equal(status.settings.rulesets.frames, true);
  await assert.rejects(f.savings.request({ type: 'savings', rulesets: { dns: true } }), /Невідомий набір/);
});

test('pausing a site adds one allowAllRequests rule above static rules; resuming removes it', async () => {
  const f = fixture();
  await f.savings.request({ type: 'savings-qa', bypass: false });
  await f.savings.request({ type: 'savings-pause', host: 'news.example', paused: true });
  assert.equal(f.data.dynamic.length, 1);
  assert.equal(f.data.dynamic[0].action.type, 'allowAllRequests');
  assert.deepEqual(f.data.dynamic[0].condition, { requestDomains: ['news.example'], resourceTypes: ['main_frame'] });
  assert.ok(f.data.dynamic[0].priority > 4);
  await f.savings.request({ type: 'savings-pause', host: 'news.example', paused: false });
  assert.deepEqual(f.data.dynamic, []);
  await assert.rejects(f.savings.request({ type: 'savings-pause', host: 'bad host', paused: true }), /адреса/);
});

test('AV1 script registers only with the YouTube grant and unregisters when off', async () => {
  const f = fixture();
  await f.savings.request({ type: 'savings', noAv1: true });
  assert.deepEqual(f.data.scripts, []);
  f.data.granted = true;
  await f.savings.initialize();
  assert.equal(f.data.scripts.length, 1);
  assert.equal(f.data.scripts[0].world, 'MAIN');
  assert.equal(f.data.scripts[0].runAt, 'document_start');
  await f.savings.request({ type: 'savings', noAv1: false });
  assert.deepEqual(f.data.scripts, []);
});

test('dev set toggles only marked extensions and never itself', async () => {
  const f = fixture();
  await f.savings.request({ type: 'savings-dev-set', id: DEV, member: true });
  const status = await f.savings.request({ type: 'savings', devActive: false });
  assert.equal(f.data.extensions.find(item => item.id === DEV).enabled, false);
  assert.equal(f.data.extensions.find(item => item.id === OTHER).enabled, true);
  assert.deepEqual(status.extensions.map(item => item.name), ['Bitwarden', 'React Developer Tools']);
  await f.savings.request({ type: 'savings', devActive: true });
  assert.equal(f.data.extensions.find(item => item.id === DEV).enabled, true);
  await assert.rejects(f.savings.request({ type: 'savings-dev-set', id: SELF, member: true }), /розширення/);
});

test('manual discard skips active, pinned, audible, protected, loading and service tabs', async () => {
  const tabs = [tab(1, { active: true }), tab(2, { pinned: true }), tab(3, { audible: true }), tab(4, { autoDiscardable: false }),
    tab(5, { status: 'loading' }), tab(6, { url: 'chrome://settings' }), tab(7), tab(8)];
  const f = fixture({ tabs });
  const status = await f.savings.request({ type: 'savings-discard-others' });
  assert.deepEqual(f.data.calls, [7, 8]);
  assert.equal(status.discarded, 2);
});

test('normalizes stored settings and routes only savings messages', () => {
  const settings = normalizeSavings({ rulesets: { ads: false, x: true }, pausedHosts: ['a.com', 'a.com', '*'], devSet: ['bad', DEV], noAv1: 'yes' });
  assert.deepEqual(settings.rulesets, { ads: false, privacy: true, frames: false });
  assert.deepEqual(settings.pausedHosts, ['a.com']);
  assert.deepEqual(settings.devSet, [DEV]);
  assert.equal(settings.noAv1, false);
  assert.deepEqual(pauseRules(['a.com', 'b.com']).map(rule => rule.id), [1, 2]);
  assert.equal(manuallyDiscardable(tab(1, { incognito: true })), false);
  assert.equal(isSavingsRequest({ type: 'savings-status' }), true);
  assert.equal(isSavingsRequest({ type: 'status' }), false);
});
