import { hostname, validHost } from './policy.js';
import { FORM_ORIGINS, QA_DOMAINS, type Protection } from './protection.js';

// Static rulesets declared in manifest.json, built by `npm run rules`.
export const RULESETS = ['ads', 'privacy', 'frames'] as const;
export type Ruleset = (typeof RULESETS)[number];
export const VIDEO_MATCHES = ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'];
const AV1_SCRIPT = 'no-av1';
// Element hiding for empty ad slots needs access to every site; it follows the ads ruleset.
export const COSMETIC_MATCHES = ['*://*/*'];
const COSMETIC_SCRIPT = 'cosmetic';
// Above every static rule, so a paused site loads everything.
const PAUSE_PRIORITY = 100;

export interface SavingsSettings {
  rulesets: Record<Ruleset, boolean>;
  pausedHosts: string[];
  noAv1: boolean;
  cosmetic: boolean;
  devSet: string[];
  devActive: boolean;
  qaBypass: boolean;
  qaHosts: string[];
}
export const DEFAULT_SAVINGS: SavingsSettings = {
  rulesets: { ads: true, privacy: true, frames: false }, pausedHosts: [], noAv1: false, cosmetic: true, devSet: [], devActive: true,
  qaBypass: true, qaHosts: []
};

export interface ExtensionStatus { id: string; name: string; enabled: boolean; inSet: boolean; }
export interface SavingsStatus {
  settings: SavingsSettings;
  currentHost: string | null;
  videoPermission: boolean;
  cosmeticPermission: boolean;
  formProtection: boolean;
  extensions: ExtensionStatus[];
  discarded?: number;
}
export type SavingsRequest = { type: 'savings-status' }
  | { type: 'savings'; rulesets?: Partial<Record<Ruleset, boolean>>; noAv1?: boolean; cosmetic?: boolean; devActive?: boolean }
  | { type: 'savings-pause'; host: string; paused: boolean }
  | { type: 'savings-dev-set'; id: string; member: boolean }
  | { type: 'savings-qa'; bypass?: boolean; host?: string; member?: boolean }
  | { type: 'savings-discard-others' };

export function isSavingsRequest(message: { type?: unknown }): message is SavingsRequest {
  return typeof message.type === 'string' && message.type.startsWith('savings');
}

export function normalizeSavings(value: unknown): SavingsSettings {
  const input = value as Partial<SavingsSettings> | null;
  const rulesets = { ...DEFAULT_SAVINGS.rulesets };
  for (const id of RULESETS) if (typeof input?.rulesets?.[id] === 'boolean') rulesets[id] = input.rulesets[id];
  const ids = (list: unknown) => Array.isArray(list) ? [...new Set(list.filter(id => typeof id === 'string' && /^[a-p]{32}$/.test(id)))].sort() : [];
  return {
    rulesets,
    pausedHosts: Array.isArray(input?.pausedHosts) ? [...new Set(input.pausedHosts.filter(validHost))].sort() : [],
    noAv1: input?.noAv1 === true,
    cosmetic: typeof input?.cosmetic === 'boolean' ? input.cosmetic : true,
    devSet: ids(input?.devSet),
    devActive: typeof input?.devActive === 'boolean' ? input.devActive : true,
    qaBypass: typeof input?.qaBypass === 'boolean' ? input.qaBypass : true,
    qaHosts: Array.isArray(input?.qaHosts) ? [...new Set(input.qaHosts.filter(validHost))].sort() : []
  };
}

const ALLOW_ALL = { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType };
const FRAMES = ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[];
const QA_RULE = 100_000;
// Private IPv4 ranges and IPv6 loopback/ULA, which requestDomains cannot express.
const PRIVATE_URL = '^https?://(10\\.|127\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|\\[(::1|f[cd]))';

export function pauseRules(hosts: string[]): chrome.declarativeNetRequest.Rule[] {
  return hosts.map((host, i) => ({
    id: i + 1, priority: PAUSE_PRIORITY, action: ALLOW_ALL,
    condition: { requestDomains: [host], resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] }
  }));
}

