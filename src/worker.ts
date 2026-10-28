import { Controller, type Request } from './controller.js';
import { Savings, isSavingsRequest, type SavingsRequest } from './savings.js';
import { Folders, isFoldersRequest, type FoldersRequest } from './folders.js';
import { Protection } from './protection.js';

// Open DevTools, local/test hosts and dirty forms keep a tab from being discarded or closed by a folder switch.
const protection = new Protection(chrome);
const controller = new Controller(chrome, undefined, protection);
const savings = new Savings(chrome, protection);
const folders = new Folders(chrome, protection.guard);
const logFailure = (error: unknown) => console.error('Легко: операція не виконана', error instanceof Error ? error.message : 'Невідома помилка');

// Register synchronously so events can wake an otherwise stopped MV3 worker.
chrome.runtime.onConnect.addListener(port => protection.connect(port));
chrome.runtime.onStartup.addListener(() => {
  void controller.reset().then(() => controller.initialize()).catch(logFailure);
  void savings.initialize().catch(logFailure);
  void folders.init({ settle: true }).catch(logFailure);
});
chrome.runtime.onInstalled.addListener(() => {
  void controller.initialize().catch(logFailure);
  void savings.initialize().catch(logFailure);
  void folders.init().catch(logFailure);
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'sweep') void controller.sweep().catch(logFailure);
});
chrome.tabs.onActivated.addListener(({ tabId }) => { void controller.activity(tabId, true).catch(logFailure); });
chrome.tabs.onCreated.addListener(tab => {
  if (tab.id !== undefined) void controller.activity(tab.id, tab.active).catch(logFailure);
});
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.url || changes.status === 'loading') void controller.activity(tabId, false).catch(logFailure);
  else if (changes.audible !== undefined || changes.pinned !== undefined || changes.autoDiscardable !== undefined ||
    changes.discarded === false || changes.status === 'complete') controller.invalidate(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => { void controller.removed(tabId).catch(logFailure); });
chrome.tabs.onReplaced.addListener((added, removed) => {
  void controller.removed(removed).then(() => controller.activity(added, false)).catch(logFailure);
});
chrome.tabs.onCreated.addListener(tab => folders.created(tab));
chrome.tabs.onRemoved.addListener((tabId, info) => folders.removed(tabId, info));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => folders.updated(tabId, change, tab));
chrome.tabs.onMoved.addListener((tabId, info) => folders.moved(tabId, info));
chrome.tabs.onActivated.addListener(info => folders.activated(info));
chrome.tabs.onAttached.addListener((tabId, info) => folders.attached(tabId, info));
chrome.tabs.onDetached.addListener((tabId, info) => folders.detached(tabId, info));
chrome.windows.onRemoved.addListener(id => { void folders.windowRemoved(id).catch(logFailure); });
chrome.runtime.onMessage.addListener((message: Request | SavingsRequest | FoldersRequest, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (!message || typeof message !== 'object') { respond({ ok: false, error: 'Невідома команда.' }); return false; }
  const reply = isFoldersRequest(message) ? folders.request(message)
    : isSavingsRequest(message) ? savings.request(message) : controller.request(message as Request);
  void reply.then(status => respond({ ok: true, status }), error => {
    respond({ ok: false, error: error instanceof Error ? error.message : 'Операція не виконана.' });
  });
  return true;
});

void controller.initialize().catch(logFailure);
