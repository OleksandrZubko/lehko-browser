import { KDF_DEFAULT, checkKeyBlob, checkPassphrase, toB64, type KdfParams } from './sync-crypto.js';
import type { SyncRequest, SyncStatus } from './sync.js';

// Global of the vendored hash-wasm build (extension/vendor).
declare const hashwasm: { argon2id(options: { password: string; salt: Uint8Array; parallelism: number; iterations: number; memorySize: number; hashLength: number; outputType: 'binary' }): Promise<Uint8Array> };

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const body = element<HTMLDivElement>('sync-body');
const label = element<HTMLSpanElement>('sync-state');
const message = element<HTMLParagraphElement>('sync-message');

const DEFAULT_SERVER = 'https://lehko-sync.avzubko.workers.dev';

let status: SyncStatus = { enabled: false, devices: [] };
let mode: 'create' | 'join' = 'create';
let confirmWipe = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
function button(text: string, onClick: () => void, className = 'text-button'): HTMLButtonElement {
  const node = el('button', { type: 'button', textContent: text, className });
  node.addEventListener('click', onClick);
  return node;
}

async function send(request: SyncRequest): Promise<void> {
  message.textContent = '';
  try {
    const response = await chrome.runtime.sendMessage(request) as { ok: boolean; status?: SyncStatus; error?: string };
    if (!response?.ok || !response.status) throw new Error(response?.error ?? 'Немає відповіді від розширення.');
    status = response.status;
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Операція не виконана.';
  }
  render();
}

function field(type: string, placeholder: string, value = ''): HTMLInputElement {
  return el('input', { type, placeholder, value, required: true, autocomplete: 'off', spellcheck: false });
}

async function deriveKek(passphrase: string, salt: Uint8Array, params: KdfParams): Promise<string> {
  const kek = await hashwasm.argon2id({ password: passphrase.normalize('NFKC'), salt, parallelism: 1, iterations: params.iterations, memorySize: params.memoryKiB, hashLength: 32, outputType: 'binary' });
  return toB64(kek);
}

// After Google sign-in: a new passphrase for the first device, the existing one for the others.
function passphraseForm(): HTMLElement {
  const google = status.google!;
  const device = status.enabled ? null : field('text', 'Назва пристрою', 'Мій Mac');
  const first = field('password', 'Фраза синхронізації');
  const second = google.hasKey ? null : field('password', 'Повторіть фразу');
  const submit = el('button', { type: 'submit', className: 'primary', textContent: google.hasKey ? 'Відкрити дані' : 'Зберегти фразу' });
  const form = el('form', {}, ...(device ? [device] : []), first, ...(second ? [second] : []), submit,
    button('Скасувати', () => { void send({ type: 'sync-google-cancel' }); }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit.disabled = true;
    void (async () => {
      try {
        const deviceName = device?.value ?? status.deviceName ?? '';
        if (google.blob) {
          const blob = checkKeyBlob(google.blob);
          const kek = await deriveKek(first.value, Uint8Array.from(atob(blob.salt.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)), blob);
          await send({ type: 'sync-google-unlock', kek, deviceName });
        } else {
          const passphrase = checkPassphrase(first.value);
          if (passphrase !== second?.value) throw new Error('Фрази не збігаються');
          const salt = crypto.getRandomValues(new Uint8Array(16));
          await send({ type: 'sync-google-setup', kek: await deriveKek(passphrase, salt, KDF_DEFAULT), salt: toB64(salt), params: KDF_DEFAULT, deviceName });
        }
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : 'Операція не виконана.';
      } finally { submit.disabled = false; }
    })();
  });
  return el('div', {}, el('p', { className: 'hint', textContent: google.hasKey
    ? 'Введіть фразу, задану на першому пристрої. Google її не знає, сервер теж.'
    : 'Придумайте фразу щонайменше з 12 символів. Її ніхто не зможе відновити: забудете фразу, і дані на сервері стануть недоступні новим пристроям.' }), form);
}

