// The box: a command run with no network, without the owner's home, seeing only the folders it is given (docs/BOX.md).
// What a session wrote is never run by the product outside it. The rule that holds everything else: when the box
// cannot be made, NOTHING runs. There is no fallback, no "run it anyway", and no variable or setting that switches it
// off: the only way to a command is through a yes of the self-test, made in this process and kept in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boxEnv } from './env.mjs';
import { gitGuards } from './gitguard.mjs';
import { meansCall } from './call.mjs';
import { runtimeOf, startFailure } from './linux.mjs';
import { findMeans } from './means.mjs';
import { runMeans } from './run.mjs';
import { selfTest } from './selftest.mjs';

const KEEP_MS = 10 * 60_000;
const OPTIONS = new Set(['cwd', 'write', 'read', 'env', 'timeoutMs', 'maxOut']);
export const DEFAULT_MAX_OUT = 1 << 20;

let kept = null; // { at, answer }: in this process only, never in a file or a variable a session could write

const no = (why, extra = {}) => ({ ok: false, code: null, signal: null, out: '', timedOut: false, why, ...extra });

/**
 * The real homes, resolved: the one of the password database and the one HOME names (os.homedir reads HOME). Neither
 * is inside, nor anything of them but the parents of a named folder.
 */
export function realHomes(real = fs.realpathSync) {
  const out = new Set();
  for (const h of [os.userInfo().homedir, os.homedir()]) {
    if (!h || !path.isAbsolute(h)) continue;
    out.add(path.resolve(h));
    try {
      out.add(real(h));
    } catch {
      /* a home that is not there is still refused by its name */
    }
  }
  return [...out];
}

/**
 * The folders of the system that are never a named folder: the kernel's own trees, and where a session's sockets
 * (an ssh agent, the desktop bus, tmux, a container service) and everyone's temporary files live. Naming one would
 * bring those back into the box, which keeps them out, and would let a command drive a server through a socket
 * file outside.
 */
export const SYSTEM_FOLDERS = ['/proc', '/sys', '/dev', '/run', '/var', '/var/run', '/var/tmp', '/etc', '/mnt', '/media'];

/** The system folders of THIS computer: the fixed list above, the temporary folders, and the per-session socket folders. */
export function systemFolders(real = fs.realpathSync) {
  const out = [...SYSTEM_FOLDERS, '/tmp'];
  try {
    out.push(path.resolve(os.tmpdir()));
  } catch {
    /* no temporary folder */
  }
  const uid = process.getuid?.();
  if (uid != null) out.push(`/run/user/${uid}`, `/tmp/tmux-${uid}`);
  // A named folder is judged by the place it resolves to: where the system reaches one of these through a link (macOS:
  // /etc, /var and /tmp are links to /private/...), that place is a system folder too.
  for (const s of [...out]) {
    try {
      out.push(real(s));
    } catch {
      /* not on this computer */
    }
  }
  return [...new Set(out)];
}

/**
 * Why folder `d` may not be inside the box ('' when it may): the whole disk, a real home or a folder holding one, or
 * a system folder or a folder holding one. A folder INSIDE a temporary or system folder (a test's own `mkdtemp`, a
 * project under the home) is allowed: only the folder itself and its parents are refused.
 */
export function refused(d, homes, system = systemFolders()) {
  if (d === '/') return 'the whole disk';
  const home = homes.find((h) => h === d || h.startsWith(d + '/'));
  if (home) return home === d ? 'a home' : 'a folder that holds a home';
  const sys = system.find((s) => s === d || s.startsWith(d + '/'));
  if (sys) return sys === d ? 'a system folder' : 'a folder that holds a system folder';
  return '';
}

/**
 * The way to folder `d`, walked as the kernel walks it: a link's own target is walked too, and ".." goes up from the
 * real folder reached so far. One of three answers:
 *   { link }     the first symbolic link on the way that a command in the box could have made;
 *   { missing }  the first part of the way that cannot be looked at (it is not there);
 *   { real }     the place the kernel reaches, with no link left in it.
 * A command runs as the user who starts the box, so a link that user owns (or anyone but root) may have been left by an
 * earlier run in a folder that was its write folder then: followed, it would hand an outside folder to a run that
 * names the link, so the caller names the real target instead (docs/BOX.md). A link of the system (root's, such as
 * /var on macOS) is followed. When the box runs as root, every link counts.
 */
