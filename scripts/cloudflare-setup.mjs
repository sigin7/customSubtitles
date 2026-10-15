import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../cloudflare/', import.meta.url));
const cli = path.join(directory, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const configPath = path.join(directory, 'wrangler.local.json');
const secretPath = path.join(directory, '.cloudflare-secrets.local.json');
const action = process.argv[2];
if (!['prepare', 'provision', 'deploy'].includes(action)) throw new Error('Usage: node scripts/cloudflare-setup.mjs prepare|provision|deploy');
if (!existsSync(cli)) throw new Error('Install deployment tools first: cd cloudflare && npm install');
function command(args, capture = false) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (result.status !== 0) throw new Error('The Cloudflare command failed. Fix the reported error and run this step again.');
  return result.stdout;
}
if (!existsSync(configPath)) {
  const config = JSON.parse(readFileSync(path.join(directory, 'wrangler.jsonc'), 'utf8'));
  config.d1_databases = []; config.kv_namespaces = [];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
if (!existsSync(secretPath)) writeFileSync(secretPath, JSON.stringify({ ADMIN_PASSWORD: randomBytes(24).toString('base64url'), SESSION_SECRET: randomBytes(32).toString('hex'), ADDON_KEY: randomBytes(24).toString('hex') }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Private configuration and generated credentials are saved locally and excluded from Git.');
console.log('Credentials file: ' + secretPath);
if (action === 'prepare') process.exit(0);
const identity = JSON.parse(command(['whoami', '--json'], true));
if (!identity.loggedIn) throw new Error('Sign in first: cd cloudflare && npx wrangler login');
let config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!config.account_id) {
  const accounts = identity.accounts || [];
  if (accounts.length !== 1) throw new Error('Set account_id in cloudflare/wrangler.local.json to the intended Cloudflare account before continuing.');
  config.account_id = accounts[0].id;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
const flags = ['--config', configPath];
if (action === 'provision') {
  if (!config.d1_databases.some(binding => binding.binding === 'DB')) command(['d1', 'create', 'custom-subtitles', '--binding', 'DB', '--update-config', '--location', 'weur', ...flags]);
  config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.kv_namespaces.some(binding => binding.binding === 'FILES')) command(['kv', 'namespace', 'create', 'custom-subtitles-files', '--binding', 'FILES', '--update-config', ...flags]);
  command(['d1', 'execute', 'DB', '--remote', '--file', 'schema.sql', '--yes', ...flags]);
  console.log('Cloud storage is ready. Keep the account on the Workers Free plan.');
} else {
  if (!config.d1_databases.some(binding => binding.binding === 'DB') || !config.kv_namespaces.some(binding => binding.binding === 'FILES')) throw new Error('Provision storage before deployment.');
  command(['secret', 'bulk', secretPath, ...flags]);
  command(['deploy', ...flags]);
  console.log('Open the workers.dev address printed above. Sign in using ADMIN_PASSWORD from the local credentials file.');
}
