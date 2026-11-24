// The administrator commands that are refused with NO card at EVERY level of Tia's rights, "Full" too:
// they would change who may be administrator, or switch a safety rule off, and whatever the
// level a mistake of hers may cost a day, never the work. No level ever lets a command raise her own rights.
//
// What a reader of ours surely knows is refused by the list below; what it cannot break down is refused too (fail
// closed: "what it cannot read is refused, not run"). The list is data with a reason per entry, and one test runs the
// whole list (test/assistant/adminrefused.test.mjs).
//
// Which commands are administrator commands is the wall's own reader (src/wall.mjs: readCommands splits the line and
// wallKind calls it "admin" for sudo/su/doas/pkexec): there is ONE reader of that, never a second. This module reads
// no line for admin-ness of its own; it takes the commands readCommands already split and asks, of an administrator
// command, whether it is one of the forms refused at every level.
//
// Only a plain `sudo <program> <arguments>` is ever a candidate for a card or for Full, since the card shows exactly sudo
// and one program with its arguments. Every other way to become administrator — `su`, `doas`, `pkexec`, `runas`, a
// login or a shell as administrator, a wrapper that runs an arbitrary program as root (`env`, `nice`, `timeout`,
// `chrt`, `flock`, `watch`, `find -exec`, …), a privilege or namespace tool (`setpriv`, `unshare`, `chroot`, …), a form
// the reader cannot break down — is refused here at every level.

import path from 'node:path';
import { pathTexts, shellWords } from '../shellwords.mjs';
import { adminReads, hoprigRelation, pastWrappers, readCommands, runsItsWords } from '../wall.mjs';

// The escalators the wall counts as administrator (src/wall.mjs ADMIN set), plus `runas` (Windows). `sudo` is the one
// the owner may allow a card or Full for; the rest are refused at every level.
const ESCALATORS = new Set(['sudo', 'sudoedit', 'su', 'doas', 'pkexec', 'run0', 'runas']);
// A program that runs its own words as a command (the wall's ONE list, runsItsWords: the passers, the wrappers, the
// programs that take a command to run) is stepped over in FRONT of sudo, so `env sudo …` still shows sudo as the
// escalator. It matters a second time AFTER sudo: run as sudo's program it runs an arbitrary program as root while
// hiding which one (`sudo env bash`, `sudo nice bash`, `sudo chrt 1 bash`, `sudo flock /tmp/l su`, `sudo busybox sh`,
// `sudo watch bash`). Only `env` with assignments is read through to the real program (adminForm), because that is
// the one wrapped form Hoprig itself writes (`sudo env DEBIAN_FRONTEND=noninteractive apt-get …`); every other such
// program, and env carrying an option, is refused (passer-as-admin) rather than stepped. A list of its own here did
// not match the wall's, and a root shell behind `sudo chrt 1` ran at Full.
// find is one of them when it is told to run a program for what it finds (`sudo find / -exec bash ;`).
const findRuns = (prog, args) => prog === 'find' && args.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a));
// What stays the owner's own step with or without sudo in her own tool, the same two rows as owner-tools.mjs
// HIS_ALONE (a test holds the two in step): a push or a merge, and data sent to another computer.
const SENDERS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']);
const SENDS_DATA = /^(-d|--data.*|-F|--form.*|-T|--upload-file|--post-data|--post-file|-X|--request)$/;
const pushesOrMerges = (prog, args) => prog === 'git' && args.some((a) => a === 'push' || a === 'merge');
const sendsOut = (prog, args) => SENDERS.has(prog) || ((prog === 'curl' || prog === 'wget') && args.some((a) => SENDS_DATA.test(a)));

// sudo's own options. The valueless flags here do not change which program runs, so they are stepped over; `-i`/`-s`
// open a login or a shell (refused below); any other option (one that takes a value such as `-u`/`--user`, a bundled
// short flag, an unknown flag) means the reader cannot say which program runs, so the command is refused (fail closed).
const SUDO_SAFE_FLAGS = new Set(['-n', '-k', '-K', '-b', '-E', '-H', '-P', '-S', '--non-interactive', '--reset-timestamp', '--remove-timestamp', '--background', '--set-home', '--preserve-groups', '--stdin']);
const SUDO_LOGIN_SHELL = new Set(['-i', '--login', '-s', '--shell']);

