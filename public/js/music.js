import { api, $, el, setMsg, toast, fmtDuration, fmtBytes, fmtWhen, thumbUrl, markActiveNav, saveToDevice, revealInFolder } from './common.js';
import { onCleanup } from './app.js';
import * as player from './player.js';
import * as localLib from './localLibrary.js';

markActiveNav();

// Glyphs are written with escapes so the file's encoding can never corrupt them.
const MUSIC_GLYPH = '\u266b';
const ICON_DOWNLOAD = '\u2b07';
const ICON_REVEAL = '\u2197';
const ICON_DELETE = '\u2715';
const ICON_MORE = '\u22ef';
const ICON_PLAY = '\u25b6';
const ICON_PAUSE = '\u23f8';
const ICON_REPEAT_OFF = '\u21bb';
const ICON_REPEAT_ALL = '\u1f501';
const ICON_REPEAT_ONE = '\u1f502';
const TIMES = '\u00d7';
const DOT = ' \u00b7 ';
const ELLIPSIS = '\u2026';

const state = {
  items: [],
  query: '',
  sort: 'new',
};

const audio = player.getAudio();

async function load() {
  try {
    const items = await localLib.load();
    state.items = items
      .filter((i) => i.kind === 'audio')
      .map((i) => ({ ...i, progress: i.progress || {} }))
      .filter((i) => i.exists !== false);
    player.setLibrary(state.items);
    const bytes = state.items.reduce((s, it) => s + (it.size || 0), 0);
    $('#stats').textContent = `${state.items.length} song${state.items.length === 1 ? '' : 's'}${DOT}${fmtBytes(bytes)}`;
    if (!player.getState().itemId) player.setQueue(visible().map((i) => i.id), 0);
    render();
  } catch (err) {
    setMsg($('#msg'), err.message, 'error');
  }
}

// ---------------------------------------------------------------- library
function visible() {
  const q = state.query;
  const list = q ? state.items.filter((i) => i.title.toLowerCase().includes(q)) : [...state.items];
  const key = state.sort;
  return list.sort((a, b) => {
    if (key === 'title') return a.title.localeCompare(b.title);
    if (key === 'size') return (b.size || 0) - (a.size || 0);
    if (key === 'old') return String(a.addedAt).localeCompare(String(b.addedAt));
    if (key === 'recent') return String(b.progress?.updatedAt || '').localeCompare(String(a.progress?.updatedAt || ''));
    return String(b.addedAt).localeCompare(String(a.addedAt));
  });
}

function render() {
  const list = visible();
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!list.length) {
    $('#empty').hidden = state.items.length === 0;
    return;
  }
  $('#empty').hidden = true;

  const p = player.getState();
  for (const item of list) {
    const isCurrent = p.itemId === item.id;
    grid.append(
      el(
        'div',
        {
          class: `song${isCurrent && p.playing ? ' playing' : ''}`,
          onclick: () => playItem(item.id),
        },
        el(
          'div',
          { class: 'song-art' },
          thumbNode(item),
          isCurrent ? el('div', { class: 'song-eq' }, el('span'), el('span'), el('span')) : null,
        ),
        el(
          'div',
          { class: 'song-info' },
          el('div', { class: 't', title: item.title }, item.title),
          el(
            'div',
            { class: 's' },
            [item.duration ? fmtDuration(item.duration) : null, fmtBytes(item.size), item.sourceUrl ? 'yt' : 'uploaded', fmtWhen(item.addedAt)]
              .filter(Boolean)
              .join(DOT),
          ),
        ),
        // Shown on phones only, where a stray row tap while scrolling would
        // otherwise start playback.
        el(
          'button',
          {
            class: 'song-play',
            title: isCurrent && p.playing ? 'Pause' : 'Play',
            'aria-label': `${isCurrent && p.playing ? 'Pause' : 'Play'} ${item.title}`,
            onclick: (e) => {
              e.stopPropagation();
              playItem(item.id);
            },
          },
          isCurrent && p.playing ? ICON_PAUSE : ICON_PLAY,
        ),
        el(
          'div',
          { class: 'song-actions' },
          // Visible on desktop; the sheet takes over on a phone.
          el('button', { class: 'icon-btn', title: 'Download file', 'aria-label': 'Download file', onclick: (e) => { e.stopPropagation(); saveFile(item); } }, ICON_DOWNLOAD),
          el('button', {
            class: 'icon-btn song-more',
            title: 'More actions',
            'aria-label': `More actions for ${item.title}`,
            onclick: (e) => {
              e.stopPropagation();
              openActions(item);
            },
          }, ICON_MORE),
        ),
      ),
    );
  }
}

