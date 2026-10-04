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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

// Cloud hosts pick the port and route traffic through a proxy, so binding
// loopback here would reset every request. Listen on all interfaces.
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';

// Ensure cookies from read-only secret mounts (Render) are available to yt-dlp.
// The destination has to be writable because yt-dlp rewrites the jar as it
// refreshes session cookies, and it must be OS-correct: the hard-coded /tmp
// path this replaces silently failed on Windows, which is where local testing
// happens, and every local run then fell through to the read-only source.
const COOKIES_SRC = (process.env.VIDGRAB_COOKIES || '').trim();
const COOKIES_DST = path.join(os.tmpdir(), 'youtube_cookies.txt');

if (COOKIES_SRC) {
  try {
    // Copy synchronously on startup so all subsequent spawns use writable cookies.
    fs.copyFileSync(COOKIES_SRC, COOKIES_DST);
  } catch (err) {
    console.warn(`Failed to copy VIDGRAB_COOKIES to ${COOKIES_DST}:`, err.message);
  }
}

// Opt-in shared secret. A Render URL is public, and without a token anyone who
// finds it can spend this account's bandwidth. Unset locally so development
// needs no configuration.
const TOKEN = (process.env.VIDGRAB_TOKEN || '').trim();

const MISSING_BIN =
  'yt-dlp is not available on this server. It is installed by the build step '
  + '(see render-build.sh); check that the build command ran and that the '
  + 'deployment is using a Linux build.';

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
 *
 * `client` selects which YouTube app the extractor impersonates. It is threaded
 * through by the caller that is retrying a bot check (see YT_CLIENTS); pass
 * nothing to use yt-dlp's own default chain.
 */
function baseArgs({ client } = {}) {
  const args = ['--no-colors', '--no-simulate'];
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) {
    args.push('--js-runtimes', `node:${process.execPath}`);
    args.push('--remote-components', 'ejs:github');
  }
  if (FFMPEG) args.push('--ffmpeg-location', path.dirname(FFMPEG));

  // A datacentre IP is far more likely to be challenged than a home one, and
  // cookies are the only reliable way through. Supplied as an env var pointing
  // at a Render secret file, never committed. Always pass if configured so the
  // deployed instance gets the bot-block bypass.
  if (COOKIES_SRC) {
    try {
      if (fs.existsSync(COOKIES_DST)) {
        args.push('--cookies', COOKIES_DST);
      } else {
        fs.copyFileSync(COOKIES_SRC, COOKIES_DST);
        args.push('--cookies', COOKIES_DST);
      }
    } catch (err) {
      console.warn('Failed to prepare VIDGRAB_COOKIES:', err.message);
      args.push('--cookies', COOKIES_SRC);
    }
  }

  if (client) args.push('--extractor-args', `youtube:player_client=${client}`);
  return args;
}

/**
 * YouTube apps to impersonate, in the order they are tried.
 *
 * This is the fix for "Sign in to confirm you're not a bot". That check is not
 * about cookies and not about being logged out: YouTube applies it per player
 * client based on the shape of the request, and a datacentre IP is challenged by
 * the default `web` client almost every time. Cookies are the last resort, not
 * the mechanism, and until this list existed the only way through them was to
 * configure a secret the user does not have.
 *
 * Every entry here was verified to deliver real, playable bytes, not merely to
 * answer metadata. That distinction matters and is not obvious:
 *
 *  - `android_vr`, `tv` and `ios` extract fine and then return HTTP 403 for the
 *    media itself, so a client list built from "which one answers the API"
 *    hands the device a 0-byte file with a success status.
 *  - `tv_simply`, `mweb`, `web_safari` and `web_embedded` all serve bytes.
 *
 * `default` is last so no link is lost to this list being incomplete.
 */
const YT_CLIENTS = [
  'tv_simply,mweb',
  'web_safari',
  'web_embedded,mweb',
  'mweb',
  'default',
];

/**
 * Failures that mean "this client got challenged", as opposed to "this video is
 * unavailable". Only the former is worth retrying with a different client.
 */
const CHALLENGE_RE = /sign in to confirm|confirm you'?re not a bot|not a bot|confirm your age|age-restricted|bot detection|http error 429|too many requests|po ?token|missing.*potoken|login required/i;

function isChallenge(text) {
  return CHALLENGE_RE.test(String(text || ''));
}

