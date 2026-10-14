import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from './subtitles.js';

const execute = promisify(execFile);
export const tailscaleExecutable = () => process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
const run = args => execute(tailscaleExecutable(), args, { timeout: 12000, windowsHide: true, maxBuffer: 1024 * 1024 });

export function validateFunnelConfiguration(configuration, dnsName, httpsPort, gatewayPort) {
  const existing = configuration.Web?.[`${dnsName}:${httpsPort}`];
  const expectedProxy = `http://127.0.0.1:${gatewayPort}`;
  if (existing && (Object.keys(existing.Handlers ?? {}).length !== 1 || existing.Handlers?.['/']?.Proxy !== expectedProxy)) throw new HttpError(409, `HTTPS port ${httpsPort} already serves another application. Existing routes were preserved.`);
  if (configuration.TCP?.[httpsPort] && !existing) throw new HttpError(409, `HTTPS port ${httpsPort} is already in use. Existing routes were preserved.`);
}

export async function getNetworkState(httpsPort = 8443, gatewayPort = 7001) {
  try {
    const { stdout } = await run(['status', '--json']);
    const status = JSON.parse(stdout);
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '') ?? '';
    let publicEnabled = false;
    if (dnsName) {
      const { stdout: configText } = await run(['serve', 'status', '--json']);
      const configuration = JSON.parse(configText);
      publicEnabled = !!configuration.AllowFunnel?.[`${dnsName}:${httpsPort}`] && configuration.Web?.[`${dnsName}:${httpsPort}`]?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${gatewayPort}`;
    }
    return { available: true, running: status.BackendState === 'Running', suggestedUrl: dnsName ? `https://${dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}` : '', publicEnabled };
  } catch { return { available: false, running: false, suggestedUrl: '', publicEnabled: false }; }
}

export async function enablePublicAccess(httpsPort, gatewayPort) {
  const { stdout } = await run(['status', '--json']).catch(() => { throw new HttpError(503, 'Install Tailscale on the server and sign in first.'); });
  const status = JSON.parse(stdout);
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '') ?? '';
  if (status.BackendState !== 'Running' || !/^[a-z0-9.-]+\.ts\.net$/i.test(dnsName)) throw new HttpError(503, 'Sign in to Tailscale on the server first.');
  const { stdout: configurationText } = await run(['serve', 'status', '--json']);
  validateFunnelConfiguration(JSON.parse(configurationText), dnsName, httpsPort, gatewayPort);
  try {
    await run(['funnel', '--bg', '--yes', `--https=${httpsPort}`, `http://127.0.0.1:${gatewayPort}`]);
  } catch (error) {
    const approvalUrl = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.match(/https:\/\/login\.tailscale\.com\/f\/[^\s]+/)?.[0];
    const message = approvalUrl ? `Enable Funnel in your Tailscale account: ${approvalUrl} . Then click Enable public access again.` : 'Tailscale Funnel could not start. Check your Tailscale account permissions and try again.';
    throw new HttpError(503, message);
  }
  const state = await getNetworkState(httpsPort, gatewayPort);
  if (!state.publicEnabled) throw new HttpError(503, 'Tailscale has not confirmed public access yet. Try again shortly.');
  return state;
}
