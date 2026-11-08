// Clip rendering on the local server with ffmpeg and the computer's hardware H.264 encoder (Intel QuickSync, NVIDIA, AMD or
// Windows Media Foundation): several times faster than real time. Used for YouTube videos, whose file is already here.
// The page sends the cut, framing and an ASS caption file built from its own caption settings; captions burn in with libass.
import { spawn } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ENCODERS = [ // tried in this order; the first that encodes a test frame wins
  ['h264_qsv', ['-preset', 'veryfast']],
  ['h264_nvenc', ['-preset', 'p4']],
  ['h264_amf', ['-quality', 'speed']],
  ['h264_mf', ['-hw_encoding', '1']],
  ['libx264', ['-preset', 'veryfast']], // software fallback for the cloud server (Linux ffmpeg builds include it)
];
const PARALLEL = 2;
const SYSTEM_FONTS = { Georgia: ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'], Arial: ['arial.ttf', 'arialbd.ttf'] };

export function renderer(root, dir) {
  const ffmpeg = join(root, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const fontCache = join(root, 'tools', 'fonts'), fontDir = join(dir, 'fonts');
  mkdirSync(fontCache, { recursive: true }); mkdirSync(fontDir, { recursive: true });
  for (const f of readdirSync(fontCache)) copyFileSync(join(fontCache, f), join(fontDir, f));
  const renders = new Map(), queue = [];
  let encoder = null, running = 0;

  const run = (args, opts = {}) => new Promise((ok) => { const p = spawn(ffmpeg, args, { windowsHide: true, ...opts }); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (code) => ok({ code, err })); p.on('error', (e) => ok({ code: -1, err: e.message })); });
  const detected = (async () => {
    if (!existsSync(ffmpeg)) return null;
    for (const [name, opts] of ENCODERS) {
      const r = await run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2', '-c:v', name, ...opts, '-f', 'null', '-']);
      if (r.code === 0) { encoder = [name, opts]; return name; }
    }
    return null;
  })();

  // Fonts for libass: Google Fonts families are fetched once as TTF (an old user agent gets TTF instead of WOFF2) and cached in tools/fonts.
  async function ensureFont(family, weight) {
    if (!/^[\w ]{2,40}$/.test(family)) return;
    const sys = SYSTEM_FONTS[family];
    if (sys) { for (const f of sys) { const s = join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f); if (existsSync(s) && !existsSync(join(fontDir, f))) copyFileSync(s, join(fontDir, f)); } return; }
    const name = `${family.replace(/ /g, '')}-${weight}.ttf`;
    if (existsSync(join(fontCache, name))) { if (!existsSync(join(fontDir, name))) copyFileSync(join(fontCache, name), join(fontDir, name)); return; }
    try {
      const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, { headers: { 'user-agent': 'Mozilla/4.0' }, signal: AbortSignal.timeout(10000) })).text();
      const url = (css.match(/url\((https:[^)]+\.ttf)\)/) || [])[1]; if (!url) return;
      const buf = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
      writeFileSync(join(fontCache, name), buf); copyFileSync(join(fontCache, name), join(fontDir, name));
    } catch {} // without the font, libass falls back to a default sans-serif
  }

  function graph(o) {
    const { W, H } = o, cx = Math.min(1, Math.max(0, +o.cx || 0.5)).toFixed(3);
    const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${cx}:(ih-${H})/2`;
    const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
    const base = o.frame === 'fit' ? `[0:v]fps=30,${fit},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
      // the background is blurred at 1/8 size and scaled back up: it looks the same and costs a fraction of a full-size blur
      : o.frame === 'blur' ? `[0:v]fps=30,split[a][b];[a]scale=${(W / 16 | 0) * 2}:${(H / 16 | 0) * 2}:force_original_aspect_ratio=increase,crop=${(W / 16 | 0) * 2}:${(H / 16 | 0) * 2},gblur=sigma=4,scale=${W}:${H},lutyuv=y=val*0.7[bg];[b]${fit}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`
      : `[0:v]fps=30,${cover},setsar=1`;
    return base + (o.assFile ? `,ass=${o.assFile}:fontsdir=fonts` : '') + ',format=nv12[v]';
  }

  function pump() {
    while (running < PARALLEL && queue.length) {
      const r = queue.shift(); if (r.state !== 'queued') continue;
      running++; r.state = 'rendering';
      const dur = r.o.end - r.o.start, [name, opts] = encoder;
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(r.o.start), '-i', r.src, '-t', dur.toFixed(3), '-filter_complex', graph(r.o), '-map', '[v]', '-map', '0:a?',
        '-c:v', name, ...opts, '-b:v', String(r.o.bitrate), '-maxrate', String(Math.round(r.o.bitrate * 1.5)), '-bufsize', String(r.o.bitrate * 2), '-g', '60',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', r.out];
      const p = spawn(ffmpeg, args, { windowsHide: true, cwd: dir }); r.proc = p;
      let err = '';
      p.stdout.on('data', (d) => { const m = String(d).match(/out_time_us=(\d+)/g); if (m) r.pct = Math.min(0.99, +m.at(-1).split('=')[1] / 1e6 / dur); });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => {
        running--;
        if (r.state === 'cancelled') { try { rmSync(r.out, { force: true }); } catch {} }
        else if (code === 0 && existsSync(r.out)) { r.state = 'ready'; r.pct = 1; r.size = statSync(r.out).size; }
        else { r.state = 'failed'; r.error = 'ffmpeg couldn’t render this clip' + (err ? ': ' + err.trim().split('\n').pop().slice(0, 200) : '.'); }
        if (r.assFile) try { rmSync(join(dir, r.assFile), { force: true }); } catch {}
        pump();
      });
    }
  }

  async function start(job, o) {
    const id = randomUUID(), r = { id, job: job.id, owner: job.owner, state: 'queued', pct: 0, src: job.out, out: join(dir, `${job.id}.r_${id}.mp4`), o, started: Date.now() };
    if (o.ass) { r.assFile = `${job.id}.r_${id}.ass`; writeFileSync(join(dir, r.assFile), o.ass); o.assFile = r.assFile; }
    if (o.font) await ensureFont(String(o.font.family || ''), Math.round(+o.font.weight || 400));
    renders.set(id, r); queue.push(r); pump();
    return r;
  }

  // Answers /api/ytdl/<job>/render[/<id>[/file]]. Returns true when it handled the request.
  async function route(req, res, url, job, send, serve) {
    const m = url.pathname.match(/^\/api\/ytdl\/[\w-]{36}\/render(?:\/([\w-]{36})(\/file)?)?$/);
    if (!m) return false;
    if (!m[1] && req.method === 'POST') {
      if (!(await detected)) return send(503, { error: 'No hardware H.264 encoder was found for ffmpeg on this computer.' }), true;
      if (job.state !== 'ready') return send(409, { error: 'The video isn’t ready yet.' }), true;
      let o = {}; try { o = JSON.parse(req.body || '{}'); } catch {}
      const start0 = +o.start, end0 = +o.end, W = Math.round(+o.W / 2) * 2, H = Math.round(+o.H / 2) * 2;
      if (!(end0 > start0 && start0 >= 0 && end0 - start0 <= 600)) return send(422, { error: 'The clip must be between 0 and 10 minutes long.' }), true;
      if (!(W >= 240 && W <= 3840 && H >= 240 && H <= 3840)) return send(422, { error: 'Unsupported output size.' }), true;
      const r = await start(job, { start: start0, end: end0, W, H, frame: ['cover', 'fit', 'blur'].includes(o.frame) ? o.frame : 'cover', cx: o.cx, bitrate: Math.min(2e7, Math.max(1e6, +o.bitrate || 5e6)),
        ass: typeof o.ass === 'string' && o.ass.length < 2e6 ? o.ass : '', font: o.font });
      return send(200, { id: r.id, encoder: encoder[0] }), true;
    }
    const r = m[1] && renders.get(m[1]);
    if (!r || r.owner !== job.owner || r.job !== job.id) return send(404, { error: 'This render no longer exists.' }), true;
    if (req.method === 'DELETE') { if (r.proc && r.proc.exitCode === null) { r.state = 'cancelled'; r.proc.kill(); } else { r.state = 'cancelled'; try { rmSync(r.out, { force: true }); } catch {} } renders.delete(r.id); return send(200, { ok: true }), true; }
    if (!m[2]) return send(200, { state: r.state, pct: r.pct, size: r.size || null, error: r.error || null, queued: r.state === 'queued' ? queue.indexOf(r) + 1 : 0 }), true;
    if (r.state !== 'ready') return send(409, { error: 'The clip isn’t ready yet.' }), true;
    serve(req, res, r.out, 'video/mp4');
    return true;
  }
  return { detected, route, drop: (jobId) => { for (const [id, r] of renders) if (r.job === jobId) { if (r.proc && r.proc.exitCode === null) { r.state = 'cancelled'; r.proc.kill(); } renders.delete(id); } } };
}
