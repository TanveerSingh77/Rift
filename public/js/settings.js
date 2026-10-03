import { api, $, el, setMsg, toast, fmtBytes, markActiveNav } from './common.js';
import { onCleanup } from './app.js';

markActiveNav();

const msg = $('#msg');
let settings = {};

// The resume rule is not a plain percentage: a stop is only offered when it is
// past BOTH 10 seconds and this share of the video, so the form has to explain
// the larger of the two rather than quote the number on its own.
const RESUME_FLOOR_SECONDS = 10;

const FORMAT_NOTES = {
  mp3: 'Re-encoded to MP3. Plays on every device, but the sound is compressed again.',
  m4a: 'Copied straight from the source when it is already AAC, so there is no extra quality loss.',
  opus: 'Re-encoded to Opus. Smaller files than MP3 at the same perceived quality.',
  flac: 'Repackaged into a FLAC container without regaining any detail — bigger than Opus for the same audio.',
  wav: 'Repackaged as uncompressed PCM. The largest option and no extra quality.',
};

async function load() {
  settings = await api.get('/api/settings');
  $('#maxHeight').value = String(settings.maxHeight);
  $('#audioFormat').value = settings.audioFormat;
  $('#concurrentJobs').value = String(settings.concurrentJobs);
  $('#cookies').value = settings.cookies || '';
  $('#autoResume').checked = settings.autoResume !== false;
  $('#resumeThresholdPct').value = settings.resumeThresholdPct;
  $('#markCompletePct').value = settings.markCompletePct;

  explainFormat();
  explainResume();
  showCookiesStatus(settings.cookiesProblem);

  const health = await api.get('/api/health');
  renderDiag(health);
  renderStats(health.stats);
}

function explainFormat() {
  $('#format-note').textContent = FORMAT_NOTES[$('#audioFormat').value] || '';
}

/** Turns the percentage into the real time limit for a few video lengths. */
function explainResume() {
  const pct = Number($('#resumeThresholdPct').value);
  if (!Number.isFinite(pct) || pct < 1) {
    $('#resume-note').textContent = 'Enter a number between 1 and 50.';
    return;
  }
  const examples = [[6, '10 min'], [40, '40 min'], [110, '1h 50m'], [240, '4 hours']];
  const parts = examples.map(([minutes, label]) => {
    const limit = Math.max(RESUME_FLOOR_SECONDS, (minutes * 60 * pct) / 100);
    return `${label}: ${Math.round(limit)}s`;
  });
  $('#resume-note').textContent =
    `A stop is only resumed if it is past both ${RESUME_FLOOR_SECONDS}s and ${pct}% of the video — so `
    + `${parts.join(', ')}. Raise this to ignore brief stops.`;
}

function showCookiesStatus(problem) {
  const note = $('#cookies-note');
  const has = Boolean($('#cookies').value.trim());
  if (!has) {
    note.textContent = 'Only needed for private or age-restricted videos. Must be a Netscape cookies.txt export.';
    note.style.color = '';
    return;
  }
  note.textContent = problem || 'cookies.txt found and looks valid.';
  note.style.color = problem ? 'var(--warn)' : 'var(--ok)';
}

function renderDiag(health) {
  const s = health.setup;
  const rows = [
    ['yt-dlp', s.ytdlp.found
      ? el('span', { style: 'color:var(--ok)' }, s.ytdlpVersion ? `installed \u2014 ${s.ytdlpVersion}` : 'installed')
      : el('span', { style: 'color:var(--warn)' }, 'missing \u2014 redeploy to run the build step')],
    ['ffmpeg', s.ffmpeg?.found
      ? el('span', { style: 'color:var(--ok)' }, 'installed \u2014 video+audio merge available')
      : el('span', { style: 'color:var(--warn)' }, 'missing \u2014 720p single-file downloads only')],
    ['JS runtime', s.runtime ? el('span', { style: 'color:var(--ok)' }, `${s.runtime.name}`) : el('span', { style: 'color:var(--warn)' }, 'none \u2014 Node 20+ required')],
    ['Cookies', s.cookies
      ? el('span', { style: 'color:var(--ok)' }, 'loaded from VIDGRAB_COOKIES')
      : el('span', { style: 'color:var(--warn)' }, 'none \u2014 some videos may be refused')],
    ['Node', s.node],
    ['Platform', s.platform],
    ['Server storage', el('span', { class: 'mono' }, 'none \u2014 media streams to your device')],
  ];
  const table = $('#diag');
  table.innerHTML = '';
  for (const [k, v] of rows) {
    table.append(el('tr', {}, el('td', {}, el('strong', {}, k)), el('td', {}, v instanceof Node ? v : String(v))));
  }
}