function thumbNode(item) {
  const thumb = thumbUrl(item);
  if (!thumb) return el('div', { class: 'ph' }, MUSIC_GLYPH);
  return el('img', {
    src: thumb,
    alt: '',
    loading: 'lazy',
    onerror: (e) => {
      e.target.replaceWith(el('div', { class: 'ph' }, MUSIC_GLYPH));
    },
  });
}

async function removeItem(item) {
  if (!confirm(`Delete "${item.title}" from disk?`)) return;
  if (player.getState().itemId === item.id) player.stop();
  await api.del(`/api/library/${item.id}`);
  toast('Deleted', 'ok');
  load();
}

function saveFile(item) {
  saveToDevice(item);
}

async function reveal(item) {
  await revealInFolder(item);
}

// ---------------------------------------------------------------- sheet
// One sheet, two panels. Speed/pitch/volume outgrew the dock on a phone, and
// the per-song overflow menu has to go somewhere, so both are drawers now.
const sheet = $('#sheet');
const panels = { fx: $('#panel-fx'), actions: $('#panel-actions') };
let sheetPushed = false;

function showPanel(name) {
  for (const [key, node] of Object.entries(panels)) node.hidden = key !== name;
}

function openSheet(name) {
  showPanel(name);
  $('#btn-fx').classList.add('active');
  $('#btn-fx').setAttribute('aria-expanded', 'true');
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  // Two frames: the first makes the panel visible, the second starts the
  // transition so it actually animates instead of snapping.
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('show')));
  // A history entry means the Android back button closes the sheet instead of
  // leaving the app. app.js ignores it because the path has not changed.
  if (!sheetPushed) {
    history.pushState({ vgSheet: name }, '');
    sheetPushed = true;
  }
}

function closeSheet(fromPop = false) {
  if (sheet.hidden) return;
  sheet.classList.remove('show');
  $('#btn-fx').classList.remove('active');
  $('#btn-fx').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sheet-open');
  const hide = () => {
    sheet.hidden = true;
  };
  if (fromPop) {
    sheetPushed = false;
    hide();
  } else if (sheetPushed) {
    sheetPushed = false;
    setTimeout(hide, 200);
    history.back();
  } else {
    hide();
  }
}

function openActions(item) {
  $('#act-title').textContent = item.title;
  $('#act-sub').textContent = [
    item.duration ? fmtDuration(item.duration) : null,
    fmtBytes(item.size),
    item.sourceUrl ? 'yt' : 'uploaded',
  ].filter(Boolean).join(DOT);

  const list = $('#act-list');
  list.innerHTML = '';
  list.append(
    actionRow(ICON_DOWNLOAD, 'Save to this phone', () => saveFile(item)),
    actionRow(ICON_REVEAL, 'Show in folder', () => reveal(item)),
    actionRow(ICON_DELETE, 'Delete from disk', () => removeItem(item), true),
  );
  openSheet('actions');
}

function actionRow(icon, label, run, danger = false) {
  return el(
    'button',
    {
      class: `sheet-action${danger ? ' danger' : ''}`,
      onclick: () => {
        closeSheet();
        run();
      },
    },
    el('span', { class: 'ico' }, icon),
    label,
  );
}

$('#sheet-scrim').addEventListener('click', () => closeSheet());
$('#fx-close').addEventListener('click', () => closeSheet());
$('#act-close').addEventListener('click', () => closeSheet());

// ---------------------------------------------------------------- playback
function currentItem() {
  return player.currentItem();
}

