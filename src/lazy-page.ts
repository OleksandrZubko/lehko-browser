import { unwrapLazy } from './lazy-tab.js';

const entry = unwrapLazy(location.href);
if (entry) {
  document.title = entry.title || entry.url;
  const icon = document.createElement('link');
  icon.rel = 'icon';
  // From the browser's own icon cache: the site gets no request.
  icon.href = `/_favicon/?${new URLSearchParams({ pageUrl: entry.url, size: '32' })}`;
  document.head.append(icon);
  document.getElementById('label')!.textContent = entry.title || entry.url;

  const open = () => {
    let scheme = '';
    try { scheme = new URL(entry.url).protocol; } catch { return; }
    // replace(): the Back button must not return here and bounce forward again.
    if (scheme === 'http:' || scheme === 'https:') location.replace(entry.url);
    else if (scheme === 'chrome:') void chrome.tabs.getCurrent().then(tab => { if (tab?.id !== undefined) void chrome.tabs.update(tab.id, { url: entry.url }); });
  };
  // Only the selected tab may go to the site; a tab loading in the background waits here to be put to sleep.
  void chrome.tabs.getCurrent().then(tab => {
    if (tab?.active) { open(); return; }
    chrome.tabs.onActivated.addListener(({ tabId }) => { if (tabId === tab?.id) open(); });
  });
}
