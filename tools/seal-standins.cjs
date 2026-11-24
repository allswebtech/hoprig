'use strict';
// Stand-ins for df, ps and ss, first on every test's PATH after the traps (tools/test.mjs). The dashboard's look, the
// Operator and the session tools start these read-only programs on every tick; with the computer's own a test read
// this computer's disks, its whole process table and its listening ports, and the Operator's look in a test could
// name another run's tmux server. Each stand-in answers in the real program's shape:
//  - df: one made-up disk with room (`/dev/seal-made-up` on `/`), in bytes for `-B1` (the Linux form) and in
//    1024-byte blocks for `-k` and by default (the macOS form `-P -k -l`);
//  - ss: the test file's own listeners only (the computer's ss asked as the caller asked, with -p added where the caller
//    left it out, and every line that does not name a process of the test's own tree, `users:(("…",pid=N`, left out;
//    the process field is then taken out again where the caller did not ask it), exit 0. Without root ss names only
//    the user's own processes, and a listener of another run or of the person's own is never shown. With no ss on
//    the computer: no listener;
//  - ps: the test file's own processes only. The tree is rooted at the test file's process (HOPRIG_TEST_PID, which
//    the wrap carries to every child) and holds its descendants and every process whose environment carries the test
//    file's mark (HOPRIG_TEST_MARK; a tmux server the test started puts itself in the background). The selection the
//    caller asked (-e, -A, -ax, aux, -C sleep, -u 1000, --ppid 1, -p, or none) is put to the computer's ps for pids
//    only, so it picks as the real program does, and only the pids of that tree among them are kept; then the columns
//    and the format asked (-o, -f, BSD u, --sort, --no-headers, -w: an allow list, psArgs) are asked of the computer's
//    ps for those pids alone (`-p`), so every column comes in the real shape and nothing widens the answer. When none of
//    the pids picked is the test's own, it prints nothing and exits 1, as the real ps does when nothing is selected; a
//    selection the real ps refuses (an unknown user) gets its own message and exit code.
// A test that needs the real one for what it proves sets HOPRIG_SEAL_REAL (a list: df, ps, ss, proc) with a line
// `// seal: <why>`; the stand-in then hands the call to the next program of that name on PATH. test/seal-rule.mjs
// lists those tests. Run as a program: node tools/seal-standins.cjs <the stand-ins' folder> <df|ps|ss> <arguments>.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ownTree, realAsked, STAND_INS } = require('./seal-core.cjs');

