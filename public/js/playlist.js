import { api, $, el, setMsg, toast, fmtDuration, fmtBytes, fmtRemaining, markActiveNav, renderSetupStatus } from './common.js';
import { onCleanup } from './app.js';
import * as localLib from './localLibrary.js';
import * as downloader from './downloader.js';

markActiveNav();

const state = { playlist: null, selected: new Set(), kind: 'audio', stopped: false, libraryCount: 0 };
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
  } catch { /* ignore */ }

  // The "have it" badge and the queue's downloaded count come from the local
  // library, which is the only place a finished file is recorded. The server's
  // /api/library is inert on this bridge and always answers with an empty list.
  try {
    const items = await localLib.load();
    state.libraryCount = items.filter((i) => i.exists !== false).length;
    window.__ownedIds = new Set(items.filter((i) => i.mediaId && i.exists !== false).map((i) => i.mediaId));
  } catch { /* ignore */ }

  renderQueue();
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
  setMsg(msg, 'Reading playlistâ€¦ this can take a few seconds.', 'info');
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
        el('div', { class: 's' }, [entry.uploader, entry.duration ? fmtDuration(entry.duration) : null].filter(Boolean).join(' Â· ') || 'unknown'),
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
 * Download every ticked track, one at a time.
 *
 * Sequential on purpose: a phone asked to hold three transfers at once drops
 * two of them, and a playlist is dozens of tracks. Each one is fetched through
 * downloader.js so progress is real and visible, written to the device by
 * store.js, and only then added to the library.
 */
const state2 = { queue: [], running: false, cancelled: false };

$('#start').addEventListener('click', async () => {
  if (state2.running) {
    state2.cancelled = true;
    downloader.cancel();
    return;
  }
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
  state2.running = true;
  state2.cancelled = false;
  state2.queue = entries.map((e) => ({
    entry: e,
    kind,
    loaded: 0,
    total: 0,
    percent: 0,
    phase: 'queued',
    startedAt: 0,
  }));

  button.textContent = 'Stop';
  button.classList.add('btn-danger');
  setMsg(msg, `Downloading 0 of ${entries.length} ${label}${entries.length === 1 ? '' : 's'} to this device\u2026`, 'info');
  renderQueue();

  let done = 0;
  let failed = 0;
  const firstError = [];

  for (const task of state2.queue) {
    if (state2.cancelled) break;
    task.phase = 'connecting';
    task.startedAt = Date.now();
    renderQueue();
    try {
      const { item } = await downloader.fetchAndSave(libraryEntry(task.entry, kind), {
        onProgress: (p) => {
          task.loaded = p.loaded;
          task.total = p.total;
          task.percent = p.percent;
          task.phase = p.phase;
          renderQueue();
          if (done) {
            setMsg(msg, `Downloading ${done + 1} of ${entries.length} ${label}${entries.length === 1 ? '' : 's'} to this device\u2026`, 'info');
          }
        },
      });
      // The row lands in the library only now, when the file is real.
      await localLib.upsert(item);
      if (window.__ownedIds) window.__ownedIds.add(task.entry.id);
      done += 1;
      task.phase = 'done';
      task.percent = 100;
    } catch (err) {
      if (state2.cancelled) {
        task.phase = 'cancelled';
        break;
      }
      task.phase = 'failed';
      task.error = err?.message || 'Failed';
      firstError.push(`${task.entry.title}: ${task.error}`);
      failed += 1;
      console.warn('[playlist] track failed', task.entry.url, err);
    }
    renderQueue();
  }

  state2.running = false;
  button.textContent = 'Start';
  button.classList.remove('btn-danger');
  renderQueue();

  if (state2.cancelled) {
    setMsg(msg, `Stopped. ${done} of ${entries.length} finished and are in ${kind === 'audio' ? 'My Music' : 'My Videos'}.`, 'warn');
    return;
  }

  const where = kind === 'audio' ? 'My Music' : 'My Videos';
  if (!done) {
    setMsg(msg, firstError[0] || 'Nothing could be downloaded.', 'error');
    toast(firstError[0] || 'Download failed.', 'error');
    return;
  }

  state.selected.clear();
  renderRows();
  if (failed) {
    setMsg(msg, `Saved ${done} of ${entries.length} to ${where}. ${failed} failed: ${firstError[0]}`, 'warn');
    toast(`Saved ${done}, ${failed} failed`, 'warn', 8000);
  } else {
    setMsg(msg, `Saved ${done} ${label}${done === 1 ? '' : 's'} to your device. They are in ${where} and ready to play.`, 'ok');
    toast(`Saved to this device \u00b7 check ${where}`, 'ok');
  }
});

