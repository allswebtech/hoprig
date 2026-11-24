// A restart the dashboard asks for itself (an update on its own Updates page, which a person with no terminal must be
// able to finish): the dashboard cannot run `service restart` in its own process, because that would end the very
// process doing the restart before the new one starts (takeover.mjs refuses it from inside the dashboard's own
// terminal for the same reason). So the restart is handed to a DETACHED helper that outlives the dashboard: it waits
// until this dashboard has exited, then runs `<app> service restart`. By then the helper is no longer inside the
// dashboard's process tree and the dashboard's record is gone (removed on a clean exit, or its pid dead after an
// unconditional stop on Windows), so that restart is not refused and ends nothing of this dashboard — the service
// manager starts it fresh. Nothing here reaches a real program in a test: spawn and the service run are injected.
import { spawn } from 'node:child_process';
import { binFile } from '../paths.mjs';
import { service } from './service/index.mjs';

/** Spawn the detached helper (`<app> __service-restart <pid>`); returns its pid. It outlives this process (unref). */
export function spawnServiceRestart({ node = process.execPath, bin = binFile(), pid = process.pid, spawnImpl = spawn, env = process.env } = {}) {
  const child = spawnImpl(node, [bin, '__service-restart', String(pid)], { detached: true, stdio: 'ignore', windowsHide: true, env });
  if (child && typeof child.unref === 'function') child.unref();
  return child ? child.pid : null;
}

const defaultAlive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // it exists, owned by another user (not our case, but not "gone")
  }
};
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The helper's work: wait until `pid` (the dashboard that asked for the restart) is gone, up to `tries` × the sleep,
 * then `service('restart')`. Returns that command's exit code. `alive`, `sleep` and `runService` are injected in tests.
 */
export async function restartAfterExit(pid, { alive = defaultAlive, sleep = defaultSleep, runService = service, tries = 300 } = {}) {
  const p = Number(pid);
  if (Number.isInteger(p) && p > 0) {
    for (let i = 0; i < tries && alive(p); i++) await sleep(100);
  }
  return runService('restart');
}
