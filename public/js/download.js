import { api, $, el, setMsg, toast, fmtDuration, markActiveNav, renderSetupStatus } from './common.js';
import * as localLib from './localLibrary.js';

markActiveNav();

// Written as escapes so the file encoding can never corrupt these glyphs.
const DOT = ' \u00b7 ';
const RECENT_KEY = 'vidgrab:recent';

const state = {
  quality: 1080,
  info: null,
  busy: false,
};

const urlInput = $('#url');
const bulkInput = $('#bulk');
const msg = $('#msg');
const preview = $('#preview');
const downloadBtn = $('#download');
const fastMode = $('#fastmode');

// ---------------------------------------------------------------- health

(async () => {
  const health = await renderSetupStatus();
  if (health?.tiers?.length) {
    // Highest tier the server reports, so the chips match what it can deliver.
    const top = health.tiers[health.tiers.length - 1].height;
    setQuality(Math.min(state.quality, top));
  }
  if (health?.ok === false) {
    setMsg(msg, 'The server has no video extractor installed, so downloads will fail. Redeploy the service to run the build step.', 'error');
    downloadBtn.disabled = true;
  }
})();

function setQuality(value) {
  state.quality = Number(value) || 1080;
  for (const chip of document.querySelectorAll('#quality .chip')) {
    chip.classList.toggle('active', Number(chip.dataset.v) === state.quality);
  }
  const note = $('#quality-note');
  if (!note) return;
  if (fastMode.checked) {
    note.textContent = `Up to ${Math.min(state.quality, 720)}p${DOT}redirects to YouTube's CDN`;
  } else {
    note.textContent = `Video + audio merged into one MP4${DOT}max ${state.quality}p`;
  }
}

$('#quality').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) setQuality(chip.dataset.v);
});

// Data-saver mode caps quality, because /save can only redirect to a file
// YouTube already serves muxed, and the highest of those is 720p.
fastMode.addEventListener('change', () => {
  setQuality(state.quality);
  if (fastMode.checked) {
    for (const chip of document.querySelectorAll('#quality .chip')) {
      if (Number(chip.dataset.v) > 720) chip.classList.add('disabled');
    }
  } else {
    for (const chip of document.querySelectorAll('#quality .chip')) chip.classList.remove('disabled');
  }
});

// -------------------------------------------------------------- preview

async function fetchInfo() {
  const raw = (bulkInput.value.trim() || urlInput.value.trim()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!raw.length) {
    setMsg(msg, 'Paste a YouTube link first.', 'error');
    return;
  }
  if (raw.length > 1) {
    state.info = null;
    preview.innerHTML = '';
    downloadBtn.disabled = false;
    setMsg(msg, `${raw.length} links ready. They will save one after another — your phone can only take so many at once.`, 'info');
    return;
  }

  setMsg(msg, 'Fetching video details\u2026', 'info');
  $('#fetch').disabled = true;
  try {
    const info = await api.post('/api/probe', { url: raw[0] });
    if (info.kind === 'playlist') {
      state.info = null;
      downloadBtn.disabled = true;
      setMsg(msg, `That is a playlist (${info.count} videos). Use the Playlist page to pick individual songs.`, 'warn');
      preview.innerHTML = '';
      return;
    }
    state.info = info;
    renderPreview(info);
    setMsg(msg, '');
    downloadBtn.disabled = false;
  } catch (err) {
    state.info = null;
    preview.innerHTML = '';
    downloadBtn.disabled = false;
    setMsg(msg, err?.message || 'Could not fetch video details.', 'error');
  } finally {
    $('#fetch').disabled = false;
  }
}

function renderPreview(info) {
  preview.innerHTML = '';
  preview.append(
    el(
      'div',
      { class: 'preview' },
      info.thumbnail ? el('img', { src: info.thumbnail, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-wrap' }),
      el(
        'div',
        { class: 'preview-body' },
        el('h3', {}, info.title),
        el(
          'div',
          { class: 'meta' },
          el('span', { class: 'badge badge-hd' }, `${state.quality}p max`),
          info.uploader ? el('span', {}, `by ${info.uploader}`) : null,
          info.duration ? el('span', {}, fmtDuration(info.duration)) : null,
        ),
      ),
    ),
  );
}

$('#fetch').addEventListener('click', fetchInfo);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchInfo();
});
urlInput.addEventListener('input', () => {
  if (!urlInput.value.trim() && !bulkInput.value.trim()) {
    state.info = null;
    preview.innerHTML = '';
    downloadBtn.disabled = true;
  }
});