// QA bypass: pages on local and test hosts load everything, including third-party pixels and payment widgets.
export function qaRules(settings: Pick<SavingsSettings, 'qaBypass' | 'qaHosts'>): chrome.declarativeNetRequest.Rule[] {
  if (!settings.qaBypass) return [];
  return [
    { id: QA_RULE, priority: PAUSE_PRIORITY, action: ALLOW_ALL,
      condition: { requestDomains: [...QA_DOMAINS, ...settings.qaHosts], resourceTypes: FRAMES } },
    { id: QA_RULE + 1, priority: PAUSE_PRIORITY, action: ALLOW_ALL, condition: { regexFilter: PRIVATE_URL, resourceTypes: FRAMES } }
  ];
}

// Hidden ad slots on every site except where blocking is off: paused sites and, with QA bypass, test hosts.
// Private IPs are not expressible as match patterns, so pages there still get the hiding CSS.
export function cosmeticScript(settings: SavingsSettings): chrome.scripting.RegisteredContentScript {
  const open = [...settings.pausedHosts, ...settings.qaBypass ? [...QA_DOMAINS, ...settings.qaHosts] : []];
  return { id: COSMETIC_SCRIPT, css: ['cosmetic.css'], matches: COSMETIC_MATCHES, runAt: 'document_start', allFrames: true,
    ...open.length ? { excludeMatches: [...new Set(open)].map(host => `*://*.${host}/*`) } : {} };
}

// Manual "free memory now": skips only tabs the browser or the user is actively using.
export function manuallyDiscardable(tab: chrome.tabs.Tab): boolean {
  return tab.id !== undefined && !tab.active && !tab.pinned && !tab.audible && !tab.discarded && !tab.incognito &&
    tab.autoDiscardable !== false && tab.status === 'complete' && hostname(tab.url) !== null;
}

