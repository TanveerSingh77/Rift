import { api, $, $$, el, toast, fmtDuration, fmtBytes, fmtWhen, thumbUrl, markActiveNav } from './common.js';
import { onCleanup } from './app.js';
import * as localLib from './localLibrary.js';

markActiveNav();

const state = { items: [], filter: 'all', sort: 'recent', query: '', settings: {}, current: null, media: null, lastSave: 0 };

const grid = $('#grid');
const emptyBox = $('#empty');
const player = $('#player');

async function load() {
  const items = await localLib.load();
  state.items = items.filter((i) => i.kind === 'video').map((i) => ({
    ...i,
    progress: i.progress || {},
    exists: i.exists !== false,
  }));
  const bytes = state.items.reduce((s, it) => s + (it.size || 0), 0);
  const completed = state.items.filter((it) => it.progress?.completed).length;
  $('#stats').innerHTML = `${state.items.length} video(s) · ${fmtBytes(bytes)}<br><span class="muted">${completed} finished</span>`;
  render();
}

function matches(item) {
  if (state.query && !item.title.toLowerCase().includes(state.query)) return false;
  const p = item.progress;
  switch (state.filter) {
    case 'progress': return Boolean(resumeInfo(item));
    case 'done': return p?.completed === true;
    case 'missing': return item.exists === false;
    default: return true;
  }
}