// ------------------------------------------------------------- download

/**
 * Build the URL the browser is sent to.
 *
 * This must stay same-origin. Navigating to our /download route means the
 * response carries Content-Disposition, so the phone saves the file under its
 * real title. Handing the browser the raw cross-origin CDN URL instead would
 * navigate to the video and play it rather than save it.
 */
const TOKEN_KEY = 'vidgrab_token';

function accessToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function saveUrlFor(url) {
  const kind = 'video';
  const height = fastMode.checked ? Math.min(state.quality, 720) : state.quality;
  const route = fastMode.checked ? 'save' : 'download';
  const params = new URLSearchParams({ url, kind, height: String(height) });
  const token = accessToken();
  if (token) params.set('token', token);
  return `/${route}?${params.toString()}`;
}

async function recordHistory(url, title) {
  try {
    const t = title && title.trim() ? title.trim() : url;
    await localLib.upsert({ url, kind: 'video', title: t });
  } catch (e) {
    console.warn('local library upsert failed', e);
  }
}

function remember(title, url) {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    list = [];
  }
  const entry = { title: String(title || url).slice(0, 120), url, at: Date.now() };
  // De-dupe by link, newest first.
  list = [entry, ...list.filter((e) => e.url !== url)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private browsing: history is a nicety, not a requirement */
  }
  renderRecent();
}

function renderRecent() {
  const host = $('#recent');
  if (!host) return;
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    list = [];
  }
  host.innerHTML = '';
  if (!list.length) {
    host.append(el('div', { class: 'empty small' }, 'Nothing yet.'));
    return;
  }
  for (const item of list) {
    host.append(
      el(
        'div',
        { class: 'job' },
        el(
          'div',
          { class: 'job-top' },
          el('div', { class: 'job-title', title: item.title }, item.title),
          el('button', {
            class: 'icon-btn',
            title: 'Save again',
            onclick: () => { window.location.href = saveUrlFor(item.url); },
          }, '\u2b07'),
        ),
        el('div', { class: 'job-sub' }, el('span', { class: 'muted' }, new Date(item.at).toLocaleString())),
      ),
    );
  }
}

renderRecent();

/**
 * Kick off one save.
 *
 * There is no server-side job to poll: the browser owns the transfer and shows
 * its own progress, so all this does is navigate. The iframe trick would be
 * needed to save several files without leaving the page, but a plain navigation
 * is what actually triggers the download reliably on mobile, so bulk mode
 * opens each link directly and asks the user to come back.
 */
function save(url, title) {
  const t = title || state.info?.title || url;
  remember(t, url);
  recordHistory(url, t);
  window.location.href = saveUrlFor(url);
}

downloadBtn.addEventListener('click', () => {
  if (state.busy) return;
  const urls = (bulkInput.value.trim() || urlInput.value.trim()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!urls.length) return;

  const bad = urls.filter((u) => !/youtu|yt\.be|youtube\.com/i.test(u));
  if (bad.length) {
    setMsg(msg, `${bad.length} line(s) do not look like YouTube links.`, 'error');
    return;
  }

  if (urls.length > 1) {
    // Phones refuse or silently drop parallel downloads, so this saves the
    // first and queues the rest to be confirmed one at a time.
    state.busy = true;
    downloadBtn.disabled = true;
    setMsg(msg, `Saving the first of ${urls.length}. When it finishes, press Download again for the next one.`, 'info');
    remember(state.info?.title || urls[0], urls[0]);
    window.location.href = saveUrlFor(urls[0]);
    window.addEventListener('pageshow', () => {
      state.busy = false;
      bulkInput.value = urls.slice(1).join('\n');
      urlInput.value = '';
      downloadBtn.disabled = false;
      setMsg(msg, `${urls.length - 1} left. Press Download for the next one.`, 'info');
    }, { once: true });
    return;
  }

  save(urls[0]);
  setMsg(msg, 'Download started. Check your phone\u2019s Downloads folder.', 'ok');
});

// Coming back from a download should offer the next link rather than the old
// cleared form.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) return;
  const pending = bulkInput.value.trim().split(/\r?\n/).filter(Boolean);
  if (pending.length) downloadBtn.disabled = false;
});