// A shell as administrator: it could run anything as root, so no level allows it.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'csh', 'tcsh', 'fish']);
// Tools that hand their caller the full rights of root directly — a credential change, a new namespace, a changed
// root — so run as administrator they open a root shell or run an arbitrary program as root by another door
// (`sudo setpriv --reuid 0 bash`, `sudo unshare -r bash`, `sudo chroot / bash`). Refused as the program at every level.
const PRIV_TOOLS = new Set(['setpriv', 'capsh', 'unshare', 'nsenter', 'chroot']);
// An editor as administrator (the owner approves an editor as administrator at the keyboard, never Tia). visudo, vipw
// and vigr edit the files that decide who may be administrator, so they are editors and account tools both.
const EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'emacsclient', 'ed', 'ex', 'pico', 'joe', 'micro', 'kak', 'helix', 'hx', 'sensible-editor', 'editor', 'visudo', 'vipw', 'vigr']);
// Commands that change who may be administrator or a password (the sudoers rules, the administrator groups, the
// passwords, PAM) as a program rather than as a file.
const ACCOUNT_TOOLS = new Set(['visudo', 'passwd', 'chpasswd', 'usermod', 'useradd', 'adduser', 'userdel', 'deluser', 'groupadd', 'addgroup', 'groupdel', 'delgroup', 'gpasswd', 'newusers', 'vipw', 'vigr', 'chage', 'pam-auth-update', 'pam_tally2', 'setcap', 'setfacl']);

// Files and folders that decide who may use sudo or become another user (sudoers, the administrator groups, the
// passwords, PAM, polkit). A command that names any of these paths is refused, read or write alike. Matched on a path
// prefix, after a trailing slash is trimmed.
const PROTECTED_PATHS = [
  '/etc/sudoers', '/etc/sudoers.d', '/etc/pam.d', '/etc/pam.conf', '/etc/security',
  '/etc/polkit-1', '/usr/share/polkit-1', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow', '/etc/doas.conf',
];

const base = (w) => {
  const noSlash = String(w).slice(String(w).lastIndexOf('/') + 1);
  return noSlash.toLowerCase();
};
const isOption = (w) => typeof w === 'string' && w.startsWith('-');
const isAssignment = (w) => {
  const eq = typeof w === 'string' ? w.indexOf('=') : -1;
  if (eq <= 0) return false;
  const name = w.slice(0, eq);
  return [...name].every((c, k) => c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (k > 0 && c >= '0' && c <= '9'));
};
// A set-user-id / set-group-id bit: `chmod u+s`, `+s`, `g+s`, or an octal mode with a special high digit (4755, 2755,
// 6755). It would make a program run as its owner (root) for anyone.
const SETUID = /(^|,)[ugoa]*\+[rwxXst]*s|^[2467][0-7]{3}$/;

// The mode `install` is told to set (`-m 4755`, `-m4755`, `--mode=4755`, `--mode 6755`), or null when none is given.
const installMode = (args) => {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-m' || a === '--mode') return i + 1 < args.length ? args[i + 1] : null;
    if (a.startsWith('--mode=')) return a.slice('--mode='.length);
    if (a.startsWith('-m') && !a.startsWith('--') && a.length > 2) return a.slice(2);
  }
  return null;
};
// Does a mode set a set-user-id or set-group-id bit? An octal (`4755`, `6755`, `04755`) with a high 4/2/6 digit, or a
// symbolic form (`u+s`, `+s`, `g+s`). A plain `0755`/`755` or a sticky-only `1777` does not.
const setsSetuidMode = (m) => (typeof m === 'string' && /^[0-7]+$/.test(m) ? (parseInt(m, 8) & 0o6000) !== 0 : SETUID.test(String(m)));

