// What Claude Code asks on the screen, read from the terminal's text. Two readers:
//   menuOpen          any numbered menu at the bottom (a permission, a question, the menu at a usage limit): what is
//                     typed now would answer it instead of reaching Claude as a message
//   permissionDialog  Claude Code's PERMISSION dialog and nothing else: the page's Allow, Do not allow and "always"
//                     are typed only while it stands there (server.mjs), and its "always" answer is offered from it
//
// The permission dialog of Claude Code 2.1.326, as drawn 80 columns wide (the real captures are in
// test/server/fixtures/claude-screens/perm-*):
//   ────────────────────────────────────────                    a rule the full width of the terminal
//    Bash command                                                (Create file, Edit file, Read file, Fetch, …)
//    Create empty file b.txt
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌                    the dashed frame around what is asked
//    touch b.txt
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    Do you want to proceed?                                     ("Do you want to create w.txt?", "… make this edit …")
//    ❯ 1. Yes                                                    one space, the arrow or a space, a space, the number
//      2. Yes, and always allow access to /home/alex/app from
//         this project                                           an answer wraps six spaces deep
//      3. Yes, and switch to auto mode · auto mode handles these prompts for you
//      4. No
//
//    Esc to cancel · Tab to amend                                (none for a web fetch: its last answer ends "(esc)")
// A subagent's: " Bash command · from the general-purpose agent   2 of 2" on top, and the footer
// "Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents", cut with "…" where it does not fit.
// On a narrow terminal every other line wraps, the short footer too ("Esc to cancel ·" / "Tab to amend"); at 16
// columns all of it but the full-width rule still fits a 40-line capture, at 12 columns the question scrolls away and
// nothing is recognised.
//
// The other things Claude Code asks look alike but are not permissions, and are told apart by these fixed parts:
//   the question tool (AskUserQuestion)   its menu starts at the left edge, its footer reads "Enter to select · …"
//   the plan's approval (ExitPlanMode)    indented three spaces, its first answer switches the mode, no footer of ours
//   the folder trust dialog               no numbers, "Enter to confirm · Esc to cancel"
// and a model's own text that copies a dialog stands in the conversation above the message box, never at the bottom.
// Anything not recognised is not a permission dialog: the page then tells the owner to answer in the terminal.

// "❯ 2. Yes, …" inside the box older versions drew around it (│ sides): any menu, for menuOpen.
const OPTION = /^[\s│┃]*(?:❯\s*)?([1-9])\.\s+(.*?)[\s│┃]*$/;
const norm = (s) => s.replace(/[‘’ʼ]/g, "'").replace(/ /g, ' ').replace(/\s+$/, '');

/**
 * A numbered menu stands at the bottom of `screen` (a permission question, the menu Claude Code shows at a usage
 * limit, any other choice): what is typed now would answer it instead of reaching Claude as a message.
 */
