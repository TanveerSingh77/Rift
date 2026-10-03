import { thumbUrl } from './common.js';

/**
 * The player lives on `window`, not inside a page module, because clicking
 * between pages must never interrupt playback. Page modules come and go; this
 * one does not.
 *
 * A browser unloads the entire document on a normal navigation, which destroys
 * any <audio> element no matter which APIs are used. That is why navigation in
 * this app is done client side (see app.js): the document - and therefore this
 * element and the current track - stay alive.
 */
const audio = (window.__vgAudio ||= new Audio());
audio.preload = 'metadata';

// The music page (and any media on it) may not exist yet.
const syncOtherMedia = () => {
  for (const node of document.querySelectorAll('video, audio:not(#vg-audio)')) {
    if (node === audio) continue;
    node.playbackRate = audio.playbackRate;
    node.preservesPitch = audio.preservesPitch;
  }
};

const SPEED_MIN = 0.25;
const SPEED_MAX = 4;
const PITCH_MAX = 12;

const state = {
  itemId: null,
  duration: 0,
  speed: 1,
  pitch: 0,
  volume: 1,
  playing: false,
  loading: false,
  shuffle: false,
  repeat: 'off', // off | all | one
};

let library = new Map();
let queue = [];
let qIndex = -1;
let saveTimer = 0;
let prefTimer = 0;
let toast = () => {};
const subscribers = new Set();

export function getAudio() { return audio; }
export function getState() { return state; }
export function getQueue() { return { queue, index: qIndex }; }

export function setNotifier(fn) { toast = typeof fn === 'function' ? fn : () => {}; }

export function subscribe(fn) {
  subscribers.add(fn);
  fn(state);
  return () => subscribers.delete(fn);
}

function emit() {
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch (err) {
      console.error('[player]', err);
    }
  }
}

export function setLibrary(items) {
  library = new Map((items || []).map((i) => [i.id, i]));
}

export function setQueue(ids, index) {
  queue = Array.isArray(ids) ? [...ids] : [];
  qIndex = Number.isInteger(index) ? index : -1;
}

export function currentItem() {
  return state.itemId ? library.get(state.itemId) || null : null;
}

// ------------------------------------------------------------ effects
/**
 * Speed and pitch are applied to the <audio> element itself.
 *
 * - Speed is genuinely independent: `preservesPitch` keeps the pitch fixed
 *   while the tempo moves.
 * - Pitch is a turntable-style fader: with `preservesPitch` off, resampling
 *   raises the pitch and the tempo follows by the same ratio.
 *
 * Setting these before load() is pointless - assigning src and calling load()
 * both reset playbackRate back to 1 - so this is re-applied from
 * loadedmetadata and canplay as well. See applyRatioSafely.
 */
function targetRate() {
  return state.pitch ? state.speed * 2 ** (state.pitch / 12) : state.speed;
}

export function applyRatio() {
  audio.playbackRate = targetRate();
  audio.preservesPitch = !state.pitch;
  audio.defaultPlaybackRate = targetRate();
  syncOtherMedia();
  emit();
}

/**
 * Re-asserts the rate once the media pipeline is ready. Browsers reset
 * playbackRate whenever the resource is (re)loaded, which is why setting the
 * slider alone appeared to do nothing.
 */
function applyRatioSafely() {
  const rate = targetRate();
  if (audio.playbackRate !== rate) audio.playbackRate = rate;
  if (audio.preservesPitch !== !state.pitch) audio.preservesPitch = !state.pitch;
}

export function setSpeed(value) {
  state.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(value) || 1));
  applyRatio();
  savePrefs();
}

export function setPitch(value) {
  state.pitch = Math.min(PITCH_MAX, Math.max(-PITCH_MAX, Math.round(Number(value) || 0)));
  applyRatio();
  savePrefs();
}

/** Returns playback to normal speed and pitch. */
export function resetFx() {
  state.speed = 1;
  state.pitch = 0;
  applyRatio();
  savePrefs();
}

