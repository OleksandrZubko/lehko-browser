// A sleeping folder tab is this extension page, discarded. A committed page keeps its title and icon in the tab strip
// after discard, and the site itself gets no request until the tab is opened. Everything outside the tab strip sees the real address.
const LAZY = /^chrome-extension:\/\/[a-p]{32}\/lazy\.html\?/;

export interface LazyEntry { url: string; title: string; }

export function lazyPageUrl(base: string, entry: LazyEntry): string {
  return `${base}?${new URLSearchParams({ url: entry.url, title: entry.title })}`;
}
export function unwrapLazy(url: string | undefined): LazyEntry | undefined {
  if (!url || !LAZY.test(url)) return undefined;
  const params = new URL(url).searchParams;
  const real = params.get('url');
  return real ? { url: real, title: params.get('title') ?? '' } : undefined;
}
