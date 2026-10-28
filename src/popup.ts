import type { Request, Status } from './controller.js';
import type { TimeoutMinutes } from './policy.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const enabled = element<HTMLInputElement>('enabled');
const timeout = element<HTMLSelectElement>('timeout');
const safeSite = element<HTMLInputElement>('safe-site');
const toggleSite = element<HTMLButtonElement>('toggle-site');
const message = element<HTMLParagraphElement>('message');
const refresh = element<HTMLButtonElement>('refresh');
let current: Status | null = null;
let busy = false;

function controls(): void {
  enabled.disabled = busy || !current;
  timeout.disabled = busy || !current;
  refresh.disabled = busy;
  safeSite.disabled = busy;
  const allowed = !!current?.currentHost && current.settings.allowedHosts.includes(current.currentHost);
  toggleSite.disabled = busy || !current?.currentHost || (!allowed && !safeSite.checked);
  for (const button of document.querySelectorAll<HTMLButtonElement>('#allowed-hosts button')) button.disabled = busy;
}

function render(status: Status): void {
  current = status;
  enabled.checked = status.settings.enabled;
  timeout.value = String(status.settings.timeoutMinutes);
  element('mode-description').textContent = status.settings.enabled ? 'Збалансований режим увімкнено' : 'Автоматичне вивантаження на паузі';
  element('site-title').textContent = status.currentHost ?? 'Службова сторінка';
  const allowed = !!status.currentHost && status.settings.allowedHosts.includes(status.currentHost);
  element('site-description').textContent = !status.currentHost ? 'Тут економія не застосовується.' : allowed
    ? 'Економію дозволено для цього домену. Вкладки перевіряються раз на хвилину.'
    : 'Сайт захищений. Дозвольте економію лише для сторінок, які можна перезавантажувати.';
  element('confirmation').hidden = allowed || !status.currentHost;
  safeSite.checked = false;
  toggleSite.textContent = allowed ? 'Заборонити економію на цьому сайті' : 'Дозволити економію на цьому сайті';
  element('discarded-count').textContent = String(status.session.discardedCount);
  element('currently-discarded').textContent = String(status.currentlyDiscarded);
  element('tab-count').textContent = `(${status.tabs.length})`;
  element('host-count').textContent = `(${status.settings.allowedHosts.length})`;
  const tabs = element<HTMLUListElement>('tab-status');
  tabs.replaceChildren();
  for (const tab of status.tabs) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = tab.title;
    title.title = tab.title;
    const reason = document.createElement('span');
    reason.textContent = tab.reason;
    item.append(title, reason);
    tabs.append(item);
  }
  const hosts = element<HTMLUListElement>('allowed-hosts');
  hosts.replaceChildren();
  for (const host of status.settings.allowedHosts) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = host;
    const remove = document.createElement('button');
    remove.className = 'text-button';
    remove.textContent = 'Захистити';
    remove.setAttribute('aria-label', `Заборонити економію на ${host}`);
    remove.addEventListener('click', () => { void send({ type: 'host', host, allowed: false }); });
    item.append(label, remove);
    hosts.append(item);
  }
  if (!status.settings.allowedHosts.length) {
    const item = document.createElement('li');
    item.textContent = 'Поки що всі сайти захищені.';
    hosts.append(item);
  }
  element('last-check').textContent = status.session.lastSweepAt
    ? `Перевірено о ${new Date(status.session.lastSweepAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`
    : 'Перевірка раз на хвилину';
  message.textContent = status.session.errors ? `Не виконано операцій за сесію: ${status.session.errors}. Вкладка могла закритися або бути захищеною браузером.` : '';
}

async function send(request: Request): Promise<void> {
  if (busy) return;
  busy = true;
  controls();
  try {
    const response = await chrome.runtime.sendMessage(request) as { ok: boolean; status?: Status; error?: string };
    if (!response?.ok || !response.status) throw new Error(response?.error ?? 'Немає відповіді від розширення.');
    render(response.status);
  } catch (error) {
    if (current) render(current);
    message.textContent = error instanceof Error ? error.message : 'Не вдалося завантажити стан. Натисніть «Оновити».';
  } finally {
    busy = false;
    controls();
  }
}

enabled.addEventListener('change', () => { void send({ type: 'settings', enabled: enabled.checked }); });
timeout.addEventListener('change', () => { void send({ type: 'settings', timeoutMinutes: Number(timeout.value) as TimeoutMinutes }); });
safeSite.addEventListener('change', controls);
toggleSite.addEventListener('click', () => {
  if (!current?.currentHost) return;
  void send({ type: 'host', host: current.currentHost, allowed: !current.settings.allowedHosts.includes(current.currentHost) });
});
refresh.addEventListener('click', () => { void send({ type: 'status' }); });
void send({ type: 'status' });
