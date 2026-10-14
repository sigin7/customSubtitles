import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Library } from './library.js';
import { Authentication } from './auth.js';
import { getNetworkState, enablePublicAccess } from './network.js';
import packageInfo from '../package.json' with { type: 'json' };
import { HttpError, LANGUAGES, validateMetadata, prepareSubtitle, filenameHints } from './subtitles.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const manifest = {
  id: 'community.customsubtitles.personal', version: packageInfo.version, name: 'Custom Subtitles',
  description: 'Subtitles from your personal library, matched to movies and episodes by IMDb ID.',
  resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'], catalogs: [], behaviorHints: { configurable: false }
};

export function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw new HttpError(400, 'Enter a server address starting with http:// or https://, without a path.'); }
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new HttpError(413, 'The request is too large. The file limit is 10 MB.'); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); };
    const onError = error => { cleanup(); reject(error); };
    const onAborted = () => onError(new HttpError(400, 'The upload was interrupted.'));
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) { cleanup(); req.resume(); reject(new HttpError(413, 'The request is too large. The file limit is 10 MB.')); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
  });
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON data.');
  try { return JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON data.'); }
}

export function createApplication(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 7000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const publicPort = options.publicPort ?? Number(process.env.PUBLIC_PORT ?? 7001);
  const httpsPort = options.httpsPort ?? Number(process.env.FUNNEL_HTTPS_PORT ?? 8443);
  if (publicPort !== false && (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535)) throw new Error('PUBLIC_PORT must be a valid port.');
  if (![443, 8443, 10000].includes(httpsPort)) throw new Error('FUNNEL_HTTPS_PORT must be 443, 8443, or 10000.');
  const defaultDataDir = existsSync(path.join(root, '.installed')) && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CustomSubtitles', 'data') : path.join(root, 'data');
  const library = new Library(options.dataDir ?? (process.env.DATA_DIR ? path.resolve(root, process.env.DATA_DIR) : defaultDataDir));
  const auth = new Authentication(library, options.password ?? process.env.ADMIN_PASSWORD ?? '');
  const fixedBase = options.baseUrl ?? process.env.BASE_URL ?? '';
  if (fixedBase) normalizeBaseUrl(fixedBase);
  const adminBase = options.adminBaseUrl ?? process.env.ADMIN_BASE_URL ?? '';
  if (adminBase) normalizeBaseUrl(adminBase);
  let activeUploads = 0;
  const fetchMetadata = options.fetchMetadata ?? fetch;
  let localUrl = '', gatewayUrl = '', networkBusy = false;
  const baseUrl = () => library.getSetting('baseUrl') || (fixedBase ? normalizeBaseUrl(fixedBase) : localUrl);
  const origins = () => new Set([localUrl, localUrl.replace('127.0.0.1', 'localhost'), gatewayUrl, baseUrl(), ...(fixedBase ? [normalizeBaseUrl(fixedBase)] : []), ...(adminBase ? [normalizeBaseUrl(adminBase)] : [])].filter(Boolean));
  const setupAllowed = (req, publicGateway) => !publicGateway && loopback(req.socket.remoteAddress) && [new URL(localUrl).host, new URL(localUrl.replace('127.0.0.1', 'localhost')).host].includes(req.headers.host);
  const networkState = () => options.tailscale ?? getNetworkState(httpsPort, publicServer?.address()?.port ?? publicPort);
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const requireAuth = req => { if (!auth.authenticated(req)) throw new HttpError(401, 'Sign in to manage your library.'); };
  const checkOrigin = req => {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
    if (req.headers.origin) {
      const allowed = origins();
      if (!allowed.has(req.headers.origin)) throw new HttpError(403, 'Request origin is not allowed. Configure the correct server address.');
    }
  };

  const setSessionCookie = (req, res, token) => {
    const secure = loopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `cs_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
  };
  const handleRequest = async (req, res, publicGateway = false) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const requestHost = req.headers.host ?? '';
      const allowedHosts = new Set([...origins()].map(origin => new URL(origin).host));
      if (!allowedHosts.has(requestHost)) throw new HttpError(403, 'Unknown server address. Configure it locally or set BASE_URL first.');

      const addon = pathname.match(/^\/addon\/([a-f0-9]{48})(\/.*)$/);
      if (addon) {
        if (publicGateway && !auth.ready()) throw new HttpError(503, 'The server owner must finish local setup before public access is available.');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (addon[1] !== library.getSetting('addonKey')) throw new HttpError(404, 'Addon not found.');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
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
          if (!item || item.extension !== file[2]) throw new HttpError(404, 'Subtitles not found.');
          res.writeHead(200, { 'Content-Type': item.extension === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Length': item.content.length }); res.end(req.method === 'HEAD' ? undefined : item.content); return;
        }
        throw new HttpError(404, 'Endpoint not found.');
      }

      if (pathname === '/api/session' && req.method === 'GET') { json(res, 200, { passwordEnabled: auth.ready(), needsSetup: !auth.ready(), setupAllowed: setupAllowed(req, publicGateway), authenticated: auth.authenticated(req) }); return; }
      if (pathname === '/api/setup' && req.method === 'POST') {
        if (!setupAllowed(req, publicGateway) || ![localUrl, localUrl.replace('127.0.0.1', 'localhost')].includes(req.headers.origin)) throw new HttpError(403, 'Create the administrator password from the local interface on the server.');
        checkOrigin(req);
        const body = await readJson(req);
        await auth.setup(body?.password);
        setSessionCookie(req, res, auth.newSession());
        json(res, 201, { ok: true }); return;
      }
      if (pathname === '/api/login' && req.method === 'POST') {
        checkOrigin(req);
        const body = await readJson(req);
        const token = await auth.login(body?.password, `${publicGateway ? 'public' : 'local'}:${req.socket.remoteAddress}`);
        setSessionCookie(req, res, token);
        json(res, 200, { ok: true }); return;
      }
      if (pathname.startsWith('/api/')) {
        requireAuth(req);
        if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
        if (pathname === '/api/logout' && req.method === 'POST') {
          auth.logout(req);
          res.setHeader('Set-Cookie', 'cs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/config' && req.method === 'GET') {
          const externalUrl = baseUrl(); const addonUrl = `${externalUrl}/addon/${library.getSetting('addonKey')}/manifest.json`;
          json(res, 200, { version: packageInfo.version, baseUrl: externalUrl, localUrl, gatewayUrl, baseUrlLocked: false, networkSetupAllowed: setupAllowed(req, publicGateway), httpsPort, addonUrl, installUrl: addonUrl.replace(/^https?:\/\//, 'stremio://'), languages: LANGUAGES, tailscale: await networkState(), passwordEnabled: auth.ready(), maxFileBytes: 10 * 1024 * 1024 }); return;
        }
        if (pathname === '/api/config' && req.method === 'PUT') {
          const body = await readJson(req); library.setSetting('baseUrl', normalizeBaseUrl(body?.baseUrl)); json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/network/public' && req.method === 'POST') {
          if (!setupAllowed(req, publicGateway)) throw new HttpError(403, 'Enable public access from the local interface on the server.');
          if (!publicServer) throw new HttpError(409, 'The public gateway is disabled.');
          if (networkBusy) throw new HttpError(409, 'A network configuration request is already running.');
          networkBusy = true;
          try {
            const state = await (options.enablePublicAccess ?? enablePublicAccess)(httpsPort, publicServer.address().port);
            library.setSetting('baseUrl', normalizeBaseUrl(state.suggestedUrl));
            json(res, 200, { ok: true, baseUrl: state.suggestedUrl }); return;
          } finally { networkBusy = false; }
        }
        if (pathname === '/api/subtitles' && req.method === 'GET') { json(res, 200, { subtitles: library.list() }); return; }
        if (pathname === '/api/subtitles' && req.method === 'POST') {
          if (activeUploads >= 4) throw new HttpError(503, 'The server is processing other uploads. Try again shortly.');
          activeUploads++;
          try {
            const contentType = req.headers['content-type'] ?? '';
            if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'Use the file upload form.');
            const bytes = await readBody(req, 10 * 1024 * 1024 + 64 * 1024);
            let form;
            try { form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData(); }
            catch { throw new HttpError(400, 'Invalid upload form.'); }
            const file = form.get('file');
            if (!(file instanceof File) || form.getAll('file').length !== 1 || file.size === 0) throw new HttpError(400, 'Select one subtitle file.');
            const meta = validateMetadata(Object.fromEntries(form));
            const prepared = prepareSubtitle(file.name, Buffer.from(await file.arrayBuffer()), form.get('encoding') || 'auto');
            const result = library.add(meta, prepared); json(res, result.duplicate ? 200 : 201, result); return;
          } finally { activeUploads--; }
        }
        const deletion = pathname.match(/^\/api\/subtitles\/([a-f0-9-]{36})$/);
        if (deletion && req.method === 'DELETE') { if (!library.delete(deletion[1])) throw new HttpError(404, 'Subtitles not found.'); json(res, 200, { ok: true }); return; }
        if (pathname === '/api/hints' && req.method === 'GET') { json(res, 200, filenameHints((url.searchParams.get('filename') ?? '').slice(0, 500))); return; }
        if (pathname === '/api/meta' && req.method === 'GET') {
          const type = url.searchParams.get('type'), query = (url.searchParams.get('q') ?? '').trim().slice(0, 150);
          if (!['movie', 'series'].includes(type) || query.length < 2) throw new HttpError(400, 'Enter at least two characters and select a video type.');
          const idQuery = /^tt\d{7,10}$/.test(query);
          const remoteUrl = idQuery ? `https://v3-cinemeta.strem.io/meta/${type}/${query}.json` : `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
          try {
            const response = await fetchMetadata(remoteUrl, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error();
            const result = await response.json();
            const metas = (idQuery ? result.meta ? [result.meta] : [] : result.metas ?? []).filter(item => /^tt\d{7,10}$/.test(item.id)).slice(0, 12).map(item => ({ id: item.id, name: item.name, year: String(item.releaseInfo ?? item.year ?? ''), poster: typeof item.poster === 'string' && item.poster.startsWith('https://') ? item.poster : '' }));
            json(res, 200, { metas }); return;
          } catch { throw new HttpError(502, 'Metadata search is unavailable. You can enter the title and IMDb ID manually.'); }
        }
        throw new HttpError(404, 'API endpoint not found.');
      }

      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (!['GET', 'HEAD'].includes(req.method) || !staticFiles[pathname]) throw new HttpError(404, 'Page not found.');
      const [name, mime] = staticFiles[pathname];
      const content = await readFile(path.join(root, 'public', name));
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 500;
      if (status === 500) console.error('Server error:', error.message);
      json(res, status, { error: status === 500 ? 'The server could not process the request.' : error.message });
    }
  };
  const server = createServer((req, res) => handleRequest(req, res, false));
  const publicServer = publicPort === false ? null : createServer((req, res) => handleRequest(req, res, true));
  for (const listener of [server, publicServer].filter(Boolean)) {
    listener.requestTimeout = 30000;
    listener.headersTimeout = 10000;
  }
  const listen = (listener, listenPort, listenHost) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(listenPort, listenHost, () => { listener.off('error', reject); resolve(); });
  });
  const stop = listener => new Promise(resolve => { if (!listener?.listening) { resolve(); return; } listener.close(resolve); listener.closeIdleConnections(); });
  let closed = false;
  return {
    server, publicServer, library,
    start: async () => {
      await listen(server, port, host);
      localUrl = `http://127.0.0.1:${server.address().port}`;
      if (publicServer) {
        try { await listen(publicServer, publicPort, '127.0.0.1'); }
        catch (error) { await stop(server); throw error; }
        gatewayUrl = `http://127.0.0.1:${publicServer.address().port}`;
      }
      console.log(`Custom Subtitles: ${localUrl}`);
      return { localUrl, gatewayUrl, host, port: server.address().port };
    },
    close: async () => { if (closed) return; closed = true; await Promise.all([stop(server), stop(publicServer)]); library.close(); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApplication();
  app.start().catch(error => { console.error(error.code === 'EADDRINUSE' ? 'The port is in use. Stop the other server or change PORT in .env.' : error.message); app.library.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