/** Fisher-Yates. */
function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Sets the play queue.
 *
 * `startId` moves that song to the front. It is deliberately omitted when the
 * user asked for a shuffle: hoisting one fixed song to the front is what made
 * "Shuffle all" start with the same track every time.
 */
function buildOrder(list, startId) {
  const order = player.getState().shuffle ? shuffled(list) : [...list];
  let index = -1;
  if (startId) {
    index = order.findIndex((i) => i.id === startId);
    if (index > 0) order.unshift(...order.splice(index, 1));
    index = 0;
  }
  // The queue is a list of ids; the player resolves them against its library.
  player.setQueue(order.map((i) => i.id), index);
}

async function playItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const same = player.getState().itemId === id;
  if (same && audio.src && audio.currentTime > 0) {
    // Tapping the song that is already playing toggles it, as expected.
    await player.toggle();
    return;
  }
  buildOrder(visible(), id);
  await player.playId(id);
}

/**
 * "Play all" and "Shuffle all".
 *
 * Both hand the player a queue that matches what was asked for: unshuffled
 * starts at the first visible song, shuffled starts at a random one.
 */
function playVisible(shuffle) {
  const list = visible();
  if (!list.length) return;
  player.setShuffle(shuffle);
  const order = shuffle ? shuffled(list) : [...list];
  player.setQueue(order.map((i) => i.id), 0);
  player.playId(order[0].id);
}

// ---------------------------------------------------------------- dock
/** Writes the read-out labels only. Slider positions belong to their input handlers. */
function syncFxLabels() {
  const ps = player.getState();
  $('#speed-val').textContent = `${ps.speed.toFixed(2)}${TIMES}`;
  const p = ps.pitch;
  $('#pitch-val').textContent = p === 0 ? '0 st' : `${p > 0 ? '+' : ''}${p} st`;
  // Pitch is applied by resampling, so the tempo necessarily follows the pitch
  // fader. Say what is actually being heard instead of only the slider value.
  const effective = p ? ps.speed * 2 ** (p / 12) : ps.speed;
  const hint = $('#pitch-hint');
  if (hint) {
    hint.textContent = p
      ? `pitch ${p > 0 ? '+' : ''}${p} st, playing at ${effective.toFixed(2)}${TIMES}`
      : `speed only, pitch unchanged`;
  }
  $('#btn-shuffle').classList.toggle('active', ps.shuffle);
  $('#btn-repeat').classList.toggle('active', ps.repeat !== 'off');
  $('#btn-repeat').textContent = ps.repeat === 'one' ? ICON_REPEAT_ONE : ps.repeat === 'all' ? ICON_REPEAT_ALL : ICON_REPEAT_OFF;
}

function updateDockText() {
  const item = currentItem();
  const ps = player.getState();
  $('#dock').hidden = !item;
  if (!item) return;

  $('#dock-title').textContent = item.title;
  const bits = [item.uploader, fmtWhen(item.addedAt)].filter(Boolean);
  $('#dock-sub').textContent = ps.loading ? 'loading...' : bits.join(DOT);
  $('#btn-play').textContent = ps.loading ? ELLIPSIS : ps.playing ? ICON_PAUSE : ICON_PLAY;
}

/**
 * Paints a slider's filled portion.
 *
 * The groove is drawn by a CSS gradient driven by --p, which turns every slider
 * into a meter instead of a featureless grey line.
 */
function paintRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const span = max - min;
  const raw = span > 0 ? ((Number(input.value) - min) / span) * 100 : 0;
  input.style.setProperty('--p', `${Math.max(0, Math.min(100, raw))}%`);
}