function setup(): HTMLElement {
  if (status.google) return passphraseForm();
  const server = field('url', 'https://адреса-сервера', DEFAULT_SERVER);
  const device = field('text', 'Назва пристрою', 'Мій Mac');
  const secret = field(mode === 'create' ? 'password' : 'text', mode === 'create' ? 'Інвайт-код сервера' : 'Код з іншого пристрою');
  const form = el('form', {}, server, device, secret,
    el('button', { type: 'submit', className: 'primary', textContent: mode === 'create' ? 'Створити ланцюжок' : 'Приєднатися' }),
    button(mode === 'create' ? 'У мене вже є інший пристрій' : 'Це мій перший пристрій', () => { mode = mode === 'create' ? 'join' : 'create'; render(); }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    void send(mode === 'create'
      ? { type: 'sync-create', server: server.value, invite: secret.value, deviceName: device.value }
      : { type: 'sync-join', server: server.value, code: secret.value, deviceName: device.value });
  });
  const google = button('Увійти через Google', () => { void send({ type: 'sync-google-login', server: server.value }); }, 'primary');
  return el('div', {}, el('p', { className: 'hint', textContent: 'Папки, групи й відкриті вкладки шифруються на цьому пристрої. Сервер бачить лише шифротекст. Google лише підтверджує вхід, дані відкриває ваша фраза.' }),
    google, el('details', {}, el('summary', { textContent: 'Без Google: інвайт або код пристрою' }), form));
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function device(item: SyncStatus['devices'][number]): HTMLElement {
  const tabs = el('ul', { className: 'sync-tabs' }, ...item.tabs.map(tab => el('li', {},
    button(tab.title || tab.url, () => { void send({ type: 'sync-open', url: tab.url }); }, ''))));
  return el('div', { className: 'sync-device' },
    el('div', { className: 'sync-actions' }, el('h3', { textContent: item.name }),
      button('Надіслати сюди цю вкладку', () => {
        void activeTab().then(tab => send({ type: 'sync-send', deviceId: item.id, url: tab?.url ?? '', title: tab?.title ?? '' }));
      })),
    el('p', { className: 'hint', textContent: `Оновлено ${new Date(item.at).toLocaleString('uk')}` }), tabs);
}

function linked(): HTMLElement {
  const box = el('div', { className: 'sync-block' });
  box.append(el('p', { className: 'hint', textContent: `${status.deviceName} · ${status.server}` }));
  if (status.lastError) box.append(el('p', { className: 'error', textContent: status.lastError }));
  if (status.skipped) box.append(el('p', { className: 'error', textContent: `Відхилено пошкоджених записів: ${status.skipped}.` }));
  if (status.held) {
    const where = status.held.direction === 'local' ? 'На цьому пристрої' : 'На іншому пристрої';
    box.append(el('div', { className: 'sync-held', role: 'alert' },
      el('p', { textContent: `${where} видалено ${status.held.deleted} із ${status.held.total} записів. Синхронізацію призупинено.` }),
      el('div', { className: 'sync-actions' },
        button('Застосувати видалення', () => { void send({ type: 'sync-confirm' }); }, 'primary'),
        button('Поки не застосовувати', () => { void send({ type: 'sync-reject' }); }))));
  }
  if (status.code) {
    box.append(el('p', { className: 'hint', textContent: 'Введіть цей код на новому пристрої протягом 10 хвилин. Код дає повний доступ до даних.' }),
      el('div', { className: 'sync-code', textContent: status.code }));
  }
  if (status.google) box.append(passphraseForm());
  else if (!status.linked) box.append(button('Прив’язати до Google', () => { void send({ type: 'sync-google-login', server: status.server ?? DEFAULT_SERVER }); }));
  box.append(el('div', { className: 'sync-actions' },
    button('Додати пристрій', () => { void send({ type: 'sync-pair' }); }),
    button('Синхронізувати', () => { void send({ type: 'sync-now' }); })));
  box.append(...status.devices.map(device));
  box.append(confirmWipe
    ? el('div', { className: 'sync-actions' }, el('span', { textContent: 'Видалити дані з сервера для всіх пристроїв?' }),
      button('Так, видалити', () => { confirmWipe = false; void send({ type: 'sync-wipe' }); }, 'danger'),
      button('Ні', () => { confirmWipe = false; render(); }))
    : el('div', { className: 'sync-actions' },
      button('Вийти на цьому пристрої', () => { void send({ type: 'sync-leave' }); }),
      button('Видалити дані з сервера', () => { confirmWipe = true; render(); })));
  return box;
}

function render(): void {
  label.textContent = status.enabled ? (status.lastError || status.held ? '· потребує уваги' : '· увімкнено') : '';
  body.replaceChildren(status.enabled ? linked() : setup());
}

void send({ type: 'sync-status' });