const normPath = (p) => String(p).replace(/\/+$/, '') || '/';
const under = (p, dir) => {
  const a = normPath(p);
  const b = normPath(dir);
  return a === b || a.startsWith(`${b}/`);
};
// Does a word of the command name a protected administrator file, or one of the owner's Hoprig folders? Each word is
// read by the ONE reader of paths (shellwords.mjs: `~`, `$HOME`, quotes, a doubled separator, `.` and `..` are one
// folder however it is written) and placed by the wall's own relation (hoprigRelation, through the real place too),
// so this module keeps no spellings of its own. A path IN one of Hoprig's folders counts for every program; a folder
// that HOLDS one of them, all the way up to `/`, counts for a program that does not only read (a move, a change of
// owner, a delete or a write there takes Hoprig's rules with it). A pattern names the entries of its folder, and is
// protected where a protected file could be one of them.
function touchesProtected(c, ctx) {
  const reads = adminReads(c.effProg, c.effArgs);
  const cwd = typeof ctx.cwd === 'string' && ctx.cwd.startsWith('/') ? ctx.cwd : null;
  for (const t of ctx.texts || []) {
    if (t.unsure) continue;
    const abs = t.text.startsWith('/') ? path.posix.normalize(t.text) : cwd ? path.posix.resolve(cwd, t.text) : null;
    if (abs) for (const p of PROTECTED_PATHS) if (under(abs, p)) return 'protected';
    if (t.glob && typeof t.fixed === 'string' && t.fixed.startsWith('/')) {
      const fixed = path.posix.normalize(t.fixed);
      if (PROTECTED_PATHS.some((p) => p.startsWith(fixed))) return 'protected';
    }
    const rel = hoprigRelation(t.text, { hoprig: ctx.hoprigDirs }, cwd);
    if (rel === 'inside' || (rel === 'above' && !reads)) return 'hoprig';
  }
  return null;
}

