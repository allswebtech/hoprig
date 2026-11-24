// The box on Linux: the arguments for bubblewrap. An allow list: everything inside is named here, and what is not
// named is not there (never the whole disk minus a list). A toolchain under /opt, /nix or a Linux Homebrew is not on
// it: the caller names such a folder in `read`.
import fs from 'node:fs';
import path from 'node:path';

export const BOX_HOME = '/home/box';
const HOME_SIZE = 64 << 20;
const TMP_SIZE = 512 << 20;
/** The top folders of the system that are links into /usr on most computers, or real folders on older ones. */
export const TOP = ['bin', 'lib', 'lib64', 'sbin'];
/**
 * The only names of /etc inside, read-only where the computer has them: the dynamic loader's cache and settings, the
 * `alternatives` links many programs resolve through, the time zone, and how names are looked up. A tool that needs
 * one more name gets it added here with a comment, never a whole folder. passwd, group and hosts are the box's own.
 */
export const ETC = ['ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'alternatives', 'localtime', 'nsswitch.conf'];

/** The runtime folder: the resolved folder above `bin/node` of the running Node. */
export const runtimeOf = (execPath) => path.dirname(path.dirname(execPath));

/** How a top folder is on this computer: a link (its target), a folder, or not there. */
function topEntry(name, lstat, readlink) {
  try {
    const st = lstat(`/${name}`);
    if (st.isSymbolicLink()) return { link: readlink(`/${name}`) };
    if (st.isDirectory()) return { dir: true };
  } catch {
    /* not on this computer */
  }
  return null;
}

/**
 * bwrap's arguments for one run, and the small files it reads on fds 4, 5, ... (the box's passwd, group, hosts).
 * `plan` is the checked plan of box.mjs: { argv, cwd, write, read, runtime, uid, gid }. The command follows `--`, so a
 * first word that starts with "-" is never taken as an option of bwrap. → { args, data }
 */
export function bwrapArgs(plan, { lstat = fs.lstatSync, readlink = fs.readlinkSync } = {}) {
  const a = ['--json-status-fd', '3', '--unshare-user', '--unshare-pid', '--die-with-parent'];
  // No network at all: a network space of its own holds only its own loopback, so neither an address outside nor this
  // computer's own services answer, and abstract socket names (they belong to a network space) are not shared. The
  // folders that hold the session's socket files (/run, /tmp, the home) are not on the allow list.
  a.push('--unshare-net', '--unshare-ipc', '--unshare-uts', '--hostname', 'box');
  // Its own processes only: a pid space of its own (it sees and signals nothing outside, and when its first process
  // ends the kernel ends every other), a cgroup space where the kernel has one, no new user space inside, no
  // capability, a session of its own (no controlling terminal: it cannot type into the caller's), and it dies with
  // the caller (--die-with-parent above).
  a.push('--unshare-cgroup-try', '--disable-userns', '--new-session', '--cap-drop', 'ALL');
  a.push('--ro-bind', '/usr', '/usr');
  for (const name of TOP) {
    const e = topEntry(name, lstat, readlink);
    if (e?.link) a.push('--symlink', e.link, `/${name}`);
    else if (e?.dir) a.push('--ro-bind', `/${name}`, `/${name}`);
  }
  for (const name of ETC) a.push('--ro-bind-try', `/etc/${name}`, `/etc/${name}`);
  const data = [
    `box:x:${plan.uid}:${plan.gid}:box:${BOX_HOME}:/bin/sh\n`,
    `box:x:${plan.gid}:\n`,
    '127.0.0.1\tlocalhost\n::1\tlocalhost\n',
  ].map((s) => Buffer.from(s));
  ['passwd', 'group', 'hosts'].forEach((name, i) => a.push('--perms', '0644', '--ro-bind-data', String(4 + i), `/etc/${name}`));
  a.push('--dev', '/dev', '--proc', '/proc');
  // An empty home and an empty /tmp of its own, in memory: gone when the box ends.
  a.push('--size', String(HOME_SIZE), '--tmpfs', BOX_HOME, '--size', String(TMP_SIZE), '--tmpfs', '/tmp');
  // Every folder, shallow before the deeper folders it contains, so bwrap applies the deeper mount last and it wins:
  // a read folder inside a write folder stays read-only, a git guard over its write folder stays read-only,
  // and a write folder inside a read folder stays writable. Write folders are read-write; the runtime, the read
  // folders and the git guards are read-only. (Were the runtime and read folders bound first, a write folder that
  // held them would make them writable inside, and what is written inside runs later outside.)
  const mounts = [
    ...plan.write.map((d) => ['--bind', d]),
    ['--ro-bind', plan.runtime],
    ...plan.read.map((d) => ['--ro-bind', d]),
    ...(plan.guard || []).map((g) => ['--ro-bind', g]),
  ];
  mounts.sort((x, y) => x[1].split('/').length - y[1].split('/').length);
  for (const [opt, d] of mounts) a.push(opt, d, d);
  // The whole runtime folder is readable inside, global npm packages included. Its own `etc` can hold a global npm
  // settings file with a token, which Node itself does not need: an empty folder over it where it exists (bwrap
  // cannot make the mount point where it does not).
  const runtimeEtc = path.join(plan.runtime, 'etc');
  try {
    if (lstat(runtimeEtc).isDirectory()) a.push('--tmpfs', runtimeEtc);
  } catch {
    /* no etc under the runtime: nothing to hide */
  }
  // Its environment is the plan's closed list only, never the caller's (the means itself starts with none).
  a.push('--clearenv');
  for (const [k, v] of Object.entries(plan.env || {})) a.push('--setenv', k, v);
  a.push('--chdir', plan.cwd, '--', ...plan.argv);
  return { args: a, data };
}

/**
 * What a failed start of the means says, from its first line: { why, step } (`why` follows "the box does not start: "). A bwrap that may not make its spaces (a
 * kernel or security setting forbids user namespaces) and one too old for an option the box needs are named; the
 * step is words for a person, never run.
 */
export function startFailure(line) {
  const l = String(line || '').trim().split('\n')[0] || 'no reason given';
  // The box itself is fine here: bwrap could not START THE COMMAND. A command that is not there or is not executable
  // is the caller's, not a broken box, so it gets no step (and never the AppArmor one the permission match below
  // would otherwise give for its "Permission denied").
  const exec = /execvp (.+?): (.+)$/.exec(l);
  if (exec) {
    const [, cmd, reason] = exec;
    if (/No such file or directory/i.test(reason)) return { why: `the command could not be started: ${cmd} is not there`, step: '' };
    if (/Permission denied|not permitted/i.test(reason)) return { why: `the command could not be started: ${cmd} cannot be run (is it executable?)`, step: '' };
    return { why: `the command could not be started: ${cmd} (${reason})`, step: '' };
  }
  if (/Unknown option|unrecognized option/i.test(l)) {
    return { why: `this bubblewrap does not know an option the box needs (${l})`, step: 'install bubblewrap 0.8 or later' };
  }
  if (/namespace|uid map|setting up uid|Operation not permitted|Permission denied|No permissions/i.test(l)) {
    return {
      why: `bubblewrap is not allowed to make its spaces here (${l})`,
      step: 'allow unprivileged user namespaces for bubblewrap; on Ubuntu 24.04 and later this means an AppArmor profile for /usr/bin/bwrap (see https://github.com/allswebtech/hoprig/blob/main/docs/BOX.md)',
    };
  }
  return { why: l, step: '' };
}
