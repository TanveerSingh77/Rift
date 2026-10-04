/**
 * The one way media gets onto the device.
 *
 * The previous implementation handed /download to a hidden iframe and hoped the
 * browser would honour the Content-Disposition header. It never did, on the two
 * platforms that matter here: an Android WebView has no download listener at
 * all, so the response was discarded in silence, and desktop browsers block
 * iframe-initiated downloads that have no user gesture behind them. Nothing was
 * written anywhere, while the library was updated to say the track was on disk.
 *
 * So the bytes are fetched here, in the page, where progress is visible and
 * failure is reportable, and handed to store.js. The library row is only
 * written after the file exists, which is what stops My Music from filling up
 * with entries that cannot be played.
 */

import * as store from './store.js';

const TOKEN_KEY = 'vidgrab_token';

function accessToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

/** The URL /download is asked for. Kept in one place so both callers match. */
export function requestUrl({ url, kind = 'video', height, audioFormat }) {
  const params = new URLSearchParams({ url, kind: kind === 'audio' ? 'audio' : 'video' });
  if (kind === 'audio') params.set('audioFormat', audioFormat || 'mp3');
  else if (height) params.set('height', String(height));
  const token = accessToken();
  if (token) params.set('token', token);
  return `/download?${params.toString()}`;
}

/** The server's real filename, out of the Content-Disposition header. */
function filenameFrom(res, fallback) {
  const header = res.headers.get('Content-Disposition') || '';
  // Prefer the RFC 5987 form: it is the only one that survives a title with
  // emoji or accents in it.
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return (plain ? plain[1].trim() : '') || fallback;
}

/** Read an error response, which is JSON when the server refused to start. */
async function errorFrom(res) {
  try {
    const data = await res.json();
    if (data && data.error) return String(data.error);
  } catch {
    /* not JSON */
  }
  return `The server refused the download (HTTP ${res.status}).`;
}

/**
 * Read a response body into one Blob, reporting progress as it goes.
 *
 * The body is piped through a TransformStream rather than accumulated in an
 * array of chunks: the bytes stay in the network stack until the Blob is built,
 * so a long track does not double its own size in JavaScript memory. The
 * fallback exists for WebViews without TransformStream.
 */
async function toBlob(res, total, onProgress) {
  const report = (loaded) => {
    if (onProgress) onProgress({ loaded, total });
  };

  if (res.body && typeof TransformStream === 'function') {
    let seen = 0;
    const meter = new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        report(seen);
        controller.enqueue(chunk);
      },
    });
    // The content type has to be re-attached here. Rebuilding a Response around
    // the stream to measure it discards the original headers, and an untyped
    // Blob makes store.js fall back to application/octet-stream -- which then
    // gets written into the library row and makes My Music mislabel every file
    // it downloads.
    const contentType = res.headers.get('Content-Type') || '';
    const blob = await new Response(res.body.pipeThrough(meter), {
      headers: contentType ? { 'Content-Type': contentType } : undefined,
    }).blob();
    report(blob.size);
    return blob;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    seen += value.byteLength;
    report(seen);
  }
  return new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' });
}

let active = null;

/** Abort whatever is in flight. Wired to the Cancel button. */
export function cancel() {
  if (active) active.abort();
}

export function isBusy() {
  return Boolean(active);
}

/**
 * Fetch one link and write it to the device.
 *
 * `onProgress` receives {loaded, total, percent, bytesPerSecond, phase} so a
 * caller can draw a progress bar without knowing how the transfer works. The
 * resolved value is the library row, complete with the `ref` that makes the file
 * real and playable.
 */
export async function fetchAndSave(item, { onProgress, signal } = {}) {
  const { url, kind = 'video' } = item;
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('That entry has no usable link.');

  const controller = new AbortController();
  active = controller;
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const startedAt = Date.now();
  let loaded = 0;
  const tick = (bytes, total, phase) => {
    if (!onProgress) return;
    const elapsed = Math.max(1, Date.now() - startedAt) / 1000;
    onProgress({
      loaded: bytes,
      total,
      percent: total > 0 ? Math.min(99, Math.round((bytes / total) * 100)) : 0,
      bytesPerSecond: bytes / elapsed,
      phase,
    });
  };

  try {
    tick(0, 0, 'connecting');

    // The token goes in the header rather than the query string: this is a
    // fetch, so there is no navigation to justify putting a secret in a URL
    // that ends up in proxy logs.
    const headers = {};
    const token = accessToken();
    if (token) headers['X-Vidgrab-Token'] = token;

    const res = await fetch(requestUrl(item), { headers, signal: controller.signal });
    if (!res.ok) throw new Error(await errorFrom(res));

    const filename = filenameFrom(res, `${item.title || 'download'}.${kind === 'audio' ? 'mp3' : 'mp4'}`);
    const declared = Number(res.headers.get('Content-Length')) || 0;

    tick(0, declared, 'downloading');
    const blob = await toBlob(res, declared, ({ loaded: bytes }) => tick(bytes, declared, 'downloading'));

    if (!blob.size) throw new Error('The transfer finished with no data. Try again.');
    tick(blob.size, blob.size, 'saving');

    // From here the track is on the device and playable whatever happens next.
    const saved = await store.save(item.id, blob, item.title || filename, filename);

    const row = {
      ...item,
      ref: saved.ref,
      store: saved.backend,
      uri: saved.uri || null,
      filename: saved.name,
      name: saved.name,
      mime: saved.mime,
      size: saved.size,
      // Set last, and only once bytes exist. This is the field every "is this
      // real?" check reads.
      exists: true,
      downloadedAt: Date.now(),
      file: saved.path || null,
    };

    tick(saved.size, saved.size, 'done');
    return { item: row, blob };
  } finally {
    if (active === controller) active = null;
  }
}

/**
 * Re-fetch a library row that lost its file.
 *
 * Used by "download again" and by the recovery path when the OS has cleared
 * app storage: the row keeps its id, so the re-download replaces it in place
 * instead of appearing twice in My Music.
 */
export async function redownload(item, options = {}) {
  store.forget(item.ref);
  return fetchAndSave({ ...item, ref: undefined, file: undefined }, options);
}
