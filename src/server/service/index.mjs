// `<app> service install|uninstall|status|start|stop|restart`: run the dashboard in the background, started with your login. One
// module per service manager: systemd (Linux), launchd (macOS), Task Scheduler (Windows).
import fs from 'node:fs';
import path from 'node:path';
import { clearStopped, markStopped } from '../../keeper/keep.mjs';
import { stateDir } from '../../paths.mjs';
import { files as launchdFiles, service as launchd, plistFile } from './launchd.mjs';
import { files as systemdFiles, service as systemd, UNIT, unitDir } from './systemd.mjs';
import { files as windowsFiles, service as windows, scriptFile } from './windows.mjs';

const MANAGERS = { linux: systemd, darwin: launchd, win32: windows };

/**
 * `opts` is passed on to the manager: systemd.mjs takes { env, lingerNote } and every manager takes { run } (a stand-in
 * for the service manager's own program in a test) and what windows.mjs needs to end the old dashboard.
 */
export async function service(sub, platform = process.platform, opts = {}) {
  const manager = MANAGERS[platform];
  // As root, a service is never made NEW for root unless root is on purpose (a container, or his choice): the real
  // server ended with root's own user service and lingering for root. One installed already keeps working (the doctor
  // offers the move). `opts.rootFacts` (rootfacts.mjs rootFacts) is handed in by set-up and by tests.
  if (sub === 'install' && manager) {
    const { freshRootRefusal, rootFacts } = await import('../../setup/rootfacts.mjs');
    const facts = opts.rootFacts || rootFacts({ platform, cfg: (await import('../../config.mjs')).loadConfig() });
    const no = freshRootRefusal(facts, serviceInstalled(platform, opts.env ? { env: opts.env } : {}));
    if (no) {
      console.error(no);
      return 1;
    }
  }
  if (manager) {
    const code = await manager(sub, opts);
    // The owner's own stop is remembered, so the keeper (src/keeper/keep.mjs) and the Windows script leave it stopped;
    // every start clears it.
    if (code === 0) {
      const state = opts.state || stateDir();
      if (sub === 'stop') markStopped(state);
      else if (['start', 'restart', 'install'].includes(sub)) clearStopped(state);
    }
    return code;
  }
  console.error(`Running the dashboard as a service is not supported on ${platform}. Start it with the "serve" command.`);
  return 1;
}

/** The service files `install` writes, as the product would write them now: [{ file, text }] (the keeper compares them). */
export function serviceFiles(platform = process.platform, opts = {}) {
  const make = { linux: systemdFiles, darwin: launchdFiles, win32: windowsFiles }[platform];
  return make ? make(opts) : [];
}

/**
 * Whether the dashboard is installed as a background service on this system, by the file its install writes and its
 * uninstall removes: the systemd unit, the launchd plist, or the Windows startup script. Used to offer a restart from
 * the dashboard's own page (updater.restart): a plain `serve` in a terminal is restarted by the person, not a button.
 */
export function serviceInstalled(platform = process.platform, { existsSync = fs.existsSync, env } = {}) {
  try {
    if (platform === 'linux') return existsSync(path.join(unitDir(env), UNIT));
    if (platform === 'darwin') return existsSync(plistFile());
    if (platform === 'win32') return existsSync(scriptFile());
  } catch {
    /* a path that cannot be built: treat as not installed */
  }
  return false;
}
