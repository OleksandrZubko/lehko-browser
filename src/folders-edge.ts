// Runs in every top-level web page: a thin strip on the left edge that slides the folder panel out on hover.
// Nothing but the strip exists until the first hover, so an unused page pays for one element and two listeners.
(() => {
  const WIDTH = 300, STRIP = 4, OPEN_DELAY = 120, CLOSE_DELAY = 400;
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; inset: 0 auto 0 0; z-index: 2147483647; width: 0; height: 100vh;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .strip { position: fixed; inset: 0 auto 0 0; width: ${STRIP}px; }
    .panel { position: fixed; inset: 0 auto 0 0; width: ${WIDTH}px; transform: translateX(-100%); transition: transform .16s ease-out;
      box-shadow: none; background: #f4f5ef; }
    .panel.open { transform: none; box-shadow: 2px 0 14px rgb(0 0 0 / .22); }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
    @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }`;
  const strip = document.createElement('div');
  strip.className = 'strip';
  const panel = document.createElement('div');
  panel.className = 'panel';
  root.append(style, strip, panel);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (job: () => void, ms: number) => { clearTimeout(timer); timer = setTimeout(job, ms); };
  const open = () => {
    if (!panel.firstChild) {
      const frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('folders-panel.html');
      frame.title = 'Папки';
      panel.append(frame);
    }
    panel.classList.add('open');
  };
  const close = () => panel.classList.remove('open');

  // A held button means a drag or text selection reaching the edge, not a request for the panel.
  strip.addEventListener('mouseenter', event => { if (!event.buttons) later(open, OPEN_DELAY); });
  // A quick flick can leave the strip without ever entering the panel, so this closes an open panel too.
  strip.addEventListener('mouseleave', () => {
    if (panel.classList.contains('open')) later(close, CLOSE_DELAY); else clearTimeout(timer);
  });
  panel.addEventListener('mouseenter', () => clearTimeout(timer));
  panel.addEventListener('mouseleave', () => later(close, CLOSE_DELAY));
  document.addEventListener('fullscreenchange', () => { host.style.display = document.fullscreenElement ? 'none' : ''; });

  const apply = (enabled: unknown) => {
    if (enabled === false) { close(); host.remove(); } else if (!host.isConnected) document.documentElement.append(host);
  };
  void chrome.storage.local.get('folderEdge').then(({ folderEdge }) => apply(folderEdge));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.folderEdge) apply(changes.folderEdge.newValue); });
})();
