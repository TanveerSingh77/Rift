/**
 * VidGrab - cloud bridge.
 *
 * The server resolves where a video lives and then gets out of the way. It
 * never writes media to its own filesystem: `/download` pipes yt-dlp's stdout
 * straight into the HTTP response and `/save` redirects the device to the CDN.
 * That is what keeps the app inside a free cloud host's storage limit, where
 * the filesystem is small, ephemeral, and wiped on every spin-down.
 *
 * Metadata endpoints (`/api/probe`, `/api/playlist`) are kept because the
 * preview and playlist pages depend on them. Everything that implied a
 * server-side library returns empty rather than 404, so the other pages render
 * instead of erroring.
 */

import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

// Cloud hosts pick the port and route traffic through a proxy, so binding
// loopback here would reset every request. Listen on all interfaces.
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';

// Opt-in shared secret. A Render URL is public, and without a token anyone who
// finds it can spend this account's bandwidth. Unset locally so development
// needs no configuration.
const TOKEN = (process.env.VIDGRAB_TOKEN || '').trim();

const MISSING_BIN =
  'yt-dlp is not available on this server. Locally: npm run setup. '
  + 'On a cloud host it is installed by the build command (see render-build.sh).';

// --------------------------------------------------------------- binaries

/** Resolve an executable on PATH, the way a shell would. */
function whichSync(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * yt-dlp, or null.
 *
 * On a cloud host the binary is a Linux executable unpacked into ./bin by the
 * build command, so there is no Windows .exe anywhere in this deployment.
 */
function resolveYtdlp() {
  const override = process.env.VIDGRAB_YTDLP;
  if (override && fs.existsSync(override)) return override;

  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  for (const dir of [path.join(ROOT, 'bin'), '/usr/local/bin', '/usr/bin']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return whichSync(name) || whichSync('yt-dlp');
}

function resolveFfmpeg() {
  const override = process.env.VIDGRAB_FFMPEG;
  if (override && fs.existsSync(override)) return override;
  for (const dir of [path.join(ROOT, 'bin'), '/usr/local/bin', '/usr/bin']) {
    const candidate = path.join(dir, 'ffmpeg');
    if (fs.existsSync(candidate)) return candidate;
  }
  return whichSync('ffmpeg');
}

const YTDLP = resolveYtdlp();
const FFMPEG = resolveFfmpeg();

// ----------------------------------------------------------------- yt-dlp

/**
 * YouTube's challenge needs a JavaScript runtime. Node 20+ is used directly
 * here; there is no Deno in a Linux container image.
 */
function baseArgs() {
  const args = ['--no-colors', '--no-simulate'];
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) {
    args.push('--js-runtimes', `node:${process.execPath}`);
    args.push('--remote-components', 'ejs:github');
  }
  if (FFMPEG) args.push('--ffmpeg-location', path.dirname(FFMPEG));

  // A datacentre IP is far more likely to be challenged than a home one, and
  // cookies are the only reliable way through. Supplied as an env var pointing
  // at a Render secret file, never committed.
  const cookies = (process.env.VIDGRAB_COOKIES || '').trim();
  if (cookies && fs.existsSync(cookies)) args.push('--cookies', cookies);
  return args;
}

function cleanError(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[debug\]/.test(l) && !/^\d{4}-\d{2}-\d{2}/.test(l));
  const interesting = lines.filter((l) => /^ERROR:/.test(l) || /Unsupported URL|Private video|not available|sign in|requested format/i.test(l));
  return (interesting[0] || lines[lines.length - 1] || '').replace(/^ERROR:\s*/, '');
}

