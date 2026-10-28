import test from 'node:test';
import assert from 'node:assert/strict';
import { Protection, isQaHost } from '../dist/protection.js';
import { qaRules, normalizeSavings } from '../dist/savings.js';
import { newSession, reasonFor } from '../dist/policy.js';
import { tab } from './helpers.mjs';

const SELF = 'p'.repeat(32);

function fixture({ granted = false, dirty = [], qaHosts = [] } = {}) {
  const data = { granted, dirty, scripted: [], savings: { qaHosts } };
  const api = {
    runtime: { id: SELF },
    storage: { local: { async get() { return { savings: data.savings }; } } },
    permissions: { async contains() { return data.granted; } },
    scripting: {
      async executeScript({ target }) {
        data.scripted.push(target.tabId);
        if (target.tabId === 99) return new Promise(() => {}); // a page that never answers
        return [{ result: data.dirty.includes(target.tabId) }];
      }
    }
  };
  return { protection: new Protection(api), data };
}

function port(name, id = SELF) {
  const listeners = [];
  return { name, sender: { id }, onDisconnect: { addListener: fn => listeners.push(fn) }, disconnect: () => listeners.forEach(fn => fn()) };
}

test('local, test and private hosts are QA hosts, including subdomains and user masks', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', 'shop.test', 'printer.local', '10.0.0.5', '192.168.1.20',
    '172.16.0.1', '172.31.255.255', '[::1]', '[fd00::1]']) assert.equal(isQaHost(host), true, host);
  for (const host of ['example.com', 'latest.com', 'local.com', '172.32.0.1', '11.0.0.1', null]) assert.equal(isQaHost(host), false, String(host));
  assert.equal(isQaHost('qa.staging.example.com', ['staging.example.com']), true);
  assert.equal(isQaHost('example.com', ['staging.example.com']), false);
});

test('QA bypass: allow-all frame rules for QA domains and private IPs, none when switched off', () => {
  const rules = qaRules(normalizeSavings({ qaHosts: ['staging.example.com'] }));
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition.requestDomains, ['localhost', '127.0.0.1', 'test', 'local', 'staging.example.com']);
  assert.deepEqual(rules[0].condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.equal(rules.every(rule => rule.action.type === 'allowAllRequests' && rule.priority === 100), true);
  const regex = new RegExp(rules[1].condition.regexFilter);
  assert.equal(regex.test('http://192.168.0.10:8080/app'), true);
  assert.equal(regex.test('https://example.com/?ip=10.0.0.1'), false);
  assert.deepEqual(qaRules(normalizeSavings({ qaBypass: false })), []);
  assert.equal(normalizeSavings({}).qaBypass, true);
  assert.deepEqual(normalizeSavings({ qaHosts: ['bad host', 'staging.example.com'] }).qaHosts, ['staging.example.com']);
});

test('shield keeps DevTools tabs and QA hosts from auto-discard until DevTools close', async () => {
  const f = fixture({ qaHosts: ['staging.example.com'] });
  await f.protection.load();
  const settings = { enabled: true, timeoutMinutes: 15, allowedHosts: ['example.com', 'localhost', 'qa.staging.example.com'] };
  const session = newSession(0);
  const old = { idleSince: 0, order: 1, browserLastAccessed: 0, wasActive: false };
  const reason = t => { session.activity[String(t.id)] = old; return reasonFor(t, settings, session, new Set(), 3_600_000, f.protection.shield); };
  assert.equal(reason(tab(1)), 'eligible');
  assert.equal(reason(tab(2, { url: 'http://localhost:3000/' })), 'qa-host');
  assert.equal(reason(tab(3, { url: 'https://qa.staging.example.com/' })), 'qa-host');
  const devtools = port('devtools:1');
  f.protection.connect(devtools);
  f.protection.connect(port('devtools:1', 'x'.repeat(32))); // foreign sender ignored
  assert.equal(reason(tab(1)), 'devtools');
  devtools.disconnect();
  assert.equal(reason(tab(1)), 'eligible');
  f.data.savings = { qaBypass: false, qaHosts: ['staging.example.com'] };
  await f.protection.load();
  assert.equal(reason(tab(2, { url: 'http://localhost:3000/' })), 'eligible');
});

test('guard: DevTools, audio and dirty forms block closing; forms only with the permission; hung pages time out', async () => {
  const f = fixture({ dirty: [3] });
  f.protection.connect(port('devtools:1'));
  const tabs = [tab(1), tab(2, { audible: true }), tab(3), tab(4), tab(5, { discarded: true })];
  assert.deepEqual((await f.protection.guard(tabs)).map(b => [b.tabId, b.reason]), [[1, 'Відкрито DevTools'], [2, 'Відтворює звук']]);
  assert.deepEqual(f.data.scripted, []);
  f.data.granted = true;
  assert.deepEqual((await f.protection.guard(tabs)).map(b => [b.tabId, b.reason]),
    [[1, 'Відкрито DevTools'], [2, 'Відтворює звук'], [3, 'Незбережені дані у формі']]);
  assert.equal(f.data.scripted.includes(5), false);
  const started = Date.now();
  assert.equal(await f.protection.dirty(99), false);
  assert.ok(Date.now() - started < 3000);
});
