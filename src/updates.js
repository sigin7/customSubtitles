import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

export const RELEASE_API = 'https://api.github.com/repos/sigin7/customSubtitles/releases/latest';
const DOWNLOAD_ROOT = 'https://github.com/sigin7/customSubtitles/releases/download/';
const DOWNLOAD_HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const CACHE_MARKER = 'Custom Subtitles automatic updater';

function versionParts(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Invalid update version.');
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Invalid update version.');
  return parts;
}
export function isNewerVersion(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
export function selectUpdate(release, currentVersion) {
  if (release.draft || release.prerelease) return null;
  const version = /^v(.+)$/.exec(release.tag_name ?? '')?.[1];
  if (!version || !isNewerVersion(version, currentVersion)) return null;
  const filename = `CustomSubtitles-${version}-Setup-x64.exe`;
  const installer = release.assets?.find(asset => asset.name === filename && asset.state === 'uploaded');
  const checksums = release.assets?.find(asset => asset.name === 'SHA256SUMS.txt' && asset.state === 'uploaded');
  if (!installer || !checksums) return null;
  const expectedRoot = `${DOWNLOAD_ROOT}v${version}/`;
  if (installer.browser_download_url !== expectedRoot + filename || checksums.browser_download_url !== expectedRoot + 'SHA256SUMS.txt') throw new Error('The update assets are outside the official repository.');
  if (!Number.isSafeInteger(installer.size) || installer.size < 1 || installer.size > MAX_INSTALLER_BYTES) throw new Error('The update installer size is invalid.');
  if (installer.digest && !/^sha256:[a-f0-9]{64}$/.test(installer.digest)) throw new Error('The GitHub installer digest is invalid.');
  return { version, filename, size: installer.size, digest: installer.digest?.slice(7), installerUrl: installer.browser_download_url, checksumUrl: checksums.browser_download_url };
}
async function trustedFetch(url, fetchImpl, signal) {
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('The update download redirected to an untrusted address.');
    const response = await fetchImpl(url, { redirect: 'manual', signal, headers: { Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'CustomSubtitles-Updater', 'X-GitHub-Api-Version': '2026-03-10' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('The update download redirect is invalid.');
    url = new URL(location, url).href;
  }
  throw new Error('The update download has too many redirects.');
}
async function smallBody(response, limit) {
  if (!response.ok) throw new Error(`The update server returned HTTP ${response.status}.`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('The update server response is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function checkForUpdate(currentVersion, fetchImpl = fetch) {
  const response = await trustedFetch(RELEASE_API, fetchImpl, AbortSignal.timeout(8000));
  if (response.status === 404) { await response.body?.cancel(); return null; }
  return selectUpdate(JSON.parse(await smallBody(response, 256 * 1024)), currentVersion);
}
export async function downloadUpdate(update, cacheDirectory, fetchImpl = fetch, log = () => {}) {
  const checksumText = await smallBody(await trustedFetch(update.checksumUrl, fetchImpl, AbortSignal.timeout(10000)), 16 * 1024);
  const matches = checksumText.split(/\r?\n/).map(line => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)).filter(match => match?.[2] === update.filename);
  if (matches.length !== 1) throw new Error('The release does not contain an unambiguous installer checksum.');
  const sha256 = matches[0][1].toLowerCase();
  if (update.digest && update.digest !== sha256) throw new Error('The GitHub digest and release checksum do not match.');
  await mkdir(cacheDirectory, { recursive: true });
  const directory = await mkdtemp(path.join(cacheDirectory, `v${update.version}-`));
  await writeFile(path.join(directory, '.custom-subtitles-update'), CACHE_MARKER);
  const installerPath = path.join(directory, update.filename), partialPath = installerPath + '.partial';
  const file = await open(partialPath, 'wx');
  let bytes = 0, nextProgress = 25;
  const hash = createHash('sha256');
  try {
    const response = await trustedFetch(update.installerUrl, fetchImpl, AbortSignal.timeout(5 * 60 * 1000));
    if (!response.ok) throw new Error(`The installer download returned HTTP ${response.status}.`);
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > update.size) throw new Error('The downloaded installer is larger than its published size.');
      hash.update(chunk); await file.writeFile(chunk);
      if (bytes * 100 / update.size >= nextProgress) { log(`Update download: ${Math.floor(bytes * 100 / update.size)}%.`); nextProgress += 25; }
    }
    if (bytes !== update.size || hash.digest('hex') !== sha256) throw new Error('The downloaded installer failed SHA-256 verification.');
  } catch (error) {
    await file.close(); await unlink(partialPath).catch(() => {}); throw error;
  }
  await file.close(); await rename(partialPath, installerPath);
  return { directory, installerPath, sha256 };
}
export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export function portIsInUse(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = createConnection({ host: host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(600); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
async function acquireLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx');
      try { await file.writeFile(JSON.stringify({ pid: process.pid })); } finally { await file.close(); }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch { return false; }
      if (processIsAlive(owner.pid)) return false;
      await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return false;
}
export async function releaseUpdateLock(lockPath) {
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    if (owner.pid === process.pid || !processIsAlive(owner.pid)) await unlink(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function cleanCache(cacheDirectory) {
  for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
    const version = /^v(\d+\.\d+\.\d+)-[a-zA-Z0-9]+$/.exec(entry.name)?.[1];
    if (!entry.isDirectory() || !version) continue;
    const directory = path.join(cacheDirectory, entry.name);
    if (await readFile(path.join(directory, '.custom-subtitles-update'), 'utf8').catch(() => '') !== CACHE_MARKER) continue;
    for (const name of ['node.exe', 'update-helper.mjs', 'job.json', 'installer.log', `CustomSubtitles-${version}-Setup-x64.exe`, `CustomSubtitles-${version}-Setup-x64.exe.partial`]) await unlink(path.join(directory, name)).catch(() => {});
    const remaining = await readdir(directory);
    if (remaining.length === 1 && remaining[0] === '.custom-subtitles-update') { await unlink(path.join(directory, '.custom-subtitles-update')); await rmdir(directory); }
  }
}
export async function startUpdateHelper(job) {
  const jobPath = path.join(job.directory, 'job.json');
  await copyFile(process.execPath, path.join(job.directory, 'node.exe'));
  await copyFile(path.join(job.installDirectory, 'src', 'update-helper.js'), path.join(job.directory, 'update-helper.mjs'));
  await writeFile(jobPath, JSON.stringify(job));
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(job.directory, 'node.exe'), [path.join(job.directory, 'update-helper.mjs'), jobPath], { cwd: job.directory, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let handedOff = false;
    const timer = setTimeout(() => fail(new Error('The update helper did not become ready.')), 15000);
    const fail = error => { if (handedOff) return; clearTimeout(timer); child.kill(); reject(error); };
    child.once('error', fail);
    child.once('exit', () => { if (!handedOff) fail(new Error('The update helper exited before installation.')); });
    child.on('message', message => {
      if (!message?.ready || message.pid !== child.pid || handedOff) return;
      child.send({ install: true }, error => {
        if (error) { fail(error); return; }
        handedOff = true; clearTimeout(timer); child.disconnect(); child.unref(); resolve();
      });
    });
  });
}
export async function runStartupUpdate(options) {
  const { root, currentVersion, env = process.env, platform = process.platform, arch = process.arch, execPath = process.execPath, fetchImpl = fetch, handoff = startUpdateHelper, log = console.log } = options;
  if (options.skip || env.AUTO_UPDATE === 'false' || platform !== 'win32' || arch !== 'x64' || !existsSync(path.join(root, '.installed')) || path.resolve(execPath).toLowerCase() !== path.join(path.resolve(root), 'runtime', 'node.exe').toLowerCase()) return { action: 'continue' };
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 7000);
  if (await portIsInUse(host, port)) { log('A server is already using the configured port. Skipping this update check.'); return { action: 'continue' }; }
  const cacheDirectory = options.cacheDirectory ?? (env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'CustomSubtitles', 'updates'));
  if (!cacheDirectory) { log('The application update directory is unavailable. Starting the current version.'); return { action: 'continue' }; }
  const lockPath = path.join(cacheDirectory, 'update.lock');
  let locked = false, handedOff = false;
  try {
    locked = await acquireLock(lockPath);
    if (!locked) { log('An automatic update is already in progress. Open Custom Subtitles again after it finishes.'); return { action: 'busy' }; }
    await cleanCache(cacheDirectory);
    log('Checking GitHub for application updates…');
    const update = await checkForUpdate(currentVersion, fetchImpl);
    if (!update) { log(`Custom Subtitles ${currentVersion} is up to date.`); return { action: 'continue' }; }
    log(`Downloading Custom Subtitles ${update.version}…`);
    const downloaded = await downloadUpdate(update, cacheDirectory, fetchImpl, log);
    const job = { ...downloaded, version: update.version, installDirectory: path.resolve(root), parentPid: process.pid, lockPath, host, port };
    await handoff(job); handedOff = true;
    log(`Installing Custom Subtitles ${update.version}. The application will reopen automatically.`);
    return { action: 'install', version: update.version };
  } catch (error) {
    log(`Automatic update unavailable: ${error.message} Starting the current version.`);
    return { action: 'continue' };
  } finally { if (locked && !handedOff) await releaseUpdateLock(lockPath).catch(() => {}); }
}
