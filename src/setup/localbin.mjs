// The `hoprig` and `hop` commands in every shell, not only in an interactive one.
//
// Why: Node.js installed with nvm is put on PATH by lines in ~/.bashrc that a non-interactive shell never reaches
// (Debian's and Ubuntu's ~/.bashrc stop early when the shell is not interactive), so `ssh <computer> 'hoprig doctor'`
// and a non-interactive login shell said "command not found". Two parts fix that:
//   1. ~/.local/bin/hoprig and ~/.local/bin/hop: tiny scripts that start Hoprig with the full path of the Node.js
//      it runs on now, so they work without nvm loaded. `hoprig setup` writes them again (a new Node.js version
//      moves that path; the doctor says when they point to one that is gone). A file there that is not ours is left alone;
//      it is named only when it would start another Hoprig or another program (npm's own link to this Hoprig, from an
//      install with --prefix ~/.local, is left without a word).
//   2. ~/.local/bin on PATH in the files each shell reads:
//        ~/.profile (and ~/.bash_profile when there is one: bash reads that one instead)   login shells
//        ~/.bashrc, at its TOP: before the "not interactive: stop here" line           bash started by sshd for a command
//        ~/.zshenv                                                                       every zsh (login, ssh command, script)
//        ~/.config/fish/conf.d/hoprig.fish                                               fish, when that is the login shell
//      Each line is added once (marked), so running setup again changes nothing.
// Not on Windows: npm's own .cmd files are on PATH there for every program.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binFile } from '../paths.mjs';

export const MARK = '# added by hoprig: ~/.local/bin on PATH';
const WRAP_MARK = '# hoprig-command-wrapper';
const POSIX_LINE = `case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH"; export PATH ;; esac ${MARK}`;
const FISH_LINE = `contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH ${MARK}`;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

/** Do `a` and `b` lead to the same file (links followed)? */
const sameFile = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

export const wrapperText = (node, script) => `#!/bin/sh\n${WRAP_MARK}: written by \`hoprig setup\`; starts Hoprig with this Node.js in every shell\nexec ${shq(node)} ${shq(script)} "$@"\n`;

/** The shell start files to have the PATH line: [{ file, at: 'top' | 'end', line }]. */
export function shellFiles({ home = os.homedir(), shell = process.env.SHELL || '', platform = process.platform } = {}) {
  const sh = path.basename(shell);
  const out = [{ file: path.join(home, '.profile'), at: 'end', line: POSIX_LINE }];
  if (fs.existsSync(path.join(home, '.bash_profile'))) out.push({ file: path.join(home, '.bash_profile'), at: 'end', line: POSIX_LINE });
  if (sh === 'bash' || fs.existsSync(path.join(home, '.bashrc'))) out.push({ file: path.join(home, '.bashrc'), at: 'top', line: POSIX_LINE });
  if (sh === 'zsh' || platform === 'darwin' || fs.existsSync(path.join(home, '.zshenv'))) out.push({ file: path.join(home, '.zshenv'), at: 'end', line: POSIX_LINE });
  if (sh === 'fish') out.push({ file: path.join(home, '.config', 'fish', 'conf.d', 'hoprig.fish'), at: 'end', line: FISH_LINE });
  return out;
}

/**
 * Make it so. → { skipped?: why, did: [plain lines], kept: [plain lines] }. `dryRun` says what it would do.
 */
export function ensureCommand({ home = os.homedir(), shell = process.env.SHELL || '', platform = process.platform, node = process.execPath, script = binFile(), dryRun = false } = {}) {
  if (platform === 'win32') return { skipped: 'not needed on Windows', did: [], kept: [] };
  const did = [];
  const kept = [];
  const bin = path.join(home, '.local', 'bin');
  const want = wrapperText(node, script);
  for (const name of ['hoprig', 'hop']) {
    const f = path.join(bin, name);
    let cur = null;
    let mine = false;
    let same = false;
    try {
      const st = fs.lstatSync(f);
      cur = st.isSymbolicLink() ? '' : read(f);
      mine = !st.isSymbolicLink() && cur !== null && cur.includes(WRAP_MARK);
      // npm's own link to this very Hoprig (an install with --prefix ~/.local): it starts what the wrapper would.
      same = st.isSymbolicLink() && sameFile(f, script);
    } catch {
      /* not there */
    }
    if (same) continue; // nothing to say: it is this Hoprig, put there by npm
    if (cur !== null && !mine) {
      kept.push(`${f} is not ours: left as it is`);
      continue;
    }
    if (cur === want) continue;
    did.push(`${dryRun ? 'would write' : 'wrote'} ${f}`);
    if (dryRun) continue;
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(f, want, { mode: 0o755 });
    fs.chmodSync(f, 0o755);
  }
  for (const s of shellFiles({ home, shell, platform })) {
    const text = read(s.file);
    if (text !== null && text.includes(MARK)) continue;
    did.push(`${dryRun ? 'would add' : 'added'} ~/.local/bin to PATH in ${s.file}`);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    const body = text || '';
    const next = s.at === 'top' ? `${s.line}\n${body}` : `${body}${body && !body.endsWith('\n') ? '\n' : ''}${s.line}\n`;
    fs.writeFileSync(s.file, next);
  }
  return { did, kept };
}

