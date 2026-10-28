import { hostname, type Reason, type Tab } from './policy.js';

// Local and test environments: never blocked, never discarded. Matching includes subdomains.
export const QA_DOMAINS = ['localhost', '127.0.0.1', 'test', 'local'];
const PRIVATE_IP = /^(10\.\d+|127\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$|^\[(::1|f[cd][0-9a-f:]*)\]$/;
// Dirty-form checks need access to every site; the optional permission doubles as the on/off switch.
export const FORM_ORIGINS = ['<all_urls>'];
const FORM_CHECK_MS = 1500;

export function isQaHost(host: string | null, extra: string[] = []): boolean {
  if (!host) return false;
  return PRIVATE_IP.test(host) || [...QA_DOMAINS, ...extra].some(domain => host === domain || host.endsWith(`.${domain}`));
}

export interface Blocker { tabId: number; title: string; reason: string; }
export type Guard = (tabs: chrome.tabs.Tab[]) => Promise<Blocker[]>;

// Runs in the page: true when a field differs from what the page was served with.
function dirtyForm(): boolean {
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')) {
    if (field instanceof HTMLSelectElement) {
      if ([...field.options].some(option => option.selected !== option.defaultSelected)) return true;
    } else if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
      if (field.checked !== field.defaultChecked) return true;
    } else if (!['hidden', 'submit', 'button', 'reset', 'image'].includes(field.type) && field.value !== field.defaultValue) return true;
  }
  return false;
}

export class Protection {
  private devtools = new Map<number, number>();
  private extraHosts: string[] = [];
  private qa = true;
  constructor(private api: typeof chrome) {}

  // The DevTools page of every inspected tab keeps a port open; it reconnects whenever the worker restarts.
  connect(port: chrome.runtime.Port): void {
    const tabId = Number(port.name.match(/^devtools:(\d+)$/)?.[1]);
    if (!Number.isInteger(tabId) || port.sender?.id !== this.api.runtime.id) return;
    this.devtools.set(tabId, (this.devtools.get(tabId) ?? 0) + 1);
    port.onDisconnect.addListener(() => {
      const left = (this.devtools.get(tabId) ?? 1) - 1;
      if (left > 0) this.devtools.set(tabId, left); else this.devtools.delete(tabId);
    });
  }

  async load(): Promise<void> {
    const savings = (await this.api.storage.local.get('savings')).savings as { qaBypass?: unknown; qaHosts?: unknown } | undefined;
    // One switch for QA mode: no blocking and no discarding on local and test hosts.
    this.qa = savings?.qaBypass !== false;
    this.extraHosts = Array.isArray(savings?.qaHosts) ? savings.qaHosts.filter((host): host is string => typeof host === 'string') : [];
  }

  // Synchronous part, for policy decisions: open DevTools and local/test hosts.
  shield = (tab: Tab): Reason | null => {
    if (tab.id !== undefined && this.devtools.has(tab.id)) return 'devtools';
    if (this.qa && isQaHost(hostname(tab.url), this.extraHosts)) return 'qa-host';
    return null;
  };

  async dirty(tabId: number): Promise<boolean> {
    if (!await this.api.permissions.contains({ origins: FORM_ORIGINS })) return false;
    const check = this.api.scripting.executeScript({ target: { tabId }, func: dirtyForm })
      .then(results => results.some(result => result.result === true), () => false);
    // A frozen or busy page must not stall a sweep or a folder switch.
    return Promise.race([check, new Promise<boolean>(ok => setTimeout(() => ok(false), FORM_CHECK_MS))]);
  }

  // Tabs that must not be closed or discarded right now, with a reason the user can act on.
  guard: Guard = async tabs => {
    const found = await Promise.all(tabs.map(async tab => {
      if (tab.id === undefined || tab.discarded) return null;
      const reason = this.devtools.has(tab.id) ? 'Відкрито DevTools' : tab.audible ? 'Відтворює звук'
        : await this.dirty(tab.id) ? 'Незбережені дані у формі' : null;
      return reason ? { tabId: tab.id, title: tab.title || tab.url || 'Без назви', reason } : null;
    }));
    return found.filter((blocker): blocker is Blocker => blocker !== null);
  };
}