function renderStats(stats) {
  const table = $('#stats');
  table.innerHTML = '';
  const rows = [
    ['Items', String(stats.total)],
    ['Videos', String(stats.videos)],
    ['Songs', String(stats.music)],
    ['Finished', String(stats.completed)],
    ['Total size', fmtBytes(stats.bytes)],
  ];
  for (const [k, v] of rows) {
    table.append(el('tr', {}, el('td', {}, el('strong', {}, k)), el('td', {}, v)));
  }
}

// One save button covers the whole page. Previously the download fields and the
// resume fields each had their own button, and using the wrong one silently
// discarded the edits made in the other card.
// This page holds no timers or document-level listeners, but it does bind a
// message that outlives the DOM it points at.
let stale = false;
const onBeforeUnload = (e) => {
  if (stale) {
    e.preventDefault();
    e.returnValue = '';
  }
};

$('#save').addEventListener('click', async () => {
  const resumePct = Number($('#resumeThresholdPct').value);
  const donePct = Number($('#markCompletePct').value);
  if (!Number.isFinite(resumePct) || resumePct < 1 || resumePct > 50) {
    return setMsg(msg, '“Ignore stops earlier than” must be between 1 and 50.', 'error');
  }
  if (!Number.isFinite(donePct) || donePct < 50 || donePct > 100) {
    return setMsg(msg, '“Mark as watched after this much” must be between 50 and 100.', 'error');
  }
  try {
    settings = await api.put('/api/settings', {
      maxHeight: Number($('#maxHeight').value),
      audioFormat: $('#audioFormat').value,
      concurrentJobs: Number($('#concurrentJobs').value),
      cookies: $('#cookies').value.trim(),
      autoResume: $('#autoResume').checked,
      resumeThresholdPct: resumePct,
      markCompletePct: donePct,
    });
    stale = false;
    explainResume();
    showCookiesStatus(settings.cookiesProblem);
    setMsg(msg, 'Saved. Downloads already running keep the settings they started with.', 'ok');
  } catch (err) {
    setMsg(msg, err.message, 'error');
  }
});

// Leaving with unsaved edits is the fastest way to think a setting was saved
// when it was not.
for (const id of ['#maxHeight', '#audioFormat', '#concurrentJobs', '#cookies', '#autoResume', '#resumeThresholdPct', '#markCompletePct']) {
  const node = $(id);
  node.addEventListener('input', () => { stale = true; });
  node.addEventListener('change', () => { stale = true; });
}
window.addEventListener('beforeunload', onBeforeUnload);

$('#audioFormat').addEventListener('change', explainFormat);
$('#resumeThresholdPct').addEventListener('input', explainResume);
$('#cookies').addEventListener('input', () => showCookiesStatus(null));

$('#refresh').addEventListener('click', () => load().then(() => toast('Refreshed', 'ok')));

$('#rescan').addEventListener('click', async () => {
  const res = await api.post('/api/library/rescan');
  toast(res.added ? `Added ${res.added} file(s)` : 'Nothing new found', res.added ? 'ok' : 'info');
  load();
});

$('#wipe').addEventListener('click', async () => {
  if (!confirm('Delete ALL downloaded files from disk? This cannot be undone.')) return;
  if (!confirm('Really sure? Every video and song will be gone.')) return;
  await api.post('/api/library/clear');
  toast('Library cleared', 'ok');
  load();
});

$('#update-ytdlp').addEventListener('click', async () => {
  const out = $('#update-out');
  out.style.display = 'block';
  out.textContent = 'Updating yt-dlp…';
  try {
    const res = await api.post('/api/ytdlp/update', {});
    out.textContent = res.output || 'done';
    toast(`yt-dlp is now ${res.version || 'updated'}`, 'ok');
    load();
  } catch (err) {
    out.textContent = err.message;
    toast(err.message, 'error');
  }
});

onCleanup(() => {
  // without this the guard would survive every visit and fire against a
  // detached form.
  window.removeEventListener('beforeunload', onBeforeUnload);
});

load().catch((err) => setMsg(msg, err.message, 'error'));