export function walkFolder(d, { lstat = fs.lstatSync, readlink = fs.readlinkSync, uid = process.getuid?.() } = {}) {
  let hops = 0;
  const walk = (start, p) => {
    let cur = start;
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        cur = path.dirname(cur);
        continue;
      }
      const at = path.join(cur, part);
      let st;
      try {
        st = lstat(at);
      } catch {
        return { missing: at }; // a part that cannot be looked at is never passed over
      }
      if (!st.isSymbolicLink()) {
        cur = at;
        continue;
      }
      if (uid === 0 || st.uid !== 0 || ++hops > 40) return { link: at };
      const to = readlink(at);
      const r = walk(path.isAbsolute(to) ? '/' : cur, to);
      if (r.link || r.missing) return r;
      cur = r.cur;
    }
    return { cur };
  };
  const r = walk('/', d);
  return r.link ? { link: r.link } : r.missing ? { missing: r.missing } : { real: r.cur };
}

/** The first symbolic link on the way to `d` that a command in the box could have made, or '' (walkFolder). */
export const userLink = (d, deps) => walkFolder(d, deps).link || '';

/** The checked plan of one run, or { why } when an option is wrong or a folder is not there: nothing runs then. */
export function planRun(argv, opts = {}, { execPath = process.execPath, real = fs.realpathSync, stat = fs.statSync, lstat = fs.lstatSync, readlink = fs.readlinkSync, homes = realHomes(real), lang = process.env.LANG } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) return { why: 'the command must be a list of words' };
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return { why: 'the options must be an object' };
  const unknown = Object.keys(opts).filter((k) => !OPTIONS.has(k));
  if (unknown.length) return { why: `unknown option: ${unknown[0]}` };
  const { cwd, write = [], read = [], env = {}, timeoutMs, maxOut = DEFAULT_MAX_OUT } = opts;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return { why: 'timeoutMs must be a whole number of milliseconds above 0' };
  if (!Number.isInteger(maxOut) || maxOut <= 0) return { why: 'maxOut must be a whole number of bytes above 0' };
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((v) => typeof v !== 'string' || v.includes('\0'))) return { why: 'env must name strings' };
  const badName = Object.keys(env).find((k) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || k === 'HOME');
  if (badName !== undefined) return { why: `env: the name ${JSON.stringify(badName)} is not allowed (capitals, digits and _ only; never HOME)` };
  const system = systemFolders(real);
  const folders = (list, what) => {
    if (!Array.isArray(list)) return { why: `${what} must be a list of folders` };
    const out = [];
    for (const d of list) {
      if (typeof d !== 'string' || !path.isAbsolute(d) || d.includes('\0')) return { why: `${what}: not an absolute path: ${String(d)}` };
      let r;
      try {
        r = real(d);
        if (!stat(r).isDirectory()) return { why: `${what}: not a folder: ${d}` };
      } catch {
        return { why: `${what}: the folder is not there: ${d}` };
      }
      const no = refused(r, homes, system);
      if (no) return { why: `${what}: ${d} is ${no}` };
      out.push(r);
    }
    return { list: [...new Set(out)] };
  };
  const w = folders(write, 'write');
  if (w.why) return w;
  const r = folders(read, 'read');
  if (r.why) return r;
  for (const [list, what] of [[write, 'write'], [read, 'read']]) {
    for (const d of list) {
      const way = walkFolder(d, { lstat, readlink });
      if (way.link) return { why: `${what}: ${d} is reached through a link a command could have made (${way.link}); name the real folder` };
      // ONE place: the folder that gets bound (above, by its spelling) must be the folder this walk reached. A spelling
      // that reads to another place than it walks to (".." after a part that is not there, or after a link) is never
      // bound, so no way of writing a path passes the check and then leads the box somewhere else.
      if (way.missing || way.real !== real(d)) return { why: `${what}: ${d} does not name one place (a part of its way is not there, or ".." follows a link); name the real folder` };
    }
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { why: 'cwd must be an absolute path' };
  let where;
  try {
    where = real(cwd);
  } catch {
    return { why: `cwd: the folder is not there: ${cwd}` };
  }
  const within = (d) => where === d || where.startsWith(d.endsWith('/') ? d : d + '/');
  if (![...w.list, ...r.list].some(within)) return { why: 'cwd must be inside a write or read folder' };
  let runtime;
  try {
    runtime = runtimeOf(real(execPath));
  } catch {
    return { why: 'the folder of Node cannot be found' };
  }
  const noRuntime = refused(runtime, homes, system);
  if (noRuntime) return { why: `the folder of Node (${runtime}) is ${noRuntime}` };
  // A write folder that is, holds, or lies inside the runtime would make the owner's Node and its global packages
  // writable inside (a deeper --bind wins over the runtime's read-only one); Node changed inside then runs later
  // outside, where the box no longer holds it. It is refused as a home is.
  const holdsRuntime = w.list.find((d) => d === runtime || runtime.startsWith(d + '/'));
  if (holdsRuntime) return { why: `write: ${holdsRuntime} is the folder of Node or holds it` };
  const inRuntime = w.list.find((d) => d.startsWith(runtime + '/'));
  if (inRuntime) return { why: `write: ${inRuntime} lies inside the folder of Node (${runtime})` };
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const guard = gitGuards(w.list, [...w.list, ...r.list]);
  return { argv, cwd: where, write: w.list, read: r.list.filter((d) => !w.list.includes(d)), guard, env: boxEnv(runtime, env, lang), timeoutMs, maxOut, runtime, uid, gid };
}

