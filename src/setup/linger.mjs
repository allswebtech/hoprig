// Lingering: without it systemd stops a user's services when the last session of that user ends, so a dashboard on a
// server died with the ssh session. Set-up turns it on as one of the sudo steps it lists ("Will run") and runs under
// the same yes (pcsetup/setup.mjs runPcSetup's `extraSteps`), and says afterwards what came of it.
import os from 'node:os';
import { capture, showCommand, stream } from './system.mjs';
import { yours } from './ui.mjs';

const userOf = (sys) => {
  if (sys.user) return sys.user;
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
};

/** 'yes' | 'no' | null (no loginctl, or it could not say). */
export async function lingerState(sys) {
  const user = userOf(sys);
  if (sys.platform !== 'linux' || !user || !sys.has('loginctl')) return null;
  const r = await capture(['loginctl', 'show-user', user, '-p', 'Linger'], { env: sys.env, timeout: 5000 });
  const m = /Linger=(yes|no)/.exec(r.stdout || '');
  // A user with no session yet is not known to logind: lingering is off then.
  return m ? m[1] : /not logged in|No such|not known/i.test(`${r.stderr}`) ? 'no' : null;
}

/** The command that turns it on, as this user can run it (root: without sudo). */
export const lingerArgv = (sys) => [...(sys.root ? [] : ['sudo']), 'loginctl', 'enable-linger', userOf(sys) || '<you>'];

/**
 * The step to add to the "Will run" list, or why there is none: { step } | { manual: command line } | {} (not needed).
 * `step` has the shape of a plan step (kits.mjs): { argv, admin, kit: null, items, why }.
 */
export async function lingerPlan(sys) {
  if ((await lingerState(sys)) !== 'no') return {};
  const argv = lingerArgv(sys);
  if (!sys.root && !sys.has('sudo')) return { manual: `as root: ${showCommand(argv.slice(1))}` };
  return { step: { argv, admin: !sys.root, kit: null, items: ['linger'], why: 'keep the dashboard running after you log out' } };
}

/** Run the step on its own (set-up without the computer step: --only base, a hub), after the same kind of question. */
export async function runLingerAlone(ui, sys, step) {
  ui.out(`\n  Will run${step.admin ? '  (sudo asks for your password itself; Hoprig never sees it)' : ''}`);
  ui.out(`    ${showCommand(step.argv)}`);
  if (!(await ui.confirm('Run it now?', true))) return false;
  return (await stream(step.argv, { env: sys.env, interactive: ui.interactive })).ok;
}

/** The line after it ran (or did not): what is true now. Returns true when lingering is on. */
export async function lingerOutcome(ui, sys, { manual = null } = {}) {
  const now = await lingerState(sys);
  if (now === 'yes') {
    ui.line('ok', 'The dashboard keeps running after you log out (lingering is on)');
    return true;
  }
  const cmd = manual || showCommand(lingerArgv(sys));
  // Inside set-up: the mark now, the command in its closing list.
  yours(ui, 'warn', 'The dashboard stops when you log out: lingering is off', 'linger', { step: cmd, alone: `The dashboard stops when you log out: lingering is off. Turn it on once: ${cmd}` });
  return false;
}
