const list = document.getElementById('list');
const footer = document.getElementById('footer');
const errorBox = document.getElementById('error');
const windowParam = new URLSearchParams(location.search).get('windowId');

let state = { folders: [], currentId: null };
let windowId;
let editing = null; // { id, mode: 'rename' | 'delete' }
let creating = false;

async function send(message) {
  const reply = await chrome.runtime.sendMessage({ ...message, windowId });
  if (!reply?.ok) throw new Error(reply?.error ?? 'Помилка');
  state = reply.state;
}

async function run(message, { close = false } = {}) {
  try {
    await send(message);
    errorBox.hidden = true;
    editing = null;
    creating = false;
    if (close) return window.close();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
  render();
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function button(text, title, onClick, props = {}) {
  const node = el('button', { type: 'button', textContent: text, title, ...props });
  node.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return node;
}

function textInput(value, placeholder, onSubmit, onCancel) {
  const input = el('input', { type: 'text', value, placeholder, maxLength: 40 });
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') onSubmit(input.value);
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
  });
  return input;
}

function row(folder) {
  const isCurrent = folder.id === state.currentId;
  const li = el('li', { className: isCurrent ? 'current' : '' });
  li.dataset.id = folder.id;
  const dot = el('span', { className: 'dot' });
  dot.style.background = folder.color;
  li.append(el('span', { className: 'mark', textContent: isCurrent ? '●' : '○' }), dot);

  if (editing?.id === folder.id && editing.mode === 'rename') {
    li.append(textInput(folder.name, 'Назва папки',
      name => run({ type: 'rename', id: folder.id, name }),
      () => { editing = null; render(); }));
    return li;
  }

  li.append(el('span', { className: 'name', textContent: folder.name, title: folder.name }),
    el('span', { className: 'count', textContent: String(folder.count) }));

  if (editing?.id === folder.id && editing.mode === 'delete') {
    li.append(el('span', { className: 'confirm' }, 'Видалити?',
      button('Так', 'Видалити папку', () => run({ type: 'delete', id: folder.id }), { className: 'danger' }),
      button('Ні', 'Скасувати', () => { editing = null; render(); })));
  } else {
    const actions = el('span', { className: 'actions' },
      button('✎', 'Перейменувати', () => { editing = { id: folder.id, mode: 'rename' }; render(); }));
    if (!isCurrent) actions.append(button('↳', 'Перемістити сюди поточну вкладку', () => run({ type: 'moveTab', id: folder.id })));
    actions.append(button('×', isCurrent ? 'Поточну папку видалити не можна' : 'Видалити',
      () => { editing = { id: folder.id, mode: 'delete' }; render(); }, { disabled: isCurrent }));
    li.append(actions);
  }
  li.addEventListener('click', () => run({ type: 'switch', id: folder.id }, { close: true }));
  return li;
}

function render() {
  list.replaceChildren(...state.folders.map(row));
  footer.replaceChildren(creating
    ? textInput('', 'Назва нової папки',
      name => run({ type: 'create', name }, { close: true }),
      () => { creating = false; render(); })
    : button('+ Нова папка', 'Створити папку', () => { creating = true; render(); }));
  list.querySelector('input')?.focus();
  footer.querySelector('input')?.focus();
}

windowId = windowParam !== null ? Number(windowParam) : (await chrome.windows.getLastFocused()).id;
await run({ type: 'list' });
