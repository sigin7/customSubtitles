import { spawn } from 'node:child_process';
import { createApplication } from './server.js';

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Otvor webové rozhranie: ${url}`)); child.unref();
}

let app;
try {
  app = createApplication();
  const { localUrl } = await app.start();
  if (process.env.OPEN_BROWSER !== 'false') openBrowser(localUrl);
  console.log('Server aj web sú spustené. Ukončenie: Ctrl+C.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? 'Port je obsadený. Zastav druhý server alebo zmeň PORT v .env.' : error.message);
  app?.library.close(); process.exitCode = 1;
}
