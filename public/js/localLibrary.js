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

/**
 * Rows written before downloads were persisted.
 *
 * The Playlist page used to insert a library row for every track *before*
 * starting the transfer, and the transfer wrote nothing. Every one of those rows
 * claims `exists: true` and carries no `ref`, no `file` and no upload marker:
 * they are a promise the app never kept, and they are exactly why My Music looked
 * full of songs that answered "That file could not be played."
 *
 * They are downgraded rather than deleted, so the original link survives and
 * Download again still works. A row that does have a `ref` is a real file and is
 * left alone.
 */
function isPhantom(item) {
  if (!item || item.exists === false) return false;
  if (item.ref) return false;
  if (item.uploaded) return false;
  // A real file:// or content:// path counts as a file too.
  if (item.file && /^(file|content|blob|https?):/i.test(item.file)) return false;
  return true;
}

export async function load() {
  try {
    const value = await readRaw();
    const data = value ? JSON.parse(value) : [];
    if (!Array.isArray(data)) return [];

    let changed = false;
    const next = [];
    for (const item of data) {
      if (isPhantom(item)) {
        changed = true;
        next.push({ ...item, exists: false, missing: 'never downloaded' });
        continue;
      }
      next.push(item);
    }
    if (changed) {
      // Best effort: if this write fails the rows are still downgraded in
      // memory for this session, which is the part the user can see.
      await save(next).catch(() => {});
    }
    return next;
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
