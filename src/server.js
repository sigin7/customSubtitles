import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { Library } from './library.js';
import { HttpError, LANGUAGES, validateMetadata, prepareSubtitle, filenameHints } from './subtitles.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const runFile = promisify(execFile);
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const manifest = {
  id: 'community.customsubtitles.personal', version: '1.0.0', name: 'Custom Subtitles',
  description: 'Titulky z tvojej vlastnej knižnice. Filmy a epizódy spárované podľa IMDb.',
  resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'], catalogs: [], behaviorHints: { configurable: false }
};

export function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw new HttpError(400, 'Zadaj adresu servera vrátane http:// alebo https://, bez cesty.'); }
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new HttpError(413, 'Požiadavka je príliš veľká. Limit súboru je 10 MB.'); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); };
    const onError = error => { cleanup(); reject(error); };
    const onAborted = () => onError(new HttpError(400, 'Nahrávanie bolo prerušené.'));
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) { cleanup(); req.resume(); reject(new HttpError(413, 'Požiadavka je príliš veľká. Limit súboru je 10 MB.')); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
  });
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Očakávané sú JSON údaje.');
  try { return JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Neplatné JSON údaje.'); }
}

async function tailscaleInfo() {
  const executable = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
  try {
    const { stdout } = await runFile(executable, ['status', '--json'], { timeout: 2500, windowsHide: true, maxBuffer: 1024 * 1024 });
    const status = JSON.parse(stdout);
    return { available: true, running: status.BackendState === 'Running', suggestedUrl: status.Self?.DNSName ? `https://${status.Self.DNSName.replace(/\.$/, '')}` : '' };
  } catch { return { available: false, running: false, suggestedUrl: '' }; }
}