function updateDockArt() {
  const item = currentItem();
  const thumb = item ? thumbUrl(item) : null;
  const art = $('#dock-art');
  art.innerHTML = '';
  if (thumb) art.append(el('img', { src: thumb, alt: '' }));
  else art.append(el('div', { class: 'ph' }, MUSIC_GLYPH));

  // The effects sheet carries the same artwork at a larger size.
  const sheetArt = $('#sheet-art');
  sheetArt.innerHTML = '';
  if (thumb) sheetArt.append(el('img', { src: thumb, alt: '' }));
  else sheetArt.append(el('div', { class: 'ph' }, MUSIC_GLYPH));

  $('#sheet-title').textContent = item ? item.title : 'Nothing playing';
  $('#sheet-sub').textContent = item
    ? [item.uploader, fmtBytes(item.size)].filter(Boolean).join(DOT)
    : '';
}

function paintSeek() {
  const item = currentItem();
  if (!item) return;
  const d = Number.isFinite(audio.duration) ? audio.duration : item.duration || 0;
  $('#t-cur').textContent = fmtDuration(audio.currentTime || 0);
  $('#t-dur').textContent = fmtDuration(d);
  if (document.activeElement !== $('#seek')) {
    $('#seek').value = d > 0 ? Math.round((audio.currentTime / d) * 1000) : 0;
  }
  paintRange($('#seek'));
}

// ---------------------------------------------------------------- controls
$('#btn-play').addEventListener('click', () => player.toggle());
$('#btn-next').addEventListener('click', () => player.next());
$('#btn-prev').addEventListener('click', () => {
  if (audio.currentTime > 3) {
    player.seek(0);
    return;
  }
  player.previous();
});
$('#btn-shuffle').addEventListener('click', () => {
  const on = !player.getState().shuffle;
  player.setShuffle(on);
  toast(on ? 'Shuffle on' : 'Shuffle off', 'info', 2000);
});
$('#btn-repeat').addEventListener('click', () => player.cycleRepeat());
$('#btn-download').addEventListener('click', () => {
  const item = currentItem();
  if (item) saveFile(item);
});

$('#seek').addEventListener('input', (e) => {
  const d = Number.isFinite(audio.duration) ? audio.duration : 0;
  paintRange(e.target);
  if (d > 0) player.seek((Number(e.target.value) / 1000) * d);
});

// Speed, pitch and volume are global: one setting for the whole player, saved
// automatically, and every song plays that way.
$('#speed').addEventListener('input', (e) => {
  paintRange(e.target);
  player.setSpeed(Number(e.target.value) / 100);
});
$('#pitch').addEventListener('input', (e) => {
  paintRange(e.target);
  player.setPitch(Number(e.target.value));
});
$('#volume').addEventListener('input', (e) => {
  paintRange(e.target);
  player.setVolume(Number(e.target.value) / 100);
});

$('#btn-reset').addEventListener('click', () => {
  player.resetFx();
  toast('Speed and pitch reset for all songs', 'ok');
});

// The effects now open the sheet rather than expanding inside the dock.
$('#btn-fx').addEventListener('click', () => {
  if (sheet.hidden) openSheet('fx');
  else closeSheet();
});

for (const btn of document.querySelectorAll('[data-pitch]')) {
  btn.addEventListener('click', () => {
    player.setPitch(Number(btn.dataset.pitch));
  });
}
for (const btn of document.querySelectorAll('[data-speed]')) {
  btn.addEventListener('click', () => {
    player.setSpeed(Number(btn.dataset.speed) / 100);
  });
}

$('#play-all').addEventListener('click', () => playVisible(false));
$('#shuffle-all').addEventListener('click', () => playVisible(true));

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value.trim().toLowerCase();
  render();
});
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  render();
});
$('#rescan').addEventListener('click', async () => {
  const res = await api.post('/api/library/rescan');
  toast(res.added ? `Found ${res.added} new file(s)` : 'Everything is already indexed', res.added ? 'ok' : 'info');
  load();
});

// ---------------------------------------------------------------- upload
$('#upload-btn').addEventListener('click', () => $('#upload').click());

