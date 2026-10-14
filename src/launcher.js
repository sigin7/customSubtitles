import { spawn } from 'node:child_process';
import { createApplication } from './server.js';

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open the web interface: ${url}`)); child.unref();
}

let app;
try {
  app = createApplication();
  const { localUrl } = await app.start();
  if (process.env.OPEN_BROWSER !== 'false') openBrowser(localUrl);
  console.log('The server and web interface are running. Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? 'The port is in use. Stop the other server or change PORT in .env.' : error.message);
  app?.library.close(); process.exitCode = 1;
}