/**
 * The queue panel.
 *
 * This used to poll /api/jobs, which is a stateless bridge and always answered
 * with an empty list, so the panel sat on "Queue is empty" through an entire
 * playlist download and the progress bar never meant anything. The queue is
 * local state now, because the queue is local: the page owns the transfer, so
 * the page is the only thing that can honestly report how far along it is.
 */
const PHASE_LABEL = {
  queued: 'waiting',
  connecting: 'contacting YouTube',
  downloading: 'downloading',
  saving: 'saving to this device',
  done: 'saved',
  failed: 'failed',
  cancelled: 'stopped',
};

function renderQueue() {
  const queue = state2.queue;
  const box = $('#jobs');
  if (!box) return;
  box.innerHTML = '';

  const done = queue.filter((t) => t.phase === 'done').length;
  const failed = queue.filter((t) => t.phase === 'failed').length;
  const left = queue.length - done - failed;
  const downloaded = (state.libraryCount || 0) + done;

  const countBox = $('#job-count');
  if (countBox) {
    countBox.innerHTML = queue.length
      ? `<span style="color:var(--ok)">${downloaded} downloaded</span> \u00b7 `
        + `<span style="color:var(--accent-2)">${Math.max(0, left)} left</span>`
        + (failed ? ` \u00b7 <span style="color:var(--warn)">${failed} failed</span>` : '')
      : `<span style="color:var(--ok)">${downloaded} downloaded</span> \u00b7 <span class="muted">queue empty</span>`;
  }

  if (!queue.length) {
    box.append(el('div', { class: 'empty small' }, 'Queue is empty. Downloaded songs are in My Music.'));
    return;
  }

  // The active track first, then the next few waiting, then whatever finished.
  const ordered = [...queue].sort((a, b) => rank(a) - rank(b));
  for (const task of ordered.slice(0, 8)) {
    const pct = task.phase === 'done' ? 100 : Math.round(task.percent || 0);
    const bits = [];
    if (task.total > 0) bits.push(`${fmtBytes(task.loaded)} / ${fmtBytes(task.total)}`);
    if (task.phase === 'downloading' && task.loaded > 0) {
      const left2 = (task.total - task.loaded) / Math.max(1, task.loaded / ((Date.now() - task.startedAt) / 1000 || 1));
      if (Number.isFinite(left2) && left2 > 0 && left2 < 86400) bits.push(fmtRemaining(left2));
    }
    if (task.phase === 'failed' && task.error) bits.push(task.error);

    box.append(
      el(
        'div',
        { class: 'job' },
        el(
          'div',
          { class: 'job-top' },
          el('div', { class: 'job-title', title: task.entry.title }, task.entry.title),
          el(
            'div',
            { class: 'job-pct', style: `color:${task.phase === 'failed' ? 'var(--warn)' : 'var(--accent-2)'}` },
            `${pct}%`,
          ),
        ),
        el('div', { class: 'progress' }, el('span', { style: `width:${pct}%` })),
        el('div', { class: 'job-sub' }, el('span', {}, [PHASE_LABEL[task.phase] || task.phase, bits.length ? ` \u00b7 ${bits.join(' \u00b7 ')}` : ''].join(''))),
      ),
    );
  }
  if (queue.length > 8) {
    box.append(el('div', { class: 'small muted', style: 'padding:8px 4px' }, `+ ${queue.length - 8} more`));
  }
}

/** Active first, then waiting, then finished and failed. */
function rank(task) {
  if (task.phase === 'downloading' || task.phase === 'connecting' || task.phase === 'saving') return 0;
  if (task.phase === 'queued') return 1;
  if (task.phase === 'failed') return 2;
  return 3;
}

onCleanup(() => {
  state.stopped = true;
  if (state2.running) {
    state2.cancelled = true;
    downloader.cancel();
  }
});
