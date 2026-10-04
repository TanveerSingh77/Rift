/**
 * Where downloaded media actually lives on the device.
 *
 * The server deliberately stores nothing: /download streams the bytes and that
 * is the whole point of the cloud bridge. Which left the app with rows in My
 * Music that pointed at files which never existed, and a player that asked for
 * /media/<nothing> and reported "That file could not be played." This module is
 * the missing half. It is the only copy of a downloaded track, so everything
 * that plays, re-saves or deletes a file goes through here.
 *
 * Two backends behind one API:
 *
 *  - native  — the device filesystem, via the Capacitor Filesystem plugin. Real
 *              files under Documents/VidGrab, visible to any file manager, any
 *              music app, and a USB cable. This is what "downloaded to my
 *              device" has to mean.
 *  - browser — IndexedDB. Same WebView code path, survives reloads and
 *              restarts, so playback still works when the plugin is absent.
 *
 * The plugin is looked up through the native bridge first and imported lazily
 * second. A bare `import '@capacitor/filesystem'` cannot be resolved by a
 * browser, and this app has no bundler, so a static import would break every
 * page that loads this module in the web build.
 */

const FOLDER = 'VidGrab';

/** Object URLs are cached per ref so repeated plays do not re-read the file. */
const urlCache = new Map();

