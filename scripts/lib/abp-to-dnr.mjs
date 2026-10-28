import { domainToASCII } from 'node:url';

// Adblock Plus filter syntax -> Chrome declarativeNetRequest rules (static subset).
const TYPES = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest', subdocument: 'sub_frame', frame: 'sub_frame',
  media: 'media', font: 'font', ping: 'ping', websocket: 'websocket', object: 'object', other: 'other'
};
export const CHUNK = 5000;
const COSMETIC = /#[@?$%]{0,2}#/;
const DOMAIN = /^(?:[a-z0-9_-]+\.)+[a-z][a-z0-9_-]*$/; // rejects IPs and bare labels
const priority = (allow, important) => (allow ? 2 : 1) + (important ? 2 : 0);

class Skip { constructor(reason, detail) { this.reason = reason; this.detail = detail; } }

function parseDomains(value) {
  const include = new Set(), exclude = new Set();
  for (const entry of value.split('|')) {
    const neg = entry[0] === '~', e = (neg ? entry.slice(1) : entry).toLowerCase();
    if (e.includes('*')) throw new Skip('unsupported-option', 'domain-wildcard');
    if (!e || /[\/\s]/.test(e)) throw new Skip('invalid');
    const ascii = domainToASCII(e);
    if (!ascii || /[^a-z0-9._-]/.test(ascii)) throw new Skip('invalid'); // IPv6/odd hosts: not worth a ruleset load risk
    (neg ? exclude : include).add(ascii);
  }
  return { include: [...include].sort(), exclude: [...exclude].sort() };
}

function parseOptions(str) {
  const o = { types: new Set(), notTypes: new Set(), important: false, matchCase: false, domainType: null, domains: null };
  for (const raw of str.split(',')) {
    if (!raw) continue;
    const eq = raw.indexOf('='), value = eq < 0 ? null : raw.slice(eq + 1);
    let name = (eq < 0 ? raw : raw.slice(0, eq)).toLowerCase();
    const neg = name[0] === '~';
    if (neg) name = name.slice(1);
    let party = null;
    if (value === null && (name === 'third-party' || name === '3p')) party = neg ? 'firstParty' : 'thirdParty';
    else if (value === null && (name === 'first-party' || name === '1p')) party = neg ? 'thirdParty' : 'firstParty';
    if (party) {
      if (o.domainType && o.domainType !== party) throw new Skip('invalid');
      o.domainType = party;
    } else if (value === null && TYPES[name]) (neg ? o.notTypes : o.types).add(TYPES[name]);
    else if (value === null && !neg && name === 'match-case') o.matchCase = true;
    else if (value === null && !neg && name === 'important') o.important = true;
    else if (value !== null && !neg && name === 'domain') {
      if (o.domains) throw new Skip('invalid');
      o.domains = parseDomains(value);
    } else throw new Skip('unsupported-option', neg ? '~' + name : name);
  }
  return o;
}

function patternOf(body, hasDomains) {
  if (/[^\x00-\x7f]/.test(body)) throw new Skip('non-ascii');
  if (/\s/.test(body)) throw new Skip('invalid');
  let p = body.replace(/\*+$/, '');
  if (p[0] !== '|') p = p.replace(/^\*+/, '');
  if (/^\|\|(?:[*^|]|$)|^\|(?:\*|$)/.test(p)) throw new Skip('invalid');
  if (!p && !hasDomains) throw new Skip('too-broad');
  return p;
}

function parse(line) {
  if (line[0] === '!' || /^\[.*\]$/.test(line)) throw new Skip('comment');
  if (COSMETIC.test(line) || line.includes('$$')) throw new Skip('cosmetic');
  const allow = line.startsWith('@@');
  let body = allow ? line.slice(2) : line, optStr = '';
  if (/^\/.*\/$/.test(body)) throw new Skip('regex');
  const d = body.lastIndexOf('$');
  if (d >= 0) { optStr = body.slice(d + 1); body = body.slice(0, d); }
  if (/^\/.+\/$/.test(body)) throw new Skip('regex');
  if (!body && !optStr) throw new Skip('invalid');
  const o = parseOptions(optStr);
  const urlFilter = patternOf(body, !!o.domains?.include.length);
  const opts = {};
  if (o.domainType) opts.domainType = o.domainType;
  if (o.domains?.include.length) opts.initiatorDomains = o.domains.include;
  if (o.domains?.exclude.length) opts.excludedInitiatorDomains = o.domains.exclude;
  if (o.types.size) {
    const t = [...o.types].filter(x => !o.notTypes.has(x)).sort();
    if (!t.length) throw new Skip('invalid');
    opts.resourceTypes = t;
  } else if (o.notTypes.size) opts.excludedResourceTypes = [...o.notTypes].sort();
  opts.isUrlFilterCaseSensitive = o.matchCase;
  const m = /^\|\|([a-z0-9._-]+)\^$/i.exec(urlFilter);
  const domain = m && DOMAIN.test(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  return { type: allow ? 'allow' : 'block', priority: priority(allow, o.important), urlFilter, domain, opts };
}

export function convert(text, { idStart = 1 } = {}) {
  const lines = String(text).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const skipped = {}, unsupported = {};
  const plain = new Map(), groups = new Map();
  let converted = 0, duplicates = 0, domainFilters = 0;
  const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { bump(skipped, 'empty'); continue; }
    let f;
    try { f = parse(line); } catch (e) {
      if (!(e instanceof Skip)) throw e;
      bump(skipped, e.reason);
      if (e.detail) bump(unsupported, e.detail);
      continue;
    }
    converted++;
    if (f.domain) {
      domainFilters++;
      const key = JSON.stringify([f.type, f.priority, f.opts]);
      let g = groups.get(key);
      if (!g) groups.set(key, g = { f, domains: new Set() });
      if (g.domains.has(f.domain)) duplicates++;
      g.domains.add(f.domain);
      continue;
    }
    const condition = f.urlFilter ? { urlFilter: f.urlFilter, ...f.opts } : { ...f.opts };
    const key = JSON.stringify([f.type, f.priority, condition]);
    if (plain.has(key)) { duplicates++; continue; }
    plain.set(key, { type: f.type, priority: f.priority, condition });
  }
  const bodies = [...plain.values()];
  for (const { f, domains } of groups.values()) {
    const sorted = [...domains].sort();
    for (let i = 0; i < sorted.length; i += CHUNK)
      bodies.push({ type: f.type, priority: f.priority, condition: { requestDomains: sorted.slice(i, i + CHUNK), ...f.opts } });
  }
  const rules = bodies.map((b, i) => ({ id: idStart + i, priority: b.priority, action: { type: b.type }, condition: b.condition }));
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  return { rules, stats: { lines: lines.length, converted, skippedTotal, skipped, unsupported, duplicates, domainFilters, rules: rules.length } };
}
