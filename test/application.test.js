import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApplication } from '../src/server.js';
import { prepareSubtitle, filenameHints } from '../src/subtitles.js';

const srt = '1\n00:00:01,000 --> 00:00:03,000\nAhoj, svet!\n';
const makeForm = (overrides = {}, text = srt, filename = 'Inception.sk.srt') => {
  const form = new FormData();
  const fields = { type: 'movie', title: 'Inception', imdbId: 'tt1375666', lang: 'slo', label: 'BluRay', encoding: 'auto', ...overrides };
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  form.set('file', new Blob([text]), filename); return form;
};

test('upload, Stremio protocol, episode isolation, validation, deletion and persistence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'custom-subtitles-test-'));
  let app = createApplication({ host: '127.0.0.1', port: 0, dataDir: directory, password: '', tailscale: { available: false }, fetchMetadata: async () => Response.json({ metas: [{ id: 'tt1375666', name: 'Inception', releaseInfo: '2010' }, { id: 'tmdb:1', name: 'Ignore' }] }) });
  let { localUrl } = await app.start();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (url, options) => fetch(`${localUrl}${url}`, options);
  const config = await (await request('/api/config')).json();
  const addonPath = new URL(config.addonUrl).pathname.replace('/manifest.json', '');
  let movie;

  await t.test('manifest and accessible web interface', async () => {
    const page = await request('/'); assert.equal(page.status, 200); assert.match(await page.text(), /Tvoja knižnica/);
    const response = await request(`${addonPath}/manifest.json`); const manifest = await response.json();
    assert.equal(response.headers.get('access-control-allow-origin'), '*'); assert.deepEqual(manifest.resources[0].types, ['movie', 'series']);
    assert.equal((await request('/manifest.json')).status, 404);
    assert.equal((await request(`/addon/${'0'.repeat(48)}/manifest.json`)).status, 404);
  });
  await t.test('real upload is downloadable through Stremio URLs, with extra parameters', async () => {
    const response = await request('/api/subtitles', { method: 'POST', body: makeForm() }); assert.equal(response.status, 201);
    movie = (await response.json()).subtitle;
    for (const endpoint of [`${addonPath}/subtitles/movie/tt1375666.json`, `${addonPath}/subtitles/movie/tt1375666/videoHash=abc&filename=film.mkv.json`]) {
      const result = await (await request(endpoint)).json(); assert.equal(result.subtitles.length, 1);
      assert.equal(result.subtitles[0].lang, 'slo'); assert.match(result.subtitles[0].label, /BluRay/);
      const file = await fetch(result.subtitles[0].url); assert.equal(await file.text(), srt); assert.equal(file.headers.get('access-control-allow-origin'), '*');
    }
    assert.equal((await (await request('/api/subtitles')).json()).subtitles[0].content, undefined);
  });
  await t.test('duplicate uploads are idempotent', async () => {
    const response = await request('/api/subtitles', { method: 'POST', body: makeForm() }); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.duplicate, true); assert.equal(result.subtitle.id, movie.id);
  });
  await t.test('series subtitles only match the exact series and episode', async () => {
    for (const episode of [1, 2]) {
      const response = await request('/api/subtitles', { method: 'POST', body: makeForm({ type: 'series', title: 'Breaking Bad', imdbId: 'tt0903747', season: 1, episode }) }); assert.equal(response.status, 201);
    }
    const first = await (await request(`${addonPath}/subtitles/series/tt0903747:1:1.json`)).json();
    const second = await (await request(`${addonPath}/subtitles/series/tt0903747%3A1%3A2.json`)).json();
    assert.equal(first.subtitles.length, 1); assert.equal(second.subtitles.length, 1); assert.notEqual(first.subtitles[0].id, second.subtitles[0].id);
    for (const endpoint of ['series/tt0903747:2:1', 'series/tt0903747', 'movie/tt0903747', 'movie/tt0000001']) assert.deepEqual((await (await request(`${addonPath}/subtitles/${endpoint}.json`)).json()).subtitles, []);
  });
  await t.test('reject invalid metadata, disguised files, oversized bodies and multiple files', async () => {
    for (const form of [makeForm({ imdbId: '../../secret' }), makeForm({ lang: 'xxx' }), makeForm({ type: 'series', season: '1', episode: '' }), makeForm({}, '<html>not subtitles</html>', 'fake.srt'), makeForm({}, srt, 'file.exe')]) assert.equal((await request('/api/subtitles', { method: 'POST', body: form })).status, 400);
    const multiple = makeForm(); multiple.append('file', new Blob([srt]), 'second.srt'); assert.equal((await request('/api/subtitles', { method: 'POST', body: multiple })).status, 400);
    const huge = makeForm({}, Buffer.alloc(10 * 1024 * 1024 + 1, 65)); assert.equal((await request('/api/subtitles', { method: 'POST', body: huge })).status, 413);
  });
  await t.test('origin and host checks prevent cross-site mutations and DNS rebinding', async () => {
    assert.equal((await request('/api/subtitles', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: makeForm() })).status, 403);
    const reboundStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(`${localUrl}/api/config`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await request('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://example.test/path?x=1' }) })).status, 400);
  });
  await t.test('metadata is filtered to IMDb and filename hints detect episodes and language', async () => {
    const result = await (await request('/api/meta?type=movie&q=Inception')).json(); assert.equal(result.metas.length, 1); assert.equal(result.metas[0].year, '2010');
    const hints = await (await request('/api/hints?filename=Breaking.Bad.S02E03.tt0903747.cs.srt')).json(); assert.deepEqual(hints, { season: 2, episode: 3, imdbId: 'tt0903747', lang: 'cze' });
  });
  await t.test('database and addon key survive a complete server restart', async () => {
    await app.close();
    app = createApplication({ host: '127.0.0.1', port: 0, dataDir: directory, password: '', tailscale: {} });
    ({ localUrl } = await app.start());
    const configAfter = await (await request('/api/config')).json(); assert.equal(new URL(configAfter.addonUrl).pathname, new URL(config.addonUrl).pathname);
    assert.equal((await (await request('/api/subtitles')).json()).subtitles.length, 3);
    assert.equal((await (await request(`${addonPath}/subtitles/movie/tt1375666.json`)).json()).subtitles[0].id, movie.id);
  });
  await t.test('changing base URL also changes subtitle download URLs', async () => {
    const response = await request('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://my-pc.example.ts.net/' }) }); assert.equal(response.status, 200);
    const result = await (await request(`${addonPath}/subtitles/movie/tt1375666.json`)).json(); assert.match(result.subtitles[0].url, /^https:\/\/my-pc\.example\.ts\.net\//);
  });
  await t.test('deletion immediately removes both subtitle response and file', async () => {
    assert.equal((await request(`/api/subtitles/${movie.id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await (await request(`${addonPath}/subtitles/movie/tt1375666.json`)).json()).subtitles, []);
    assert.equal((await request(`${addonPath}/files/${movie.id}.srt`)).status, 404);
  });
});

test('password protects administration while Stremio uses its persistent read key', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'custom-subtitles-auth-'));
  const app = createApplication({ host: '127.0.0.1', port: 0, dataDir: directory, password: 'test-private-password-123', tailscale: {} });
  const { localUrl } = await app.start();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`${localUrl}/api/config`)).status, 401);
  assert.equal((await fetch(`${localUrl}/api/subtitles`, { method: 'POST', body: makeForm() })).status, 401);
  const session = await (await fetch(`${localUrl}/api/session`)).json(); assert.equal(session.authenticated, false);
  const login = password => fetch(`${localUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localUrl }, body: JSON.stringify({ password }) });
  assert.equal((await login('incorrect')).status, 401);
  const response = await login('test-private-password-123'); assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const config = await (await fetch(`${localUrl}/api/config`, { headers: { Cookie: cookie } })).json();
  assert.equal((await fetch(config.addonUrl)).status, 200);
  await fetch(`${localUrl}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal((await fetch(`${localUrl}/api/config`, { headers: { Cookie: cookie } })).status, 401);
  for (let index = 0; index < 10; index++) await login('incorrect');
  assert.equal((await login('incorrect')).status, 429);
});

test('encoding conversion and ASS styling preservation', () => {
  const bytes = Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:03,000\r\n'), Buffer.from([0x8e, 0x6c, 0x74, 0xfd]), Buffer.from('\r\n')]);
  assert.match(prepareSubtitle('sk.srt', bytes, 'auto').content.toString(), /Žltý/);
  const ass = '[Script Info]\nTitle: Test\n[V4+ Styles]\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,{\\i1}Styled text\n';
  assert.equal(prepareSubtitle('test.ass', Buffer.from(ass), 'auto').content.toString(), ass);
  assert.deepEqual(filenameHints('Show.1x04.en.srt'), { season: 1, episode: 4, imdbId: '', lang: 'eng' });
});