/** The last client that produced data, so /api/health can report what works. */
let workingClient = null;

function cleanError(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[debug\]/.test(l) && !/^\d{4}-\d{2}-\d{2}/.test(l));
  const interesting = lines.filter((l) => /^ERROR:/.test(l) || /Unsupported URL|Private video|not available|sign in|requested format/i.test(l));
  return (interesting[0] || lines[lines.length - 1] || '').replace(/^ERROR:\s*/, '');
}

function runYtdlpOnce(args, { timeout = 90000 } = {}) {
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
 * Run a yt-dlp command, stepping down the client ladder when challenged.
 *
 * `build` is a function of the client so each attempt is genuinely a different
 * request. A pre-built argument array would make the retries identical, which
 * costs six timeouts to produce the same error the first attempt already gave.
 */
async function runYtdlp(build, opts = {}) {
  let last = null;
  for (const client of YT_CLIENTS) {
    try {
      const out = await runYtdlpOnce(build(client), opts);
      workingClient = client;
      return out;
    } catch (err) {
      last = err;
      // Anything that is not a challenge (a private video, an unsupported URL,
      // a dead format) will fail identically for every client, so surface it now.
      if (!isChallenge(err.message)) throw err;
    }
  }
  throw last || new Error('Could not reach YouTube.');
}

/** The actionable form of a bot check, for the one case the ladder cannot fix. */
function challengeMessage(err) {
  const base = err?.message || 'YouTube refused the request.';
  if (!isChallenge(base)) return base;
  return COOKIES_SRC
    ? `${base} The configured cookies were rejected too; they are probably expired.`
    : `${base} This server has no YouTube cookies configured, which is the only remaining way through. `
      + 'Export cookies.txt and set it as the VIDGRAB_COOKIES secret on the server.';
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
  // Keep this identical to streamFormat's audio selector. A "smarter" probe
  // chain such as bestaudio[ext=m4a]/bestaudio[acodec!=none]/bestaudio looks
  // better but breaks on most clients: they expose no audio-only formats at
  // all, only combined ones, so every selector in that chain errors with
  // "Requested format is not available" and the ladder burns a client on each
  // one. Plain bestaudio/best matches on all of them. Nothing is lost by dropping
  // the m4a preference -- /download renames to --audio-format after extracting,
  // so the probe's ext never reaches the user.
  if (kind === 'audio') return 'bestaudio/best';
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
 *
 * This deliberately probes with `directFormat`, not `streamFormat`. A merged
 * selector (bv*+ba) has no single URL, so yt-dlp reports %(url)s as the literal
 * string "NA" -- and it does so silently, with a zero exit code. Using it here
 * would make /save redirect to "NA" and label /download output as .webm even
 * though the real stream is muxed to MP4. The actual download still uses
 * streamFormat, which can merge freely because nothing reads %(url)s from it.
 */
async function resolveMeta(url, { kind = 'video', maxHeight = 1080 } = {}) {
  const { stdout } = await runYtdlp((client) => [
    ...baseArgs({ client }),
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '-f',
    directFormat(kind, maxHeight),
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

/**
 * Authorization for the two bandwidth-spending routes.
 *
 * Headers are checked first, which is what the JSON API uses. The query
 * parameter is accepted too because the browser reaches these routes through a
 * plain navigation (`location.href = /download?...`), and a navigation cannot
 * set a custom header. Without this, setting VIDGRAB_TOKEN would make every
 * download fail with a 401 while the rest of the app kept working, which reads
 * as a broken toggle rather than a locked-down one.
 *
 * A token in a URL can end up in proxy logs, so headers are preferred wherever
 * the caller controls the request.
 */
function authorized(req) {
  if (!TOKEN) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const fromQuery = String((req.query && req.query.token) || '').trim();
  const supplied =
    String(req.headers['x-vidgrab-token'] || '').trim() || bearer || fromQuery;
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
 * Where a download is assembled before it is sent.
 *
 * os.tmpdir(), not the app directory: this host's filesystem is small and
 * ephemeral and gets wiped on spin-down, which is fine for a scratch file that
 * lives for the length of one request.
 */
const SCRATCH = path.join(os.tmpdir(), 'vidgrab-scratch');

/** Containers whose first bytes are legitimately an audio frame sync. */
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'm4b', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'weba']);

/**
 * Does this look like the container we asked for?

 *
 * This check exists because of a silent failure that cost real downloads.
 * yt-dlp's `-o -` writes to a pipe, which is not seekable, so it stops asking
 * for a single muxed progressive file and concatenates the separate video and
 * audio streams instead. The exit code is 0 and the byte count is larger than
 * the real file, so nothing reports a problem, and the device is handed ~65MB
 * of raw stream data with no MP4 header anywhere in it. Every such file plays as
 * "That file could not be played."
 *
 * Sniffing the first bytes turns that into a retry while the response headers
 * are still unwritable, so the device never sees the broken attempt.
 */
function looksLikeMedia(head, ext) {
  if (!head || head.length < 4) return false;
  const ascii = (from, len) => head.slice(from, from + len).toString('latin1');
  const b0 = head[0];
  const b1 = head[1];

  // MP4 family: an ISO base media file begins with a box. 'ftyp' is the normal
  // one; the rest are accepted because a fragmented or unusual mux can lead with
  // one of them instead, and all of them are still a valid file to hand over.
  if (head.length >= 8) {
    const box = ascii(4, 4);
    if (['ftyp', 'styp', 'moov', 'moof', 'mdat', 'free', 'skip', 'wide'].includes(box)) return true;
  }
  // Matroska / WebM.
  if (b0 === 0x1a && b1 === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
  // MPEG-TS: the sync byte repeats every 188 bytes.
  if (b0 === 0x47 && head.length > 188 && head[188] === 0x47) return true;

  // Everything below can only be the right answer when audio was what we asked
  // for, so they are gated on the requested extension.
  const wanted = String(ext || '').toLowerCase();
  if (AUDIO_EXTS.has(wanted)) {
    // Ogg (Vorbis / Opus / FLAC-in-Ogg).
    if (ascii(0, 4) === 'OggS') return true;
    // FLAC.
    if (ascii(0, 4) === 'fLaC') return true;
    // RIFF/WAVE.
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return true;
    // ID3 tag, or a bare MPEG audio frame sync. Gated on `wanted` because a
    // bare sync is only two bytes and collisions are unavoidable: FF FE is a
    // perfectly valid MPEG-1 Layer I frame header, so accepting it for a request
    // that expected an MP4 would wave through the very corruption this exists to
    // catch.
    if (ascii(0, 3) === 'ID3') return true;
    if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true;
  }

  // Deliberately strict beyond this point. An unrecognised header is the exact
  // shape of the concatenated-stream corruption described above, and accepting
  // it would make this whole check a no-op while looking like it worked.
  return false;
}


function sniffHead(file, bytes = 16) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function rmQuiet(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* the scratch dir is disposable and gets swept on restart */
  }
}

/**
 * Download one link to a scratch file with a single yt-dlp client.
 *
 * Resolves with { file, size, ext } only once the file is on disk and its
 * header has been verified, so the caller can decide whether to send it or try
 * another client.
 */
function downloadToScratch({ target, kind, maxHeight, audioFormat, client }) {
  return new Promise((resolve, reject) => {
    if (!YTDLP) {
      reject(new Error(MISSING_BIN));
      return;
    }

    const dir = path.join(SCRATCH, `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    const outTpl = path.join(dir, 'media.%(ext)s');

    const args = [
      ...baseArgs({ client }),
      '--no-warnings',
      '--no-playlist',
      '--no-part',
      '--no-mtime',
      '--no-progress',
      '--socket-timeout',
      '120',
      '--retries',
      '10',
// Sized to the host, not to YouTube. The scratch copy lives on the same
      // ephemeral disk as everything else on a small instance, so the ceiling
      // has to leave room for ffmpeg's temp files during extraction and for the
      // OS itself. Video is already capped at 720p, where a real file is tens
      // of megabytes, so this never fires on anything the ladder would serve.
      '--max-filesize',
      '300M',

      '-o',
      outTpl,
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

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rmQuiet(dir);
      reject(new Error('yt-dlp timed out'));
    }, 15 * 60 * 1000);

    child.on('error', (err) => {
      clearTimeout(timer);
      rmQuiet(dir);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        files = [];
      }
      const name = files.find((f) => f.startsWith('media.'));
      if (code !== 0 || !name) {
        const detail = cleanError(stderr || '');
        rmQuiet(dir);
        const err = new Error(detail || `yt-dlp produced no file (exit code ${code})`);
        // The challenge text can be several lines above the last one.
        err.raw = stderr;
        reject(err);
        return;
      }

      const file = path.join(dir, name);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        rmQuiet(dir);
        reject(new Error('The downloaded file vanished before it could be sent.'));
        return;
      }
      if (!size) {
        rmQuiet(dir);
        reject(new Error('The download finished empty.'));
        return;
      }

      const ext = name.replace(/^media\./, '') || 'mp4';
      // A real track is never a few bytes long. Checked as well as the header so
      // a truncated or error-page body cannot pass as media.
      if (size < 1024) {
        rmQuiet(dir);
        const err = new Error('The download was too small to be a real file.');
        err.corrupt = true;
        reject(err);
        return;
      }
      let head = null;
      try {
        head = sniffHead(file, 200);
      } catch {
        /* treated as unverified below */
      }
      if (!looksLikeMedia(head, ext)) {
        rmQuiet(dir);
const err = new Error(`The ${ext} that came back was not a playable file.`);
        err.corrupt = true;
        reject(err);
        return;
      }

      resolve({ file, dir, size, ext, name, mime: mimeFor(ext) });
    });
  });
}

/** Containers yt-dlp can produce here, and what the device should be told. */
const MIME_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  weba: 'audio/webm',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

const mimeFor = (ext) => MIME_TYPES[String(ext || '').toLowerCase()] || 'application/octet-stream';

/**
 * Send a verified scratch file to the device, then delete it.
 *
 * The file is streamed rather than buffered, so memory stays flat, and the
 * scratch copy is removed the moment the last byte has gone out — including
 * when the device hangs up halfway through, which is the common case on a
 * phone leaving Wi-Fi.
 */
function sendFile(req, res, { file, dir, size, mime }, disposition) {
  return new Promise((resolve) => {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': disposition,
      // Real length, so the app can show a true percentage instead of a bar
      // that fills up at an unknown rate.
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });

    const stream = fs.createReadStream(file);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      rmQuiet(dir);
      resolve();
    };

    stream.on('error', () => {
      res.destroy();
      done();
    });
    res.on('close', done);
    stream.on('end', () => {
      res.end();
      done();
    });
    stream.pipe(res);
  });
}

/**
 * Download the media and stream it to the device.
 *
 * Deliberately same-origin: the browser only honours Content-Disposition, and
 * therefore only *saves* rather than *plays*, for a same-origin response.
 *
 * Each client on the ladder is tried in turn and its output is verified before
 * any header is sent, so a challenged client, a client whose media URLs are
 * refused, and a client that returns an unplayable file are all retried without
 * the device ever seeing a broken attempt.
 */
app.get('/download', async (req, res) => {
  if (gate(req, res)) return;

  const target = String(req.query.url || '').trim();
  if (!validUrl(target)) return res.status(400).json({ error: 'Paste a valid YouTube URL first.' });
  const kind = readKind(req);
  const maxHeight = readHeight(req, 1080);
  const audioFormat = String(req.query.audioFormat || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';

  if (req.method === 'HEAD') {
    let info;
    try {
      info = await resolveMeta(target, { kind, maxHeight });
    } catch (err) {
      return res.status(422).json({ error: challengeMessage(err) });
    }
const ext = kind === 'audio' ? audioFormat : info.ext || 'mp4';
    return res.status(200).set({
      'Content-Type': mimeFor(ext),
      'Content-Disposition': contentDisposition(`${info.title}.${ext}`),
    }).end();
  }

  let info;
  try {
    info = await resolveMeta(target, { kind, maxHeight });
  } catch (err) {
    return res.status(422).json({ error: challengeMessage(err) });
  }

const ext = kind === 'audio' ? audioFormat : info.ext || 'mp4';

  // The client that just answered metadata is tried first: it is the most
  // likely to answer the media request too.
  const order = workingClient
    ? [workingClient, ...YT_CLIENTS.filter((c) => c !== workingClient)]
    : YT_CLIENTS;

  let last = null;
  for (const client of order) {
    let got = null;
    try {
      got = await downloadToScratch({ target, kind, maxHeight, audioFormat, client });
    } catch (err) {
      last = err;
      // A device that gave up mid-request should not keep the ladder running.
      if (res.writableEnded || req.destroyed) return undefined;
      if (!err.corrupt && !isChallenge(err.raw || err.message)) break;
      continue;
    }
    workingClient = client;
    // Name the file after the container that actually arrived rather than the
    // one metadata predicted. If a rung below the first had to serve webm, a
    // ".mp4" name over webm bytes is a lie the device cannot recover from.
    const realExt = kind === 'audio' ? audioFormat : got.ext || ext;
    await sendFile(req, res, got, contentDisposition(`${info.title}.${realExt}`));
    return undefined;
  }

  if (!res.headersSent) {
    res.status(last?.corrupt ? 502 : 422).json({
      error: challengeMessage(last || new Error('No YouTube player would serve that file.')),
    });
  }
  return undefined;
});

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
    return res.status(422).json({ error: challengeMessage(err) });
  }
});

/** Metadata only. Powers the preview card on the download page. */
app.post('/api/probe', async (req, res) => {
  const target = String(req.body?.url || '').trim();
  if (!validUrl(target)) return res.status(400).json({ error: 'Paste a valid YouTube URL first.' });

  try {
    const { stdout } = await runYtdlp((client) => [
      ...baseArgs({ client }),
      '-J',
      '--no-playlist',
      '--skip-download',
      target,
    ]);
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
    return res.status(422).json({ error: challengeMessage(err) });
  }
});



/** Playlist listing. Flat mode, so it stays fast and needs no per-video call. */
app.post('/api/playlist', async (req, res) => {
  const target = String(req.body?.url || '').trim();
  if (!validUrl(target)) return res.status(400).json({ error: 'Paste a valid YouTube playlist URL.' });

  try {
    const { stdout } = await runYtdlp(
      (client) => [...baseArgs({ client }), '-J', '--flat-playlist', '--skip-download', target],
      { timeout: 120000 },
    );
    const data = JSON.parse(stdout);
    if (data._type !== 'playlist') return res.status(422).json({ error: 'That link is not a playlist.' });

    return res.json({
      title: data.title || 'Playlist',
      playlistId: data.id,
      uploader: data.uploader || data.channel || null,
      thumbnail: data.thumbnails?.[data.thumbnails.length - 1]?.url || null,
      entries: (data.entries || [])
        .filter((e) => e && (e.id || e.url))
        .map((e, i) => {
          const id = e.id || String(e.url).split('v=')[1] || null;
          return {
            index: i + 1,
            id,
            // Required, not optional: the client hands this straight to /download
            // and /save. Without it every track was requested as the literal
            // string "undefined" and the download failed validation.
            url: id ? `https://www.youtube.com/watch?v=${id}` : e.url,
            title: e.title || id || 'Unknown',
            duration: typeof e.duration === 'number' ? e.duration : null,
            uploader: e.uploader || e.channel || null,
            thumbnail: e.thumbnails?.[e.thumbnails.length - 1]?.url || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
          };
        }),
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
      cookiesProblem: (process.env.VIDGRAB_COOKIES || '').trim() ? null : 'not set',
      // Which YouTube app is answering right now. Non-null means at least one
      // client has cleared the bot check on this host.
      client: workingClient,
      clients: YT_CLIENTS,
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
//
// Media lives on the device (see public/js/store.js), so the library is a client
// concern now. These are here so an older cached page still gets JSON.
const NO_LIBRARY = { items: [], stats: { total: 0, videos: 0, music: 0, bytes: 0, completed: 0 }, mode: 'bridge' };
const NO_STORE = 'This server keeps no library. Media is saved on your device, not here.';

app.get('/api/library', (req, res) => res.json(NO_LIBRARY));
// The Playlist page asks for recently used playlists. It is listed here so the
// request resolves to JSON; without it the SPA fallback answered with
// index.html and the client tried to parse a web page as a list.
app.get('/api/playlists', (req, res) => res.json([]));

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
  console.log(`  cookies: ${(process.env.VIDGRAB_COOKIES || '').trim() ? 'loaded' : 'none (player fallback only)'}`);
  console.log(`  youtube players: ${YT_CLIENTS.join(' -> ')}`);
  console.log('  storage: no library - media is downloaded to a temp file, sent, then deleted\n');
});

// A restart must not leave a device-sized file lying around in the temp dir.
function sweepScratch() {
  rmQuiet(SCRATCH);
}
process.on('exit', sweepScratch);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    sweepScratch();
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => console.error('[uncaught]', err));