export function setVolume(value) {
  state.volume = Math.min(1, Math.max(0, Number(value)));
  audio.volume = state.volume;
  savePrefs();
}

export function setShuffle(on) {
  state.shuffle = Boolean(on);
  emit();
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  emit();
}

// ------------------------------------------------------------ persistence
// One set of values for the whole player, restored on the next visit.
function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    fetch('/api/player', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: state.speed, pitch: state.pitch, volume: state.volume }),
    }).catch(() => {});
  }, 500);
}

export async function loadPrefs() {
  try {
    const res = await fetch('/api/player');
    const prefs = await res.json();
    state.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(prefs.speed) || 1));
    state.pitch = Math.min(PITCH_MAX, Math.max(-PITCH_MAX, Math.round(Number(prefs.pitch) || 0)));
    state.volume = Math.min(1, Math.max(0, Number(prefs.volume ?? 1)));
  } catch {
    /* keep defaults */
  }
  audio.volume = state.volume;
  applyRatio();
}

// ------------------------------------------------------------ progress
function postProgress(completed) {
  const id = state.itemId;
  if (!id) return;
  const duration = Number.isFinite(audio.duration) ? audio.duration : state.duration || 0;
  const position = audio.currentTime;
  fetch(`/api/progress/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      position,
      duration,
      completed: completed !== undefined ? completed : (duration > 0 && position >= duration * 0.97),
    }),
  }).catch(() => {});
}

export function saveProgress(force = false) {
  if (!force && Date.now() - saveTimer < 5000) return;
  saveTimer = Date.now();
  postProgress();
}

/**
 * Forgets the stored position of a song.
 *
 * Only the song that is playing keeps a resume point. Switching away or letting
 * a song finish clears the old one, so the library never fills up with stale
 * "continue listening" markers.
 */
export function forgetProgress(id) {
  if (!id) return;
  fetch(`/api/progress/${id}`, { method: 'DELETE' }).catch(() => {});
}

// ------------------------------------------------------------ playback
export function seek(seconds) {
  const d = Number.isFinite(audio.duration) ? audio.duration : 0;
  audio.currentTime = Math.min(Math.max(0, seconds), d > 0 ? Math.max(0, d - 0.5) : seconds);
  emit();
}

function waitForMetadata() {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('Could not open that file.')); };
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', ok);
      audio.removeEventListener('error', bad);
    };
    audio.addEventListener('loadedmetadata', ok, { once: true });
    audio.addEventListener('error', bad, { once: true });
  });
}

export async function playId(id, { offset } = {}) {
  const item = library.get(id);
  if (!item) return;

  const previous = state.itemId;
  if (previous && previous !== id) forgetProgress(previous);

  state.loading = true;
  state.itemId = id;
  state.duration = item.duration || 0;
  qIndex = queue.indexOf(id);
  emit();

  const start = offset !== undefined
    ? offset
    : item.progress && !item.progress.completed && item.progress.position > 3
      ? item.progress.position
      : 0;

  audio.src = `/media/${encodeURI(item.file)}`;
  // load() resets playbackRate, so it has to be re-applied afterwards.
  audio.load();
  applyRatioSafely();

  const ready = waitForMetadata();
  state.loading = false;

  try {
    await ready;
  } catch (err) {
    emit();
    toast(err.message, 'error');
    return;
  }

  applyRatioSafely();

  const max = Number.isFinite(audio.duration) ? audio.duration : 0;
  state.duration = max || state.duration;
  if (start > 0 && max > 0) audio.currentTime = Math.min(start, Math.max(0, max - 0.5));

  emit();
  try {
    await audio.play();
    state.playing = true;
  } catch {
    state.playing = false;
    toast('Playback was blocked by the browser. Press play.', 'error');
  }
  emit();
}

export async function toggle() {
  if (!state.itemId && library.size) {
    const first = queue[0] || [...library.keys()][0];
    if (first) {
      setQueue(queue.length ? queue : [...library.keys()], 0);
      await playId(first);
    }
    return;
  }
  if (!audio.src) return;
  if (audio.paused) {
    try {
      await audio.play();
      state.playing = true;
    } catch {
      toast('Playback was blocked by the browser. Press play.', 'error');
    }
  } else {
    audio.pause();
    state.playing = false;
  }
  emit();
}

export function stop() {
  saveProgress(true);
  audio.pause();
  state.playing = false;
  emit();
}

function advance(delta) {
  if (!queue.length) return;
  let next = qIndex + delta;
  if (next < 0) {
    if (state.repeat === 'all') next = queue.length - 1;
    else return;
  }
  if (next >= queue.length) {
    if (state.repeat === 'all') next = 0;
    else if (state.repeat === 'one') next = qIndex;
    else {
      stop();
      return;
    }
  }
  playId(queue[next]);
}

export function next() { advance(1); }
export function previous() { advance(-1); }

// ------------------------------------------------------------ media session
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const item = currentItem();
  if (!item) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    return;
  }
  const art = thumbUrl(item);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: item.uploader || 'VidGrab',
      album: 'My Music',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
  } catch { /* metadata unavailable */ }
  navigator.mediaSession.playbackState = state.loading ? 'none' : state.playing ? 'playing' : 'paused';
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch { /* not ready yet */ }
  }
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const bind = (action, handler) => {
    try {
      ms.setActionHandler(action, handler);
    } catch { /* action unsupported */ }
  };
  bind('play', () => { if (audio.paused) toggle(); });
  bind('pause', () => { if (!audio.paused) audio.pause(); });
  bind('stop', () => stop());
  bind('nexttrack', () => next());
  bind('previoustrack', () => previous());
  bind('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d?.seekOffset || 10)); });
  bind('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (d?.seekOffset || 10)); });
  bind('seekto', (d) => { if (Number.isFinite(d?.seekTime)) audio.currentTime = d.seekTime; });
}

// ------------------------------------------------------------ wiring
// Attached once for the lifetime of the document, so they keep working no
// matter which page is on screen.
audio.addEventListener('play', () => { state.playing = true; emit(); });
audio.addEventListener('pause', () => { state.playing = false; saveProgress(true); emit(); });
audio.addEventListener('timeupdate', () => { saveProgress(false); emit(); });
audio.addEventListener('seeked', () => emit());
audio.addEventListener('durationchange', () => {
  state.duration = Number.isFinite(audio.duration) ? audio.duration : state.duration;
  emit();
});
audio.addEventListener('loadedmetadata', () => {
  // The rate is thrown away on every load; this is what makes the pitch and
  // speed sliders actually take effect on a newly opened song.
  applyRatioSafely();
  state.duration = Number.isFinite(audio.duration) ? audio.duration : state.duration;
  emit();
});
audio.addEventListener('canplay', applyRatioSafely);
audio.addEventListener('ratechange', () => {
  // Detect a silent reset by the browser and put it back.
  const want = targetRate();
  if (Math.abs(audio.playbackRate - want) > 0.001) applyRatioSafely();
});
audio.addEventListener('ended', () => {
  postProgress(true);
  if (state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  advance(1);
});
audio.addEventListener('error', () => {
  if (audio.src) toast('That file could not be played.', 'error');
});

const notify = () => { saveProgress(false); updateMediaSession(); };
for (const ev of ['play', 'pause', 'timeupdate', 'seeked', 'durationchange', 'loadedmetadata']) {
  audio.addEventListener(ev, notify);
}

// Save the position the moment the tab is hidden or closed so background
// listening time is never lost.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress(true);
});
window.addEventListener('pagehide', () => saveProgress(true));
window.addEventListener('beforeunload', () => saveProgress(true));

bindMediaSession();
loadPrefs();