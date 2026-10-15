import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2]).origin;
const local = process.argv[3] === '--local';
const credentials = local ? { ADMIN_PASSWORD: 'local-cloud-test-password' } : JSON.parse(await readFile(process.argv[3], 'utf8'));
const statePath = process.argv[4];
const mode = process.argv[5] || 'complete';
const send = (pathname, options = {}) => fetch(origin + pathname, { redirect: 'error', signal: AbortSignal.timeout(15000), ...options });
const response = await send('/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: credentials.ADMIN_PASSWORD }) });
assert.equal(response.status, 200, 'Administrator login failed.');
const cookie = response.headers.get('set-cookie').split(';')[0];
const headers = { Cookie: cookie, Origin: origin };
const configResponse = await send('/api/config', { headers }); assert.equal(configResponse.status, 200);
const config = await configResponse.json(); assert.equal(config.deployment, 'cloudflare');
assert.equal((await send('/api/config')).status, 401);
assert.equal((await send(new URL(config.addonUrl).pathname)).status, 200);
const text = '1\n00:00:01,000 --> 00:00:03,000\nCloudflare deployment verification.\n';
let rows = [];
try {
  if (mode === 'verify') rows = JSON.parse(await readFile(statePath, 'utf8'));
  else {
    for (const fields of [{ type: 'movie', imdbId: 'tt1375666', title: 'Inception' }, { type: 'series', imdbId: 'tt0903747', title: 'Breaking Bad', season: 1, episode: 2 }]) {
      const form = new FormData();
      for (const [name, value] of Object.entries({ ...fields, lang: 'eng', label: 'Disposable deployment check ' + crypto.randomUUID() })) form.set(name, String(value));
      form.set('file', new File([text], 'deployment-check.srt'));
      const upload = await send('/api/subtitles', { method: 'POST', headers, body: form }); assert.equal(upload.status, 201, 'A subtitle upload failed.');
      const { subtitle } = await upload.json(); rows.push(subtitle);
      if (statePath) await writeFile(statePath, JSON.stringify(rows));
    }
  }
  const prefix = new URL(config.addonUrl).pathname.replace('/manifest.json', '');
  for (const row of rows) {
    const selected = await (await send(`${prefix}/subtitles/${row.type}/${row.videoId}/videoHash=smoke.json`)).json();
    const match = selected.subtitles.find(item => item.id === row.id); assert.ok(match, 'The uploaded subtitle did not match its movie or episode.');
    let subtitle;
    for (let attempt = 0; attempt < 20; attempt++) {
      subtitle = await fetch(match.url, { signal: AbortSignal.timeout(15000) });
      if (subtitle.status !== 503) break;
      await delay(local ? 100 : 3000);
    }
    assert.equal(subtitle.status, 200, 'The saved subtitle is not downloadable.'); assert.equal(await subtitle.text(), text);
  }
  const wrongEpisode = await (await send(`${prefix}/subtitles/series/tt0903747:1:1.json`)).json();
  assert.ok(!wrongEpisode.subtitles.some(item => rows.some(row => row.id === item.id)), 'An episode matched the wrong episode.');
  console.log('Cloudflare smoke check passed: private administration, uploads, movie/episode matching, and stored subtitle downloads.');
} finally {
  if (mode !== 'keep') for (const row of rows) {
    const removal = await send(`/api/subtitles/${row.id}`, { method: 'DELETE', headers }); assert.ok([200, 404].includes(removal.status), 'The disposable subtitle could not be removed.');
  }
  await send('/api/logout', { method: 'POST', headers });
}
