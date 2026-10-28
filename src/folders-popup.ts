import type { Blocker, FoldersRequest, FoldersStatus } from './folders.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const list = element<HTMLUListElement>('folders-list');
const footer = element<HTMLDivElement>('folders-footer');
const blockedBox = element<HTMLDivElement>('folders-blocked');
const message = element<HTMLParagraphElement>('folders-message');

let status: FoldersStatus = { currentId: undefined, folders: [] };
let windowId: number | undefined;
let editing: { id: string; mode: 'rename' | 'delete' } | null = null;
let creating = false;
let blocked: { request: FoldersRequest; blockers: Blocker[] } | null = null;
let busy = false;

// Distributes over the union so each request keeps its own fields.
type Draft<T> = T extends unknown ? Omit<T, 'windowId'> : never;
async function send(request: Draft<FoldersRequest>): Promise<FoldersStatus> {
  const response = await chrome.runtime.sendMessage({ ...request, windowId }) as { ok: boolean; status?: FoldersStatus; error?: string };
  if (!response?.ok || !response.status) throw new Error(response?.error ?? 'Немає відповіді від розширення.');
  return response.status;
}

async function run(request: Draft<FoldersRequest>, { close = false } = {}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const { blocked: found, ...next } = await send(request);
    status = next;
    message.textContent = '';
    editing = null;
    creating = false;
    blocked = found?.length ? { request: request as FoldersRequest, blockers: found } : null;
    if (close && !blocked) { window.close(); return; }
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Операція не виконана.';
  } finally {
    busy = false;
  }
  render();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function button(text: string, title: string, onClick: () => void, props: Partial<HTMLButtonElement> = {}): HTMLButtonElement {
  const node = el('button', { type: 'button', textContent: text, title, ...props });
  node.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return node;
}

function textInput(placeholder: string, value: string, onSubmit: (value: string) => void, onCancel: () => void): HTMLInputElement {
  const input = el('input', { type: 'text', value, placeholder, maxLength: 40 });
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') onSubmit(input.value);
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
  });
  return input;
}

function row(folder: FoldersStatus['folders'][number]): HTMLLIElement {
  const isCurrent = folder.id === status.currentId;
  const item = el('li', { className: isCurrent ? 'folder current' : 'folder' });
  item.dataset.id = folder.id;
  const dot = el('span', { className: 'folder-dot' });
  dot.style.background = folder.color;
  item.append(el('span', { className: 'folder-mark', textContent: isCurrent ? '●' : '○' }), dot);

  if (editing?.id === folder.id && editing.mode === 'rename') {
    item.append(textInput('Назва папки', folder.name,
      name => { void run({ type: 'folders-rename', id: folder.id, name }); },
      () => { editing = null; render(); }));
    return item;
  }

  item.append(el('span', { className: 'folder-name', textContent: folder.name, title: folder.name }),
    el('span', { className: 'folder-count', textContent: String(folder.count) }));

  if (editing?.id === folder.id && editing.mode === 'delete') {
    item.append(el('span', { className: 'folder-confirm' }, 'Видалити?',
      button('Так', 'Видалити папку', () => { void run({ type: 'folders-delete', id: folder.id }); }, { className: 'danger' }),
      button('Ні', 'Скасувати', () => { editing = null; render(); })));
  } else {
    const actions = el('span', { className: 'folder-actions' },
      button('✎', 'Перейменувати', () => { editing = { id: folder.id, mode: 'rename' }; render(); }));
    if (!isCurrent) actions.append(button('↳', 'Перемістити сюди поточну вкладку', () => { void run({ type: 'folders-move-tab', id: folder.id }); }));
    actions.append(button('×', isCurrent ? 'Поточну папку видалити не можна' : 'Видалити',
      () => { editing = { id: folder.id, mode: 'delete' }; render(); }, { disabled: isCurrent }));
    item.append(actions);
  }
  item.addEventListener('click', () => { void run({ type: 'folders-switch', id: folder.id }, { close: true }); });
  return item;
}

function renderBlocked(): void {
  blockedBox.hidden = !blocked;
  blockedBox.replaceChildren();
  if (!blocked) return;
  const pending = blocked.request;
  const items = el('ul', { className: 'folder-blockers' }, ...blocked.blockers.map(item =>
    el('li', {}, el('strong', { textContent: item.title || 'Без назви' }), el('span', { textContent: item.reason }))));
  blockedBox.append(el('p', { textContent: 'У цих вкладках може бути незбережена робота:' }), items,
    el('div', { className: 'folder-blocked-actions' },
      button('Все одно перемкнути', 'Закрити ці вкладки без збереження', () => { void run({ ...pending, force: true } as FoldersRequest, { close: true }); }, { className: 'primary' }),
      button('Скасувати', 'Залишитися в поточній папці', () => { blocked = null; render(); }, { className: 'text-button' })));
}

function render(): void {
  list.replaceChildren(...status.folders.map(row));
  footer.replaceChildren(creating
    ? textInput('Назва нової папки', '',
      name => { void run({ type: 'folders-create', name }, { close: true }); },
      () => { creating = false; render(); })
    : button('+ Нова папка', 'Створити папку', () => { creating = true; render(); }, { className: 'text-button' }));
  renderBlocked();
  list.querySelector('input')?.focus();
  footer.querySelector('input')?.focus();
}

async function start(): Promise<void> {
  const param = new URLSearchParams(location.search).get('windowId');
  try { windowId = param !== null ? Number(param) : (await chrome.windows.getLastFocused()).id; } catch { /* worker falls back to the focused window */ }
  await run({ type: 'folders-list' });
}
void start();
