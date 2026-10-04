import { api, $, el, setMsg, toast, fmtDuration, fmtBytes, markActiveNav, renderSetupStatus, extractId } from './common.js';
import * as localLib from './localLibrary.js';
import * as downloader from './downloader.js';

markActiveNav();

// Written as escapes so the file encoding can never corrupt these glyphs.
const DOT = ' \u00b7 ';
const RECENT_KEY = 'vidgrab:recent';

const state = {
  quality: 1080,
  info: null,
  busy: false,
  stopped: false,
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
 * The row a link is downloaded under.
 *
 * Kept next to save() so the Download button and "Save again" in the recent
 * list produce identical library rows, and therefore the same file on disk
 * instead of a second copy under a different name.
 */
function rowFor(url, title) {
  const mediaId = extractId(url);
  return {
    id: mediaId ? `yt_${mediaId}` : `yt_${Date.now().toString(36)}`,
    url,
    kind: 'video',
    title: title && title.trim() ? title.trim() : (state.info?.title || url),
    thumbnail: state.info?.thumbnail || null,
    duration: state.info?.duration || null,
    uploader: state.info?.uploader || null,
    ...(mediaId ? { mediaId, sourceUrl: url } : { sourceUrl: url }),
    height: fastMode.checked ? Math.min(state.quality, 720) : state.quality,
  };
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
            onclick: () => save(item.url, item.title),
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
 * There is no server-side job to poll and no navigation to make. The bytes are
 * fetched here through downloader.js and written to the device by store.js, so
 * the page can show real progress and a real failure. Navigating to /download
 * instead relied on the browser acting on Content-Disposition, which an Android
 * WebView silently ignores: the file was never written, and the app navigated
 * to a response it could not do anything with.
 *
 * `manageBusy` is false when a caller is already driving a sequence and is
 * holding the button itself.
 */
async function save(url, title, { manageBusy = true } = {}) {
  if (manageBusy) {
    if (state.busy) return;
    state.busy = true;
    downloadBtn.disabled = true;
  }
  remember(title || state.info?.title || url, url);

  const row = rowFor(url, title);

  const show = (text) => setMsg(msg, text, 'info');
  try {
    show('Starting\u2026');
    const { item } = await downloader.fetchAndSave(row, {
      onProgress: (p) => {
        if (p.phase === 'saving') show('Saving to your device\u2026');
        else if (p.total > 0) {
          show(`Downloading ${Math.round(p.percent)}% \u00b7 ${fmtBytes(p.loaded)} of ${fmtBytes(p.total)}`);
        } else show('Starting\u2026');
      },
    });
    await localLib.upsert(item);
    setMsg(msg, `Saved "${item.title}" (${fmtBytes(item.size)}) to your device.`, 'ok');
    toast('Saved to this device', 'ok');
  } catch (err) {
    if (err?.name === 'AbortError') {
      setMsg(msg, 'Download stopped.', 'warn');
    } else {
      setMsg(msg, err?.message || 'The download failed.', 'error');
    }
  } finally {
    if (manageBusy) {
      state.busy = false;
      downloadBtn.disabled = false;
    }
  }
}

downloadBtn.addEventListener('click', async () => {
  if (state.busy) return;
  const urls = (bulkInput.value.trim() || urlInput.value.trim()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!urls.length) return;

  const bad = urls.filter((u) => !/youtu|yt\.be|youtube\.com/i.test(u));
  if (bad.length) {
    setMsg(msg, `${bad.length} line(s) do not look like YouTube links.`, 'error');
    return;
  }

  if (urls.length > 1) {
    // One at a time. A phone asked to hold several transfers at once drops
    // most of them, so the list is worked through in order and the button turns
    // into a progress report instead of the page being navigated away.
    state.busy = true;
    downloadBtn.disabled = true;
    let done = 0;
    try {
      for (const url of urls) {
        if (state.stopped) break;
        setMsg(msg, `Saving ${done + 1} of ${urls.length}\u2026`, 'info');
        await save(url, done === 0 ? state.info?.title : null, { manageBusy: false });
        done += 1;
      }
    } finally {
      state.busy = false;
      downloadBtn.disabled = false;
    }
    if (done === urls.length) {
      setMsg(msg, `Saved ${done} link${done === 1 ? '' : 's'} to your device.`, 'ok');
    } else {
      setMsg(msg, `Saved ${done} of ${urls.length}. Check the messages above for problems.`, 'warn');
    }
    return;
  }

  await save(urls[0]);
});

// Stopping must not leave a half-written row in the library.
window.addEventListener('pagehide', () => downloader.cancel());
