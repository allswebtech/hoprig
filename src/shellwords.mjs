// The words of ONE command as the shell would hand them to its program, where that can be told with certainty.
//
// The wall (wall.mjs) and the list of administrator forms refused at every level (assistant/adminrefused.mjs) both
// have to know which folder a word of a command names. A word is not its spelling: `~/x`, `$HOME/x`, `${HOME}//x`,
// `~/./x` and `"$HOME"/x` are one folder. This is the ONE reader of that, so no caller keeps a list of spellings of
// its own. It reads what is certain and SAYS where it is not:
//   - a `~` that begins a word (alone, or before a `/`) and `$HOME` / `${HOME}` are the home folder it is given; so
//     is a `~` right after the `=` of a word shaped like an assignment, or after a `:` in one (`of=~/x`,
//     `DIRS=/a:~/b`): bash fills those in for an argument too;
//   - quotes are taken off as the shell does (single quotes keep every character, double quotes keep all but `$`,
//     a backtick and a backslash before one of `"\$` and a backtick);
//   - every other `$…` (another variable, `${HOME:?}`, `${HOME%/}`, `$?`, a `$( … )`), a backtick, `~name` (another
//     user's home, or `~+` / `~-`) and a brace list (`{a,b}`, `{1..3}`) make the word `unsure`: its value cannot be
//     told from the line;
//   - an unquoted `*`, `?` or `[` makes it a `glob`: `fixed` is the text before the first of them, so a caller can
//     tell which folder the pattern is matched in.
// Only the text is read; nothing on disk is looked at here (a caller resolves `..`, links and the real place).
// Only node: imports, and none at all: the hook loads this and the coding tool waits for it.

const NAME = /[A-Za-z0-9_]/;
const ASSIGN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BREAKS = ' \t\r\n;|&()<>';

/**
 * @param {string} text  one command's text (operators such as ; | & and a redirection only part words here)
 * @param {{ home?: string|null }} [o]  the home folder a `~` or `$HOME` stands for (an absolute path)
 * @returns {{ value: string, unsure: boolean, glob: boolean, fixed: string|null, vars: boolean, home: boolean }[]}
 *   `value` the word with what is certain filled in; `vars` it holds a `$` reference of any kind; `home` it was
 *   written with `~`, `$HOME` or `${HOME}`
 */
