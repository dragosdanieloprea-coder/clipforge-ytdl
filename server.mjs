// ClipForge YouTube downloader for the cloud (a Hugging Face Docker Space): the same ytdl.mjs + render.mjs as the laptop,
// without the rest of the app. The live site (src/worker.js) checks each visitor's plan, then forwards /api/ytdl* here with
// TUNNEL_KEY and an anonymous per-account id. Anything without the key gets 403. GET / is a health check with no secrets.
// Optional YT_COOKIES: a Netscape cookies.txt for a spare YouTube account, used when YouTube blocks this server as a bot.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { ytdl } from './ytdl.mjs';

if (process.env.YT_COOKIES) { writeFileSync('/tmp/yt-cookies.txt', process.env.YT_COOKIES.replace(/\\n/g, '\n')); process.env.YTDL_COOKIES_FILE = '/tmp/yt-cookies.txt'; }
const yt = ytdl(process.cwd());
const KEY = String(process.env.TUNNEL_KEY || '').trim();
const keyOK = (got) => { const a = Buffer.from(String(got || '').trim()), b = Buffer.from(KEY); return !!KEY && a.length === b.length && timingSafeEqual(a, b); };
const send = (res, st, o) => { res.writeHead(st, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://cloud');
    if (url.pathname === '/' || url.pathname === '/health') return send(res, 200, { service: 'clipforge-ytdl', ready: yt.ready(), encoder: await yt.encoder(), key: !!KEY, cookies: !!process.env.YTDL_COOKIES_FILE });
    if (!keyOK(req.headers['x-tunnel-key']) || !url.pathname.startsWith('/api/ytdl')) return send(res, 403, { error: 'Forbidden.' });
    const chunks = []; for await (const c of req) chunks.push(c);
    req.body = Buffer.concat(chunks).toString('utf8');
    req.headers.cookie = 'v=' + String(req.headers['x-cf-visitor'] || '').slice(0, 80); // files are kept per account
    if (await yt.route(req, res, url, async () => ({ status: 200, body: '{"ok":true}' }))) return; // plan already checked by the live site
    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Cloud server error: ' + e.message }); else res.end();
  }
}).listen(+process.env.PORT || 7860, () => console.log('ClipForge cloud downloader on port ' + (process.env.PORT || 7860) + (yt.ready() ? '' : ' (yt-dlp or ffmpeg missing!)')));
