import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.js';

const origin = 'https://subtitles.example.workers.dev';
const subtitleText = '1\n00:00:01,000 --> 00:00:03,000\nStored in your cloud library.\n';
function environment(t) {
  const database = new DatabaseSync(':memory:'); database.exec(readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8'));
  t.after(() => database.close());
  function statement(sql, values = []) {
    const prepared = database.prepare(sql);
    return {
      bind(...next) { return statement(sql, next); },
      async first() { return prepared.get(...values) || null; },
      async all() { return { results: prepared.all(...values) }; },
      async run() { const result = prepared.run(...values); return { meta: { changes: result.changes } }; },
    };
  }
  const files = new Map();
  return {
    ADMIN_PASSWORD: 'cloud-test-password-do-not-use', SESSION_SECRET: 'b'.repeat(64), ADDON_KEY: 'c'.repeat(48),
    DB: { prepare: statement, async batch(statements) { database.exec('BEGIN'); try { const result = []; for (const item of statements) result.push(await item.run()); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } } },
    FILES: { async put(key, bytes) { files.set(key, Uint8Array.from(bytes).buffer); }, async get(key) { return files.get(key) || null; }, async delete(key) { files.delete(key); } },
    ASSETS: { async fetch() { return new Response('The static interface'); } }, files, database,
  };
}
const request = (env, pathname, options = {}) => worker.fetch(new Request(origin + pathname, options), env);
const jsonPost = (body, cookie = '') => ({ method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function signIn(env) {
  const response = await request(env, '/api/login', jsonPost({ password: env.ADMIN_PASSWORD })); assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure/);
  return response.headers.get('Set-Cookie').split(';')[0];
}
function upload(cookie, fields = {}, contents = subtitleText) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ type: 'movie', imdbId: 'tt1375666', title: 'Inception', lang: 'eng', ...fields })) form.set(key, String(value));
  form.set('file', new File([contents], 'inception.en.srt'));
  return { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form };
}
test('cloud sessions protect administration, survive a Worker instance, revoke logout, and follow password rotation', async t => {
  const env = environment(t);
  assert.equal((await request(env, '/api/config')).status, 401);
  assert.equal((await request(env, '/api/session')).headers.get('Cache-Control'), 'no-store');
  assert.equal((await (await request({ ...env, ADMIN_PASSWORD: '' }, '/api/session')).json()).needsSetup, true);
  const cookie = await signIn(env);
  const state = await (await request({ ...env }, '/api/session', { headers: { Cookie: cookie } })).json();
  assert.equal(state.authenticated, true);
  const config = await (await request(env, '/api/config', { headers: { Cookie: cookie } })).json();
  assert.equal(config.deployment, 'cloudflare'); assert.equal(config.baseUrlLocked, true); assert.equal(config.networkSetupAllowed, false);
  assert.equal(config.addonUrl, `${origin}/addon/${env.ADDON_KEY}/manifest.json`); assert.equal(config.ADMIN_PASSWORD, undefined);
  assert.equal((await request({ ...env, ADMIN_PASSWORD: 'a-different-password-for-the-worker' }, '/api/config', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request(env, '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 200);
  assert.equal((await request(env, '/api/config', { headers: { Cookie: cookie } })).status, 401);
});
test('cloud upload, duplicate handling, exact episode matches, CORS, persistence, and deletion use durable bindings', async t => {
  const env = environment(t), cookie = await signIn(env);
  const response = await request(env, '/api/subtitles', upload(cookie)); assert.equal(response.status, 201);
  const movie = (await response.json()).subtitle;
  assert.equal(movie.content, undefined); assert.equal(movie.hash, undefined);
  assert.equal((await (await request(env, '/api/subtitles', upload(cookie))).json()).duplicate, true); assert.equal(env.files.size, 1);
  const episodeResponse = await request(env, '/api/subtitles', upload(cookie, { type: 'series', imdbId: 'tt0903747', title: 'Breaking Bad', season: 1, episode: 2 })); assert.equal(episodeResponse.status, 201);
  const prefix = `/addon/${env.ADDON_KEY}`;
  const result = await request({ ...env }, prefix + '/subtitles/movie/tt1375666/videoHash=abc.json');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), '*'); const matches = await result.json(); assert.equal(matches.subtitles[0].id, movie.id);
  const content = await worker.fetch(new Request(matches.subtitles[0].url), { ...env }); assert.equal(await content.text(), subtitleText);
  assert.equal((await (await request(env, prefix + '/subtitles/series/tt0903747%3A1%3A2.json')).json()).subtitles.length, 1);
  assert.deepEqual((await (await request(env, prefix + '/subtitles/series/tt0903747:1:1.json')).json()).subtitles, []);
  assert.equal((await request(env, prefix + '/manifest.json', { method: 'OPTIONS' })).status, 204);
  assert.equal((await request(env, prefix + `/files/${movie.id}.srt`, { method: 'HEAD' })).headers.get('Content-Length'), String(Buffer.byteLength(subtitleText)));
  assert.equal((await request(env, `/addon/${'0'.repeat(48)}/manifest.json`)).status, 404);
  assert.equal((await request(env, `/api/subtitles/${movie.id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin } })).status, 200);
  assert.equal((await request(env, prefix + `/files/${movie.id}.srt`)).status, 404);
});
test('cloud rejects cross-site changes, invalid uploads, quota failures, and repeated incorrect login attempts', async t => {
  const env = environment(t), cookie = await signIn(env);
  const crossSite = upload(cookie); crossSite.headers.Origin = 'https://untrusted.example';
  assert.equal((await request(env, '/api/subtitles', crossSite)).status, 403);
  assert.equal((await request(env, '/api/subtitles', upload(''))).status, 401);
  assert.equal((await request(env, '/api/subtitles', upload(cookie, {}, 'This is not a subtitle.'))).status, 400);
  env.FILES.put = async () => { throw new Error('KV free quota reached'); };
  assert.equal((await request(env, '/api/subtitles', upload(cookie))).status, 503);
  assert.equal(env.database.prepare('SELECT COUNT(*) AS total FROM subtitles').get().total, 0);
  for (let index = 0; index < 10; index++) assert.equal((await request(env, '/api/login', jsonPost({ password: 'wrong' }))).status, 401);
  assert.equal((await request(env, '/api/login', jsonPost({ password: env.ADMIN_PASSWORD }))).status, 429);
});