export function shellWords(text, { home = null } = {}) {
  const out = [];
  if (typeof text !== 'string') return out;
  const homeOk = typeof home === 'string' && home.startsWith('/');
  let w = null;
  const begin = () => (w ||= { value: '', unsure: false, glob: false, fixed: null, vars: false, home: false });
  const end = () => {
    if (w) out.push({ value: w.value, unsure: w.unsure, glob: w.glob, fixed: w.fixed, vars: w.vars, home: w.home });
    w = null;
  };
  const addHome = () => {
    const x = begin();
    x.home = true;
    if (homeOk) x.value += home;
    else x.unsure = true;
  };
  // A `$` at i: → the index of the last character it takes. `$HOME` and `${HOME}` are the home folder; a lone `$`
  // is itself; everything else is a value this reader does not know.
  const dollar = (i) => {
    const x = begin();
    const n = text[i + 1];
    if (n === '{') {
      x.vars = true;
      const e = text.indexOf('}', i + 2);
      if (e < 0) {
        x.unsure = true;
        return text.length - 1;
      }
      if (text.slice(i + 2, e) === 'HOME') addHome();
      else x.unsure = true;
      return e;
    }
    if (n === '(') {
      x.vars = true;
      x.unsure = true;
      return i; // the parenthesis ends the word below
    }
    let j = i + 1;
    while (j < text.length && NAME.test(text[j])) j++;
    if (j === i + 1) {
      if (n !== undefined && '?$!#@*-'.includes(n)) {
        x.vars = true;
        x.unsure = true;
        return i + 1;
      }
      x.value += '$';
      return i;
    }
    x.vars = true;
    if (text.slice(i + 1, j) === 'HOME') addHome();
    else x.unsure = true;
    return j - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (BREAKS.includes(c)) {
      end();
      continue;
    }
    if (c === "'") {
      const x = begin();
      const e = text.indexOf("'", i + 1);
      if (e < 0) {
        x.unsure = true; // a quote that never closes
        x.value += text.slice(i + 1);
        break;
      }
      x.value += text.slice(i + 1, e);
      i = e;
      continue;
    }
    if (c === '"') {
      const x = begin();
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j];
        if (d === '\\' && '"\\$`'.includes(text[j + 1] || '')) x.value += text[++j];
        else if (d === '`') x.unsure = true;
        else if (d === '$') j = dollar(j);
        else x.value += d;
      }
      if (j >= text.length) x.unsure = true; // a quote that never closes
      i = j;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < text.length) begin().value += text[++i];
      continue;
    }
    if (c === '`') {
      begin().unsure = true;
      continue;
    }
    if (c === '$') {
      i = dollar(i);
      continue;
    }
    if (c === '~' && (!w || w.tildeNext === i)) {
      const n = text[i + 1];
      if (n === undefined || n === '/' || n === ':' || BREAKS.includes(n)) addHome();
      else {
        const x = begin();
        x.unsure = true; // ~name, ~+ or ~-: a folder this reader does not know
        x.value += c;
      }
      continue;
    }
    if (w && ((c === '=' && w.assign === undefined && ASSIGN_NAME.test(w.value)) || (c === ':' && w.assign === true))) {
      // NAME=… as an argument: bash fills in a `~` that stands right after the `=`, and after each `:` in its value.
      w.assign = true;
      w.tildeNext = i + 1;
      w.value += c;
      continue;
    }
    if (c === '*' || c === '?' || c === '[') {
      const x = begin();
      if (!x.glob) {
        x.glob = true;
        x.fixed = x.value;
      }
      x.value += c;
      continue;
    }
    if (c === '{') {
      const x = begin();
      const e = text.indexOf('}', i + 1);
      const inner = e < 0 ? '' : text.slice(i + 1, e);
      if (e >= 0 && ![...inner].some((d) => BREAKS.includes(d)) && (inner.includes(',') || inner.includes('..'))) x.unsure = true;
      x.value += c;
      continue;
    }
    begin().value += c;
  }
  end();
  return out;
}

/**
 * The paths a command's words may name, for a caller that asks where each lands. An option is not a path, but the
 * value after its `=` may be (`--target-directory=/x`, `of=/dev/sda`, `NAME=/x`); a glob gives the folder its
 * pattern is matched in (`dir: true`: the entries of that folder are what it names).
 * @returns {{ text: string|null, unsure: boolean, glob: boolean, home: boolean, fixed?: string }[]}  `text` null
 *   where `unsure`; for a pattern, `fixed` is its text before the first `*`, `?` or `[`
 */
export function pathTexts(words) {
  const out = [];
  for (const w of words) {
    if (w.unsure) {
      out.push({ text: null, unsure: true, glob: w.glob, home: w.home });
      continue;
    }
    let t = w.glob ? w.fixed : w.value;
    const eq = t.indexOf('=');
    if (t.startsWith('-')) {
      if (eq < 0) continue; // a plain option
      t = t.slice(eq + 1);
    } else if (eq > 0 && !t.slice(0, eq).includes('/')) {
      t = t.slice(eq + 1);
    }
    const fixed = t;
    if (w.glob) {
      // The folder the pattern is matched in: the fixed text up to its last separator ("" is the folder it runs in).
      const cut = t.lastIndexOf('/');
      t = cut < 0 ? '.' : cut === 0 ? '/' : t.slice(0, cut);
    }
    if (!t) continue;
    out.push({ text: t, unsure: false, glob: w.glob, home: w.home, ...(w.glob ? { fixed } : {}) });
  }
  return out;
}
