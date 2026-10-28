// Loaded once per open DevTools window. The open port tells the worker this tab is being inspected,
// so it is neither discarded nor closed by a folder switch. The worker may restart: reconnect then.
const tabId = chrome.devtools.inspectedWindow.tabId;
function connect(): void {
  chrome.runtime.connect({ name: `devtools:${tabId}` }).onDisconnect.addListener(() => setTimeout(connect, 1000));
}
connect();
