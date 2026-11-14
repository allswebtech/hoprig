// `<app> service install|uninstall|status`: run the dashboard in the background, started with your login. One
// module per service manager: systemd (Linux), launchd (macOS), Task Scheduler (Windows).
import { service as launchd } from './launchd.mjs';
import { service as systemd } from './systemd.mjs';
import { service as windows } from './windows.mjs';

const MANAGERS = { linux: systemd, darwin: launchd, win32: windows };

export async function service(sub, platform = process.platform) {
  const manager = MANAGERS[platform];
  if (manager) return manager(sub);
  console.error(`Running the dashboard as a service is not supported on ${platform}. Start it with the "serve" command.`);
  return 1;
}
