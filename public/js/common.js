import * as store from './store.js';

export const api = {
  async req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },
  get(url) {
    return this.req('GET', url);
  },
  post(url, body) {
    return this.req('POST', url, body ?? {});
  },
  put(url, body) {
    return this.req('PUT', url, body ?? {});
  },
  del(url) {
    return this.req('DELETE', url);
  },
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'html') node.innerHTML = value;
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.ceil(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s}s left`;
  return `${s}s left`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtSpeed(bytesPerSec) {
  return bytesPerSec > 0 ? `${fmtBytes(bytesPerSec)}/s` : '';
}

export function fmtWhen(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function toast(message, kind = 'info', ms = 5000) {
  let host = $('#toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host', style: 'position:fixed;right:18px;bottom:18px;z-index:200;display:flex;flex-direction:column;gap:8px;max-width:340px' });
    document.body.append(host);
  }
  const node = el('div', { class: `msg show msg-${kind}`, style: 'box-shadow:var(--shadow)' }, message);
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, ms);
}

export function setMsg(node, message, kind = 'info') {
  if (!node) return;
  if (!message) {
    node.className = 'msg';
    node.textContent = '';
    return;
  }
  node.className = `msg show msg-${kind}`;
  node.textContent = message;
}

export function extractId(url) {
  const patterns = [/[?&]v=([\w-]{6,})/, /youtu\.be\/([\w-]{6,})/, /\/shorts\/([\w-]{6,})/, /\/embed\/([\w-]{6,})/];
  for (const re of patterns) {
    const m = String(url).match(re);
    if (m) return m[1];
  }
  return null;
}

export function thumbUrl(item) {
  if (item.thumb) return `/media/${encodeURI(item.thumb)}`;
  if (item.mediaId) return `https://i.ytimg.com/vi/${item.mediaId}/mqdefault.jpg`;
  return null;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function markActiveNav() {
  const page = location.pathname.replace(/^\/|\/$/g, '') || 'index.html';
  for (const link of $$('.nav-link')) {
    // Toggle rather than add, so client-side navigation cannot leave several
    // links highlighted at once.
    link.classList.toggle('active', link.getAttribute('href') === page);
  }
}

/**
 * Save a library item to the device again.
 *
 * The file is already on the device, so this is a no-op that reports where the
 * file lives. The old version fired a hidden iframe at /download, which is what
 * made re-saving appear to work on desktop while writing nothing on a phone.
 */
export async function saveToDevice(item) {
  if (!item) return '';
  try {
    const where = await store.exportToDevice(item);
    if (where) {
      toast(`Already saved on this device: ${where}`, 'info', 7000);
    } else {
      toast('Saved to your Downloads folder.', 'ok');
    }
    return where;
  } catch (err) {
    console.warn('[save] export failed', err);
    toast('Could not save that file again.', 'error');
    return '';
  }
}

/**
 * Point the user at the file on disk.
 *
 * Reports the real path now that there is a real file. The /api/reveal route is
 * gone from this bridge by design: there is no server-side library to open a
 * file manager for.
 */
export async function revealInFolder(item) {
  if (!item) return;
  const where = await store.locationOf(item.ref).catch(() => '');
  if (where) {
    toast(where, 'info', 8000);
    return;
  }
  if (item.url && /^https?:\/\//i.test(item.url)) {
    toast('This track is not downloaded yet. Download it first.', 'info');
    return;
  }
  toast('No file on disk for that item.', 'warn');
}

/**
 * Renders the server status line at the bottom of the sidebar.
 *
 * The sidebar is shared and is never replaced by client-side navigation, so
 * every page must use the same element id for it and must tolerate its absence.
 */
const WARN = '\u26a0';
const TICK = '\u2714';

export async function renderSetupStatus() {
  const box = $('#setup-status');
  if (!box) return { ok: true };
  try {
    const health = await api.get('/api/health');
    const { ytdlp, ffmpeg } = health.setup || {};
    // A <span> separator rather than <br> so the same markup works as a
    // single-line pill in the mobile header.
    const sep = '<span class="sep">\u00b7</span>';
    if (!ytdlp || !ytdlp.found) {
      box.innerHTML = `${WARN} <span style="color:var(--warn)">extractor missing</span>${sep}<span class="muted">redeploy to build</span>`;
      return { ...health, ok: false, reason: 'ytdlp' };
    }
    if (!ffmpeg || !ffmpeg.found) {
      // Still usable, just no video+audio merge and no MP3.
      box.innerHTML = `${WARN} <span style="color:var(--warn)">no ffmpeg</span>${sep}<span class="muted">720p only</span>`;
      return { ...health, ok: true, reason: 'ffmpeg' };
    }
    box.innerHTML = `${TICK} ready${sep}<span class="muted">${ffmpeg.found ? 'merged MP4' : 'direct'}</span>`;
    return { ...health, ok: true };
  } catch {
    box.textContent = 'server not reachable';
    return { ok: false, reason: 'offline' };
  }
}