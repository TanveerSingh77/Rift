import { Preferences } from '@capacitor/preferences';

const KEY = 'vidgrab_library_v1';

function now() {
  return Date.now();
}

function genId() {
  return 'vl_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function load() {
  try {
    const { value } = await Preferences.get({ key: KEY });
    const data = value ? JSON.parse(value) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function save(items) {
  try {
    await Preferences.set({ key: KEY, value: JSON.stringify(items) });
  } catch {
    /* ignore quota */
  }
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
