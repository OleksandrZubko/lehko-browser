export const tab = (id, overrides = {}) => ({ id, url: `https://example.com/page/${id}`, title: `Tab ${id}`,
  windowId: 1, active: false, pinned: false, audible: false, incognito: false,
  status: 'complete', discarded: false, autoDiscardable: true, lastAccessed: id, ...overrides });

export function fakeChrome(initial = Array.from({ length: 10 }, (_, i) => tab(i + 1))) {
  const data = { local: {}, session: {}, tabs: structuredClone(initial), alarms: {}, calls: [], getHook: null, discardHook: null };
  function storage(name) {
    return {
      async get(key) { return { [key]: structuredClone(data[name][key]) }; },
      async set(value) { Object.assign(data[name], structuredClone(value)); }
    };
  }
  const api = {
    storage: { local: storage('local'), session: storage('session') },
    alarms: {
      async get(name) { return data.alarms[name]; },
      async create(name, options) { data.alarms[name] = options; }
    },
    tabs: {
      async query(query) {
        return structuredClone(data.tabs.filter(t => (!query.active || t.active) && (!query.lastFocusedWindow || t.windowId === 1)));
      },
      async get(id) {
        if (data.getHook) await data.getHook(id);
        const found = data.tabs.find(t => t.id === id);
        if (!found) throw new Error('No tab');
        return structuredClone(found);
      },
      async discard(id) {
        data.calls.push(id);
        if (data.discardHook) await data.discardHook(id);
        const found = data.tabs.find(t => t.id === id);
        if (!found || found.active || found.discarded) throw new Error('Cannot discard');
        found.discarded = true;
        return structuredClone(found);
      }
    }
  };
  return { api, data };
}
