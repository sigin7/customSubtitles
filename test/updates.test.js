import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_API, checkForUpdate, downloadUpdate, isNewerVersion, releaseUpdateLock, runStartupUpdate, selectUpdate } from '../src/updates.js';

const payload = Buffer.from('verified-installer-test-fixture');
const digest = createHash('sha256').update(payload).digest('hex');
const filename = 'CustomSubtitles-1.2.0-Setup-x64.exe';
const downloadRoot = 'https://github.com/sigin7/customSubtitles/releases/download/v1.2.0/';
const release = () => ({ tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [
  { name: filename, state: 'uploaded', size: payload.length, digest: `sha256:${digest}`, browser_download_url: downloadRoot + filename },
  { name: 'SHA256SUMS.txt', state: 'uploaded', browser_download_url: downloadRoot + 'SHA256SUMS.txt' },
] });
const fixtureFetch = async url => {
  if (url === RELEASE_API) return Response.json(release());
  if (url === downloadRoot + 'SHA256SUMS.txt') return new Response(`${digest}  ${filename}\n`);
  if (url === downloadRoot + filename) return new Response(payload);
  throw new Error('Unexpected test request.');
};
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'custom-subtitles-updates-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('updates compare numeric versions, reject unsafe tags, and never downgrade or install previews', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.8'), true);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
  assert.equal(isNewerVersion('1.2.0', '1.2.0'), false);
  assert.equal(isNewerVersion('1.1.9', '1.2.0'), false);
  for (const value of ['../2.0.0', '2.0.0-beta', '01.2.0', '1.2', '9007199254740992.0.0']) assert.throws(() => isNewerVersion(value, '1.0.0'));
  assert.equal(selectUpdate({ ...release(), prerelease: true }, '1.1.1'), null);
  assert.equal(selectUpdate({ ...release(), draft: true }, '1.1.1'), null);
  assert.equal(selectUpdate(release(), '1.2.0'), null);
  assert.equal(selectUpdate({ ...release(), assets: [] }, '1.1.1'), null);
});
test('only completed installer assets from the official repository are selected', () => {
  assert.equal(selectUpdate(release(), '1.1.1').filename, filename);
  const unsafe = release(); unsafe.assets[0].browser_download_url = 'https://example.com/installer.exe';
  assert.throws(() => selectUpdate(unsafe, '1.1.1'), /official repository/);
  const oversized = release(); oversized.assets[0].size = 301 * 1024 * 1024;
  assert.throws(() => selectUpdate(oversized, '1.1.1'), /size/);
  const digestError = release(); digestError.assets[0].digest = 'md5:unsafe';
  assert.throws(() => selectUpdate(digestError, '1.1.1'), /digest/);
});
test('GitHub errors, missing releases, and untrusted redirects cannot become updates', async () => {
  assert.equal(await checkForUpdate('1.1.1', async () => new Response('', { status: 404 })), null);
  await assert.rejects(checkForUpdate('1.1.1', async () => new Response('', { status: 403 })), /HTTP 403/);
  let requests = 0;
  await assert.rejects(checkForUpdate('1.1.1', async () => { requests++; return new Response(null, { status: 302, headers: { Location: 'https://example.com/update' } }); }), /untrusted/);
  assert.equal(requests, 1);
  await assert.rejects(checkForUpdate('1.1.1', async () => new Response('x'.repeat(257 * 1024))), /too large/);
});
test('installer download requires matching SHA-256, published size, and GitHub digest', async t => {
  const root = await directory(t), update = selectUpdate(release(), '1.1.1');
  const downloaded = await downloadUpdate(update, root, fixtureFetch);
  assert.deepEqual(await readFile(downloaded.installerPath), payload);
  assert.equal(downloaded.sha256, digest);
  await assert.rejects(downloadUpdate({ ...update, digest: '0'.repeat(64) }, root, fixtureFetch), /do not match/);
  await assert.rejects(downloadUpdate(update, root, async url => url.endsWith('.exe') ? new Response(Buffer.alloc(payload.length)) : fixtureFetch(url)), /SHA-256/);
  await assert.rejects(downloadUpdate(update, root, async url => url.endsWith('.exe') ? new Response(Buffer.alloc(payload.length + 1)) : fixtureFetch(url)), /larger/);
  await assert.rejects(downloadUpdate(update, root, async url => url.endsWith('.txt') ? new Response(`${digest}  other.exe\n`) : fixtureFetch(url)), /unambiguous/);
  for (const entry of await readdir(root)) assert.ok(!(await readdir(path.join(root, entry))).some(name => name.endsWith('.partial')));
});
test('startup hands verified updates to the helper and preserves separate user data', async t => {
  const root = await directory(t), installed = path.join(root, 'installed'), cacheDirectory = path.join(root, 'updates');
  await mkdir(installed); await writeFile(path.join(installed, '.installed'), 'installed');
  const dataPath = path.join(root, 'library.sqlite'); await writeFile(dataPath, 'user-library-sentinel');
  const options = { root: installed, currentVersion: '1.1.1', platform: 'win32', arch: 'x64', execPath: path.join(installed, 'runtime', 'node.exe'), env: { PORT: '0' }, cacheDirectory, fetchImpl: fixtureFetch, log: () => {} };
  let handoffs = 0;
  const result = await runStartupUpdate({ ...options, handoff: async job => {
    handoffs++; assert.equal(job.sha256, digest); assert.equal(job.version, '1.2.0');
    assert.equal(job.installDirectory, installed); assert.equal(job.parentPid, process.pid);
    assert.deepEqual(await readFile(job.installerPath), payload);
  } });
  assert.equal(result.action, 'install'); assert.equal(handoffs, 1);
  assert.equal(await readFile(dataPath, 'utf8'), 'user-library-sentinel');
  await releaseUpdateLock(path.join(cacheDirectory, 'update.lock'));
  const offline = await runStartupUpdate({ ...options, fetchImpl: async () => { throw new Error('Offline'); }, handoff: async () => assert.fail('Must not install') });
  assert.equal(offline.action, 'continue');
  const tampered = await runStartupUpdate({ ...options, fetchImpl: async url => url.endsWith('.exe') ? new Response(Buffer.alloc(payload.length)) : fixtureFetch(url), handoff: async () => assert.fail('Must not install') });
  assert.equal(tampered.action, 'continue');
  assert.ok(!(await readdir(cacheDirectory)).includes('update.lock'));
});
test('source runs, disabled updates, and an active update never download or install', async t => {
  const root = await directory(t), cacheDirectory = path.join(root, 'updates');
  const options = { root, currentVersion: '1.1.1', platform: 'win32', arch: 'x64', execPath: path.join(root, 'runtime', 'node.exe'), env: { PORT: '0' }, cacheDirectory, fetchImpl: async () => assert.fail('Must not request updates'), handoff: async () => assert.fail('Must not install'), log: () => {} };
  assert.equal((await runStartupUpdate(options)).action, 'continue');
  await writeFile(path.join(root, '.installed'), 'installed');
  assert.equal((await runStartupUpdate({ ...options, env: { AUTO_UPDATE: 'false' } })).action, 'continue');
  assert.equal((await runStartupUpdate({ ...options, skip: true })).action, 'continue');
  await mkdir(cacheDirectory); await writeFile(path.join(cacheDirectory, 'update.lock'), JSON.stringify({ pid: process.pid }));
  assert.equal((await runStartupUpdate(options)).action, 'busy');
});
test('an occupied server port prevents an update from replacing a running application', async t => {
  const root = await directory(t); await writeFile(path.join(root, '.installed'), 'installed');
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await runStartupUpdate({ root, currentVersion: '1.1.1', platform: 'win32', arch: 'x64', execPath: path.join(root, 'runtime', 'node.exe'), env: { PORT: String(server.address().port) }, cacheDirectory: path.join(root, 'updates'), fetchImpl: async () => assert.fail('A running server must not be updated'), log: () => {} });
  assert.equal(result.action, 'continue');
});