const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Writes the three stand-ins into `dir` (POSIX only). */
function writeStandIns(dir, { node = process.execPath } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of STAND_INS) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec ${sh(node)} ${sh(__filename)} ${sh(dir)} ${name} "$@"\n`, { mode: 0o755 });
  return dir;
}

/** The next program `name` on PATH after the folder `dir`, or null. */
function nextOnPath(name, dir) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  const at = dirs.findIndex((d) => d && path.resolve(d) === path.resolve(dir));
  for (const d of dirs.slice(at + 1)) {
    if (!d || path.resolve(d) === path.resolve(dir) || d === process.env.HOPRIG_TEST_TRAPS) continue;
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
  }
  return null;
}

/** The made-up disk: 100 GiB, 10 GiB used. */
const DISK = { fs: '/dev/seal-made-up', size: 100 * 2 ** 30, used: 10 * 2 ** 30, mount: '/' };

function df(args) {
  const unit = args.includes('-B1') ? 1 : 1024;
  const n = (b) => String(Math.round(b / unit));
  process.stdout.write(`Filesystem ${unit === 1 ? '1-blocks' : '1024-blocks'} Used Available Capacity Mounted on\n${DISK.fs} ${n(DISK.size)} ${n(DISK.used)} ${n(DISK.size - DISK.used)} 10% ${DISK.mount}\n`);
  return 0;
}

/**
 * `args` of a ps call split into what is KEPT (the columns and the format asked: -o / -O / --format, BSD o / O, a format
 * letter such as -f or the BSD u, and --sort, --no-headers, -w), the SELECTION asked (a selection word: -e, -A, BSD a
 * and x, --deselect; a selection with its value: -u 1000, --ppid 1, -C node, -t pts/1, BSD U alex; the pids asked:
 * -p, -q, --pid, BSD p, a bare list of pids). Columns are an allow list: what is neither kept nor a selection (a
 * stray word, a long option this does not know) is dropped. The selection is put to the computer's ps for pids only
 * and then narrowed to the test's own tree (ps below).
 */
// Letters that only shape the answer: UNIX (-f -F -l -j -y -c -H -L -w, and the output modifiers -Z -M) and BSD
// (u v j l s X w, and Z). A modifier sent to the selection pass beside its `-o pid=` would be refused by procps.
const UNIX_FORMAT = new Set(['f', 'F', 'l', 'j', 'y', 'c', 'H', 'L', 'w', 'Z', 'M']);
const BSD_FORMAT = new Set(['u', 'v', 'j', 'l', 's', 'X', 'w', 'Z']);
// Selections that take a value, which is dropped with them: UNIX -u -U -g -G -t -C -s, BSD U and t, and the long forms.
const UNIX_SELECT_VALUE = new Set(['u', 'U', 'g', 'G', 't', 'C', 's']);
const BSD_SELECT_VALUE = new Set(['U', 't']);
const LONG_SELECT_VALUE = new Set(['ppid', 'user', 'User', 'group', 'Group', 'sid', 'tty', 'pid', 'quick-pid']);
const LONG_KEEP_VALUE = new Set(['format', 'sort', 'cols', 'columns', 'width']);
const LONG_KEEP = new Set(['no-headers', 'no-heading', 'headers', 'forest']);

// Whether a user of that name is on this computer (`-aux`: procps reads it as `-a -u x` only when a user x exists).
const userOnComputer = (name) => spawnSync('id', ['-u', name], { stdio: 'ignore' }).status === 0;

function psArgs(args, { userExists = userOnComputer } = {}) {
  const keep = [];
  const select = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (/^\d+(,\d+)*$/.test(a)) { select.push('-p', a); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      const value = () => (eq >= 0 ? a.slice(eq + 1) : String(args[++i] ?? ''));
      if (name === 'pid' || name === 'quick-pid') select.push(`--${name}=${value()}`);
      else if (name === 'format') keep.push('-o', value());
      else if (LONG_KEEP_VALUE.has(name)) keep.push(`--${name}`, value());
      else if (LONG_KEEP.has(name)) keep.push(a);
      else if (LONG_SELECT_VALUE.has(name)) select.push(`--${name}=${value()}`);
      else if (name === 'deselect') select.push(a);
      continue; // every option this does not know: dropped
    }
    // A cluster of letters: UNIX after a dash (-ef, -eo), BSD without one (aux, ax). A letter that takes a value takes
    // the rest of the cluster, else the next argument, and ends the cluster.
    // `-aux` and the like: a dash cluster whose -u takes the rest of it as a user name that is not there is read as the
    // BSD cluster without the dash, as procps reads it.
    const um = /^-([A-Za-z]*)u([A-Za-z]+)$/.exec(a);
    if (um && /^[a-zA-Z]+$/.test(a.slice(1)) && !userExists(um[2])) { args = [...args.slice(0, i), a.slice(1), ...args.slice(i + 1)]; i--; continue; }
    const bsd = !a.startsWith('-');
    if (!(bsd ? /^[A-Za-z]+(\d[\d,]*)?$/ : /^-[A-Za-z]/).test(a)) continue; // a stray word (a column list without its -o): dropped
    let words = ''; // the selection letters of this cluster, without a value: e, A, a, x, N, d, r, T …
    for (let j = bsd ? 0 : 1; j < a.length; j++) {
      const c = a[j];
      const value = () => (j + 1 < a.length ? a.slice(j + 1) : String(args[++i] ?? ''));
      if (c === 'o' || c === 'O') { keep.push(`-${c}`, value()); break; }
      if (c === 'p' || (!bsd && c === 'q')) { select.push(`-${c}`, value()); break; }
      if (!bsd && c === 'k') { keep.push('--sort', value()); break; }
      if ((bsd ? BSD_SELECT_VALUE : UNIX_SELECT_VALUE).has(c)) { select.push(bsd ? c : `-${c}`, value()); break; }
      if (bsd ? BSD_FORMAT.has(c) : UNIX_FORMAT.has(c)) keep.push(bsd ? c : `-${c}`);
      else words += c; // a selection word, or a letter this does not know: the computer's ps judges it
    }
    if (words) select.push(bsd ? words : `-${words}`);
  }
  return { keep, select };
}

/**
 * The test's own tree from two answers of the computer's ps (macOS and the BSDs, which have no /proc): `parents`
 * (`-axo pid=,ppid=`) and `envs` (`-axE -o pid=,command=`, the command and then the environment, for the user's own
 * processes). It holds `root` and its descendants, and every process whose environment carries the word
 * HOPRIG_TEST_MARK=<mark> (a tmux server the test started puts itself in the background: its parent is then launchd)
 * with its descendants. The word must match whole, so a server of an earlier test file of the same pid is left out.
 */
function treeFromPs(root, mark, parents, envs) {
  const kids = new Map();
  const known = new Set();
  for (const l of String(parents || '').split('\n')) {
    const [p, pp] = l.trim().split(/\s+/).map(Number);
    if (!p) continue;
    known.add(p);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const marked = [];
  if (mark) {
    const word = `HOPRIG_TEST_MARK=${mark}`;
    for (const l of String(envs || '').split('\n')) {
      const w = l.trim().split(/\s+/);
      if (Number(w[0]) && w.slice(1).includes(word)) marked.push(Number(w[0]));
    }
  }
  const out = new Set();
  const todo = [Number(root), ...marked].filter((p) => known.has(p));
  while (todo.length) { const p = todo.pop(); if (out.has(p)) continue; out.add(p); todo.push(...(kids.get(p) || [])); }
  return out;
}

/** The test's own tree: from /proc on Linux, else from the computer's ps (treeFromPs). */
function tree(root, real) {
  if (process.platform === 'linux') return ownTree(root);
  const mark = process.env.HOPRIG_TEST_MARK;
  const parents = spawnSync(real, ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout;
  const envs = mark ? spawnSync(real, ['-axE', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout : '';
  return treeFromPs(root, mark, parents, envs);
}

/** Whether an ss call asked for the process field (-p in a cluster of short options, or --processes). */
const ssAsksProcesses = (args) => args.some((a) => a === '--processes' || /^-[A-Za-z0-9]*p[A-Za-z0-9]*$/.test(String(a)));
/** The process field of an ss line, `users:(("node",pid=1,fd=21),…)`, with the space before it. */
const USERS = /\s?users:\((?:\([^()]*\),?)*\)/g;

function ss(args, real) {
  if (!real) return 0;
  // Which process a line belongs to is only in its process field. A caller that did not ask for it (the web-server
  // check asks `ss -ltnH`) gets the same lines in the shape it asked: ss is asked with -p, and the field is taken out.
  const asked = ssAsksProcesses(args);
  const r = spawnSync(real, asked ? args : ['-p', ...args], { encoding: 'utf8' });
  const own = tree(process.env.HOPRIG_TEST_PID || process.pid, real);
  const mine = (l) => [...l.matchAll(/pid=(\d+)/g)].some((m) => own.has(Number(m[1])));
  const lines = String(r.stdout || '').split('\n').filter((l) => l.trim() && mine(l));
  process.stdout.write(lines.map((l) => `${asked ? l : l.replace(USERS, '')}\n`).join(''));
  return 0;
}

function ps(args, real) {
  const { keep, select } = psArgs(args);
  const own = tree(process.env.HOPRIG_TEST_PID || process.pid, real);
  // Which processes the caller's selection picks, as the real program picks them (by name, parent, user, terminal, pid,
  // or the default: the caller's own user and terminal); only pids are asked, and only the test's own are kept.
  const picked = spawnSync(real, [...select, '-o', 'pid='], { encoding: 'utf8' });
  if (picked.status !== 0 && String(picked.stderr || '').trim()) { process.stderr.write(picked.stderr); return picked.status ?? 1; }
  const asked = String(picked.stdout || '').split('\n').map((l) => Number(l.trim())).filter((p) => own.has(p));
  if (!asked.length) return 1;
  const r = spawnSync(real, [...keep, '-p', asked.join(',')], { stdio: 'inherit' });
  return r.status ?? 1;
}

if (require.main === module) {
  const [dir, name, ...args] = process.argv.slice(2);
  const real = nextOnPath(name, dir);
  let code;
  if (realAsked().includes(name)) {
    if (!real) { process.stderr.write(`${name}: command not found\n`); process.exit(127); }
    code = spawnSync(real, args, { stdio: 'inherit' }).status ?? 1;
  } else if (name === 'df') code = df(args);
  else if (name === 'ss') code = ss(args, real);
  else if (name === 'ps') {
    if (!real) { process.stderr.write('ps: command not found\n'); process.exit(127); }
    code = ps(args, real);
  } else code = 127;
  process.exitCode = code;
}

module.exports = { writeStandIns, psArgs, treeFromPs, DISK };
