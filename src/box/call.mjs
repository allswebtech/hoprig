// How the means is started for a checked plan, per kind: bwrap on Linux, sandbox-exec on macOS. box.mjs and the
// self-test both start the box through here, so the self-test tries the very box a command gets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bwrapArgs } from './linux.mjs';
import { macProfile } from './mac.mjs';

/**
 * The start of the means `kind` for `plan`. → { args, data, statusFd, env, cwd, cleanup } or { why } (nothing runs).
 * `cleanup` removes what the start made (the box's home and temporary folder on macOS).
 */
export function meansCall(kind, plan) {
  if (kind === 'bwrap') {
    const { args, data } = bwrapArgs(plan);
    return { args, data, statusFd: true, env: {}, cwd: '/', cleanup: () => {} };
  }
  if (kind === 'sandbox-exec') {
    // macOS has no memory folder of the box's own: a real temporary home and /tmp, removed when the box ends.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-box-')));
    const home = path.join(base, 'home');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(home);
    fs.mkdirSync(tmp);
    const cleanup = () => fs.rmSync(base, { recursive: true, force: true });
    const p = macProfile(plan, { home, tmp });
    if (p.why) {
      cleanup();
      return { why: p.why };
    }
    // sandbox-exec applies the profile and only then starts the command: when it cannot, nothing runs.
    return { args: ['-p', p.text, '--', ...plan.argv], data: [], statusFd: false, env: { ...plan.env, HOME: home, TMPDIR: tmp }, cwd: plan.cwd, cleanup };
  }
  return { why: `no box of kind ${kind}` };
}