$('#upload').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  const bar = $('#upload-bar');
  const fill = $('#upload-fill');
  const text = $('#upload-text');
  bar.hidden = false;
  setMsg($('#msg'), `Uploading ${files.length} file(s)...`, 'info');

  const form = new FormData();
  for (const f of files) form.append('file', f, f.name);

  // XHR because uploads need a real progress bar, fetch does not expose one.
  try {
    const res = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        fill.style.width = `${pct}%`;
        text.textContent = `${pct}%${DOT}${fmtBytes(ev.loaded)} of ${fmtBytes(ev.total)}`;
      };
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = { error: xhr.responseText.slice(0, 200) };
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed: connection lost'));
      xhr.send(form);
    });

    fill.style.width = '100%';
    const saved = res.saved?.length || 0;
    setMsg($('#msg'), res.warning || `Added ${saved} song(s) to your library.`, res.warning ? 'warn' : 'ok');
    toast(`Added ${saved} song(s)`, 'ok');
    await load();
    setTimeout(() => {
      bar.hidden = true;
      fill.style.width = '0%';
    }, 1500);
  } catch (err) {
    bar.hidden = false;
    setMsg($('#msg'), err.message, 'error');
  }
});

// drag and drop anywhere on the page
const onDragOver = (e) => e.preventDefault();
const onDrop = (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|opus|wav|flac|aac|ogg)$/i.test(f.name));
  if (!files.length) return;
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const input = $('#upload');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
};
document.addEventListener('dragover', onDragOver);
document.addEventListener('drop', onDrop);

const onKey = (e) => {
  // While the sheet is up it owns the keyboard: Space would otherwise toggle
  // playback at the same time as the focused button activates.
  if (!sheet.hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
    }
    return;
  }
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    player.toggle();
  }
  if (e.key === 'ArrowRight' && e.shiftKey) player.next();
  if (e.key === 'ArrowLeft' && e.shiftKey) player.previous();
};
document.addEventListener('keydown', onKey);

// The Android back button is a WebView history step, which lands here.
const onPopState = () => {
  if (!sheet.hidden) closeSheet(true);
};
window.addEventListener('popstate', onPopState);

// ---------------------------------------------------------------- wiring
player.setNotifier(toast);

// The player emits several times a second while a track plays. Rebuilding the
// song grid and rewriting the slider positions that often would be wasteful and
// would fight the user mid-drag, so the view only redraws when something that
// is actually visible has changed.
let lastTrackId;
let lastTrackSig;
let lastFxSig;

const unsubscribe = player.subscribe(() => {
  const ps = player.getState();
  const trackSig = `${ps.playing}|${ps.loading}`;
  const fxSig = `${ps.speed}|${ps.pitch}|${ps.shuffle}|${ps.repeat}`;

  if (ps.itemId !== lastTrackId) {
    lastTrackId = ps.itemId;
    lastTrackSig = null;
    lastFxSig = null;
    updateDockText();
    updateDockArt();
    render();
  }

  if (trackSig !== lastTrackSig) {
    lastTrackSig = trackSig;
    updateDockText();
    render();
  }

  if (fxSig !== lastFxSig) {
    lastFxSig = fxSig;
    syncFxLabels();
    $('#speed').value = Math.round(ps.speed * 100);
    $('#pitch').value = ps.pitch;
    paintRange($('#speed'));
    paintRange($('#pitch'));
  }

  paintSeek();
});

// Everything above is bound to elements inside <main>, which client-side
// navigation replaces. Unsubscribing stops this view from being called back
// while the audio keeps playing on its own.
// The toast host lives on <body> and is shared, so it is intentionally left
// alone here. The player keeps the same notifier because it imports common.js
// itself and therefore stays valid after this module's view is gone.
onCleanup(() => {
  unsubscribe();
  document.removeEventListener('dragover', onDragOver);
  document.removeEventListener('drop', onDrop);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('popstate', onPopState);
  // The sheet's history entry is overwritten rather than popped: a back() here
  // would fight the navigation that is already under way.
  if (sheetPushed) {
    sheetPushed = false;
    history.replaceState({ vgSheet: null }, '');
  }
  sheet.classList.remove('show');
  sheet.hidden = true;
  document.body.classList.remove('sheet-open');
});

load();
$('#volume').value = Math.round(audio.volume * 100);
for (const id of ['#seek', '#speed', '#pitch', '#volume']) paintRange($(id));