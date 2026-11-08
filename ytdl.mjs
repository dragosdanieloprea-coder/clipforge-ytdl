// YouTube links for the local server: yt-dlp downloads the video (ffmpeg joins picture and sound) into a temp folder,
// the page plays it straight from here (in ranges, so even an hour-long video never has to fit in browser memory)
// and transcribes from a separate audio-only copy. Files are deleted after a few hours, when the visitor loads
// another video, or when the server restarts.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { renderer } from './render.mjs';

const MAX_SECONDS = 3 * 60 * 60;
const KEEP_MS = 6 * 60 * 60 * 1000;
const KEEP_PER_VISITOR = 2;

export function ytdl(root) {
  const bin = join(root, 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const ffmpeg = join(root, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const dir = join(tmpdir(), 'clipforge-yt');
  const jobs = new Map();
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const rnd = renderer(root, dir);
  const ready = () => existsSync(bin) && existsSync(ffmpeg);
  // Cloud servers: YouTube may ask datacenter addresses to sign in, so a cookies file (YTDL_COOKIES_FILE) can be passed to yt-dlp.
  const cookies = () => { const f = process.env.YTDL_COOKIES_FILE; return f && existsSync(f) ? ['--cookies', f] : []; };
  const owner = (req) => createHash('sha256').update(String(req.headers.cookie || '')).digest('hex');
  // Windows won't delete files a process still has open, so a running job is stopped first and cleaned up when it exits.
  const clean = (id) => { for (const f of readdirSync(dir)) if (f.startsWith(id)) try { rmSync(join(dir, f), { force: true }); } catch {} };
  const drop = (id) => { const j = jobs.get(id); if (!j) return; jobs.delete(id); rnd.drop(id); if (j.proc && j.proc.exitCode === null && j.proc.signalCode === null) { j.proc.once('close', () => clean(id)); j.proc.kill(); } else clean(id); };
  setInterval(() => { for (const [id, j] of jobs) if (Date.now() - j.started > KEEP_MS) drop(id); }, 60000).unref();

  function fail(j, err, code) {
    j.state = 'failed';
    const why = (err.match(/ERROR: (.*)/) || [, ''])[1].slice(0, 200);
    j.error = /Sign in to confirm|not a bot/i.test(err) ? 'YouTube asked to confirm this isn’t a bot and blocked the download. Try again later, or from another network.'
      : /Private video|members-only|channel's members/i.test(err) ? 'This video is private or members-only, so it can’t be downloaded.'
      : /confirm your age|age-restricted/i.test(err) ? 'This video is age-restricted, so it can’t be downloaded without signing in.'
      : /Video unavailable|not available/i.test(err) ? 'YouTube says this video is unavailable.'
      : code === 0 || /does not pass filter/i.test(err) ? `This video is live or longer than ${MAX_SECONDS / 3600} hours. Pick a shorter one.` // a filtered video exits 0 without a file
      : `The download failed${why ? ': ' + why : '.'} If it keeps failing, update yt-dlp (see README).`;
  }
  // Transcription only needs the sound, so it gets the AAC track on its own (copied, not re-encoded: a few seconds even for an hour).
  function extractAudio(j) {
    j.state = 'audio'; j.pct = 99;
    const a = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', j.out, '-vn', '-c:a', 'copy', j.audio], { windowsHide: true }); j.proc = a;
    let err = ''; a.stderr.on('data', (d) => { err += d; });
    a.on('close', (code) => {
      if (!jobs.has(j.id)) return;
      if (code !== 0 || !existsSync(j.audio)) { j.state = 'failed'; j.error = 'The video downloaded, but its sound couldn’t be separated for transcription.' + (err ? ' ' + err.trim().slice(0, 160) : ''); return; }
      j.state = 'ready'; j.pct = 100; j.size = statSync(j.out).size;
    });
  }

  // YouTube's own captions (uploaded, or automatic speech recognition) give a timed transcript in seconds, so the page
  // only has to transcribe in the browser when a video has none. Prefers the video's language: uploaded > automatic original.
  function captions(j, videoId) {
    j.captions = { state: 'loading' };
    const p = spawn(bin, [...cookies(), '--no-warnings', '--no-playlist', '-J', '--skip-download', `https://www.youtube.com/watch?v=${videoId}`], { windowsHide: true });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', async () => {
      try {
        const info = JSON.parse(out), base = String(info.language || '').split('-')[0], man = info.subtitles || {}, auto = info.automatic_captions || {};
        // "Most replayed": how often viewers rewatch each stretch of the video (0-1), straight from YouTube. Free, real audience data.
        j.heat = (info.heatmap || []).filter((h) => Number.isFinite(h.start_time) && Number.isFinite(h.end_time) && Number.isFinite(h.value)).map((h) => ({ s: h.start_time, e: h.end_time, v: h.value }));
        const keys = (o) => Object.keys(o).filter((k) => k !== 'live_chat');
        const pick = [[man, keys(man).find((k) => base && k.split('-')[0] === base), 'youtube'], [auto, keys(auto).find((k) => k.endsWith('-orig')), 'youtube-auto'],
          [auto, base && auto[base] ? base : null, 'youtube-auto'], [man, keys(man)[0], 'youtube']].find(([o, k]) => k && o[k]);
        if (!pick) { j.captions = { state: 'none' }; return; }
        const [o, k, source] = pick, track = o[k].find((t) => t.ext === 'json3');
        if (!track) { j.captions = { state: 'none' }; return; }
        const r = await fetch(track.url, { signal: AbortSignal.timeout(20000) });
        const evs = ((await r.json()).events || []).filter((e) => e.segs && Number.isFinite(e.tStartMs));
        const segs = [];
        for (const e of evs) {
          const text = e.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const s = e.tStartMs / 1000, en = (e.tStartMs + (e.dDurationMs || 2000)) / 1000;
          if (segs.length && segs.at(-1).e > s) segs.at(-1).e = s; // automatic captions overlap while the next line rolls in
          segs.push({ s: +s.toFixed(2), e: +en.toFixed(2), text });
        }
        j.captions = segs.length ? { state: 'ready', lang: k.replace(/-orig$/, '').split('-')[0], source, segments: segs.filter((x) => x.e > x.s) } : { state: 'none' };
      } catch { j.captions = { state: 'none' }; }
    });
  }

  function start(videoId, req) {
    const me = owner(req), mine = [...jobs.values()].filter((j) => j.owner === me);
    for (const j of mine) if (!['ready', 'failed'].includes(j.state)) drop(j.id); // one download per visitor at a time
    mine.filter((j) => j.state === 'ready').slice(0, -(KEEP_PER_VISITOR - 1) || undefined).forEach((j) => drop(j.id)); // keep only the latest finished video or two on disk
    const id = randomUUID();
    const j = { id, owner: me, state: 'starting', pct: 0, part: 0, out: join(dir, id + '.mp4'), audio: join(dir, id + '.audio.m4a'), started: Date.now(), error: null };
    jobs.set(id, j);
    const args = [...cookies(), '--no-playlist', '--no-warnings', '--newline', '--ffmpeg-location', join(root, 'tools'),
      '--match-filter', `duration <= ${MAX_SECONDS} & !is_live`,
      // H.264 + AAC plays in every browser. Up to 1080p keeps vertical crops sharp; 30 fps beats 60 at the same height (half the size),
      // and the size cap drops long videos to a lower resolution instead of multi-gigabyte files. Only plain https (DASH) streams:
      // HLS streams list no size, so they would slip past the cap.
      '-f', 'bv*[vcodec^=avc1][protocol=https][filesize<900M]+ba[ext=m4a]/bv*[vcodec^=avc1][protocol=https][filesize_approx<900M]+ba[ext=m4a]/bv*[vcodec^=avc1][protocol=https][height<=480]+ba[ext=m4a]/b[ext=mp4]',
      '-S', 'res:1080,+fps',
      '--merge-output-format', 'mp4', '--progress-template', 'download:P %(progress._percent_str)s',
      '-o', join(dir, id + '.%(ext)s'), `https://www.youtube.com/watch?v=${videoId}`];
    const p = spawn(bin, args, { windowsHide: true }); j.proc = p;
    captions(j, videoId);
    let err = '';
    const onLine = (line) => {
      if (line.includes('[download] Destination:')) { j.part++; j.state = 'downloading'; }
      else if (line.startsWith('P ')) { const v = parseFloat(line.slice(2)); if (Number.isFinite(v)) j.pct = Math.min(97, Math.round(j.part <= 1 ? v * 0.9 : 90 + v * 0.07)); } // video first, then the much smaller audio
      else if (line.includes('[Merger]')) { j.state = 'joining'; j.pct = 98; }
      else if (/does not pass filter/i.test(line)) err += line;
    };
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; const ls = buf.split(/\r?\n/); buf = ls.pop(); ls.forEach(onLine); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { if (!jobs.has(id)) return; if (code === 0 && existsSync(j.out)) extractAudio(j); else fail(j, err, code); });
    p.on('error', (e) => { j.state = 'failed'; j.error = 'yt-dlp couldn’t start: ' + e.message; });
    return j;
  }

  // Serves a file with HTTP range support, so the page's <video> can seek without downloading everything.
  function serve(req, res, file, type) {
    const size = statSync(file).size, m = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (!m[1] && !m[2])) { res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }); return createReadStream(file).pipe(res); }
    let a = m[1] ? +m[1] : size - +m[2], b = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (a >= size || a > b) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    createReadStream(file, { start: a, end: b }).pipe(res);
  }

  // Returns true when it answered the request.
  async function route(req, res, url, allow) {
    const send = (st, o) => { res.writeHead(st, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/api/ytdl' && req.method === 'POST') {
      if (!ready()) return send(503, { error: 'YouTube downloads need tools/yt-dlp.exe and tools/ffmpeg.exe next to the server (see README).' }), true;
      let b = {}; try { b = JSON.parse(req.body || '{}'); } catch {}
      const m = String(b.videoUrl || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
      if (!m) return send(422, { error: 'That isn’t a supported YouTube video link.' }), true;
      const ok = await allow(); // plan and monthly limit, checked by the same server code as everything else
      if (ok.status !== 200) return res.writeHead(ok.status, { 'content-type': 'application/json' }), res.end(ok.body), true;
      return send(200, { id: start(m[1], req).id }), true;
    }
    const rm = url.pathname.match(/^\/api\/ytdl\/([\w-]{36})\/render/);
    if (rm) { const j = jobs.get(rm[1]); if (!j || j.owner !== owner(req)) return send(404, { error: 'This YouTube video is no longer on the server. Load the link again.' }), true; return rnd.route(req, res, url, j, send, serve); }
    const jm = url.pathname.match(/^\/api\/ytdl\/([\w-]{36})(?:\/(file|audio|captions))?$/);
    if (!jm || !['GET', 'HEAD'].includes(req.method)) return false;
    const j = jobs.get(jm[1]);
    if (!j || j.owner !== owner(req)) return send(404, { error: 'This YouTube video is no longer on the server (videos are kept for a few hours). Load the link again.' }), true;
    if (!jm[2]) return send(200, { state: j.state, pct: j.pct, size: j.size || null, error: j.error, captions: j.captions ? j.captions.state : 'loading', heat: j.heat || null }), true;
    if (jm[2] === 'captions') { const c = j.captions || { state: 'loading' }; return send(c.state === 'ready' ? 200 : c.state === 'none' ? 404 : 202, c.state === 'ready' ? { lang: c.lang, source: c.source, segments: c.segments, heat: j.heat || null } : { state: c.state, heat: j.heat || null }), true; }
    if (j.state !== 'ready') return send(409, { error: 'The video isn’t ready yet.' }), true;
    serve(req, res, jm[2] === 'file' ? j.out : j.audio, jm[2] === 'file' ? 'video/mp4' : 'audio/mp4');
    return true;
  }
  return { ready, route, encoder: () => rnd.detected };
}