/**
 * The inner check: the means, then the self-test inside the real box. `means` and `run` are the parts a test replaces
 * (as arguments, never through a variable or a file). → { ok, kind, why, step }
 */
export async function checkWith({ means = findMeans, run = runMeans, platform = process.platform } = {}) {
  let m;
  try {
    m = means(platform);
  } catch (e) {
    return { ok: false, kind: null, why: `the box's means could not be checked: ${e.message}`, step: '' };
  }
  if (!m.kind) return { ok: false, kind: null, why: m.why, step: m.step || '' };
  let trials;
  try {
    const t = await selfTest({ kind: m.kind, file: m.file, run, plan: planRun, homes: realHomes() });
    if (!t.ok) return { ok: false, kind: m.kind, why: t.why, step: t.step || '', trials: t.trials };
    trials = t.trials;
  } catch (e) {
    return { ok: false, kind: m.kind, why: `the self-test could not run: ${e.message}`, step: '' };
  }
  return { ok: true, kind: m.kind, why: '', step: '', file: m.file, trials };
}

/** Whether this computer has a box: the self-test's answer of this process, kept ten minutes; `fresh` runs it again. */
export async function boxCheck({ fresh = false } = {}) {
  if (!fresh && kept && Date.now() - kept.at < KEEP_MS) return kept.answer;
  // Frozen: the kept answer is shared by reference, so a holder of it (the missions' gate through its seam, a dashboard feature) must
  // not be able to change the yes or the means it names before a run reads them.
  const answer = Object.freeze(await checkWith());
  kept = { at: Date.now(), answer };
  return answer;
}

/**
 * The inner run: `check` must say yes, the plan must hold, the start must succeed. Any no: nothing runs.
 * → { ok, code, signal, out, timedOut, why, dropped }
 */
export async function runWith(argv, opts, { check = boxCheck, run = runMeans, plan = planRun } = {}) {
  // onStart (optional) is the caller's own note, not a plan option: it is stripped before the plan is checked, and the
  // runner calls it with the box's process group once it is started.
  const { onStart, ...rest } = opts || {};
  let box;
  try {
    box = await check();
  } catch (e) {
    return no(`no box on this computer: the check could not run: ${e.message}`);
  }
  if (!box || box.ok !== true) return no(`no box on this computer: ${box?.why || 'the check said no'}`, { step: box?.step || '' });
  const p = plan(argv, rest);
  if (p.why) return no(`nothing ran: ${p.why}`);
  const call = meansCall(box.kind, p);
  if (call.why) return no(`nothing ran: ${call.why}`);
  let r;
  try {
    r = await run(box.file, call.args, { timeoutMs: p.timeoutMs, maxOut: p.maxOut, data: call.data, statusFd: call.statusFd, env: call.env, cwd: call.cwd, onStart });
  } finally {
    call.cleanup();
  }
  if (!r.started && !r.timedOut) {
    const f = startFailure(r.failure || r.out);
    return no(`the box did not start: ${f.why}`, { step: f.step });
  }
  const ok = r.started && !r.timedOut && r.code === 0;
  return { ok, code: r.code, signal: r.signal, out: r.out, timedOut: r.timedOut, why: ok ? '' : r.timedOut ? 'the time ran out' : `the command ended with ${r.code}`, dropped: r.dropped || 0 };
}

/** Runs `argv` (a list of words, never a shell line) in the box. Nothing runs when there is no box. */
export function runBoxed(argv, opts = {}) {
  return runWith(argv, opts);
}
