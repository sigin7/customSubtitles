import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
function portBusy(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = createConnection({ host: host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(600); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`The update command failed with exit code ${code}.`)));
  });
}
async function reopenApplication(root) {
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `Start-Process -FilePath ${literal(path.join(root, 'runtime', 'node.exe'))} -ArgumentList @('--env-file-if-exists=.env','src/launcher.js','--skip-update-once') -WorkingDirectory ${literal(root)} -WindowStyle Normal -ErrorAction Stop`;
  await execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command]);
}

let job, approved = false, validated = false;
const permission = new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), 20000);
  process.once('message', message => { clearTimeout(timer); resolve(message?.install === true); });
  process.once('disconnect', () => { if (!approved) { clearTimeout(timer); resolve(false); } });
});
try {
  if (process.platform !== 'win32' || !process.send) throw new Error('The update helper requires a Windows launcher.');
  const jobPath = path.resolve(process.argv[2] || '');
  job = JSON.parse(await readFile(jobPath, 'utf8'));
  const directory = path.dirname(jobPath);
  if (job.directory !== directory || !/^\d+\.\d+\.\d+$/.test(job.version) || !/^[a-f0-9]{64}$/.test(job.sha256) || job.installerPath !== path.join(directory, `CustomSubtitles-${job.version}-Setup-x64.exe`) || job.lockPath !== path.join(path.dirname(directory), 'update.lock') || !Number.isSafeInteger(job.parentPid) || job.parentPid < 1 || job.parentPid === process.pid || !path.isAbsolute(job.installDirectory) || !existsSync(path.join(job.installDirectory, '.installed'))) throw new Error('Invalid automatic update job.');
  validated = true;
  const owner = JSON.parse(await readFile(job.lockPath, 'utf8'));
  if (owner.pid !== job.parentPid || !alive(job.parentPid)) throw new Error('The update launcher is no longer available.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(job.installerPath)) hash.update(chunk);
  if (hash.digest('hex') !== job.sha256) throw new Error('The installer checksum changed before installation.');
  await writeFile(job.lockPath, JSON.stringify({ pid: process.pid, version: job.version }));
  process.send({ ready: true, pid: process.pid });
  approved = await permission;
  if (!approved) throw new Error('The update launcher did not approve installation.');
  for (let attempt = 0; alive(job.parentPid); attempt++) {
    if (attempt >= 60) throw new Error('The previous launcher did not exit.');
    await delay(250);
  }
  if (await portBusy(job.host, job.port)) throw new Error('Another server started before the update could be installed.');
  await execute(job.installerPath, ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/RESTARTEXITCODE=3010', '/NOCLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', '/MERGETASKS=!tailscale', `/DIR=${job.installDirectory}`, `/LOG=${path.join(job.directory, 'installer.log')}`], { cwd: job.directory });
  const installed = JSON.parse(await readFile(path.join(job.installDirectory, 'package.json'), 'utf8'));
  if (installed.version !== job.version) throw new Error('The installed version did not match the downloaded release.');
  await writeFile(path.join(path.dirname(job.directory), 'last-update.json'), JSON.stringify({ success: true, version: job.version, checkedAt: new Date().toISOString() }));
} catch (error) {
  if (validated) await writeFile(path.join(path.dirname(job.directory), 'last-update.json'), JSON.stringify({ success: false, version: job.version, error: error.message, checkedAt: new Date().toISOString() })).catch(() => {});
} finally {
  if (validated) {
    const owner = await readFile(job.lockPath, 'utf8').then(JSON.parse).catch(() => ({}));
    if (owner.pid === process.pid) await unlink(job.lockPath).catch(() => {});
  }
  if (approved && job?.installDirectory && !await portBusy(job.host, job.port)) await reopenApplication(job.installDirectory).catch(async error => {
    await writeFile(path.join(path.dirname(job.directory), 'last-update.json'), JSON.stringify({ success: false, error: `Open Custom Subtitles manually: ${error.message}`, checkedAt: new Date().toISOString() })).catch(() => {});
  });
  process.exit();
}
