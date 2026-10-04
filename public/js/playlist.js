import { api, $, el, setMsg, toast, fmtDuration, fmtBytes, fmtSpeed, fmtRemaining, markActiveNav, renderSetupStatus } from './common.js';
import { onCleanup } from './app.js';
import * as localLib from './localLibrary.js';

markActiveNav();

const state = { playlist: null, selected: new Set(), kind: 'audio', poll: null, stopped: false, seen: new Set() };
const msg = $('#msg');

(async () => {
  try {
    await renderSetupStatus();

    // Only the recently used playlists are remembered here; finished music
    // downloads live in My Music, not on this page.
    const recent = await api.get('/api/playlists');
    if (Array.isArray(recent) && recent.length) {
      const box = $('#recent');
      box.append(el('div', { class: 'small muted', style: 'margin-top:6px' }, 'Recent playlists:'));
      const chips = el('div', { class: 'chips', style: 'margin-top:8px' });
      for (const p of recent.slice(0, 6)) {
        chips.append(el('div', { class: 'chip', onclick: () => { $('#url').value = `https://www.youtube.com/playlist?list=${p.playlistId}`; load(); } }, `${p.title} (${p.count})`));
      }
      box.append(chips);
    }

    // Used only for the "have it" badge next to each playlist entry.
    const library = await api.get('/api/library?kind=audio');
    const owned = Array.isArray(library?.items) ? library.items : [];
    window.__ownedIds = new Set(owned.filter((i) => i.mediaId && i.exists !== false).map((i) => i.mediaId));
    state.libraryCount = owned.filter((i) => i.exists !== false).length;
  } catch { /* ignore */ }
  startPolling();
})();

$('#load').addEventListener('click', load);
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

async function load() {
  const url = $('#url').value.trim();
  if (!url) {
    setMsg(msg, 'Paste a playlist link first.', 'error');
    return;
  }
  $('#load').disabled = true;
  setMsg(msg, 'Reading playlist… this can take a few seconds.', 'info');
try {
    const info = await api.post('/api/playlist', { url });
    const entries = Array.isArray(info.entries) ? info.entries : [];
    if (!entries.length) {
      state.playlist = null;
      $('#list').hidden = true;
      setMsg(msg, 'That playlist is empty, or every track in it is private.', 'warn');
      return;
    }
    state.playlist = { ...info, entries };
    state.selected = new Set(entries.map((e) => e.id));
    $('#pl-title').textContent = info.title;
    $('#pl-sub').textContent = `${entries.length} songs${info.uploader ? ` \u00b7 ${info.uploader}` : ''}`;
    renderRows();
    $('#list').hidden = false;
    setMsg(msg, '', 'info');
    if (window.__ownedIds) renderRows();
  } catch (err) {
    setMsg(msg, err?.message || 'Could not read that playlist.', 'error');
  } finally {
    $('#load').disabled = false;
  }
}

function renderRows() {
  const box = $('#rows');
  box.innerHTML = '';
  const owned = new Set((window.__ownedIds || []));
  for (const entry of state.playlist.entries) {
    const row = el(
      'label',
      { class: `pl-row${state.selected.has(entry.id) ? ' sel' : ''}` },
      el('input', {
        type: 'checkbox',
        checked: state.selected.has(entry.id),
        onchange: (e) => {
          if (e.target.checked) state.selected.add(entry.id);
          else state.selected.delete(entry.id);
          row.classList.toggle('sel', e.target.checked);
          updateSel();
        },
      }),
      entry.thumbnail ? el('img', { src: entry.thumbnail, loading: 'lazy', alt: '' }) : el('div', {}),
      el(
        'div',
        { class: 'info' },
        el('div', { class: 't', title: entry.title }, entry.title),
        el('div', { class: 's' }, [entry.uploader, entry.duration ? fmtDuration(entry.duration) : null].filter(Boolean).join(' · ') || 'unknown'),
      ),
      owned.has(entry.id) ? el('span', { class: 'badge' }, 'have it') : null,
    );
    box.append(row);
  }
  updateSel();
}

function updateSel() {
  const picked = state.playlist.entries.filter((e) => state.selected.has(e.id));
  $('#sel-count').textContent = `${picked.length} song${picked.length === 1 ? '' : 's'} selected`;
  const secs = picked.reduce((sum, e) => sum + (e.duration || 0), 0);
  $('#sel-size').textContent = secs ? `${fmtDuration(secs)} total` : '';
  $('#start').disabled = picked.length === 0;
}