export function createApplication(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 7000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT musí byť číslo od 1 do 65535.');
  const library = new Library(options.dataDir ?? path.resolve(root, process.env.DATA_DIR ?? 'data'));
  const password = options.password ?? process.env.ADMIN_PASSWORD ?? '';
  if (password && password.length < 12) { library.close(); throw new Error('ADMIN_PASSWORD musí mať aspoň 12 znakov.'); }
  const passwordHash = password ? scryptSync(password, 'custom-subtitles-admin-v1', 64) : null;
  const fixedBase = options.baseUrl ?? process.env.BASE_URL ?? '';
  if (fixedBase) normalizeBaseUrl(fixedBase);
  const sessions = new Map(), attempts = new Map();
  let activeUploads = 0;
  const tailscale = options.tailscale ?? tailscaleInfo();
  const fetchMetadata = options.fetchMetadata ?? fetch;
  let localUrl = '';
  const baseUrl = () => fixedBase ? normalizeBaseUrl(fixedBase) : library.getSetting('baseUrl') || localUrl;
  const isAuthenticated = req => {
    if (!passwordHash) return true;
    const token = req.headers.cookie?.match(/(?:^|;\s*)cs_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    return token && (sessions.get(token) ?? 0) > Date.now();
  };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const requireAuth = req => { if (!isAuthenticated(req)) throw new HttpError(401, 'Prihlás sa na správu knižnice.'); };
  const checkOrigin = req => {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Požiadavka z cudzej stránky nie je povolená.');
    if (req.headers.origin) {
      const allowed = new Set([localUrl, baseUrl(), localUrl.replace('127.0.0.1', 'localhost')]);
      if (!allowed.has(req.headers.origin)) throw new HttpError(403, 'Nepovolený pôvod požiadavky. Nastav správnu adresu servera.');
    }
  };

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const requestHost = req.headers.host ?? '';
      const allowedHosts = new Set([new URL(localUrl).host, new URL(localUrl.replace('127.0.0.1', 'localhost')).host, new URL(baseUrl()).host]);
      if (!allowedHosts.has(requestHost)) throw new HttpError(403, 'Neznáma adresa servera. Najprv ju nastav v lokálnom rozhraní alebo BASE_URL.');

      const addon = pathname.match(/^\/addon\/([a-f0-9]{48})(\/.*)$/);
      if (addon) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (addon[1] !== library.getSetting('addonKey')) throw new HttpError(404, 'Addon neexistuje.');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Nepodporovaná metóda.');
        if (addon[2] === '/manifest.json') { json(res, 200, manifest); return; }
        const match = addon[2].match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/);
        if (match) {
          const validId = match[1] === 'movie' ? /^tt\d{7,10}$/ : /^tt\d{7,10}:\d{1,3}:\d{1,4}$/;
          const rows = validId.test(match[2]) ? library.matches(match[1], match[2]) : [];
          json(res, 200, { subtitles: rows.map(row => ({ id: row.id, lang: row.lang, label: `${LANGUAGES[row.lang]} · ${row.label || row.originalName}`, url: `${baseUrl()}/addon/${addon[1]}/files/${row.id}.${row.extension}` })) }); return;
        }
        const file = addon[2].match(/^\/files\/([a-f0-9-]{36})\.(srt|vtt|ass|ssa)$/);
        if (file) {
          const item = library.file(file[1]);
          if (!item || item.extension !== file[2]) throw new HttpError(404, 'Titulky neexistujú.');
          res.writeHead(200, { 'Content-Type': item.extension === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Length': item.content.length }); res.end(req.method === 'HEAD' ? undefined : item.content); return;
        }
        throw new HttpError(404, 'Endpoint neexistuje.');
      }

      if (pathname === '/api/session' && req.method === 'GET') { json(res, 200, { passwordEnabled: !!passwordHash, authenticated: !!isAuthenticated(req) }); return; }
      if (pathname === '/api/login' && req.method === 'POST') {
        checkOrigin(req);
        const address = req.socket.remoteAddress;
        for (const [key, value] of attempts) if (Date.now() > value.until) attempts.delete(key);
        const attempt = attempts.get(address) ?? { count: 0, until: Date.now() + 15 * 60 * 1000 };
        if (attempt.count >= 10) throw new HttpError(429, 'Príliš veľa pokusov. Skús to o 15 minút.');
        const body = await readJson(req);
        if (typeof body?.password !== 'string' || body.password.length > 1024) throw new HttpError(400, 'Zadaj heslo.');
        if (passwordHash && !timingSafeEqual(passwordHash, scryptSync(body.password, 'custom-subtitles-admin-v1', 64))) { attempt.count++; attempts.set(address, attempt); throw new HttpError(401, 'Nesprávne heslo.'); }
        attempts.delete(address);
        for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
        const token = randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
        const secure = loopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Set-Cookie', `cs_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
        json(res, 200, { ok: true }); return;
      }
      if (pathname.startsWith('/api/')) {
        requireAuth(req);
        if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
        if (pathname === '/api/logout' && req.method === 'POST') {
          const token = req.headers.cookie?.match(/cs_session=([a-f0-9]{64})/)?.[1]; sessions.delete(token);
          res.setHeader('Set-Cookie', 'cs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/config' && req.method === 'GET') {
          const externalUrl = baseUrl(); const addonUrl = `${externalUrl}/addon/${library.getSetting('addonKey')}/manifest.json`;
          json(res, 200, { baseUrl: externalUrl, localUrl, baseUrlLocked: !!fixedBase, addonUrl, installUrl: addonUrl.replace(/^https?:\/\//, 'stremio://'), languages: LANGUAGES, tailscale: await tailscale, passwordEnabled: !!passwordHash, maxFileBytes: 10 * 1024 * 1024 }); return;
        }
        if (pathname === '/api/config' && req.method === 'PUT') {
          if (fixedBase) throw new HttpError(409, 'Adresa je nastavená cez BASE_URL v .env.');
          const body = await readJson(req); library.setSetting('baseUrl', normalizeBaseUrl(body?.baseUrl)); json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/subtitles' && req.method === 'GET') { json(res, 200, { subtitles: library.list() }); return; }
        if (pathname === '/api/subtitles' && req.method === 'POST') {
          if (activeUploads >= 4) throw new HttpError(503, 'Server práve nahráva ďalšie súbory. Skús to o chvíľu.');
          activeUploads++;
          try {
            const contentType = req.headers['content-type'] ?? '';
            if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'Použi formulár na nahrávanie súborov.');
            const bytes = await readBody(req, 10 * 1024 * 1024 + 64 * 1024);
            let form;
            try { form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData(); }
            catch { throw new HttpError(400, 'Neplatný formulár na nahrávanie.'); }
            const file = form.get('file');
            if (!(file instanceof File) || form.getAll('file').length !== 1 || file.size === 0) throw new HttpError(400, 'Vyber jeden súbor s titulkami.');
            const meta = validateMetadata(Object.fromEntries(form));
            const prepared = prepareSubtitle(file.name, Buffer.from(await file.arrayBuffer()), form.get('encoding') || 'auto');
            const result = library.add(meta, prepared); json(res, result.duplicate ? 200 : 201, result); return;
          } finally { activeUploads--; }
        }
        const deletion = pathname.match(/^\/api\/subtitles\/([a-f0-9-]{36})$/);
        if (deletion && req.method === 'DELETE') { if (!library.delete(deletion[1])) throw new HttpError(404, 'Titulky neexistujú.'); json(res, 200, { ok: true }); return; }
        if (pathname === '/api/hints' && req.method === 'GET') { json(res, 200, filenameHints((url.searchParams.get('filename') ?? '').slice(0, 500))); return; }
        if (pathname === '/api/meta' && req.method === 'GET') {
          const type = url.searchParams.get('type'), query = (url.searchParams.get('q') ?? '').trim().slice(0, 150);
          if (!['movie', 'series'].includes(type) || query.length < 2) throw new HttpError(400, 'Zadaj aspoň dva znaky a vyber typ videa.');
          const idQuery = /^tt\d{7,10}$/.test(query);
          const remoteUrl = idQuery ? `https://v3-cinemeta.strem.io/meta/${type}/${query}.json` : `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
          try {
            const response = await fetchMetadata(remoteUrl, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error();
            const result = await response.json();
            const metas = (idQuery ? result.meta ? [result.meta] : [] : result.metas ?? []).filter(item => /^tt\d{7,10}$/.test(item.id)).slice(0, 12).map(item => ({ id: item.id, name: item.name, year: String(item.releaseInfo ?? item.year ?? ''), poster: typeof item.poster === 'string' && item.poster.startsWith('https://') ? item.poster : '' }));
            json(res, 200, { metas }); return;
          } catch { throw new HttpError(502, 'Vyhľadávanie metadát je nedostupné. Názov a IMDb ID môžeš zadať ručne.'); }
        }
        throw new HttpError(404, 'API endpoint neexistuje.');
      }

      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (!['GET', 'HEAD'].includes(req.method) || !staticFiles[pathname]) throw new HttpError(404, 'Stránka neexistuje.');
      const [name, mime] = staticFiles[pathname];
      const content = await readFile(path.join(root, 'public', name));
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 500;
      if (status === 500) console.error('Server error:', error.message);
      json(res, status, { error: status === 500 ? 'Server nedokázal spracovať požiadavku.' : error.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server, library,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        localUrl = `http://127.0.0.1:${server.address().port}`;
        console.log(`Custom Subtitles: ${localUrl}`);
        resolve({ localUrl, host, port: server.address().port });
      });
    }),
    close: () => new Promise((resolve, reject) => { server.close(error => { library.close(); error ? reject(error) : resolve(); }); server.closeIdleConnections(); })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApplication();
  app.start().catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Port je obsadený. Zastav druhý server alebo zmeň PORT v .env.' : error.message); app.library.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