// Reduce one command (readCommands' list of { word, quoted }) to the administrator form the list below reads, or null
// when the command is not an administrator command. For a sudo command: `loginShell` a -i/-s flag was seen;
// `optUnread` an option the reader does not step over was seen (so which program runs is unknown); `prog`/`progRaw`/
// `args` the literal `sudo <word> …` (what sudoArgv runs); `effProg`/`effArgs` the program that actually runs as root
// and its arguments, read through an `env NAME=VALUE…` wrapper; `viaPasser` the program is a wrapper the reader will
// not break down (a non-env passer, or env with an option); `after` every word after sudo; `wrapped` a program stands
// in front of the escalator (a variable set for it does not count).
function adminForm(cmd) {
  // Step over any leading wrappers (env, nice, timeout, chrt, taskset, flock, busybox, …) to the escalator they run,
  // through the ONE reader the wall uses (pastWrappers), so a passer with a value or an argument no longer hides the
  // escalator from the floor: `nice -n 5 sudo su`, `timeout -s KILL 5 sudo su`, `flock /tmp/l sudo su`, `busybox sudo
  // tee /etc/sudoers.d/x`, `env -u X sudo su` are read here as `sudo …` is. (What sudo ITSELF runs as its program, a
  // wrapper AFTER sudo, is the separate question `viaPasser` answers below, so that `sudo nice bash` is refused.)
  const k = pastWrappers(cmd);
  if (k >= cmd.length) return null;
  const esc = base(cmd[k].word);
  if (!ESCALATORS.has(esc)) return null;
  const after = cmd.slice(k + 1).map((t) => t.word);
  const wrapped = cmd.slice(0, k).some((t) => !isAssignment(t.word));
  if (esc !== 'sudo') return { esc, after, wrapped };
  let loginShell = false;
  let editOpt = false;
  let optUnread = false;
  let i = 0;
  while (i < after.length && isOption(after[i])) {
    const o = after[i];
    if (SUDO_LOGIN_SHELL.has(o)) loginShell = true;
    else if (o === '-e' || o === '--edit') editOpt = true;
    else if (!(SUDO_SAFE_FLAGS.has(o) || o.startsWith('--preserve-env'))) optUnread = true;
    i += 1;
  }
  // sudo's own env assignments: its native grammar accepts `VAR=value` between the options and the program
  // (`sudo FOO=bar program …`, `sudo LD_PRELOAD=/x.so bash`), sets them for the program and runs the program as
  // root — exactly as `sudo env VAR=value program` does. Step them here (options come before assignments in sudo's
  // grammar) so the program that would actually run is read: a shell, an escalator or a privilege tool after them
  // is refused, not run, and sudoArgv builds the argv from the program alone (the assignment is dropped, never
  // carried into the run). Without this step `FOO=bar` reads as the program and a root shell slips through.
  while (i < after.length && isAssignment(after[i])) i += 1;
  const hasProg = i < after.length;
  const prog = !optUnread && hasProg ? base(after[i]) : '';
  const progRaw = hasProg ? after[i] : null; // the program word as it was written (for the argv that will run)
  const args = after.slice(i + 1);
  // The program that would actually run as root. `sudo env NAME=VALUE… PROGRAM` runs PROGRAM as root (env only sets
  // variables), so step `env` and its assignments to read PROGRAM: the non-interactive apt form Hoprig itself writes
  // (`sudo env DEBIAN_FRONTEND=noninteractive apt-get …`) stays a plain program a card or Full may run, while
  // `sudo env bash` reads as a shell and `sudo env su` as an escalator. An env OPTION (`-i`, `-u NAME`, `-S …`) can
  // change or hide which program runs, so it is NOT stepped — the form is a wrapper the reader cannot break down.
  // Any OTHER passer as the program (`sudo nice bash`, `sudo timeout 5 bash`) is a wrapper too: their option and
  // positional grammars differ and a denylist of them leaks, so a non-env passer is not stepped either — it is the
  // effective program, and `viaPasser` refuses it. `effProg`/`effArgs` are what the program-kind rules below read;
  // `prog`/`progRaw`/`args` stay the literal `sudo <word>` so sudoArgv runs the command as it was written.
  let effProg = prog;
  let effArgs = args;
  let wrapUnread = false;
  if (!optUnread && hasProg) {
    let j = i;
    while (base(after[j]) === 'env') {
      j += 1;
      while (j < after.length && isAssignment(after[j])) j += 1;
      if (j < after.length && isOption(after[j])) { wrapUnread = true; break; }
      if (j >= after.length) break;
    }
    effProg = wrapUnread || j >= after.length ? '' : base(after[j]);
    effArgs = wrapUnread || j >= after.length ? [] : after.slice(j + 1);
  }
  // (A privilege or namespace tool runs its words too, and keeps its own entry and reason: PRIV_TOOLS.)
  const viaPasser = wrapUnread || (!PRIV_TOOLS.has(effProg) && (runsItsWords(effProg) || findRuns(effProg, effArgs)));
  return { esc, after, wrapped, loginShell, editOpt, optUnread, prog, progRaw, args, hasProg, effProg, effArgs, viaPasser };
}

