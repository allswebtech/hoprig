// Starting a program on Windows. Node can start an .exe directly, but a program that npm installed is a
// ".cmd" shim, and those only run through cmd.exe, which has its own quoting rules. This file finds what a bare
// name such as "claude" stands for and builds the command for both cases. Pure functions, so they are tested on
// any system; the result is only used when process.platform is "win32".
import fs from 'node:fs';
import path from 'node:path';

/**
 * The file a command name stands for, searched the way Windows does: as given when it has a folder, else in each
 * PATH folder with each PATHEXT extension. Returns null when nothing is found.
 */
export function resolveWindowsBin(bin, env = process.env, exists = fs.existsSync) {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = exts.some((e) => bin.toLowerCase().endsWith(e.toLowerCase()));
  const names = hasExt ? [bin] : exts.map((e) => bin + e.toLowerCase());
  if (/[\\/]/.test(bin)) return names.find((n) => exists(n)) || null;
  const dirs = (env.Path || env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      const full = path.win32.join(dir, n);
      if (exists(full)) return full;
    }
  }
  return null;
}

// The characters cmd.exe treats specially outside quotes.
const META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument, quoted for the program (MSVC rules) and then escaped for cmd.exe. */
export function cmdArgument(arg, doubleEscape) {
  let a = String(arg);
  a = a.replace(/(\\*)"/g, '$1$1\\"'); // backslashes before a quote are doubled, the quote escaped
  a = a.replace(/(\\*)$/, '$1$1'); // trailing backslashes are doubled: a closing quote follows
  a = `"${a}"`;
  a = a.replace(META, '^$1');
  // A .cmd shim passes its arguments through cmd.exe a second time.
  if (doubleEscape) a = a.replace(META, '^$1');
  return a;
}

/**
 * How to start `file` with `args`: { command, args, options } for child_process.spawn. An .exe (or .com) starts
 * directly. A .cmd or .bat goes through cmd.exe with every argument escaped, so text such as a prompt with
 * quotes, "&" or "%" arrives unchanged and cannot run anything.
 */
export function windowsSpawnPlan(file, args, env = process.env) {
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args, options: {} };
  const line = [file.replace(META, '^$1'), ...args.map((a) => cmdArgument(a, true))].join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
