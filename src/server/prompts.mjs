// Claude Code's permission question as it stands on the screen: its numbered answers, so the page can offer the
// "Yes, and don't ask again …" answer in Claude's own words and pick it by its number. As drawn:
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and don't ask again for npm install commands in ~/projects/app
//     3. No, and tell Claude what to do differently (esc)
// For a file edit the second answer reads "Yes, allow all edits during this session (shift+tab)".
// Nothing is guessed: only a menu at the bottom of the screen whose first answer is "Yes" counts, and only an
// answer that says "don't ask again" or "allow all edits during this session" is offered. Anything else gives null,
// and the page shows Allow / Do not allow only.

// "❯ 2. Yes, …" inside the box Claude Code may draw around it (│ sides).
const OPTION = /^[\s│┃]*(?:❯\s*)?([1-9])\.\s+(.*?)[\s│┃]*$/;
const ALWAYS = /^Yes,\s*(?:and\s+)?(?:don't|do not)\s+ask again\b|^Yes,\s*allow all edits during this session\b/i;
const norm = (s) => s.replace(/[‘’ʼ]/g, "'").replace(/ /g, ' ');

/**
 * A numbered menu stands at the bottom of `screen` (a permission question, the menu Claude Code shows at a usage
 * limit, any other choice): what is typed now would answer it instead of reaching Claude as a message.
 */
export function menuOpen(screen) {
  return menuOptions(screen) !== null;
}

/** The answers of the menu at the bottom of `screen`: [{ n, text }] in order, or null when there is none. */
export function permissionOptions(screen, lines = 30) {
  const opts = menuOptions(screen, lines);
  return opts && /^Yes\b/i.test(opts[0].text) ? opts : null; // a menu, but not a permission question
}

function menuOptions(screen, lines = 30) {
  if (typeof screen !== 'string' || !screen) return null;
  const tail = screen.split('\n').map((l) => norm(l).replace(/\s+$/, '')).filter((l) => l.replace(/[\s│┃╭╮╰╯─]/g, '')).slice(-lines);
  let last = -1;
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 6); i--) {
    if (OPTION.test(tail[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return null; // no menu among the last lines: the question is gone or scrolled away
  const opts = [];
  let more = [];
  for (let i = last; i >= 0 && last - i < 16; i--) {
    const m = OPTION.exec(tail[i]);
    if (!m) {
      more.unshift(tail[i].replace(/^[\s│┃]+|[\s│┃]+$/g, '')); // an answer Claude Code wrapped onto the next line
      continue;
    }
    opts.unshift({ n: Number(m[1]), text: [m[2], ...more].join(' ').replace(/\s+/g, ' ').trim() });
    more = [];
    if (m[1] === '1') break;
  }
  if (!opts.length || opts[0].n !== 1 || opts.some((o, i) => o.n !== i + 1)) return null;
  return opts;
}

/**
 * The "don't ask again" answer of the permission question on `screen`: { key: '2', text, label } or null. `text` is
 * Claude's own line (the server checks it again before typing the number); `label` is it without "Yes, (and)",
 * for a button next to Allow, without a key hint such as "(shift+tab)".
 */
export function alwaysOption(screen) {
  const opts = permissionOptions(screen);
  const o = opts && opts.find((x) => x.n > 1 && ALWAYS.test(x.text));
  if (!o) return null;
  const rest = o.text.replace(/\s*\((?:shift\+tab|esc)\)\s*$/i, '').replace(/^Yes,\s*(?:and\s+)?/i, '');
  return { key: String(o.n), text: o.text.slice(0, 300), label: `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`.slice(0, 200) };
}