// The list, as data with a reason per entry. Each `match(c, ctx)` reads a reduced administrator form `c`; the first
// that matches gives the reason. `ctx.hoprigDirs` are the owner's Hoprig folders to protect (passed by the caller, so
// this module reads no real path and stays testable).
export const ADMIN_REFUSED = [
  { id: 'non-sudo-escalator', why: 'it becomes administrator by a way other than sudo (su, doas, pkexec or runas), which is never a command of hers', match: (c) => c.esc !== 'sudo' && c.esc !== 'sudoedit' },
  { id: 'sudoedit', why: "it edits a file as administrator (sudoedit / sudo -e), which is the owner's own step", match: (c) => c.esc === 'sudoedit' || c.editOpt },
  { id: 'login-or-shell-flag', why: 'it opens a login or a shell as administrator (sudo -i / -s)', match: (c) => c.esc === 'sudo' && c.loginShell },
  { id: 'option-not-read', why: 'it carries a sudo option the reader does not break down (such as running as another user, or a bundled flag), so which program would run is unknown', match: (c) => c.esc === 'sudo' && c.optUnread },
  { id: 'no-program', why: 'it names no program to run as administrator, so it is refused rather than run', match: (c) => c.esc === 'sudo' && !c.loginShell && !c.optUnread && !c.hasProg },
  { id: 'escalator-as-admin', why: 'it runs another way to become administrator as the program (sudo su, sudo sudo, sudo doas, sudo pkexec, sudo runas, sudo sudoedit), which is never a command of hers', match: (c) => c.esc === 'sudo' && ESCALATORS.has(c.effProg) },
  { id: 'passer-as-admin', why: 'it runs the program through another program that hides which program would run as administrator (nice, timeout, chrt, flock, watch, find with -exec and the like, or env carrying an option), so it is refused rather than run', match: (c) => c.esc === 'sudo' && c.viaPasser },
  { id: 'privilege-tool-as-admin', why: 'it runs a privilege or namespace tool (setpriv, capsh, unshare, nsenter, chroot) as administrator, which can hand a shell or any program the full rights of root', match: (c) => c.esc === 'sudo' && PRIV_TOOLS.has(c.effProg) },
  { id: 'shell-as-admin', why: 'it runs a shell as administrator, which could run anything', match: (c) => c.esc === 'sudo' && SHELLS.has(c.effProg) },
  { id: 'editor-as-admin', why: 'it runs an editor as administrator, which the owner approves himself at the keyboard', match: (c) => c.esc === 'sudo' && EDITORS.has(c.effProg) },
  { id: 'account-or-auth', why: 'it changes who may be administrator or a password (sudoers, the administrator groups, PAM)', match: (c) => c.esc === 'sudo' && ACCOUNT_TOOLS.has(c.effProg) },
  { id: 'setuid', why: 'it sets a set-user-id bit, which makes a program run as its owner for anyone', match: (c) => c.esc === 'sudo' && ((c.effProg === 'chmod' && c.effArgs.some((a) => SETUID.test(a))) || (c.effProg === 'install' && setsSetuidMode(installMode(c.effArgs)))) },
  // Her own tool runs the words as they are written, with no shell between (sudoArgv): a `$` word is not filled in
  // but dropped, so `$PREFIX/etc` would run as `/etc`. Refused, with what to do instead. (In a session a shell fills
  // it in; there the wall marks what it cannot tell, and this entry is not asked: `ctx.argv`.)
  // Her own tool runs `sudo <program> <arguments>` and nothing else: with a program in front of sudo it would run
  // another command than the one she was given (`chroot /mnt sudo apt-get …` would run apt-get on this computer).
  { id: 'wrapper-before-sudo', why: 'it puts another program in front of sudo (nice, timeout, chroot and the like), and her own tool runs only a line that begins with sudo itself: run without that program it would be another command than the one written, so it is refused rather than run', match: (c, ctx) => c.esc === 'sudo' && ctx.argv === true && c.wrapped },
  // What is the owner's own step without sudo is his with it (owner-tools.mjs check refuses the same without sudo).
  { id: 'push-or-merge-as-admin', why: "it pushes or merges with git as administrator, and a push or a merge is the owner's own step with or without sudo", match: (c, ctx) => c.esc === 'sudo' && ctx.argv === true && pushesOrMerges(c.effProg, c.effArgs) },
  { id: 'sends-out-as-admin', why: "it sends data to another computer as administrator (ssh, scp, rsync, or curl and wget with data), which is the owner's own step with or without sudo", match: (c, ctx) => c.esc === 'sudo' && ctx.argv === true && sendsOut(c.effProg, c.effArgs) },
  { id: 'word-not-read', why: 'it holds a variable (a word with $), which only a shell fills in: run as it is written, it would name another path than the one meant, so it is refused rather than run; the path is written out in full instead', match: (c, ctx) => c.esc === 'sudo' && ctx.argv === true && (ctx.words || []).some((w) => w.vars) },
  { id: 'protected-path', why: "it names a file that decides who may be administrator, or one of Hoprig's own folders", match: (c, ctx) => c.esc === 'sudo' && touchesProtected(c, ctx) === 'protected' },
  { id: 'hoprig-own', why: "it writes Hoprig's own install, settings, state or service, or a folder that holds them", match: (c, ctx) => c.esc === 'sudo' && touchesProtected(c, ctx) === 'hoprig' },
];