$('#select-all').addEventListener('click', () => setAll(true));
$('#select-none').addEventListener('click', () => setAll(false));
$('#select-short').addEventListener('click', () => {
  state.selected = new Set(state.playlist.entries.filter((e) => (e.duration || 0) > 0 && e.duration <= 300).map((e) => e.id));
  renderRows();
});

function setAll(on) {
  state.selected = on ? new Set(state.playlist.entries.map((e) => e.id)) : new Set();
  renderRows();
}

$('#format').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.kind = chip.dataset.f;
  for (const c of document.querySelectorAll('#format .chip')) c.classList.toggle('active', c === chip);
});

/**
 * Start a download for every ticked track.
 *
 * Each transfer is handed to a hidden iframe rather than window.open. A popup
 * is blocked once the click gesture has been consumed, which would have left
 * every track after the first one unsaved, and it navigates the user away from
 * the list. An iframe fires the same same-origin request and the browser still
 * honours the Content-Disposition header, so the file lands in the device's
 * Downloads folder under its real title while this page stays put.
 *
 * Nothing is written to the server: /download pipes the media straight through.
 */
const TRACK_GAP_MS = 350;

/** A track row rendered off-screen, so the browser treats it as a download. */
function triggerDownload(url) {
  const frame = el('iframe', { src: url, 'aria-hidden': 'true', style: 'position:absolute;width:0;height:0;border:0;visibility:hidden' });
  document.body.append(frame);
  setTimeout(() => frame.remove(), 120000);
}

/**
 * The library record for a track.
 *
 * `id` is derived from the YouTube id so saving the same song twice updates the
 * existing row instead of adding a duplicate. `mediaId` is what the Music and
 * Videos grids read to draw artwork.
 */
function libraryEntry(entry, kind) {
  return {
    id: `yt_${entry.id}`,
    url: entry.url,
    kind,
    title: entry.title,
    thumbnail: entry.thumbnail,
    duration: entry.duration,
    uploader: entry.uploader,
    mediaId: entry.id,
    sourceUrl: entry.url,
    exists: true,
  };
}

$('#start').addEventListener('click', async () => {
  if (!state.playlist) return;
  const kind = state.kind === 'video' ? 'video' : 'audio';
  // `url` is required: without it the request would be built as url=undefined
  // and rejected by the server.
  const entries = state.playlist.entries.filter((e) => state.selected.has(e.id) && e.url);
  if (!entries.length) {
    setMsg(msg, 'None of the ticked tracks have a usable link.', 'error');
    return;
  }

  const button = $('#start');
  const label = kind === 'audio' ? 'song' : 'video';
  button.disabled = true;
  setMsg(msg, `Sending ${entries.length} ${label}${entries.length === 1 ? '' : 's'} to this device\u2026`, 'info');

  let registered = 0;
  for (const entry of entries) {
    if (state.stopped) break;
    // Registered first so the track appears in My Music / My Videos straight
    // away, whichever way the transfer itself goes.
    try {
      await localLib.upsert(libraryEntry(entry, kind));
      registered += 1;
      if (window.__ownedIds) window.__ownedIds.add(entry.id);
    } catch (e) {
      console.warn('local lib upsert failed', e);
    }
    triggerDownload(buildStreamUrl(entry, kind));
    await new Promise((resolve) => setTimeout(resolve, TRACK_GAP_MS));
  }

  if (state.stopped) return;
  const where = kind === 'audio' ? 'My Music' : 'My Videos';
  button.disabled = false;
  state.selected.clear();
  renderRows();
  setMsg(msg, `Sent ${registered} of ${entries.length} ${label}${entries.length === 1 ? '' : 's'} to your device. They are listed in ${where} now.`, 'ok');
  toast(`Saved to this device \u00b7 check ${where}`, 'ok');
});

const TOKEN_KEY = 'vidgrab_token';
function accessToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * The URL one track is saved from.
 *
 * /download rather than /save: it is same-origin, so the response carries
 * Content-Disposition and the file is written under its real title with the
 * right extension. A redirect cannot set that header, and for music it would
 * hand back whatever container YouTube chose (an .m4a) instead of the mp3 the
 * Music page expects.
 */