function sortItems(list) {
  const by = {
    recent: (a, b) => String(b.progress?.updatedAt || '').localeCompare(String(a.progress?.updatedAt || '')),
    new: (a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')),
    old: (a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')),
    title: (a, b) => a.title.localeCompare(b.title),
    size: (a, b) => (b.size || 0) - (a.size || 0),
  }[state.sort];
  return [...list].sort(by);
}

/** How far into the video the saved position sits, as a percentage. */
function resumeInfo(item) {
  const p = item.progress;
  if (!p || p.completed || !p.position) return null;
  const duration = p.duration || item.duration || 0;
  if (!duration) return null;
  // The threshold is a percentage the user can set, so honour it exactly; the
  // 10s floor just stops 3-second slivers from counting as a resume point.
  // The default of 1% matters: at 5% a feature film ignored a real stop for
  // the first six minutes.
  const threshold = Math.max(10, ((state.settings.resumeThresholdPct || 1) / 100) * duration);
  if (p.position < threshold) return null;
  if (p.position >= duration * 0.97) return null;
  return { position: p.position, duration, pct: Math.min(100, (p.position / duration) * 100) };
}

function render() {
  const list = sortItems(state.items.filter(matches));
  grid.innerHTML = '';
  if (!list.length) {
    emptyBox.hidden = false;
    emptyBox.querySelector('div:last-child').innerHTML = state.items.length
      ? 'Nothing matches this filter.'
      : 'No videos here yet. <a href="/index.html">Download one</a>.';
    return;
  }
  emptyBox.hidden = true;
  for (const item of list) grid.append(card(item));
}

function card(item) {
  const r = resumeInfo(item);
  const p = item.progress;
  const thumb = thumbUrl(item);

  const node = el(
    'div',
    { class: 'vcard', onclick: () => openPlayer(item) },
    el(
      'div',
      { class: 'thumb-wrap' },
      item.exists === false
        ? el('div', { class: 'ph' }, '⚠')
        : thumb
          ? el('img', { src: thumb, alt: '', loading: 'lazy', onerror: (e) => { e.target.replaceWith(el('div', { class: 'ph' }, '▶')); } })
          : el('div', { class: 'ph' }, '▶'),
      item.duration ? el('div', { class: 'dur' }, fmtDuration(item.duration)) : null,
      p?.completed ? el('div', { class: 'done-tick' }, 'WATCHED') : null,
      r ? el('div', { class: 'resume-bar' }, el('span', { style: `width:${r.pct}%` })) : null,
      r ? el('div', { class: 'resume-badge' }, `▶ ${fmtDuration(r.position)}`) : null,
    ),
    el(
      'div',
      { class: 'body' },
      el('div', { class: 't', title: item.title }, item.title),
      el('div', { class: 's' }, [item.uploader, fmtWhen(item.addedAt)].filter(Boolean).join(' · ')),
      el(
        'div',
        { class: 'row' },
        el(
          'div',
          { class: 'grow' },
          r
            ? el('span', { class: 'tag-resume' }, `Continue at ${fmtDuration(r.position)}`)
            : item.exists === false
              ? 'file missing'
              : fmtBytes(item.size),
        ),
        el('button', { class: 'icon-btn', title: 'Save file', onclick: (e) => { e.stopPropagation(); saveFile(item); } }, '⬇'),
        el('button', { class: 'icon-btn', title: 'Show in folder', onclick: (e) => { e.stopPropagation(); reveal(item); } }, '↗'),
        el('button', {
          class: 'icon-btn danger',
          title: 'Delete',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${item.title}" from disk? This cannot be undone.`)) return;
            await api.del(`/api/library/${item.id}`);
            toast('Deleted', 'ok');
            load();
          },
        }, '✕'),
      ),
    ),
  );
  return node;
}

function saveFile(item) {
  const a = document.createElement('a');
  a.href = `/media/${encodeURI(item.file)}?download=1`;
  a.download = '';
  a.click();
}

async function reveal(item) {
  try {
    await api.post('/api/reveal', { id: item.id });
  } catch {
    alert(item.file);
  }
}

// ---------------------------------------------------------------- player
function openPlayer(item) {
  if (item.exists === false) {
    toast('That file is missing from disk. Try Rescan folder.', 'error');
    return;
  }
  state.current = item;
  $('#p-title').textContent = item.title;
  $('#p-sub').textContent = [item.uploader, fmtDuration(item.duration), fmtBytes(item.size)].filter(Boolean).join(' · ');
  $('#p-resume').textContent = '';

  const holder = $('#media-holder');
  holder.innerHTML = '';
  const media = document.createElement('video');
  media.controls = true;
  media.preload = 'metadata';
  media.playsInline = true;
  media.src = `/media/${encodeURI(item.file)}`;
  holder.append(media);
  state.media = media;

  const saved = resumeInfo(item);

  media.addEventListener('loadedmetadata', () => {
    if (saved && state.settings.autoResume !== false) {
      media.currentTime = Math.min(saved.position, Math.max(0, media.duration - 1));
      $('#p-resume').textContent = `Resumed at ${fmtDuration(saved.position)} — your position is saved automatically.`;
    }
    media.play().catch(() => {});
  });
  media.addEventListener('timeupdate', () => {
    if (Date.now() - state.lastSave < 4000) return;
    state.lastSave = Date.now();
    save(false);
  });
  media.addEventListener('pause', () => save(true));
  media.addEventListener('seeked', () => save(false));
  media.addEventListener('ended', () => {
    sendProgress({ position: 0, duration: media.duration, completed: true });
    refreshProgress();
  });
  media.addEventListener('error', () => toast('Could not play this file.', 'error'));

  player.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closePlayer() {
  save(true);
  state.media?.pause();
  state.media?.removeAttribute('src');
  state.media?.load();
  state.media = null;
  state.current = null;
  player.classList.remove('show');
  document.body.style.overflow = '';
  render();
}

function save() {
  const media = state.media;
  const item = state.current;
  if (!media || !item || !media.duration) return;
  const duration = media.duration;
  const position = media.currentTime;
  const markComplete = (state.settings.markCompletePct || 95) / 100;
  sendProgress({ position: position >= duration * markComplete ? 0 : position, duration, completed: position >= duration * markComplete });
  refreshProgress();
}

function sendProgress(payload) {
  const item = state.current;
  if (!item) return;
  fetch(`/api/progress/${item.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

function refreshProgress() {
  const item = state.current;
  if (!item) return;
  const existing = state.items.find((i) => i.id === item.id);
  if (!existing) return;
  const media = state.media;
  const duration = media?.duration || existing.progress?.duration || 0;
  const markComplete = (state.settings.markCompletePct || 95) / 100;
  existing.progress = {
    position: media ? media.currentTime : existing.progress?.position || 0,
    duration,
    completed: media ? media.currentTime >= duration * markComplete : existing.progress?.completed || false,
    updatedAt: new Date().toISOString(),
  };
  if (existing.progress.completed) existing.progress.position = 0;
}

const onPageHide = () => save(true);
const onBeforeUnload = () => {
  const item = state.current;
  const media = state.media;
  if (!item || !media || !media.duration) return;
  const duration = media.duration;
  const position = media.currentTime;
  const payload = JSON.stringify({
    position: position,
    duration,
    completed: position >= duration * ((state.settings.markCompletePct || 95) / 100),
  });
  navigator.sendBeacon?.(`/api/progress/${item.id}`, new Blob([payload], { type: 'application/json' }));
};
window.addEventListener('pagehide', onPageHide);
window.addEventListener('beforeunload', onBeforeUnload);

// ---------------------------------------------------------------- controls
$('#p-close').addEventListener('click', closePlayer);
player.addEventListener('click', (e) => {
  if (e.target === player) closePlayer();
});
const onKey = (e) => {
  if (e.key === 'Escape' && player.classList.contains('show')) closePlayer();
};
document.addEventListener('keydown', onKey);

$('#p-restart').addEventListener('click', () => {
  if (!state.media) return;
  state.media.currentTime = 0;
  state.lastSave = Date.now();
  sendProgress({ position: 0, duration: state.media.duration, completed: false });
  toast('Starting from the beginning', 'info');
  refreshProgress();
});

$('#p-download').addEventListener('click', () => {
  if (state.current) saveFile(state.current);
});

$('#p-delete').addEventListener('click', async () => {
  const item = state.current;
  if (!item) return;
  if (!confirm(`Delete "${item.title}" from disk?`)) return;
  closePlayer();
  await api.del(`/api/library/${item.id}`);
  toast('Deleted', 'ok');
  load();
});

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value.trim().toLowerCase();
  render();
});
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  render();
});
$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.f;
  for (const c of $$('#filters .chip')) c.classList.toggle('active', c === chip);
  render();
});
$('#rescan').addEventListener('click', async () => {
  const res = await api.post('/api/library/rescan');
  toast(res.added ? `Found ${res.added} new file(s)` : 'Everything is already indexed', res.added ? 'ok' : 'info');
  load();
});
$('#clear-progress').addEventListener('click', async () => {
  if (!confirm('Forget every saved watch position? Files stay on disk.')) return;
  for (const item of state.items) await api.del(`/api/progress/${item.id}`).catch(() => {});
  toast('Watch positions cleared', 'ok');
  load();
});

// ---------------------------------------------------------------- start
api.get('/api/settings').then((s) => {
  state.settings = s;
  render();
}).catch(() => {});

load().catch((err) => toast(err.message, 'error'));
const refreshTimer = setInterval(() => {
  if (!state.current) load().catch(() => {});
}, 20000);

// The modal and the video element both live inside <main>, so this page's
// listeners are re-attached on every visit. Tear them down on navigation,
// otherwise each visit would stack another set on the document.
onCleanup(() => {
  clearInterval(refreshTimer);
  closePlayer();
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('beforeunload', onBeforeUnload);
});