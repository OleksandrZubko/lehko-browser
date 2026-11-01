// Runs in every top-level web page: a thin strip on each side edge that slides the folder panel out on hover.
// Nothing but the strip exists until the first hover, so an unused page pays for one element and two listeners.
(() => {
  // The right strip is thinner so that it leaves the page's scrollbar usable.
  const WIDTH = 300, STRIP = 4, STRIP_RIGHT = 2, OPEN_DELAY = 120, CLOSE_DELAY = 400;
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; inset: 0 auto 0 0; z-index: 2147483647; width: 0; height: 100vh;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .strip { position: fixed; inset: 0 auto 0 0; width: ${STRIP}px; }
    .strip.right { inset: 0 0 0 auto; width: ${STRIP_RIGHT}px; }
    .panel { position: fixed; inset: 0 auto 0 0; width: ${WIDTH}px; transform: translateX(-100%); transition: transform .16s ease-out;
      box-shadow: none; background: #f4f5ef; }
    .panel.open { transform: none; box-shadow: 2px 0 14px rgb(0 0 0 / .22); }
    .panel.right { inset: 0 0 0 auto; transform: translateX(100%); }
    .panel.right.open { transform: none; box-shadow: -2px 0 14px rgb(0 0 0 / .22); }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
    @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }`;
  const strip = document.createElement('div');
  strip.className = 'strip';
  const panel = document.createElement('div');
  panel.className = 'panel';
  const stripRight = document.createElement('div');
  stripRight.className = 'strip right';
  root.append(style, strip, stripRight, panel);

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
    document.addEventListener('mousemove', leftPanel, true);
  };
  const close = () => {
    panel.classList.remove('open');
    document.removeEventListener('mousemove', leftPanel, true);
  };
  // The panel's frame is another process: when the pointer leaves it for the toolbar or another window, or a page
  // swallows the events, this document may hear nothing. So the frame reports its own edges, and any move past the panel counts.
  const leftPanel = (event: MouseEvent) => {
    const outside = panel.classList.contains('right') ? event.clientX < innerWidth - WIDTH : event.clientX > WIDTH;
    if (outside) later(close, CLOSE_DELAY);
  };

  // A held button means a drag or text selection reaching the edge, not a request for the panel.
  for (const edge of [strip, stripRight]) {
    edge.addEventListener('mouseenter', event => {
      if (event.buttons) return;
      if (!panel.classList.contains('open')) panel.classList.toggle('right', edge === stripRight);
      later(open, OPEN_DELAY);
    });
    // A quick flick can leave the strip without ever entering the panel, so this closes an open panel too.
    edge.addEventListener('mouseleave', () => {
      if (panel.classList.contains('open')) later(close, CLOSE_DELAY); else clearTimeout(timer);
    });
  }
  panel.addEventListener('mouseenter', () => clearTimeout(timer));
  panel.addEventListener('mouseleave', () => later(close, CLOSE_DELAY));
  document.documentElement.addEventListener('mouseleave', () => { if (panel.classList.contains('open')) later(close, CLOSE_DELAY); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  window.addEventListener('message', event => {
    const frame = panel.firstChild as HTMLIFrameElement | null;
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data === 'lehko-panel-leave') later(close, CLOSE_DELAY);
    else if (event.data === 'lehko-panel-enter') clearTimeout(timer);
  });
  document.addEventListener('fullscreenchange', () => { host.style.display = document.fullscreenElement ? 'none' : ''; });

  const apply = (enabled: unknown) => {
    if (enabled === false) { close(); host.remove(); } else if (!host.isConnected) document.documentElement.append(host);
  };
  void chrome.storage.local.get('folderEdge').then(({ folderEdge }) => apply(folderEdge));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.folderEdge) apply(changes.folderEdge.newValue); });
})();