function buildStreamUrl(entry, kind) {
  const params = new URLSearchParams({ url: entry.url, kind });
  if (kind === 'audio') params.set('audioFormat', 'mp3');
  const token = accessToken();
  if (token) params.set('token', token);
  return `/download?${params.toString()}`;
}

async function renderQueue() {
  const jobs = (await api.get('/api/jobs')).filter((j) => j.kind === 'audio');
  // Only the live queue; finished jobs are gone from this list.
  const active = jobs.filter(isActive);
  const pending = active.reduce((sum, j) => sum + pendingItems(j), 0);
  const downloaded = state.libraryCount || 0;

  const countBox = $('#job-count');
  if (countBox) {
    countBox.innerHTML = active.length
      ? `<span style="color:var(--ok)">${downloaded} downloaded</span> · <span style="color:var(--accent-2)">${pending} left</span>`
      : `<span style="color:var(--ok)">${downloaded} downloaded</span> · <span class="muted">queue empty</span>`;
  }

  const box = $('#jobs');
  box.innerHTML = '';
  if (!active.length) {
    box.append(el('div', { class: 'empty small' }, 'Queue is empty. Downloaded songs are in My Music.'));
  } else {
    for (const job of active.slice(0, 6)) {
      const pct = Math.round(job.overallPercent);
      const cur = job.items.find((i) => i.status === 'running') || job.items[job.index] || job.items[job.items.length - 1];
      const left = pendingItems(job);

      const bits = [];
      if (cur && cur.total > 0) bits.push(`${fmtBytes(cur.bytes)} / ${fmtBytes(cur.total)}`);
      if (cur && cur.speed > 0) bits.push(fmtSpeed(cur.speed));
      if (cur && cur.eta > 0 && cur.phase === 'downloading') bits.push(`${fmtRemaining(cur.eta)} left`);

      const label = job.status === 'cancelling'
        ? 'cancelling…'
        : job.status === 'queued'
          ? 'queued'
          : job.items.length > 1
            ? `song ${Math.min(job.index + 1, job.items.length)} of ${job.items.length}`
            : cur?.phase === 'converting'
              ? 'converting'
              : cur?.phase === 'finishing'
                ? 'finishing up'
                : 'downloading';

      box.append(
        el(
          'div',
          { class: 'job' },
          el(
            'div',
            { class: 'job-top' },
            el('div', { class: 'job-title', title: job.title }, job.title),
            el('div', { class: 'job-pct', style: 'color:var(--accent-2)' }, `${pct}%`),
          ),
          el('div', { class: 'progress' }, el('span', { style: `width:${pct}%` })),
          el(
            'div',
            { class: 'job-sub' },
            el('span', {}, [`${label} · ${left} of ${job.items.length} left`, bits.length ? ` · ${bits.join(' · ')}` : ''].join('')),
            job.status === 'running' || job.status === 'queued'
              ? el('button', { class: 'btn btn-sm btn-danger', onclick: () => api.del(`/api/jobs/${job.id}`).then(renderQueue).catch(() => {}) }, 'Cancel')
              : null,
          ),
        ),
      );
    }
  }

  // Announce completions even though they are no longer listed.
  for (const job of jobs) {
    if (job.status === 'done' && job.completed && !state.seen.has(job.id)) {
      state.seen.add(job.id);
      toast(`${job.completed} song(s) saved to My Music`, 'ok');
      // Refresh the "downloaded" count now that the queue shrank.
      const library = await api.get('/api/library?kind=audio').catch(() => null);
      if (library) state.libraryCount = library.items.filter((i) => i.exists !== false).length;
    }
  }

  return active.length > 0;
}

// Fast cadence while songs are downloading, relaxed when the queue is empty.
function startPolling() {
  if (state.poll || state.stopped) return;
  const loop = async () => {
    // The page may have been swapped out while this request was in flight.
    if (state.stopped) return;
    let busy = false;
    try {
      busy = await renderQueue();
    } catch {
      busy = true;
    }
    if (state.stopped) return;
    state.poll = setTimeout(loop, busy ? 700 : 4000);
  };
  loop();
}

startPolling();

onCleanup(() => {
  state.stopped = true;
  clearTimeout(state.poll);
  state.poll = null;
});