/**
 * Local library store.
 *
 * The Capacitor plugin is imported lazily and only on a native build. A static
 * `import '@capacitor/preferences'` is a bare specifier, which a browser cannot
 * resolve without an import map, so the module failed to load in the web app
 * and took every page that imports it with it: Download, Playlist, My Music and
 * My Videos. That is why the Fetch and Load buttons did nothing at all.
 */

const KEY = 'vidgrab_library_v1';

const isNative = () => Boolean(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());

let prefsPromise = null;

/** The native Preferences plugin, or null in a browser. */
function prefs() {
  if (!isNative()) return Promise.resolve(null);
  if (!prefsPromise) prefsPromise = import('@capacitor/preferences').catch(() => null);
  return prefsPromise;
}

async function readRaw() {
  const plugin = await prefs();
  if (plugin && plugin.Preferences) {
    const { value } = await plugin.Preferences.get({ key: KEY });
    return value || null;
  }
  try {
    return globalThis.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

async function writeRaw(value) {
  const plugin = await prefs();
  if (plugin && plugin.Preferences) {
    await plugin.Preferences.set({ key: KEY, value });
    return;
  }
  try {
    globalThis.localStorage.setItem(KEY, value);
  } catch {
    /* private browsing: history is a nicety, not a requirement */
  }
}

function now() {
  return Date.now();
}

function genId() {
  return 'vl_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function load() {
  try {
    const value = await readRaw();
    const data = value ? JSON.parse(value) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function save(items) {
  await writeRaw(JSON.stringify(items));
}

export async function upsert(entry) {
  const items = await load();
  const idx = items.findIndex((i) => i.id === entry.id);
  if (idx >= 0) items[idx] = { ...items[idx], ...entry, updatedAt: now() };
  else items.unshift({ id: genId(), addedAt: now(), updatedAt: now(), ...entry });
  await save(items);
  return items[idx] ?? items[0];
}

export async function add(entry) {
  return upsert(entry);
}

export async function update(id, patch) {
  const items = await load();
  const idx = items.findIndex((i) => i.id === id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...patch, updatedAt: now() };
    await save(items);
  }
  return items[idx] || null;
}

export async function remove(id) {
  const items = await load();
  const next = items.filter((i) => i.id !== id);
  await save(next);
  return next.length !== items.length;
}

export async function clear() {
  await save([]);
}

export async function findByUrl(url, kind) {
  const items = await load();
  return items.find((i) => i.url === url && (!kind || i.kind === kind)) || null;
}