/** For the doctor: { status, detail, fix }. */
export function commandCheck({ home = os.homedir(), platform = process.platform } = {}) {
  if (platform === 'win32') return { status: 'ok', detail: 'npm puts the command on PATH', fix: '' };
  const f = path.join(home, '.local', 'bin', 'hoprig');
  const text = read(f);
  if (text === null) return { status: 'warn', detail: 'only an interactive shell finds hoprig (not ssh <computer> hoprig …)', fix: 'hoprig setup' };
  if (!text.includes(WRAP_MARK)) return { status: 'ok', detail: `${f} (npm's)`, fix: '' };
  const parts = [...text.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1].replace(/'\\''/g, "'"));
  const gone = parts.filter((p) => !fs.existsSync(p));
  if (gone.length) return { status: 'warn', detail: `${f} points to a Node.js or Hoprig that is gone`, fix: 'hoprig setup' };
  return { status: 'ok', detail: 'in every shell (~/.local/bin)', fix: '' };
}

// ---- the kits block: the shell lines for toolchains in the workspace's development/ folder ----
//
// ONE block between two marker lines, in the same start files as the PATH line above, written once and replaced in
// place (never a second block). A line: { key, var, value, prepend?, kit? } — `prepend` puts `value` first on PATH
// when it is not on it; else `export var="value"`. The home folder is written as $HOME. A start file that is a link,
// or one whose owner sets that variable (or puts that folder on PATH) himself outside the block, is left as it is,
// and said.
export const BLOCK_BEGIN = '# >>> hoprig kits: toolchains in the workspace (written by hoprig pc setup) >>>';
export const BLOCK_END = '# <<< hoprig kits <<<';
const SAFE_VALUE = /^(\$HOME)?[A-Za-z0-9_@%+=:,./~ -]*$/;

/** A path for a shell line: the home folder as $HOME. null when it holds a character a shell would read. */
export function shellValue(p, home) {
  const v = home && (p === home || p.startsWith(`${home}/`)) ? `$HOME${p.slice(home.length)}` : p;
  return SAFE_VALUE.test(v) && !v.includes(' ') ? v : null;
}

/** One line as a shell writes it, with its key at the end (so the block is replaced line by line). */
export function blockLine(l, fish = false) {
  if (l.prepend) {
    return fish
      ? `contains -- ${l.value} $PATH; or set -gx PATH ${l.value} $PATH  # ${l.key}`
      : `case ":$PATH:" in *":${l.value}:"*) ;; *) PATH="${l.value}:$PATH"; export PATH ;; esac  # ${l.key}`;
  }
  return fish ? `set -gx ${l.var} "${l.value}"  # ${l.key}` : `export ${l.var}="${l.value}"  # ${l.key}`;
}

const keyOf = (l) => (/# ([a-z][a-z0-9-]{0,30})$/.exec(l) || [])[1] || null;

/**
 * The block in a text: { at: [start, end] (line numbers) | null, body: [its lines], lines: Map key → line, broken }.
 * `broken`: a begin line without its end line after it, or more than one begin or end line. Such a file is never
 * written: where the block ends cannot be known, and a guess would take the owner's lines with it.
 */
function readBlock(text) {
  const all = text.split('\n');
  const begins = all.filter((l) => l === BLOCK_BEGIN).length;
  const ends = all.filter((l) => l === BLOCK_END).length;
  const b = all.indexOf(BLOCK_BEGIN);
  const e = b < 0 ? -1 : all.indexOf(BLOCK_END, b + 1);
  if (begins > 1 || ends > 1 || (b >= 0 && e < 0)) return { at: null, body: [], lines: new Map(), all, broken: true };
  if (b < 0) return { at: null, body: [], lines: new Map(), all, broken: false };
  const body = all.slice(b + 1, e);
  const lines = new Map();
  for (const l of body) if (keyOf(l)) lines.set(keyOf(l), l);
  return { at: [b, e], body, lines, all, broken: false };
}

/** Does the owner set this himself, outside the block? (the variable, or the folder on PATH) */
function ownLine(all, at, l) {
  const outside = at ? [...all.slice(0, at[0]), ...all.slice(at[1] + 1)] : all;
  const bare = l.value.replace(/^\$HOME/, '');
  return outside.some((x) => !/^\s*#/.test(x) && (l.prepend ? x.includes('PATH') && bare && x.includes(bare) : new RegExp(`\\b${l.var}=`).test(x) || new RegExp(`set\\s+-gx\\s+${l.var}\\b`).test(x)));
}

const isLink = (f) => {
  try {
    return fs.lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The value the owner gives `name` himself in a start file, outside the kits block: { file, value } (`value`: an
 * absolute path, $HOME or ~ read as the home; null when it cannot be read without a shell), or null when no start file
 * sets it. Start files read one another (.profile reads .bashrc), so one that sets it sets it for all of them.
 */
export function ownValue(name, { home = os.homedir(), shell = process.env.SHELL || '', platform = process.platform } = {}) {
  if (platform === 'win32' || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return null;
  const re = new RegExp(`(?:^|[\\s;])(?:export\\s+)?${name}=("([^"]*)"|'([^']*)'|([^\\s;]*))|set\\s+-gx\\s+${name}\\s+("([^"]*)"|(\\S+))`);
  for (const s of shellFiles({ home, shell, platform })) {
    const { at, all } = readBlock(read(s.file) || '');
    const outside = at ? [...all.slice(0, at[0]), ...all.slice(at[1] + 1)] : all;
    for (const x of outside) {
      if (/^\s*#/.test(x)) continue;
      const m = re.exec(x);
      if (!m) continue;
      let v = [m[2], m[3], m[4], m[6], m[7]].find((y) => y !== undefined) ?? '';
      if (m[3] === undefined) v = v.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/|$)/, home);
      return { file: s.file, value: path.isAbsolute(v) && !/[$`\\]/.test(v) ? path.normalize(v) : null };
    }
  }
  return null;
}

/** Each start file and what it needs for `lines`: [{ file, link, own: [key], due: [line] }]. */
function blockPlan({ home, shell, platform, lines }) {
  // A variable the owner sets himself in any start file is his in all of them: a block in another file, read after
  // his, would set it over his value.
  const anyOwn = new Set(lines.filter((l) => !l.prepend && ownValue(l.var, { home, shell, platform })).map((l) => l.key));
  return shellFiles({ home, shell, platform }).map((s) => {
    const fish = s.file.endsWith('.fish');
    if (isLink(s.file)) return { ...s, fish, link: true, own: [], due: [] };
    const { at, lines: have, all, broken } = readBlock(read(s.file) || '');
    if (broken) return { ...s, fish, link: false, broken: true, own: [], due: [] };
    const here = lines.filter((l) => ownLine(all, at, l)).map((l) => l.key);
    const own = [...here, ...lines.filter((l) => anyOwn.has(l.key) && !here.includes(l.key)).map((l) => l.key)];
    const due = lines.filter((l) => !own.includes(l.key) && have.get(l.key) !== blockLine(l, fish));
    return { ...s, fish, link: false, own, here, due };
  });
}

/** True when every start file has the line already (or is left alone: a link, or the owner's own line). */
export function kitsBlockHas(line, { home = os.homedir(), shell = process.env.SHELL || '', platform = process.platform } = {}) {
  if (platform === 'win32') return true;
  return blockPlan({ home, shell, platform, lines: [line] }).every((f) => !f.due.length);
}

/** Write the block's `lines` into the start files, replacing a line of the same key in place. → { did, kept } */
export function ensureKitsBlock({ home = os.homedir(), shell = process.env.SHELL || '', platform = process.platform, lines = [], dryRun = false } = {}) {
  const did = [];
  const kept = [];
  if (platform === 'win32' || !lines.length) return { did, kept };
  const t = (f) => (f.startsWith(`${home}/`) ? `~${f.slice(home.length)}` : f);
  for (const f of blockPlan({ home, shell, platform, lines })) {
    if (f.link) {
      kept.push(`${t(f.file)} is a link: left as it is (add the lines yourself if you want them there)`);
      continue;
    }
    if (f.broken) {
      kept.push(`${t(f.file)} has a hoprig kits block without its end line, or two begin lines: left as it is (mend or remove the block, then run this again)`);
      continue;
    }
    for (const k of f.own) {
      const v = lines.find((l) => l.key === k).var;
      kept.push(f.here.includes(k) ? `${t(f.file)} sets ${v} itself: your line is left as it is` : `${t(f.file)}: no ${v} line is written, because another of your start files sets it`);
    }
    if (!f.due.length) continue;
    did.push(`${dryRun ? 'would write' : 'wrote'} the kits block in ${t(f.file)}`);
    if (dryRun) continue;
    const text = read(f.file) || '';
    const { at, body, broken, all } = readBlock(text);
    if (broken) continue; // changed since the plan was read: still never written
    // A line of the same key is replaced where it is; a new key goes last; a line without a key (the owner's) stays.
    const next0 = [...body];
    for (const l of f.due) {
      const i = next0.findIndex((x) => keyOf(x) === l.key);
      if (i >= 0) next0[i] = blockLine(l, f.fish);
      else next0.push(blockLine(l, f.fish));
    }
    const block = [BLOCK_BEGIN, ...next0, BLOCK_END];
    let next;
    if (at) next = [...all.slice(0, at[0]), ...block, ...all.slice(at[1] + 1)].join('\n');
    else if (f.at === 'top') next = `${block.join('\n')}\n${text}`;
    else next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block.join('\n')}\n`;
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    fs.writeFileSync(f.file, next);
  }
  return { did, kept };
}
