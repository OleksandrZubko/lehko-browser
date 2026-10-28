import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../scripts/lib/abp-to-dnr.mjs';

const one = (line) => { const { rules } = convert(line); assert.equal(rules.length, 1, line); return rules[0]; };

test('pure domain filters with equal options merge into one sorted, deduped rule', () => {
  const { rules, stats } = convert('||b.com^\n||a.com^\n||B.com^\n||c.org^$third-party\n||d.org^$third-party');
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition.requestDomains, ['a.com', 'b.com']);
  assert.equal(rules[0].condition.urlFilter, undefined);
  assert.deepEqual(rules[1].condition.requestDomains, ['c.org', 'd.org']);
  assert.equal(rules[1].condition.domainType, 'thirdParty');
  assert.equal(stats.converted, 5);
  assert.equal(stats.duplicates, 1);
});

test('merged domain rules are chunked', () => {
  const text = Array.from({ length: 5001 }, (_, i) => `||d${String(i).padStart(5, '0')}.com^`).join('\n');
  const { rules } = convert(text);
  assert.deepEqual(rules.map(r => r.condition.requestDomains.length), [5000, 1]);
});

test('non-domain rules are deduped; non-pure domain filters stay urlFilter rules', () => {
  const { rules } = convert('/ads/*\n/ads/\n||x.com/ads^\n||x.com/ads^');
  assert.deepEqual(rules.map(r => r.condition.urlFilter), ['/ads/', '||x.com/ads^']);
  const r = one('||x.com^*');
  assert.deepEqual(r.condition.requestDomains, ['x.com']);
});

test('anchors and trailing wildcard noise map to urlFilter', () => {
  assert.equal(one('|https://a.com/x|').condition.urlFilter, '|https://a.com/x|');
  assert.equal(one('*banner*').condition.urlFilter, 'banner');
  assert.equal(one('/ad*frame^*').condition.urlFilter, '/ad*frame^');
});

test('exceptions become higher priority allow rules; important blocks beat them', () => {
  const [block, allow, important, importantAllow] = convert('/x.js\n@@/x.js\n/x.js$important\n@@/x.js$important').rules;
  assert.deepEqual([block.action.type, allow.action.type, important.action.type, importantAllow.action.type], ['block', 'allow', 'block', 'allow']);
  assert.ok(allow.priority > block.priority);
  assert.ok(important.priority > allow.priority);
  assert.ok(importantAllow.priority > important.priority);
});

test('third-party options map to domainType', () => {
  assert.equal(one('/x$third-party').condition.domainType, 'thirdParty');
  assert.equal(one('/x$3p').condition.domainType, 'thirdParty');
  assert.equal(one('/x$~third-party').condition.domainType, 'firstParty');
  assert.equal(one('/x').condition.domainType, undefined);
});

test('resource types and negated types', () => {
  assert.deepEqual(one('/x$script,xhr,css,subdocument').condition.resourceTypes, ['script', 'stylesheet', 'sub_frame', 'xmlhttprequest']);
  const neg = one('/x$~image,~media').condition;
  assert.deepEqual(neg.excludedResourceTypes, ['image', 'media']);
  assert.equal(neg.resourceTypes, undefined);
  assert.equal(one('/x').condition.resourceTypes, undefined);
  assert.equal(one('/x').condition.excludedResourceTypes, undefined);
  assert.deepEqual(one('/x$script,image,~image').condition.resourceTypes, ['script']);
});

test('domain= maps to initiator domains, lowercased and punycoded', () => {
  const c = one('/x$domain=A.com|~b.com|bücher.de|~sub.c.org').condition;
  assert.deepEqual(c.initiatorDomains, ['a.com', 'xn--bcher-kva.de']);
  assert.deepEqual(c.excludedInitiatorDomains, ['b.com', 'sub.c.org']);
  assert.deepEqual(one('/x$domain=~a.com').condition.excludedInitiatorDomains, ['a.com']);
});

test('match-case sets case sensitivity, default is explicitly false', () => {
  assert.equal(one('/Ad$match-case').condition.isUrlFilterCaseSensitive, true);
  assert.equal(one('/Ad').condition.isUrlFilterCaseSensitive, false);
  assert.equal(one('||a.com^').condition.isUrlFilterCaseSensitive, false);
});

test('empty pattern needs initiator domains', () => {
  const r = one('$script,domain=a.com');
  assert.equal(r.condition.urlFilter, undefined);
  assert.deepEqual(r.condition.initiatorDomains, ['a.com']);
  assert.equal(convert('$script').stats.skipped['too-broad'], 1);
});

test('skips cosmetic, regex, comments, unsupported options', () => {
  const text = [
    '[Adblock Plus 2.0]', '! comment', '',
    'example.com##.ad', 'example.com#@#.ad', 'example.com#?#div:has(.ad)', 'example.com#$#body{x:y}', 'example.com#%#//scriptlet("x")', '##.banner',
    '/banner\\d+/', '@@/ads?/$script',
    '||a.com^$popup', '||a.com^$document', '@@||a.com^$elemhide', '||a.com^$redirect=noopjs', '||a.com^$removeparam=x', '||a.com^$csp=script-src',
    '||a.com^$badfilter', '||a.com^$all', '||a.com^$bogus', '||a.com^$script,header=x', '||a.com^$domain=*.b.*',
    '||ok.com^'
  ].join('\n');
  const { rules, stats } = convert(text);
  assert.equal(rules.length, 1);
  assert.equal(stats.lines, 23);
  assert.equal(stats.converted, 1);
  assert.equal(stats.skipped.comment, 2);
  assert.equal(stats.skipped.empty, 1);
  assert.equal(stats.skipped.cosmetic, 6);
  assert.equal(stats.skipped.regex, 2);
  assert.equal(stats.skipped['unsupported-option'], 11);
  assert.equal(stats.unsupported.popup, 1);
  assert.equal(stats.unsupported.redirect, 1);
  assert.equal(stats.skippedTotal, 22);
});

test('non-ASCII urlFilters are skipped, never emitted', () => {
  const { rules, stats } = convert('||bücher.de^\n/путь/реклама\n/ok');
  assert.deepEqual(rules.map(r => r.condition.urlFilter), ['/ok']);
  assert.equal(stats.skipped['non-ascii'], 2);
});

test('invalid filters are skipped', () => {
  const { rules, stats } = convert('||\n||*foo\n/a b\n$third-party\n/x$script,~script\n/x$domain=');
  assert.equal(rules.length, 0);
  assert.equal(stats.skippedTotal, 6);
});

test('ids are sequential from idStart; every rule has the full shape', () => {
  const { rules } = convert('/a\n||x.com^\n@@/b\n||y.com^', { idStart: 100 });
  assert.deepEqual(rules.map(r => r.id), [100, 101, 102]);
  for (const r of rules) {
    assert.deepEqual(Object.keys(r), ['id', 'priority', 'action', 'condition']);
    assert.ok(Number.isInteger(r.priority) && r.priority >= 1);
    assert.ok(['block', 'allow'].includes(r.action.type));
    assert.equal(r.condition.regexFilter, undefined);
  }
  assert.equal(convert('/a').rules[0].id, 1);
});
