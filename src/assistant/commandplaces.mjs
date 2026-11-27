// The places a command line of Tia's names, so that the never list (the credentials folder, a sign-in) can be asked
// about every one of them before a card. On Linux and macOS only a path that starts with "/" or "~/" counts, as ever.
// On Windows a place is written many ways: a drive ("C:\x", "c:/x"), a share, the long prefix, a Git Bash or WSL spelling
// ("/c/x", "/mnt/c/x"), "~\x", an environment name ("%USERPROFILE%\x", "$env:USERPROFILE\x", "$HOME/x"), after "=" or a
// redirect, in quotes (also with spaces), with a trailing separator, in any case, and a path relative to the folder the
// command runs in. `platform` and `env` are parameters so a test on any system can feed Windows-shaped lines.
import os from 'node:os';
import path from 'node:path';

const pathOf = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// One word of a line: a quoted run (spaces allowed inside) or a run without space.
const WORD = /"([^"]*)"|'([^']*)'|[^\s"']+/g;

// "%NAME%", "$env:NAME", "${NAME}" and "$NAME" from `env` (names are case-blind on Windows). An unknown name stays as written.
function expandEnv(s, env, platform, home) {
  const get = (n) => {
    if (platform === 'win32') for (const k of Object.keys(env)) if (k.toLowerCase() === n.toLowerCase()) return env[k];
    return env[n];
  };
  const own = (n) => get(n) || (/^(HOME|USERPROFILE)$/i.test(n) ? home : undefined);
  const sub = (m, n) => (typeof own(n) === 'string' && own(n) ? own(n) : m);
  return s
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, platform === 'win32' ? sub : (m) => m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, sub)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, sub)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, sub);
}

/** `~`, `~/x` (and on Windows `~\x`) as the person's home; on Windows also an environment name. A relative text stays. */
export function expandHome(x, { platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (typeof x !== 'string') return x;
  const P = pathOf(platform);
  let s = platform === 'win32' ? expandEnv(x, env, platform, home) : x;
  if (s === '~') return home;
  if (s.startsWith('~/') || (platform === 'win32' && s.startsWith('~\\'))) return P.join(home, s.slice(2));
  return s;
}

// A Windows spelling made into a drive path: the long prefix, "/c/x" and "/mnt/c/x", "/cygdrive/c/x".
function winForm(s) {
  let t = s.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '').replace(/^\\\\\?\\UNC\\/i, '\\\\');
  const m = /^[\\/](?:(?:mnt|cygdrive)[\\/])?([A-Za-z])(?:[\\/]|$)(.*)$/.exec(t);
  if (m && (t.startsWith('/mnt/') || t.startsWith('/cygdrive/') || /^\/[A-Za-z](\/|$)/.test(t))) t = `${m[1].toUpperCase()}:\\${m[2]}`;
  return t;
}

/**
 * The absolute places a command line and its folder name: [folder, ...paths]. `folder` is where the command runs
 * (absolute, or unset). Candidates are returned as the system's own absolute path, ready for isSecretFolder.
 */
export function commandPlaces(command, folder, { platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const out = [];
  const win = platform === 'win32';
  const P = pathOf(platform);
  let base = typeof folder === 'string' && P.isAbsolute(folder) ? folder : null;
  let moving = false; // the word before is cd (or its kin): the next place is where the later words stand
  if (typeof folder === 'string') out.push(win ? P.resolve(winForm(expandHome(folder, { platform, home, env }))) : folder);
  const add = (raw) => {
    let s = raw.replace(/^[<>]+/, '').replace(/[;|&)]+$/, '');
    if (!s) return;
    if (!win) {
      if (s.startsWith('/') || s.startsWith('~/')) out.push(expandHome(s, { platform, home, env }));
      return;
    }
    s = winForm(expandHome(s, { platform, home, env }));
    if (P.isAbsolute(s)) out.push(P.resolve(s));
    else if (base && (moving || /[\\/]|^\.\.?$/.test(s))) out.push(P.resolve(base, s));
    if (moving && base) base = P.resolve(base, s);
  };
  for (const m of String(command).matchAll(WORD)) {
    const w = m[1] ?? m[2] ?? m[0];
    if (win && /^\/d$/i.test(w) && moving) continue;
    add(w);
    moving = win && /^(cd|chdir|pushd|sl|set-location)$/i.test(w);
    // "--file=C:\x" and "KEY=/x": the part after the first "="
    const eq = win ? w.indexOf('=') : -1; // (elsewhere nothing changes: `of=/dev/sdb` is a card, not a refusal)
    if (eq > 0) add(w.slice(eq + 1).replace(/^["']|["']$/g, ''));
    // "-Path:C:\x" and ">C:\x" style glue: a drive path that starts inside the word
    if (win) {
      const d = /[A-Za-z]:[\\/].*$/.exec(w);
      if (d && d.index > 0) add(d[0]);
    }
  }
  return out;
}