function runYtdlp(args, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!YTDLP) {
      reject(new Error(MISSING_BIN));
      return;
    }
    const child = spawn(YTDLP, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`yt-dlp timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(cleanError(stderr || stdout) || `yt-dlp exited with code ${code}`));
    });
  });
}

/**
 * Above 720p YouTube serves DASH only, so video and audio are separate streams
 * and there is no single muxed file a redirect could point at.
 */
const PROGRESSIVE_MAX = 720;

/**
 * A selector that resolves to exactly one file.
 *
 * The acodec/vcodec filters are explicit rather than relying on yt-dlp's
 * implicit sort, because silently picking a video-only stream produces a
 * soundless file that looks like a successful download.
 *
 * The tail of the chain matters: some uploads (old or low-resolution ones) are
 * DASH-only with no pre-muxed progressive format at all. Note the bare `best`
 * cannot rescue them, because `best` itself means "best containing both video
 * and audio" and errors out when no such format exists. Only `bestvideo`
 * matches, so it closes the chain and keeps /save working on every video.
 */
function directFormat(kind, maxHeight) {
  if (kind === 'audio') return 'bestaudio[ext=m4a]/bestaudio[acodec!=none]/bestaudio';
  const h = Math.min(Number(maxHeight) || PROGRESSIVE_MAX, PROGRESSIVE_MAX);
  return [
    `best[ext=mp4][height<=${h}][acodec!=none][vcodec!=none]`,
    `best[height<=${h}][acodec!=none][vcodec!=none]`,
    `bestvideo[ext=mp4][height<=${h}]`,
    `bestvideo[height<=${h}]`,
  ].join('/');
}

/** Merged pair when ffmpeg can mux in the pipe, otherwise a single file. */
function streamFormat(kind, maxHeight) {
  if (kind === 'audio') return 'bestaudio/best';
  const h = Number(maxHeight) || 1080;
  return FFMPEG ? `bv*[height<=${h}]+ba/b[height<=${h}]` : directFormat('video', h);
}

function sanitizeFilename(name, fallback = 'video') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * Resolve a link and enough metadata to name the file, downloading nothing.
 *
 * One simulate-mode call serves both `/save` and `/download`, so the filename
 * is known before a single byte of response body is written.
 */
async function resolveMeta(url, { kind = 'video', maxHeight = 1080 } = {}) {
  const { stdout } = await runYtdlp([
    ...baseArgs(),
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '-f',
    streamFormat(kind, maxHeight),
    '--print',
    '%(url)s\t%(title)s\t%(ext)s',
    url,
  ]);
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (!line) throw new Error('Could not resolve that link.');
  const [directUrl, title, ext] = line.split('\t');
  if (!/^https?:\/\//i.test(directUrl || '')) throw new Error('yt-dlp did not return a direct link.');
  return {
    directUrl,
    title: sanitizeFilename(title, 'video'),
    ext: sanitizeFilename(ext, kind === 'audio' ? 'm4a' : 'mp4').replace(/^\./, ''),
  };
}

function validUrl(value) {
  if (!value || typeof value !== 'string') return false;
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/\S+/i.test(value.trim());
}

// ------------------------------------------------------------------ setup

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

function authorized(req) {
  if (!TOKEN) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const supplied = String(req.headers['x-vidgrab-token'] || '') || bearer;
  return supplied.length > 0 && supplied === TOKEN;
}

/** Gate for the two routes that can spend this host's bandwidth. */
function gate(req, res) {
  if (authorized(req)) return false;
  res.status(401).json({ error: 'Bad or missing token.' });
  return true;
}

/**
 * RFC 6266 with an ASCII fallback. Titles carry emoji and accents, and a raw
 * non-ASCII byte in the quoted form makes some mobile browsers drop the header
 * and save the file as "download" with no extension.
 */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function readKind(req, fallback = 'video') {
  const raw = req.query.kind ?? req.body?.kind;
  return raw === 'audio' ? 'audio' : fallback;
}

function readHeight(req, fallback) {
  const n = Number(req.query.height ?? req.body?.height);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ----------------------------------------------------------------- routes

/**
 * Stream the media through to the device without touching disk.
 *
 * This is the primary download route. It is deliberately same-origin: the
 * browser only honours Content-Disposition (and therefore only *saves* rather
 * than *plays*) for a same-origin response. Pointing the browser straight at
 * the cross-origin CDN URL instead would navigate to the video and lose the
 * filename, so the few bytes of overhead here are what make the save work.
 *
 * Costs this host's bandwidth allowance; use /save for large files.
 */
app.get('/download', async (req, res) => {
  if (gate(req, res)) return;

  const target = String(req.query.url || '').trim();
  if (!validUrl(target)) return res.status(400).json({ error: 'Paste a valid YouTube URL first.' });
  const kind = readKind(req);
  const maxHeight = readHeight(req, 1080);
  const audioFormat = String(req.query.audioFormat || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';

  let info;
  try {
    info = await resolveMeta(target, { kind, maxHeight });
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const ext = kind === 'audio' ? audioFormat : info.ext || 'mp4';
  const disposition = contentDisposition(`${info.title}.${ext}`);

  if (req.method === 'HEAD') {
    return res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition }).end();
  }

  const args = [
    ...baseArgs(),
    '--quiet',
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--no-mtime',
    '--no-progress',
    '--socket-timeout',
    '120',
    '--retries',
    '10',
    '-o',
    '-',
  ];
  if (kind === 'audio') {
    args.push('-f', streamFormat(kind), '-x', '--audio-format', audioFormat);
  } else {
    args.push('--downloader', FFMPEG ? 'ffmpeg' : 'native', '-f', streamFormat(kind, maxHeight));
  }
  args.push(target);

  const child = spawn(YTDLP, args, { windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });

  // A phone that closes the tab or drops off Wi-Fi must not leave yt-dlp
  // pulling megabytes nobody will receive.
  let settled = false;
  const kill = () => {
    if (settled) return;
    settled = true;
    if (!child.killed) child.kill('SIGKILL');
  };
  req.on('close', kill);
  res.on('close', kill);

  let started = false;
  const begin = () => {
    if (started || settled) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      // Stops any intermediary buffering the whole file before replying.
      'X-Accel-Buffering': 'no',
    });
    child.stdout.pipe(res);
  };

  // Headers are held back until the first media byte on purpose: if yt-dlp
  // fails during extraction there is nothing to send yet, and a 200 with an
  // empty body would leave the phone holding a corrupt 0-byte file instead of
  // a readable error.
  child.stdout.once('data', begin);
  child.stdout.once('error', () => {});
  child.on('error', (err) => {
    if (started) res.destroy();
    else res.status(500).json({ error: err.message });
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    if (!started) {
      const detail = String(stderr).trim().split(/\r?\n/).filter(Boolean).pop();
      return res.status(502).json({ error: detail || `yt-dlp produced no data (exit code ${code})` });
    }
    return res.end();
  });
});

/**
 * Redirect the device straight at the media.
 *
 * Zero media bytes and effectively zero bandwidth pass through this server,
 * which is the right choice for large files on a metered free tier. The cost
 * is that a redirect cannot set Content-Disposition on the final response, so
 * the saved filename comes from the CDN rather than the video title, and the
 * quality ceiling is 720p because that is the highest already-muxed MP4.
 */
app.get('/save', async (req, res) => {
  if (gate(req, res)) return;

  const target = String(req.query.url || '').trim();
  if (!validUrl(target)) return res.status(400).json({ error: 'Paste a valid YouTube URL first.' });
  const kind = readKind(req);
  const maxHeight = readHeight(req, PROGRESSIVE_MAX);

  try {
    const info = await resolveMeta(target, { kind, maxHeight });
    res.writeHead(302, {
      Location: info.directUrl,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    return res.end();
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
});

/** Metadata only. Powers the preview card on the download page. */
app.post('/api/probe', async (req, res) => {
  const target = String(req.body?.url || '').trim();
  if (!validUrl(target)) return res.status(400).json({ error: 'Paste a valid YouTube URL first.' });

  try {
    const { stdout } = await runYtdlp([...baseArgs(), '-J', '--no-playlist', '--skip-download', target]);
    const data = JSON.parse(stdout);
    if (data._type === 'playlist') {
      return res.json({
        kind: 'playlist',
        title: data.title,
        playlistId: data.id,
        count: (data.entries || []).length,
        thumbnail: data.entries?.[0]?.thumbnail || null,
      });
    }
    return res.json({
      kind: 'video',
      id: data.id,
      title: data.title || 'Unknown',
      uploader: data.uploader || data.channel || null,
      duration: typeof data.duration === 'number' ? data.duration : null,
      thumbnail: data.thumbnail || null,
      viewCount: data.view_count ?? null,
      extractor: data.extractor_key || data.extractor || null,
      isLive: Boolean(data.is_live),
    });
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
});

/** Playlist listing. Flat mode, so it stays fast and needs no per-video call. */
app.post('/api/playlist', async (req, res) => {
  const target = String(req.body?.url || '').trim();
  if (!validUrl(target)) return res.status(400).json({ error: 'Paste a valid YouTube playlist URL.' });

  try {
    const { stdout } = await runYtdlp([...baseArgs(), '-J', '--flat-playlist', '--skip-download', target], { timeout: 120000 });
    const data = JSON.parse(stdout);
    if (data._type !== 'playlist') return res.status(422).json({ error: 'That link is not a playlist.' });

    return res.json({
      title: data.title || 'Playlist',
      playlistId: data.id,
      uploader: data.uploader || data.channel || null,
      thumbnail: data.thumbnails?.[data.thumbnails.length - 1]?.url || null,
      entries: (data.entries || [])
        .filter((e) => e && (e.id || e.url))
        .map((e, i) => ({
          index: i + 1,
          id: e.id || String(e.url).split('v=')[1] || null,
          title: e.title || e.id || 'Unknown',
          duration: typeof e.duration === 'number' ? e.duration : null,
          uploader: e.uploader || e.channel || null,
          thumbnail: e.thumbnails?.[e.thumbnails.length - 1]?.url || (e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : null),
        })),
    });
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: Boolean(YTDLP),
    mode: 'bridge',
    setup: {
      ytdlp: { found: Boolean(YTDLP), path: YTDLP },
      ffmpeg: { found: Boolean(FFMPEG), path: FFMPEG },
      runtime: { name: 'node', path: process.execPath },
      cookies: Boolean((process.env.VIDGRAB_COOKIES || '').trim()),
      platform: process.platform,
      node: process.version,
    },
    tiers: [
      { height: 720, label: '720p' },
      { height: 1080, label: '1080p' },
      { height: 1440, label: '1440p' },
      { height: 2160, label: '4K' },
    ],
  });
});

app.get('/api/mode', (req, res) => res.json({ mode: 'bridge' }));

// The library endpoints below are intentionally inert. Returning an empty,
// well-formed shape keeps the Videos/Music/Player pages rendering instead of
// throwing on a 404, and makes the "nothing is stored here" behaviour obvious
// to anything that inspects the API.
const NO_LIBRARY = { items: [], stats: { total: 0, videos: 0, music: 0, bytes: 0, completed: 0 }, mode: 'bridge' };
const NO_STORE = 'This server keeps no library. Files are streamed straight to your device via /download.';

app.get('/api/library', (req, res) => res.json(NO_LIBRARY));
app.get('/api/jobs', (req, res) => res.json([]));
app.delete('/api/jobs/:id', (req, res) => res.json({ cancelled: false }));
app.get('/api/library/rescan', (req, res) => res.json({ added: 0 }));
app.post('/api/library/rescan', (req, res) => res.json({ added: 0 }));
app.post('/api/library/clear', (req, res) => res.json({ deleted: 0 }));

// Watch positions belong to a stored file, and nothing is stored. The player
// still posts here, so it gets an accepted no-op rather than a failed request
// on every seek.
const progress = new Map();
app.post('/api/progress/:id', (req, res) => {
  progress.set(req.params.id, req.body || {});
  return res.json({ ok: true });
});
app.get('/api/progress/:id', (req, res) => res.json(progress.get(req.params.id) || { position: 0, completed: false }));
app.delete('/api/progress/:id', (req, res) => {
  progress.delete(req.params.id);
  return res.json({ cleared: req.params.id });
});

// Settings are session-only: there is no database to persist them to.
const settings = { maxHeight: 1080, audioFormat: 'mp3', autoResume: true };
app.get('/api/settings', (req, res) => res.json(settings));
app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  if ([720, 1080, 1440, 2160].includes(Number(body.maxHeight))) settings.maxHeight = Number(body.maxHeight);
  if (['mp3', 'm4a', 'opus', 'wav', 'flac'].includes(body.audioFormat)) settings.audioFormat = body.audioFormat;
  if (typeof body.autoResume === 'boolean') settings.autoResume = body.autoResume;
  return res.json(settings);
});

const playerPrefs = { speed: 1, pitch: 0, volume: 1 };
app.get('/api/player', (req, res) => res.json(playerPrefs));
app.put('/api/player', (req, res) => {
  const body = req.body || {};
  if (Number.isFinite(Number(body.speed))) playerPrefs.speed = Math.min(4, Math.max(0.25, Number(body.speed)));
  if (Number.isFinite(Number(body.pitch))) playerPrefs.pitch = Math.min(12, Math.max(-12, Number(body.pitch)));
  if (Number.isFinite(Number(body.volume))) playerPrefs.volume = Math.min(1, Math.max(0, Number(body.volume)));
  return res.json(playerPrefs);
});

// yt-dlp is refreshed by redeploying, so this reports rather than mutates.
app.post('/api/ytdlp/update', (req, res) => {
  res.json({ version: YTDLP ? 'managed by the build command' : null, output: 'yt-dlp is updated by redeploying the service. Redeploy to pull a newer build.' });
});

const STUBBED = (req, res) => res.status(409).json({ error: NO_STORE, mode: 'bridge' });
app.post('/api/download', STUBBED);
app.post('/api/playlist-download', STUBBED);
app.post('/api/upload', STUBBED);
app.post('/api/reveal', STUBBED);
app.delete('/api/library/:id', STUBBED);
app.get('/media/*', STUBBED);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// SPA-style fallback for page requests only. Falling back for assets too would
// hand a browser HTML where it expected a script, turning a typo into a
// baffling MIME-type error.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const ext = path.extname(req.path);
  if (ext) return res.status(404).type('text/plain').send('Not found');
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`\n  VidGrab bridge  http://${HOST}:${PORT}`);
  console.log(`  ytdlp: ${YTDLP || 'NOT FOUND - see render-build.sh'}`);
  console.log(`  ffmpeg: ${FFMPEG || 'NOT FOUND (no video+audio merge, no MP3)'}`);
  console.log(`  cookies: ${(process.env.VIDGRAB_COOKIES || '').trim() ? 'loaded' : 'none'}`);
  console.log('  storage: none - media is streamed to the device\n');
});

process.on('uncaughtException', (err) => console.error('[uncaught]', err));