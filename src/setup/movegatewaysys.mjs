// The real system calls of the gateway step of the move (movegateway.mjs), as root: the listener of a port read from
// `ss -ltnpH` and its process's user id from /proc, a stop by that pid only, the data folder copied with its owner set to
// the user, a start as the user (runuser, asuser.mjs) and, to go back, a start as root with root's own Hoprig.
import fs from 'node:fs';
import path from 'node:path';
import { binFile } from '../paths.mjs';
import { capture } from './system.mjs';
import { runAsUser } from './asuser.mjs';
import { listenerPid, ordinaryUser, procStatus, procUid } from './moveswitch.mjs';
import { moved } from './movecopy.mjs';
import { plainDirs } from './movesafe.mjs';

/** The Node and script a user's `~/.local/bin/hoprig` wrapper starts (localbin.mjs wrapperText), or nulls. */
export function wrapperTarget(text) {
  const m = /^exec '((?:[^']|'\\'')+)' '((?:[^']|'\\'')+)' "\$@"$/m.exec(String(text || ''));
  const un = (s) => s.replace(/'\\''/g, "'");
  return m ? { node: un(m[1]), bin: un(m[2]) } : { node: null, bin: null };
}

/** Entries under `p`, `p` itself counted; links not followed. */
function count(p) {
  let n = 1;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) n += count(path.join(p, name));
  return n;
}

/** The gateway step's system calls for `plan`'s user. The lowest calls (`run`, `has`, `chown`, `readProc`, `kill`) are handed in by tests. */
export function realGatewaySys(plan, { run = capture, has, chown = fs.lchownSync, readProc = procStatus, kill = (pid, sig) => process.kill(pid, sig) } = {}) {
  const user = ordinaryUser(plan.user);
  return {
    listener: async (port) => {
      const r = await run(['ss', '-ltnpH'], { timeout: 5000 });
      const pid = listenerPid(r.stdout, port);
      if (!pid) return null;
      const line = String(r.stdout).split('\n').find((l) => l.includes(`pid=${pid},`)) || '';
      let uid = null;
      try {
        uid = procUid(readProc(pid));
      } catch {
        /* gone meanwhile */
      }
      return { pid, uid, addr: line.trim().split(/\s+/)[3] || '' };
    },
    stop: async (pid) => {
      try {
        kill(pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    },
    copyData: async (from, to) => {
      try {
        const give = (p) => chown(p, user.uid, user.gid ?? user.uid);
        // The user's dashboard runs by now: a folder above `to` may have been made a link by a process of the user's.
        // Every one from the home down is a plain folder (a missing one made as 700 and given to the user), or nothing
        // is copied (movesafe.mjs; a swap between this look and the copy is not covered, as said there).
        plainDirs(user.home, path.dirname(to), { make: true, own: give });
        let there = true;
        try {
          fs.lstatSync(to); // a link counts as there, also one that points nowhere
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          there = false;
        }
        if (there) return { ok: false, error: `${to} is already there`, entries: [0, 0] };
        fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true });
        const own = (p) => {
          give(p);
          if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) own(path.join(p, n));
        };
        own(to);
        return { ok: true, entries: [count(from), count(to)] };
      } catch (e) {
        return { ok: false, error: e.message, entries: [0, 0] };
      }
    },
    startAsUser: (id) => runAsUser(user, ['hoprig', 'addons', 'start', id], { run, ...(has && { has }), timeout: 60_000 }),
    startAsRoot: (id) => run([process.execPath, binFile(), 'addons', 'start', id], { timeout: 60_000 }),
    userHoprig: async () => {
      try {
        return wrapperTarget(fs.readFileSync(path.posix.join(user.home, '.local/bin/hoprig'), 'utf8'));
      } catch {
        return { node: null, bin: path.posix.join(user.home, '.local/bin/hoprig') };
      }
    },
    profilesDir: path.join(moved(plan.dirs.config, plan.oldHome, user.home), 'profiles'),
    own: (p) => chown(p, user.uid, user.gid ?? user.uid),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