export function menuOpen(screen) {
  if (typeof screen !== 'string' || !screen) return false;
  if (permissionDialog(screen)) return true; // also where its long wrapped answers push "1." out of the lines below
  const tail = screen.split('\n').map(norm).filter((l) => l.replace(/[\s│┃╭╮╰╯─]/g, '')).slice(-30);
  let last = -1;
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 6); i--) {
    if (OPTION.test(tail[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return false; // no menu among the last lines: the question is gone or scrolled away
  const nums = [];
  for (let i = last; i >= 0 && last - i < 16; i--) {
    const m = OPTION.exec(tail[i]);
    if (!m) continue; // an answer wrapped onto the next line
    nums.unshift(Number(m[1]));
    if (m[1] === '1') break;
  }
  return nums[0] === 1 && nums.every((n, i) => n === i + 1);
}

// The fixed parts of the permission dialog (see the top of this file).
const DIALOG_OPTION = /^ ([❯ ]) ([1-9])\. (\S.*)$/; // " ❯ 1. Yes", "   2. No"
const DIALOG_MORE = /^ {6}(\S.*)$/; // an answer wrapped onto the next line
// The footer, a subagent's with its own words; one too long for the terminal is cut with "…" on one line.
const FOOTERS = ['Esc to cancel · Tab to amend', 'Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents'];
const isFooter = (text) => FOOTERS.includes(text)
  || (text.endsWith('…') && text.startsWith('Esc to cancel') && FOOTERS.some((f) => f.startsWith(text.slice(0, -1).trimEnd())));
// A web fetch has no footer; its last answer is this (compared without spaces: a narrow terminal breaks its words).
const NO_FOOTER_LAST = 'No,andtellClaudewhattododifferently(esc)';
const QUESTION = /^Do you want to .+\?$/;
const FRAME = /^(?:─{4,}|╌{4,})$/; // a rule of the dialog, from the left edge: the full-width one or the dashed one
const LOOK_UP = 60; // the dialog's rule is searched this many lines above its question

const joined = (lines) => lines.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim();

/**
 * Claude Code's permission dialog at the bottom of `screen`: { options: [{ n, text }], cursor (the number of the
 * answer the arrow is on, which Enter would take), framed (what stands inside its dashed frame: the command, a file's
 * new text or diff, Read(path), the address), file (the file a "Create file" or "Edit file" dialog names under its
 * title, else '') }, or null when what stands there is anything else or cannot be told for sure. Every fixed part must
 * be where the dialog draws it. The lines between the title and the frame are not read for `framed`: one of them is
 * the model's own description of the command.
 */
export function permissionDialog(screen) {
  if (typeof screen !== 'string' || !screen) return null;
  const lines = screen.split('\n').map(norm);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  // The footer: the lines after the last empty one, read as one (it wraps on a narrow terminal).
  let end = lines.length; // the options end before this line
  let blank = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (!lines[i].trim()) {
      blank = i;
      break;
    }
  }
  const footer = blank >= 0 && isFooter(joined(lines.slice(blank + 1)));
  if (footer) end = blank;
  // The answers, from the bottom up: numbered from 1 without a gap, each with its wrapped lines.
  const opts = [];
  let more = [];
  let cursor = 0;
  let i = end - 1;
  for (; i >= 0 && end - i <= 80; i--) {
    const m = DIALOG_OPTION.exec(lines[i]);
    if (m) {
      opts.unshift({ n: Number(m[2]), text: joined([m[3], ...more]) });
      if (m[1] === '❯') cursor = Number(m[2]);
      more = [];
      if (m[2] === '1') break;
      continue;
    }
    const w = DIALOG_MORE.exec(lines[i]);
    if (!w) return null; // a line the dialog does not draw there
    more.unshift(w[1]);
  }
  if (i < 0 || more.length || !opts.length || opts[0].n !== 1 || opts.some((o, k) => o.n !== k + 1)) return null;
  if (opts[0].text !== 'Yes' || !/^No\b/.test(opts[opts.length - 1].text) || opts.length < 2) return null;
  if (!footer && opts[opts.length - 1].text.replace(/\s/g, '') !== NO_FOOTER_LAST) return null;
  // The question right above the answers, one space in ("Do you want to …?", wrapped over at most four lines).
  let q = -1;
  for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
    if (!/^ \S/.test(lines[k])) break;
    if (/^ Do you want to\b/.test(lines[k])) {
      q = k;
      break;
    }
  }
  if (q < 0 || !QUESTION.test(joined(lines.slice(q, i)))) return null;
  // And the dialog's own frame above it.
  const above = lines.slice(Math.max(0, q - LOOK_UP), q);
  if (!above.some((l) => FRAME.test(l))) return null;
  const top = above.findLastIndex((l) => /^─{4,}$/.test(l));
  const dashes = above.map((l, k) => (k > top && /^╌{4,}$/.test(l) ? k : -1)).filter((k) => k >= 0);
  const framed = dashes.length >= 2 ? joined(above.slice(dashes[0] + 1, dashes[dashes.length - 1])) : '';
  const title = top >= 0 ? joined(above.slice(top + 1, top + 2)) : '';
  const file = dashes.length && /^(?:Create|Edit) file$/.test(title) ? joined(above.slice(top + 2, dashes[0])) : '';
  return { options: opts, cursor, framed, file };
}

/**
 * Does the permission dialog on `screen` show `what`, the command or file a card was about (hook.mjs askedWhat: one
 * line, cut to 120 characters with "…", secrets masked)? What its frame holds (permissionDialog framed) must be that
 * command, Read(that file) or "url: that address", and begin so where the card's text was cut; read with every blank
 * taken out on both sides, as a terminal wraps a long line anywhere. A file the card names by its full path counts
 * also where a "Create file" or "Edit file" dialog names it relative to `cwd` (w.txt). False where it cannot be told:
 * nothing to compare, a masked secret, no dialog.
 */
export function dialogShows(screen, what, cwd = null) {
  const d = permissionDialog(screen);
  if (!d || typeof what !== 'string' || what.includes('***')) return false;
  const flat = (s) => s.replace(/\s+/g, '');
  const cut = what.endsWith('…');
  const want = flat(cut ? what.slice(0, -1) : what);
  if (!want) return false;
  const framed = flat(d.framed);
  if (cut ? [want, `Read(${want}`, `url:${want}`].some((w) => framed.startsWith(w))
    : framed === want || framed === `Read(${want})` || [`url:${want}prompt:`, `url:${want}/prompt:`].some((w) => framed.startsWith(w))) return true;
  const base = typeof cwd === 'string' && cwd ? `${cwd.replace(/\/+$/, '')}/` : null;
  const named = flat(d.file);
  return !!named && !cut && (named === want || (!!base && what.startsWith(base) && named === flat(what.slice(base.length))));
}

/** Claude Code's permission dialog stands at the bottom of `screen` (permissionDialog). */
export const permissionQuestion = (screen) => permissionDialog(screen) !== null;

// The answers that allow more than this one call, as Claude Code 2.1.326 words them (and older versions did):
//   "Yes, and always allow access to <folder> from this project"    a command that reaches a folder
//   "Yes, allow reading from <folder> during this session"          a read outside the project
//   "Yes, and don't ask again for <domain or command>"              a web fetch; a command (older versions)
//   "Yes, allow all edits during this session (shift+tab)"          a file edit (older versions)
// Not one: "Yes, and switch to auto mode" or "… to accept edits": they change the session's mode, not this permission.
const ALWAYS = /^Yes,\s*(?:and\s+)?(?:(?:don't|do not)\s+ask again\b|always allow access to\b|allow reading from\b|allow all edits during this session\b)/i;

/**
 * The "always" answer of the permission dialog on `screen`: { key: '2', text, label } or null. `text` is Claude's own
 * line (the server checks it again before typing the number); `label` is it without "Yes, (and)", for a button next
 * to Allow, without a key hint such as "(shift+tab)".
 */
export function alwaysOption(screen) {
  const d = permissionDialog(screen);
  const o = d && d.options.find((x) => x.n > 1 && ALWAYS.test(x.text));
  if (!o) return null;
  const rest = o.text.replace(/\s*\((?:shift\+tab|esc)\)\s*$/i, '').replace(/^Yes,\s*(?:and\s+)?/i, '');
  return { key: String(o.n), text: o.text.slice(0, 300), label: `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`.slice(0, 200) };
}
