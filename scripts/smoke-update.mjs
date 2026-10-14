import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { RELEASE_API, runStartupUpdate } from '../src/updates.js';

const root = path.resolve(process.argv[2] || '');
const installer = path.resolve(process.argv[3] || '');
if (!process.env.RUNNER_TEMP || !root.startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep) || !existsSync(path.join(root, '.installed'))) throw new Error('Run the automatic-update smoke test only on an isolated GitHub Actions installation.');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const filename = `CustomSubtitles-${version}-Setup-x64.exe`;
if (path.basename(installer) !== filename) throw new Error('The smoke-test installer version is incorrect.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const sha256 = hash.digest('hex'), size = (await stat(installer)).size;
const downloadRoot = `https://github.com/sigin7/customSubtitles/releases/download/v${version}/`;
const fetchImpl = async url => {
  if (url === RELEASE_API) return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [
    { name: filename, state: 'uploaded', size, digest: `sha256:${sha256}`, browser_download_url: downloadRoot + filename },
    { name: 'SHA256SUMS.txt', state: 'uploaded', browser_download_url: downloadRoot + 'SHA256SUMS.txt' },
  ] });
  if (url === downloadRoot + 'SHA256SUMS.txt') return new Response(`${sha256}  ${filename}\n`);
  if (url === downloadRoot + filename) return new Response(Readable.toWeb(createReadStream(installer)));
  throw new Error('The updater smoke test requested an unexpected address.');
};
const result = await runStartupUpdate({ root, currentVersion: '0.0.0', env: { ...process.env, AUTO_UPDATE: 'true' }, cacheDirectory: path.join(process.env.RUNNER_TEMP, 'CustomSubtitles-UpdateSmoke'), fetchImpl });
if (result.action !== 'install') throw new Error('The automatic update was not handed to its helper.');
process.exit(0);
