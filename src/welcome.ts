import { COSMETIC_MATCHES, type SavingsRequest, type SavingsStatus } from './savings.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const grant = element<HTMLButtonElement>('grant');
const later = element<HTMLButtonElement>('later');
const message = element<HTMLSpanElement>('welcome-message');

async function send(request: SavingsRequest): Promise<SavingsStatus> {
  const response = await chrome.runtime.sendMessage(request) as { ok: boolean; status?: SavingsStatus; error?: string };
  if (!response?.ok || !response.status) throw new Error(response?.error ?? 'Немає відповіді від розширення.');
  return response.status;
}

function render(status: SavingsStatus): void {
  const done = status.settings.cosmetic && status.cosmeticPermission;
  grant.disabled = done;
  later.textContent = done ? 'Закрити' : 'Не зараз';
  if (done) message.textContent = 'Готово: порожні рекламні блоки ховаються. Вимкнути можна в меню розширення.';
}

grant.addEventListener('click', () => {
  grant.disabled = true;
  message.textContent = '';
  // Must be requested from the click itself; the worker only checks the grant.
  void chrome.permissions.request({ origins: COSMETIC_MATCHES })
    .then(granted => granted ? send({ type: 'savings', cosmetic: true }).then(render) : Promise.reject(
      new Error('Без доступу блоки лишаються. Увімкнути можна пізніше в меню: «Порожні рекламні блоки».')))
    .catch(error => {
      grant.disabled = false;
      message.textContent = error instanceof Error ? error.message : 'Операція не виконана.';
    });
});
later.addEventListener('click', () => window.close());
void send({ type: 'savings-status' }).then(render, () => { grant.disabled = false; });
