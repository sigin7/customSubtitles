import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError, LANGUAGES, validateMetadata, prepareSubtitle, filenameHints } from '../src/subtitles.js';
import packageInfo from '../package.json' with { type: 'json' };

const columns = 'id, type, imdbId, videoId, title, season, episode, lang, label, originalName, extension, bytes, createdAt';
const maxFileBytes = 10 * 1024 * 1024;
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const fileKey = row => `subtitle:${row.id}.${row.extension}`;
const credentials = new WeakMap();
async function credentialTag(env) {
  if (!credentials.has(env)) credentials.set(env, (async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(env.ADMIN_PASSWORD))).toString('hex');
  })());
  return credentials.get(env);
}
function checkOrigin(request, url) {
  if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Use this library\'s web page to make changes.');
}
async function limitedBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, 'The request is too large. The file limit is 10 MB.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new HttpError(413, 'The request is too large. The file limit is 10 MB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON data.');
  try { return JSON.parse(new TextDecoder().decode(await limitedBody(request, 16384))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON data.'); }
}
function sessionHash(request) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)cs_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token ? sha256(token) : '';
}
async function authenticated(request, env) {
  const hash = sessionHash(request); if (!hash) return false;
  const row = await env.DB.prepare('SELECT credentialTag FROM sessions WHERE hash = ? AND expiresAt > ?').bind(hash, Date.now()).first();
  return !!row && equal(row.credentialTag, await credentialTag(env));
}
function cookie(token, url, expires = 43200) {
  return `cs_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${expires}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
async function login(request, env, url) {
  checkOrigin(request, url);
  const { password } = await readJson(request);
  if (typeof password !== 'string' || password.length > 1024) throw new HttpError(400, 'Enter your password.');
  const bucket = sha256(`${env.SESSION_SECRET}:${request.headers.get('CF-Connecting-IP') || 'local'}`), now = Date.now();
  const attempt = await env.DB.prepare(`INSERT INTO login_attempts(bucket, attempts, expiresAt) VALUES(?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expiresAt <= ? THEN 1 ELSE attempts + 1 END,
    expiresAt = CASE WHEN expiresAt <= ? THEN excluded.expiresAt ELSE expiresAt END RETURNING attempts`).bind(bucket, now + 900000, now, now).first();
  if (attempt.attempts > 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  if (!equal(password, env.ADMIN_PASSWORD)) throw new HttpError(401, 'Incorrect password.');
  const token = randomBytes(32).toString('hex');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expiresAt <= ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE expiresAt <= ? OR bucket = ?').bind(now, bucket),
    env.DB.prepare('INSERT INTO sessions(hash, credentialTag, expiresAt) VALUES(?, ?, ?)').bind(sha256(token), await credentialTag(env), now + 43200000),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(token, url) });
}
async function upload(request, env) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'Use the file upload form.');
  const bytes = await limitedBody(request, maxFileBytes + 65536);
  let form;
  try { form = await new Request('https://upload.invalid', { method: 'POST', headers: { 'Content-Type': contentType }, body: bytes }).formData(); }
  catch { throw new HttpError(400, 'Invalid upload form.'); }
  const file = form.get('file');
  if (!(file instanceof File) || form.getAll('file').length !== 1 || file.size === 0) throw new HttpError(400, 'Select one subtitle file.');
  const meta = validateMetadata(Object.fromEntries(form));
  const prepared = prepareSubtitle(file.name, Buffer.from(await file.arrayBuffer()), form.get('encoding') || 'auto');
  if (prepared.bytes > maxFileBytes) throw new HttpError(413, 'The normalized subtitle exceeds the 10 MB file limit.');
  const findDuplicate = () => env.DB.prepare(`SELECT ${columns} FROM subtitles WHERE type = ? AND videoId = ? AND lang = ? AND label = ? AND hash = ?`).bind(meta.type, meta.videoId, meta.lang, meta.label, prepared.hash).first();
  const duplicate = await findDuplicate(); if (duplicate) return json({ subtitle: duplicate, duplicate: true });
  const row = { ...meta, ...prepared, id: randomUUID(), createdAt: new Date().toISOString() };
  // Write the file first: metadata must never advertise a failed upload.
  await env.FILES.put(fileKey(row), prepared.content);
  try {
    const inserted = await env.DB.prepare(`INSERT INTO subtitles(id,type,imdbId,videoId,title,season,episode,lang,label,originalName,extension,bytes,hash,createdAt)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(bytes),0) FROM subtitles) + ? <= 268435456
      ON CONFLICT(type,videoId,lang,label,hash) DO NOTHING`).bind(row.id, row.type, row.imdbId, row.videoId, row.title, row.season, row.episode, row.lang, row.label, row.originalName, row.extension, row.bytes, row.hash, row.createdAt, row.bytes).run();
    if (!inserted.meta.changes) {
      await env.FILES.delete(fileKey(row));
      const existing = await findDuplicate();
      if (existing) return json({ subtitle: existing, duplicate: true });
      throw new HttpError(409, 'The library has reached its 256 MB safety limit. Delete unused subtitles first.');
    }
  } catch (error) {
    await env.FILES.delete(fileKey(row)).catch(() => {});
    throw error;
  }
  const { content, hash, ...subtitle } = row;
  return json({ subtitle, duplicate: false }, 201);
}
async function handleAddon(request, env, url, match) {
  if (!equal(match[1], env.ADDON_KEY)) throw new HttpError(404, 'Addon not found.');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Read-only subtitle addon.');
  if (match[2] === '/manifest.json') return json({ id: 'community.customsubtitles.cloud', version: packageInfo.version, name: 'Custom Subtitles · Cloud', description: 'Your subtitle library, available while your PC is off.', resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }], types: ['movie', 'series'], catalogs: [] }, 200, cors);
  const subtitles = /^\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/.exec(match[2]);
  if (subtitles) {
    const valid = subtitles[1] === 'movie' ? /^tt\d{7,10}$/ : /^tt\d{7,10}:\d{1,3}:\d{1,4}$/;
    const { results } = valid.test(subtitles[2]) ? await env.DB.prepare(`SELECT ${columns} FROM subtitles WHERE type = ? AND videoId = ? ORDER BY createdAt DESC, id`).bind(subtitles[1], subtitles[2]).all() : { results: [] };
    return json({ subtitles: results.map(row => ({ id: row.id, lang: row.lang, label: `${LANGUAGES[row.lang]} · ${row.label || row.originalName}`, url: `${url.origin}/addon/${env.ADDON_KEY}/files/${row.id}.${row.extension}` })) }, 200, cors);
  }
  const file = /^\/files\/([a-f0-9-]{36})\.(srt|vtt|ass|ssa)$/.exec(match[2]);
  if (file && validId.test(file[1])) {
    const row = await env.DB.prepare('SELECT id, extension, bytes FROM subtitles WHERE id = ? AND extension = ?').bind(file[1], file[2]).first();
    if (!row) throw new HttpError(404, 'Subtitles not found.');
    if (request.method === 'HEAD') return new Response(null, { headers: { ...cors, 'Content-Type': row.extension === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Length': String(row.bytes) } });
    const bytes = await env.FILES.get(fileKey(row), 'arrayBuffer');
    if (!bytes) throw new HttpError(503, 'This upload is still propagating. Try again shortly.');
    return new Response(bytes, { headers: { ...cors, 'Content-Type': row.extension === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8' } });
  }
  throw new HttpError(404, 'Subtitle endpoint not found.');
}
async function handle(request, env) {
  const url = new URL(request.url), pathname = decodeURIComponent(url.pathname);
  const addon = /^\/addon\/([a-f0-9]{48})(\/.*)$/.exec(pathname);
  const configured = typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 16 && env.ADMIN_PASSWORD.length <= 1024 && /^[a-f0-9]{64}$/.test(env.SESSION_SECRET || '') && /^[a-f0-9]{48}$/.test(env.ADDON_KEY || '');
  if (pathname === '/api/session' && request.method === 'GET') return json({ passwordEnabled: configured, needsSetup: !configured, setupAllowed: false, deployment: 'cloudflare', authenticated: configured && await authenticated(request, env) });
  if (pathname.startsWith('/api/') || addon) {
    if (!configured) throw new HttpError(503, 'Complete Cloudflare setup and configure the Worker secrets before using this library.');
    if (addon) return handleAddon(request, env, url, addon);
    if (pathname === '/api/login' && request.method === 'POST') return login(request, env, url);
    if (!await authenticated(request, env)) throw new HttpError(401, 'Sign in to manage your library.');
    if (!['GET', 'HEAD'].includes(request.method)) checkOrigin(request, url);
    if (pathname === '/api/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(sessionHash(request)).run();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', url, 0) });
    }
    if (pathname === '/api/config' && request.method === 'GET') {
      const addonUrl = `${url.origin}/addon/${env.ADDON_KEY}/manifest.json`;
      return json({ version: packageInfo.version, deployment: 'cloudflare', baseUrl: url.origin, baseUrlLocked: true, localUrl: '', gatewayUrl: '', networkSetupAllowed: false, tailscale: { available: false, running: false, publicEnabled: true }, addonUrl, installUrl: addonUrl.replace(/^https?:\/\//, 'stremio://'), languages: LANGUAGES, passwordEnabled: true, maxFileBytes });
    }
    if (pathname === '/api/subtitles' && request.method === 'GET') return json({ subtitles: (await env.DB.prepare(`SELECT ${columns} FROM subtitles ORDER BY createdAt DESC, id`).all()).results });
    if (pathname === '/api/subtitles' && request.method === 'POST') return upload(request, env);
    const deletion = /^\/api\/subtitles\/([a-f0-9-]{36})$/.exec(pathname);
    if (deletion && request.method === 'DELETE' && validId.test(deletion[1])) {
      const row = await env.DB.prepare('SELECT id, extension FROM subtitles WHERE id = ?').bind(deletion[1]).first();
      if (!row) throw new HttpError(404, 'Subtitles not found.');
      await env.FILES.delete(fileKey(row));
      await env.DB.prepare('DELETE FROM subtitles WHERE id = ?').bind(row.id).run();
      return json({ ok: true });
    }
    if (pathname === '/api/hints' && request.method === 'GET') return json(filenameHints((url.searchParams.get('filename') || '').slice(0, 500)));
    if (pathname === '/api/meta' && request.method === 'GET') {
      const type = url.searchParams.get('type'), query = (url.searchParams.get('q') || '').trim().slice(0, 150);
      if (!['movie', 'series'].includes(type) || query.length < 2) throw new HttpError(400, 'Enter at least two characters and select a video type.');
      const byId = /^tt\d{7,10}$/.test(query);
      const remote = byId ? `https://v3-cinemeta.strem.io/meta/${type}/${query}.json` : `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
      try {
        const result = await fetch(remote, { signal: AbortSignal.timeout(8000) }); if (!result.ok) throw new Error();
        const data = await result.json();
        return json({ metas: (byId ? data.meta ? [data.meta] : [] : data.metas || []).filter(row => /^tt\d{7,10}$/.test(row.id)).slice(0, 12).map(row => ({ id: row.id, name: row.name, year: String(row.releaseInfo || row.year || ''), poster: typeof row.poster === 'string' && row.poster.startsWith('https://') ? row.poster : '' })) });
      } catch { throw new HttpError(502, 'Metadata search is unavailable. You can enter the title and IMDb ID manually.'); }
    }
    throw new HttpError(404, 'API endpoint not found.');
  }
  if (!['GET', 'HEAD'].includes(request.method) || !['/', '/index.html', '/app.js', '/styles.css', '/favicon.svg'].includes(pathname)) throw new HttpError(404, 'Page not found.');
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request, env) {
    let response;
    try { response = await handle(request, env); }
    catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 503;
      response = json({ error: status === 503 ? 'Cloud storage is unavailable or its free quota has been reached. Try again later.' : error.message }, status);
    }
    const result = new Response(request.method === 'HEAD' ? null : response.body, response);
    result.headers.set('Cache-Control', 'no-store'); result.headers.set('X-Content-Type-Options', 'nosniff'); result.headers.set('Referrer-Policy', 'no-referrer');
    result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return result;
  }
};
