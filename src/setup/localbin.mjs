// The `hoprig` and `hop` commands in every shell, not only in an interactive one.
//
// Why: Node.js installed with nvm is put on PATH by lines in ~/.bashrc that a non-interactive shell never reaches
// (Debian's and Ubuntu's ~/.bashrc stop early when the shell is not interactive), so `ssh <computer> 'hoprig doctor'`
// and a non-interactive login shell said "command not found". Two parts fix that:
//   1. ~/.local/bin/hoprig and ~/.local/bin/hop: tiny scripts that start Hoprig with the full path of the Node.js
//      it runs on now, so they work without nvm loaded. `hoprig setup` writes them again (a new Node.js version
//      moves that path; the doctor says when they point to one that is gone). A file there that is not ours (an npm
//      install with --prefix ~/.local) is left alone.
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
    try {
      const st = fs.lstatSync(f);
      cur = st.isSymbolicLink() ? '' : read(f);
      mine = !st.isSymbolicLink() && cur !== null && cur.includes(WRAP_MARK);
    } catch {
      /* not there */
    }
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