function isNative() {
  return Boolean(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
}

/**
 * The Filesystem plugin, or null.
 *
 * Capacitor's native bridge installs a `Capacitor.Plugins` proxy backed by the
 * registered native handles, so on a real build this needs no bundler at all.
 * The dynamic import is kept as a second chance for a future bundled build.
 */
let fsPlugin = null;
let fsTried = false;
async function files() {
  if (fsTried) return fsPlugin;
  fsTried = true;
  if (!isNative()) return null;
  const bridged = globalThis.Capacitor?.Plugins?.Filesystem;
  if (bridged && typeof bridged.writeFile === 'function') {
    fsPlugin = bridged;
    return fsPlugin;
  }
  try {
    const mod = await import('@capacitor/filesystem');
    fsPlugin = mod?.Filesystem || null;
  } catch {
    fsPlugin = null;
  }
  return fsPlugin;
}

/** Directory.Documents, resolved without importing the enum up front. */
async function documentsDir() {
  const fs = await files();
  if (!fs) return null;
  const mod = await import('@capacitor/filesystem').catch(() => null);
  const dir = mod?.Directory?.Documents ?? 'DOCUMENTS';
  return { fs, dir };
}

// --------------------------------------------------------------- filenames

/**
 * A filename that is unique per track but still recognisable in a file manager.
 *
 * The title alone is not enough: playlists routinely contain two different
 * songs with the same name, and the second one would silently overwrite the
 * first. The YouTube id disambiguates without turning the name into noise.
 */
function buildFilename(title, id, ext) {
  const base = String(title || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'download';
  const suffix = String(id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 12);
  const cleanExt = String(ext || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
  return suffix ? `${base} [${suffix}].${cleanExt}` : `${base}.${cleanExt}`;
}

function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

// ------------------------------------------------------------ base64 helper

/**
 * Blob -> base64, in slices.
 *
 * The Filesystem plugin takes base64 rather than binary data. A single
 * String.fromCharCode(...bytes) throws on a multi-megabyte song because it
 * overflows the argument limit, so this walks the buffer in 32KB pieces.
 */
async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64, mime) {
  const binary = atob(b64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

// -------------------------------------------------------------- indexeddb

const DB_NAME = 'vidgrab_media';
const DB_VERSION = 1;
const STORE = 'files';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('no indexeddb'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }),
  );
}

// ------------------------------------------------------------------- public

/** Which backend is in use, for the settings screen. */
export async function backend() {
  const native = await documentsDir();
  if (native) return 'device';
  try {
    await openDb();
    return 'app';
  } catch {
    return 'none';
  }
}

/**
 * Write a finished download to the device and return the reference the library
 * row needs. Falls back from device files to IndexedDB without the caller
 * having to care, because a track that cannot be written is still a track the
 * user paid bandwidth for and should be able to play.
 */
export async function save(id, blob, title, fallbackExt) {
  const name = buildFilename(title, id, extOf(fallbackExt) || fallbackExt || 'mp3');
  const mime = blob.type || 'application/octet-stream';

  const native = await documentsDir();
  if (native) {
    const path = `${FOLDER}/${name}`;
    try {
      // Replace rather than merge: a re-download of the same track must not
      // leave the tail of the previous, longer, file behind it.
      await native.fs.writeFile({
        path,
        data: await toBase64(blob),
        directory: native.dir,
        recursive: true,
      });
      const where = await native.fs.getUri({ path, directory: native.dir }).catch(() => null);
      return {
        backend: 'device',
        ref: `${FOLDER}/${name}`,
        path,
        uri: where?.uri || null,
        name,
        mime,
        size: blob.size,
      };
    } catch (err) {
      console.warn('[store] device write failed, using app storage', err);
    }
  }

  await tx('readwrite', (s) => s.put({ id, blob, name, mime, size: blob.size }));
  return { backend: 'app', ref: `idb:${id}`, name, mime, size: blob.size };
}

/** The stored bytes, or null if they are gone. */
export async function read(ref, mime) {
  if (!ref) return null;
  if (ref.startsWith('idb:')) {
    try {
      const row = await tx('readonly', (s) => s.get(ref.slice(4)));
      return row?.blob || null;
    } catch {
      return null;
    }
  }
  const native = await documentsDir();
  if (native) {
    try {
      const { data } = await native.fs.readFile({ path: ref, directory: native.dir });
      return fromBase64(data, mime);
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether the bytes are still on the device. */
export async function has(ref) {
  if (!ref) return false;
  if (ref.startsWith('idb:')) {
    try {
      const row = await tx('readonly', (s) => s.get(ref.slice(4)));
      return Boolean(row?.blob);
    } catch {
      return false;
    }
  }
  const native = await documentsDir();
  if (!native) return false;
  try {
    const info = await native.fs.stat({ path: ref, directory: native.dir });
    return Number(info?.size || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * An object URL for <audio>/<video>, cached.
 *
 * A file:// URI is preferred when the plugin offers one: it streams, so a large
 * video never has to be pulled through JavaScript to start playing. Object URLs
 * are the fallback and are only revoked when the same track is replaced.
 */
export async function url(ref, mime) {
  if (!ref) return null;

  if (!ref.startsWith('idb:')) {
    const native = await documentsDir();
    if (native) {
      try {
        const got = await native.fs.getUri({ path: ref, directory: native.dir });
        if (got?.uri) return got.uri;
      } catch {
        /* fall through to the blob copy */
      }
    }
  }

  if (urlCache.has(ref)) return urlCache.get(ref);
  const blob = await read(ref, mime);
  if (!blob) return null;
  const objectUrl = URL.createObjectURL(blob);
  urlCache.set(ref, objectUrl);
  return objectUrl;
}

/** Forget a cached object URL. Called when a track is deleted or re-downloaded. */
export function forget(ref) {
  const cached = urlCache.get(ref);
  if (cached) {
    URL.revokeObjectURL(cached);
    urlCache.delete(ref);
  }
}

/** Delete the stored file. Missing files are not an error. */
export async function remove(ref) {
  forget(ref);
  if (!ref) return;
  if (ref.startsWith('idb:')) {
    try {
      await tx('readwrite', (s) => s.delete(ref.slice(4)));
    } catch {
      /* already gone */
    }
    return;
  }
  const native = await documentsDir();
  if (!native) return;
  try {
    await native.fs.deleteFile({ path: ref, directory: native.dir });
  } catch {
    /* already gone */
  }
}

/** A human-readable location, so "reveal" can tell the user where the file is. */
export async function locationOf(ref) {
  if (!ref) return '';
  if (ref.startsWith('idb:')) return 'inside the VidGrab app';
  const native = await documentsDir();
  if (native) {
    try {
      const got = await native.fs.getUri({ path: ref, directory: native.dir });
      if (got?.uri) return decodeURIComponent(String(got.uri).replace(/^file:\/\//, ''));
    } catch {
      /* fall through */
    }
  }
  return ref;
}

/**
 * A playable source for a library row, or null.
 *
 * Order matters. Stored bytes first, because that is the download. Then the
 * original YouTube link streamed back through /download, so a row whose file
 * was cleared by the OS is still playable instead of raising "That file could
 * not be played." Only when there is no link either does this give up.
 */
export async function playableUrl(item) {
  if (!item) return null;
  if (item.ref) {
    const direct = await url(item.ref, item.mime);
    if (direct) return direct;
  }
  if (item.file && /^(file|content|https?):/i.test(item.file)) return item.file;
  if (item.url && /^https?:\/\//i.test(item.url)) {
    const params = new URLSearchParams({ url: item.url, kind: item.kind === 'video' ? 'video' : 'audio' });
    if (item.kind !== 'video') params.set('audioFormat', item.audioFormat || 'mp3');
    if (item.height) params.set('height', String(item.height));
    let token = '';
    try {
      token = localStorage.getItem('vidgrab_token') || '';
    } catch {
      token = '';
    }
    if (token) params.set('token', token);
    return `/download?${params.toString()}`;
  }
  return null;
}

/**
 * Hand the file to the operating system's own "save" flow.
 *
 * On a device build the file is already in Documents, so there is nothing to
 * copy and the user is told where to look. In a browser this is the anchor
 * download that puts it in the Downloads folder.
 */
export async function exportToDevice(item) {
  const ref = item?.ref;
  if (ref && !ref.startsWith('idb:')) {
    return locationOf(ref);
  }
  const objectUrl = ref ? await url(ref, item.mime) : null;
  if (!objectUrl) return '';
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = item.name || item.filename || 'download';
  document.body.append(a);
  a.click();
  a.remove();
  return '';
}