/**
 * Of a shell line, the first reason it is refused at every level, or null when nothing on it is refused here.
 *
 * A line readCommands cannot read with certainty (it returns null) is refused — fail closed. Each administrator
 * command on the line is tested against ADMIN_REFUSED in order. Non-administrator commands are not this module's
 * concern (owner-tools.mjs decides those): they contribute nothing and the line returns null.
 *
 * @param {string} line  the shell line Tia's run_command was given
 * @param {{ hoprigDirs?: string[], home?: string, cwd?: string, argv?: boolean }} [ctx]  the owner's Hoprig folders to
 *   protect (so no real path is read here), the home and folder a `~` or relative word is read from, and `argv: true`
 *   where the command would run as its words with no shell between (her own tool)
 * @returns {{ id: string, why: string } | null}
 */
export function adminRefusal(line, ctx = {}) {
  const hoprigDirs = Array.isArray(ctx.hoprigDirs) ? ctx.hoprigDirs : [];
  const where = { home: typeof ctx.home === 'string' ? ctx.home : null, cwd: typeof ctx.cwd === 'string' ? ctx.cwd : null };
  const cmds = readCommands(line);
  if (cmds === null) return { id: 'unreadable', why: 'this command cannot be read with certainty, so it is refused rather than run' };
  for (const [j, cmd] of cmds.entries()) {
    const form = adminForm(cmd);
    if (!form) continue;
    // The command's own text, for the one reader of paths: readCommands keeps where each command stands in the line.
    const words = shellWords(cmds.line.slice(...cmds.spans[j]), { home: where.home });
    const at = { hoprigDirs, ...where, argv: ctx.argv === true, words, texts: pathTexts(words) };
    for (const entry of ADMIN_REFUSED) if (entry.match(form, at)) return { id: entry.id, why: entry.why };
  }
  return null;
}

/**
 * The exact sudo argv a runnable administrator command of hers would run: `['sudo', <program>, ...<args>]`. sudo's own
 * flags are dropped (asAdmin re-adds the auth flags, and everything after sudo's `--` is the command, so a flag kept
 * here would be read as the program); the program and its arguments are the words as they were written. The card shows
 * this argv and the run uses it, and which commands are administrator commands stays the wall's ONE reader
 * (readCommands) — this adds no second reader.
 *
 * Returns `{ argv }` for a plain runnable `sudo <program> <arguments>`, or `{ refuse: { id, why } }` for anything
 * refused at every level (adminRefusal), a line that is not a single command, or a form that is not that plain shape
 * (fail closed). Call it only for a line the wall already reads as an administrator command.
 *
 * @param {string} line  the shell line Tia's run_command was given
 * @param {{ hoprigDirs?: string[] }} [ctx]
 * @returns {{ argv: string[] } | { refuse: { id: string, why: string } }}
 */
export function sudoArgv(line, ctx = {}) {
  const refused = adminRefusal(line, { ...ctx, argv: true }); // what this builds runs with no shell between
  if (refused) return { refuse: refused };
  // adminRefusal already refused an unreadable line; a runnable administrator command is exactly ONE command, and that
  // command the plain `sudo <program> <arguments>` form — no login/shell, no option the reader cannot step over, and a
  // program to run. A line that joins it with another command cannot be shown as one argv, so it is refused.
  const cmds = readCommands(line);
  if (!cmds || cmds.length !== 1) return { refuse: { id: 'not-single', why: 'it joins an administrator command with another command, and an administrator command of hers runs alone (sudo and one program), so the line is refused rather than run; each command is given by itself' } };
  const form = adminForm(cmds[0]);
  if (!form || form.esc !== 'sudo' || form.wrapped || form.loginShell || form.editOpt || form.optUnread || !form.hasProg) {
    return { refuse: { id: 'not-runnable', why: 'it is not a plain `sudo <program> <arguments>` (the administrator command stands inside another command, or behind a program Hoprig cannot read with certainty), so it is refused rather than run' } };
  }
  return { argv: ['sudo', form.progRaw, ...form.args] };
}
