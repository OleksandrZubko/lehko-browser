import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Savings, normalizeSavings, pauseRules, qaRules, cosmeticScript, manuallyDiscardable, isSavingsRequest, COSMETIC_MATCHES,
  VIDEO_MATCHES } from '../dist/savings.js';
import { fakeChrome, tab } from './helpers.mjs';

const DEV = 'a'.repeat(32), OTHER = 'b'.repeat(32), SELF = 'p'.repeat(32);

function fixture({ tabs, granted = false } = {}) {
  const { api, data } = fakeChrome(tabs);
  Object.assign(data, { rulesets: null, dynamic: [], scripts: [], badge: null, granted, created: [],
    extensions: [{ id: DEV, name: 'React Developer Tools', type: 'extension', enabled: true, installType: 'normal' },
      { id: OTHER, name: 'Bitwarden', type: 'extension', enabled: true, installType: 'normal' },
      { id: SELF, name: 'Легко', type: 'extension', enabled: true, installType: 'development' }] });
  Object.assign(api, {
    runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}` },
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
    // `granted`: true for every origin, or the list of granted origin patterns.
    permissions: { async contains({ origins }) { return data.granted === true || (Array.isArray(data.granted) && origins.every(o => data.granted.includes(o))); } },
    management: {
      async getAll() { return structuredClone(data.extensions); },
      async setEnabled(id, enabled) { data.extensions.find(item => item.id === id).enabled = enabled; }
    }
  });
  api.tabs.create = async ({ url }) => { data.created.push(url); };
  return { savings: new Savings(api), data };
}

test('defaults: ads and privacy on, strict frames off, badge counter on', async () => {
  const f = fixture();
  await f.savings.initialize();
  assert.deepEqual(f.data.rulesets, { enableRulesetIds: ['ads', 'privacy'], disableRulesetIds: ['frames'] });
  assert.deepEqual(f.data.badge, { displayActionCountAsBadgeText: true });
  assert.deepEqual(f.data.dynamic, qaRules(normalizeSavings({})));
  assert.equal(f.data.local.savings.noAv1, false);
  assert.equal(f.data.local.savings.cosmetic, true);
  assert.deepEqual(f.data.scripts, []);
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
  f.data.granted = VIDEO_MATCHES;
  await f.savings.initialize();
  assert.deepEqual(f.data.scripts.map(script => script.id), ['no-av1']);
  assert.equal(f.data.scripts[0].world, 'MAIN');
  assert.equal(f.data.scripts[0].runAt, 'document_start');
  await f.savings.request({ type: 'savings', noAv1: false });
  assert.deepEqual(f.data.scripts, []);
});

test('ad-slot hiding registers CSS at document_start only with site access and the ads ruleset on', async () => {
  const f = fixture();
  await f.savings.initialize();
  assert.deepEqual(f.data.scripts, []);
  f.data.granted = COSMETIC_MATCHES;
  const status = await f.savings.request({ type: 'savings-status' });
  assert.equal(status.cosmeticPermission, true);
  await f.savings.initialize();
  assert.equal(f.data.scripts.length, 1);
  const [script] = f.data.scripts;
  assert.deepEqual(script.css, ['cosmetic.css']);
  assert.equal(script.js, undefined);
  assert.equal(script.runAt, 'document_start');
  assert.deepEqual(script.matches, COSMETIC_MATCHES);
  await f.savings.request({ type: 'savings', rulesets: { ads: false } });
  assert.deepEqual(f.data.scripts, []);
  await f.savings.request({ type: 'savings', rulesets: { ads: true } });
  assert.equal(f.data.scripts.length, 1);
  await f.savings.request({ type: 'savings', cosmetic: false });
  assert.deepEqual(f.data.scripts, []);
  assert.equal(f.data.local.savings.cosmetic, false);
  await assert.rejects(f.savings.request({ type: 'savings', cosmetic: 'on' }), /перемикача/);
});

test('ad-slot hiding skips paused sites and, with QA bypass, test hosts; one registration at a time', async () => {
  const f = fixture({ granted: true });
  await f.savings.request({ type: 'savings-pause', host: 'news.example', paused: true });
  await f.savings.request({ type: 'savings-qa', host: 'staging.shop.example', member: true });
  const cosmetic = () => f.data.scripts.filter(script => script.id === 'cosmetic');
  assert.equal(cosmetic().length, 1);
  assert.deepEqual(cosmetic()[0].excludeMatches, ['*://*.news.example/*', '*://*.localhost/*', '*://*.127.0.0.1/*',
    '*://*.test/*', '*://*.local/*', '*://*.staging.shop.example/*']);
  await f.savings.request({ type: 'savings-qa', bypass: false });
  assert.deepEqual(cosmetic()[0].excludeMatches, ['*://*.news.example/*']);
  await f.savings.request({ type: 'savings-pause', host: 'news.example', paused: false });
  assert.equal(cosmetic().length, 1);
  assert.equal(cosmetic()[0].excludeMatches, undefined);
  assert.equal(cosmeticScript(normalizeSavings({ qaBypass: false })).excludeMatches, undefined);
});

test('welcome tab opens once per profile, and only without site access', async () => {
  const f = fixture();
  await f.savings.welcome();
  assert.deepEqual(f.data.created, [`chrome-extension://${SELF}/welcome.html`]);
  await f.savings.welcome();
  assert.equal(f.data.created.length, 1, 'an update or a second install event does not reopen it');
  const granted = fixture({ granted: COSMETIC_MATCHES });
  await granted.savings.welcome();
  assert.deepEqual(granted.data.created, []);
  assert.equal(granted.data.local.welcomed, true);
});

test('welcome page asks for exactly the hiding grant', async () => {
  const html = await readFile(new URL('../dist/welcome.html', import.meta.url), 'utf8');
  for (const id of ['grant', 'later', 'welcome-message']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /src="welcome\.js"/);
  const script = await readFile(new URL('../dist/welcome.js', import.meta.url), 'utf8');
  assert.match(script, /permissions\.request\(\{ origins: COSMETIC_MATCHES \}\)/);
});

test('hiding stylesheet stays small, generic and display-only', async () => {
  const css = (await readFile(new URL('../dist/cosmetic.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  assert.equal(rules.length, 1);
  assert.equal(rules[0][2].trim(), 'display: none !important;');
  const selectors = rules[0][1].split(',').map(selector => selector.trim());
  assert.ok(selectors.length >= 5 && selectors.length <= 20, `${selectors.length} selectors`);
  assert.equal(new Set(selectors).size, selectors.length);
  assert.ok(selectors.includes('.ad-slot'), 'CNN keeps empty .ad-slot elements animating');
  // One class or one custom ad element each: no substring matches, descendants or bare HTML tags.
  for (const selector of selectors) assert.match(selector, /^(\.[A-Za-z][\w-]*|amp-ad)$/, selector);
  const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
  for (const origin of COSMETIC_MATCHES) assert.ok(manifest.optional_host_permissions.includes(origin), origin);
  assert.equal(manifest.host_permissions, undefined, 'site access stays optional');
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
  assert.equal(settings.cosmetic, true);
  assert.equal(normalizeSavings({ cosmetic: false }).cosmetic, false);
  assert.deepEqual(pauseRules(['a.com', 'b.com']).map(rule => rule.id), [1, 2]);
  assert.equal(manuallyDiscardable(tab(1, { incognito: true })), false);
  assert.equal(isSavingsRequest({ type: 'savings-status' }), true);
  assert.equal(isSavingsRequest({ type: 'status' }), false);
});