export class Savings {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private api: typeof chrome, private protection?: Protection) {}

  private run<T>(task: (settings: SavingsSettings) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => task(normalizeSavings((await this.api.storage.local.get('savings')).savings)));
    this.tail = result.catch(() => {});
    return result;
  }

  private async apply(settings: SavingsSettings): Promise<void> {
    const dnr = this.api.declarativeNetRequest;
    await dnr.updateEnabledRulesets({
      enableRulesetIds: RULESETS.filter(id => settings.rulesets[id]),
      disableRulesetIds: RULESETS.filter(id => !settings.rulesets[id])
    });
    const existing = await dnr.getDynamicRules();
    await dnr.updateDynamicRules({ removeRuleIds: existing.map(rule => rule.id), addRules: [...pauseRules(settings.pausedHosts), ...qaRules(settings)] });
    await dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
    const av1 = settings.noAv1 && await this.api.permissions.contains({ origins: VIDEO_MATCHES });
    await this.script(AV1_SCRIPT, av1 ? { id: AV1_SCRIPT, js: ['no-av1.js'], matches: VIDEO_MATCHES,
      runAt: 'document_start', world: 'MAIN', allFrames: true } : null);
    const cosmetic = settings.cosmetic && settings.rulesets.ads && await this.api.permissions.contains({ origins: COSMETIC_MATCHES });
    await this.script(COSMETIC_SCRIPT, cosmetic ? cosmeticScript(settings) : null);
  }

  // Re-registers on every apply, so a changed exclusion list reaches the next page load.
  private async script(id: string, script: chrome.scripting.RegisteredContentScript | null): Promise<void> {
    const registered = await this.api.scripting.getRegisteredContentScripts({ ids: [id] });
    if (registered.length) await this.api.scripting.unregisterContentScripts({ ids: [id] });
    if (script) await this.api.scripting.registerContentScripts([script]);
  }

  private async setDevExtensions(settings: SavingsSettings, ids: string[] = settings.devSet): Promise<void> {
    const installed = new Set((await this.api.management.getAll()).map(item => item.id));
    for (const id of ids) if (installed.has(id)) await this.api.management.setEnabled(id, settings.devActive);
  }

  // Once per profile: a tab that asks for site access, since only a click can trigger the permission prompt.
  async welcome(): Promise<void> {
    if ((await this.api.storage.local.get('welcomed')).welcomed === true) return;
    if (!await this.api.permissions.contains({ origins: COSMETIC_MATCHES })) {
      await this.api.tabs.create({ url: this.api.runtime.getURL('welcome.html') });
    }
    // Set after the tab exists, so `welcomed` also tells automation that the tab is there to close.
    await this.api.storage.local.set({ welcomed: true });
  }

  initialize(): Promise<void> {
    return this.run(async settings => {
      await this.api.storage.local.set({ savings: settings });
      await this.apply(settings);
    });
  }

  request(message: SavingsRequest): Promise<SavingsStatus> {
    return this.run(async settings => {
      let discarded: number | undefined;
      if (message.type === 'savings') {
        for (const [id, on] of Object.entries(message.rulesets ?? {})) {
          if (!RULESETS.includes(id as Ruleset) || typeof on !== 'boolean') throw new Error('Невідомий набір правил.');
          settings.rulesets[id as Ruleset] = on;
        }
        if (message.noAv1 !== undefined) {
          if (typeof message.noAv1 !== 'boolean') throw new Error('Неправильний стан перемикача.');
          settings.noAv1 = message.noAv1;
        }
        if (message.cosmetic !== undefined) {
          if (typeof message.cosmetic !== 'boolean') throw new Error('Неправильний стан перемикача.');
          settings.cosmetic = message.cosmetic;
        }
        if (message.devActive !== undefined) {
          if (typeof message.devActive !== 'boolean') throw new Error('Неправильний стан перемикача.');
          settings.devActive = message.devActive;
          await this.setDevExtensions(settings);
        }
      } else if (message.type === 'savings-pause') {
        if (!validHost(message.host) || typeof message.paused !== 'boolean') throw new Error('Неправильна адреса сайту.');
        settings.pausedHosts = settings.pausedHosts.filter(host => host !== message.host);
        if (message.paused) settings.pausedHosts.push(message.host);
        settings.pausedHosts.sort();
      } else if (message.type === 'savings-dev-set') {
        if (typeof message.id !== 'string' || !/^[a-p]{32}$/.test(message.id) || message.id === this.api.runtime.id ||
          typeof message.member !== 'boolean') throw new Error('Неправильне розширення.');
        settings.devSet = settings.devSet.filter(id => id !== message.id);
        if (message.member) settings.devSet.push(message.id);
        settings.devSet.sort();
        if (message.member) await this.setDevExtensions(settings, [message.id]);
      } else if (message.type === 'savings-qa') {
        if (message.bypass !== undefined) {
          if (typeof message.bypass !== 'boolean') throw new Error('Неправильний стан перемикача.');
          settings.qaBypass = message.bypass;
        }
        if (message.host !== undefined) {
          if (!validHost(message.host) || typeof message.member !== 'boolean') throw new Error('Неправильна адреса сайту.');
          settings.qaHosts = settings.qaHosts.filter(host => host !== message.host);
          if (message.member) settings.qaHosts.push(message.host);
          settings.qaHosts.sort();
        }
      } else if (message.type === 'savings-discard-others') {
        discarded = 0;
        await this.protection?.load();
        for (const tab of await this.api.tabs.query({})) {
          if (!manuallyDiscardable(tab) || this.protection?.shield(tab) || await this.protection?.dirty(tab.id!)) continue;
          // Chromium may refuse a tab (e.g. it just became active); keep going.
          try { if ((await this.api.tabs.discard(tab.id!))?.discarded) discarded++; } catch {}
        }
      } else if (message.type !== 'savings-status') throw new Error('Невідома команда.');
      if (message.type !== 'savings-status' && message.type !== 'savings-discard-others') {
        await this.api.storage.local.set({ savings: settings });
        await this.apply(settings);
      }
      const current = (await this.api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      const self = this.api.runtime.id;
      const extensions = (await this.api.management.getAll())
        .filter(item => item.type === 'extension' && item.id !== self && item.installType !== 'admin')
        .map(item => ({ id: item.id, name: item.name, enabled: item.enabled, inSet: settings.devSet.includes(item.id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        settings: structuredClone(settings), currentHost: current ? hostname(current.url) : null,
        videoPermission: await this.api.permissions.contains({ origins: VIDEO_MATCHES }),
        cosmeticPermission: await this.api.permissions.contains({ origins: COSMETIC_MATCHES }),
        formProtection: await this.api.permissions.contains({ origins: FORM_ORIGINS }), extensions,
        ...(discarded === undefined ? {} : { discarded })
      };
    });
  }
}
