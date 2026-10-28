import { FORM_ORIGINS, isQaHost } from './protection.js';
import { VIDEO_MATCHES, type Ruleset, type SavingsRequest, type SavingsStatus } from './savings.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const rulesets: Record<Ruleset, HTMLInputElement> = {
  ads: element('rules-ads'), privacy: element('rules-privacy'), frames: element('rules-frames')
};
const noAv1 = element<HTMLInputElement>('no-av1');
const togglePause = element<HTMLButtonElement>('toggle-pause');
const discardOthers = element<HTMLButtonElement>('discard-others');
const devActive = element<HTMLInputElement>('dev-active');
const qaBypass = element<HTMLInputElement>('qa-bypass');
const qaSite = element<HTMLButtonElement>('qa-site');
const formProtection = element<HTMLInputElement>('form-protection');
const message = element<HTMLParagraphElement>('savings-message');
let current: SavingsStatus | null = null;
let busy = false;
let confirmDiscard = false;

function controls(): void {
  for (const input of [...Object.values(rulesets), noAv1, devActive, qaBypass, formProtection]) input.disabled = busy || !current;
  qaSite.disabled = busy || !current?.currentHost;
  togglePause.disabled = busy || !current?.currentHost;
  discardOthers.disabled = busy || !current;
  for (const input of document.querySelectorAll<HTMLInputElement>('#dev-list input')) input.disabled = busy;
}

function render(status: SavingsStatus): void {
  current = status;
  for (const [id, input] of Object.entries(rulesets)) input.checked = status.settings.rulesets[id as Ruleset];
  noAv1.checked = status.settings.noAv1 && status.videoPermission;
  devActive.checked = status.settings.devActive;
  qaBypass.checked = status.settings.qaBypass;
  formProtection.checked = status.formProtection;
  const host = status.currentHost;
  const marked = !!host && status.settings.qaHosts.includes(host);
  const builtIn = !marked && isQaHost(host);
  qaSite.hidden = !host || builtIn;
  qaSite.textContent = marked ? 'Прибрати з тестових' : 'Позначити як тестовий';
  element('qa-description').textContent = !host ? 'Службова сторінка.' : builtIn || marked
    ? `${host} — тестовий сайт: без блокування й вивантаження.` : 'Стейджинг? Позначте сайт разом із піддоменами.';
  element('qa-count').textContent = `(${status.settings.qaHosts.length})`;
  const qaList = element<HTMLUListElement>('qa-hosts');
  qaList.replaceChildren(...status.settings.qaHosts.map(item => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = item;
    const remove = document.createElement('button');
    remove.className = 'text-button';
    remove.textContent = 'Прибрати';
    remove.addEventListener('click', () => { void send({ type: 'savings-qa', host: item, member: false }); });
    row.append(name, remove);
    return row;
  }));
  const paused = !!status.currentHost && status.settings.pausedHosts.includes(status.currentHost);
  element('pause-description').textContent = !status.currentHost ? 'Службова сторінка.'
    : paused ? `Блокування вимкнено на ${status.currentHost}.` : 'Сайт не працює? Вимкніть блокування для нього.';
  togglePause.textContent = paused ? 'Увімкнути тут' : 'Вимкнути тут';
  togglePause.hidden = !status.currentHost;
  confirmDiscard = false;
  discardOthers.textContent = 'Звільнити пам’ять зараз';
  if (status.discarded !== undefined) message.textContent = `Вивантажено вкладок: ${status.discarded}.`;
  element('dev-count').textContent = `(${status.settings.devSet.length})`;
  const list = element<HTMLUListElement>('dev-list');
  list.replaceChildren();
  for (const extension of status.extensions) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = extension.inSet;
    box.addEventListener('change', () => { void send({ type: 'savings-dev-set', id: extension.id, member: box.checked }); });
    const name = document.createElement('span');
    name.textContent = extension.name;
    label.append(box, name);
    const state = document.createElement('span');
    state.textContent = extension.enabled ? 'увімкнено' : 'вимкнено';
    item.append(label, state);
    list.append(item);
  }
  if (!status.extensions.length) {
    const item = document.createElement('li');
    item.textContent = 'Інших розширень немає.';
    list.append(item);
  }
}

async function send(request: SavingsRequest): Promise<void> {
  if (busy) return;
  busy = true;
  message.textContent = '';
  controls();
  try {
    const response = await chrome.runtime.sendMessage(request) as { ok: boolean; status?: SavingsStatus; error?: string };
    if (!response?.ok || !response.status) throw new Error(response?.error ?? 'Немає відповіді від розширення.');
    render(response.status);
  } catch (error) {
    if (current) render(current);
    message.textContent = error instanceof Error ? error.message : 'Операція не виконана.';
  } finally {
    busy = false;
    controls();
  }
}

for (const [id, input] of Object.entries(rulesets)) {
  input.addEventListener('change', () => { void send({ type: 'savings', rulesets: { [id]: input.checked } }); });
}
noAv1.addEventListener('change', () => {
  if (!noAv1.checked) { void send({ type: 'savings', noAv1: false }); return; }
  // Must be requested from the click itself; the worker only checks the grant.
  void chrome.permissions.request({ origins: VIDEO_MATCHES }).then(granted => {
    if (granted) void send({ type: 'savings', noAv1: true });
    else { noAv1.checked = false; message.textContent = 'Без дозволу для YouTube цей режим не працює.'; }
  });
});
devActive.addEventListener('change', () => { void send({ type: 'savings', devActive: devActive.checked }); });
qaBypass.addEventListener('change', () => { void send({ type: 'savings-qa', bypass: qaBypass.checked }); });
qaSite.addEventListener('click', () => {
  if (!current?.currentHost) return;
  void send({ type: 'savings-qa', host: current.currentHost, member: !current.settings.qaHosts.includes(current.currentHost) });
});
formProtection.addEventListener('change', () => {
  // Granting or removing the permission is the setting itself; the worker re-reads it on every check.
  const change = formProtection.checked ? chrome.permissions.request({ origins: FORM_ORIGINS })
    : chrome.permissions.remove({ origins: FORM_ORIGINS }).then(() => false);
  void change.then(granted => {
    if (formProtection.checked && !granted) message.textContent = 'Без доступу до сайтів форми не перевіряються.';
    void send({ type: 'savings-status' });
  });
});
togglePause.addEventListener('click', () => {
  if (!current?.currentHost) return;
  void send({ type: 'savings-pause', host: current.currentHost, paused: !current.settings.pausedHosts.includes(current.currentHost) });
});
discardOthers.addEventListener('click', () => {
  if (!confirmDiscard) {
    confirmDiscard = true;
    discardOthers.textContent = 'Підтвердити: незбережені форми у фонових вкладках зникнуть';
    return;
  }
  void send({ type: 'savings-discard-others' });
});
void send({ type: 'savings-status' });
