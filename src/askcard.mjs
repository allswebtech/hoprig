// The card of what a coding tool asks the owner, built only from what the tool itself gave (its hook event, its
// channel, its screen), never from a guess. One shape for the App and a terminal, for every coding tool:
//   { kind, tool, engine, source, key, questions?, plan?, permission?, notice?, less? }
//   kind     'question' | 'plan' | 'permission' | 'notice'
//   source   'hook' (Claude Code's hook event), 'channel' (the App's line to the tool), 'screen' (read from the screen)
//   key      the identity of what is asked (tool and input): an answer is given only while the dialog still has it
//   less     what this tool does not tell, in a sentence (OpenCode gives no "recommended" mark), else ''
//   masked   true where a text of the tool's held something that looks like a secret (shown as ***)
//   cut      true where the card shows less than the tool gave (a text over its length, more questions or options)
// A question's options keep the tool's order, each with its own description. `recommended` is the index of the one
// option the tool marked, or null (markedOption). Only node: imports (the hook loads this, and Claude Code waits).
import crypto from 'node:crypto';
import { redact } from './assistant/secrets.mjs';
import { WALL_REASON, WALL_TITLE } from './wall.mjs';

// The tool's own mark: Claude Code 2.1.327 tells its model (AskUserQuestion's description): 'If you recommend a
// specific option, make that the first option in the list and add "(Recommended)" at the end of the label'. Its data has
// no other field for it (seen in the hook's input). So this exact suffix of a label is the mark, and nothing else is.
export const MARK = ' (Recommended)';

/**
 * What a session asks, in one line, from its exact card (cardOf, noticeOnScreen): Tia's status card says this instead
 * of the run's own note. '' when the card says nothing that fits. web/tiacards.js has the same function (a test keeps
 * the two equal).
 */
export const askLine = (c) => {
  if (!c || typeof c !== 'object') return '';
  if (c.kind === 'question' && Array.isArray(c.questions) && c.questions.length && typeof c.questions[0].question === 'string') {
    const more = c.questions.length - 1;
    return `${c.questions[0].question}${more > 0 ? ` (and ${more} more question${more > 1 ? 's' : ''})` : ''}`;
  }
  if (c.kind === 'plan') return 'It shows its plan and asks whether to go ahead.';
  if (c.kind === 'permission' && c.permission && typeof c.permission.tool === 'string' && c.permission.tool) return `Allow ${c.permission.tool}${c.permission.what ? `: ${c.permission.what}` : ''}`;
  if (c.kind === 'notice' && c.notice && typeof c.notice.text === 'string') return c.notice.text;
  return '';
};

const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
// What the card shows of a text the tool gave: masked for secrets first (a key cut in half would no longer look like
// one), then cut. `seen` notes that something was masked or cut: Hands-off leaves such an ask to the owner, since the
// tool and its model read the whole text and the signs would read only a part of it.
const shownText = (seen) => (v, n) => {
  if (typeof v !== 'string') return '';
  const m = redact(v);
  if (m !== v) seen.masked = true;
  if (m.length > n) seen.cut = true;
  return m.slice(0, n);
};

/**
 * The index of the option the tool marked as recommended, or null: exactly one option whose label ends with MARK
 * exactly (that case, that wording, a plain space before it). Two marked options, another wording or language
 * ("(recommended)", "(Empfohlen)", "Recommended:"), or the word in a description or the question is no mark.
 * The label is written by the model, so a page it read can reach it: the signs of handsoff.mjs are the guard for that.
 */
export function markedOption(options) {
  if (!Array.isArray(options)) return null;
  const marked = options.map((o, i) => (o && typeof o.label === 'string' && o.label.length > MARK.length && o.label.endsWith(MARK) ? i : -1)).filter((i) => i >= 0);
  return marked.length === 1 ? marked[0] : null;
}

/** The identity of an ask: its tool and its whole input, hashed. */
export function askKey(tool, input) {
  return crypto.createHash('sha256').update(JSON.stringify([String(tool || ''), input ?? null])).digest('hex').slice(0, 24);
}

// Claude Code's question tool always takes the owner's own words ("Type something"); OpenCode's form only for a field
// of free text: one without options whose type is text (a number field takes no sentence).
const TEXT_FIELDS = new Set(['string', 'text']);
function questionsOf(input, engine, show, seen) {
  const all = input && Array.isArray(input.questions) ? input.questions : [];
  if (all.length > 10) seen.cut = true;
  return all.slice(0, 10).filter((q) => q && typeof q.question === 'string').map((q) => {
    if (Array.isArray(q.options) && q.options.length > 12) seen.cut = true;
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, 12).filter((o) => o && typeof o.label === 'string')
      .map((o) => ({ label: show(o.label, 200), description: show(o.description, 500) }));
    return {
      question: show(q.question, 1000), header: show(q.header, 60), multiSelect: q.multiSelect === true, options,
      recommended: engine === 'claude' ? markedOption(options) : null,
      freeText: engine === 'claude' ? true : options.length === 0 && (q.fieldType === undefined || TEXT_FIELDS.has(q.fieldType)),
    };
  });
}

/**
 * The card of one ask. o: { tool, input (the tool's own input), engine ('claude' | 'opencode'), source, what (a
 * permission's command or file, hook.mjs askedWhat) }.
 */
export function cardOf({ tool, input = {}, engine = 'claude', source = 'hook', what = '' }) {
  const t = cut(String(tool || ''), 80);
  const base = { tool: t, engine, source, key: askKey(t, input) };
  const seen = { masked: false, cut: false };
  const show = shownText(seen);
  const marked = (card) => ({ ...card, ...(seen.masked ? { masked: true } : {}), ...(seen.cut ? { cut: true } : {}) });
  if (t === 'AskUserQuestion') {
    return marked({ ...base, kind: 'question', questions: questionsOf(input, engine, show, seen), less: engine === 'claude' ? '' : 'OpenCode marks no option as recommended.' });
  }
  if (t === 'ExitPlanMode') return marked({ ...base, kind: 'plan', plan: show(input && input.plan, 20000), less: '' });
  return { ...base, kind: 'permission', permission: { tool: t, what: cut(what, 300) }, less: '' };
}

// The trust notice in the tool's own words, as drawn (notice-trust-100.txt): the folder under "Accessing workspace:",
// the question (wrapped over lines, joined again) up to the empty line, what the tool will be able to do, and the two
// answers in their order. Nothing of Hoprig's own; a part not found is left out.
function trustWords(lines) {
  const at = (re) => lines.findIndex((l) => re.test(l));
  const ws = at(/^Accessing workspace:$/);
  const q = at(/^Quick safety check:/);
  const can = at(/be able to read, edit, and execute files here\.$/);
  const end = [can, at(/^Security guide$/), at(/No, exit$/)].filter((i) => i > q).sort((a, b) => a - b)[0] ?? q + 1;
  const answers = lines.filter((l) => /^(?:❯\s*)?(?:\d\.\s*)?(?:No, exit|Yes, I trust this folder)$/.test(l)).map((l) => l.replace(/^(?:❯\s*)?(?:\d\.\s*)?/, ''));
  const cut = (s, n) => String(s || '').slice(0, n);
  return {
    folder: ws >= 0 && lines[ws + 1] && ws + 1 !== q ? cut(lines[ws + 1], 300) : '',
    text: cut(lines.slice(q, end).join(' '), 600),
    detail: can >= 0 ? cut(lines[can], 200) : '',
    answers: answers.slice(0, 2),
  };
}

/**
 * The notices of Claude Code itself that can stand on a terminal's screen, as drawn by 2.1.327 (the captures are in
 * test/server/fixtures/claude-screens/notice-*). Read only where every fixed part is there; anything else is null.
 *   trust   "Quick safety check: Is this a project you created or one you trust?" … "Enter to confirm · Esc to cancel"
 * While the session is still starting (`starting`), also its first-time questions: external CLAUDE.md imports, the
 * once-only Bypass permissions question, and any other numbered choice with "Enter to confirm" (see FIRST_WORDS).
 * A sign-in that ran out and the usage-limit menu are read elsewhere (server/limits.mjs, claudelogin.mjs).
 */
export function noticeOnScreen(screen, { starting = false } = {}) {
  if (typeof screen !== 'string' || !screen) return null;
  const flat = screen.replace(/ /g, ' ').split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = flat.slice(-24).join(' ');
  if (/Quick safety check: Is this a project you created or one you trust\?/.test(tail) && /❯?\s*(?:\d\.\s*)?No, exit/.test(tail)
    && /Yes, I trust this folder/.test(tail) && /Enter to confirm · Esc to cancel$/.test(flat[flat.length - 1] || '')) {
    return { kind: 'notice', notice: { type: 'trust', ...trustWords(flat) }, source: 'screen', tool: '', engine: 'claude', key: 'trust', less: '' };
  }
  // The other questions Claude Code puts before a session has started (its run is still "starting", so no hook has
  // told anything yet): read only then, so a model's text that quotes them later is never taken for one. Each answer
  // must stand on a line of its own. The card says in plain words what is asked; he answers in the terminal.
  if (!starting) return null;
  // Each line with the number the screen gives it ('' for none): the card says only the numbers the screen shows.
  const parts = flat.slice(-24).map((l) => {
    const m = /^(?:❯\s*)?(?:(\d)\.\s*)?(.*)$/.exec(l);
    return { key: m[1] || '', text: m[2] };
  });
  const lines = parts.map((p) => p.text);
  const has = (re) => lines.some((l) => re.test(l));
  // The answers of the last drawing: a screen can still show an older drawing of the same question above the live
  // one, so each answer is taken from its last line, in the screen's order, with the number it has there.
  const answersOf = (re) => {
    const last = new Map();
    parts.forEach((p, i) => re.test(p.text) && last.set(p.text, i));
    return [...last.values()].sort((a, b) => a - b).slice(0, 4).map((i) => parts[i]);
  };
  const first = (type, text, re = null) => {
    const a = re ? answersOf(re) : [];
    return { kind: 'notice', notice: { type, folder: '', text, detail: '', answers: a.map((x) => x.text), keys: a.map((x) => x.key) }, source: 'screen', tool: '', engine: 'claude', key: type, less: '' };
  };
  // The safe answer's number is read from its own line each time, never assumed: a version that puts "Yes" first
  // would otherwise be answered Yes by a person who follows the card. No number on that line, or two different
  // numbers on the screen for it (an older drawing still there): no key is named.
  const keyOf = (safe) => {
    const keys = new Set(parts.filter((p) => p.text === safe).map((p) => p.key));
    return keys.size === 1 ? [...keys][0] : '';
  };
  if (has(/^No, disable external imports$/) && has(/^Yes, allow external imports$/)) {
    return first('imports', firstWords('imports', keyOf('No, disable external imports')), /^(?:No, disable|Yes, allow) external imports$/);
  }
  if (has(/^No, exit$/) && has(/^Yes, I accept$/) && /Bypass Permissions mode/i.test(lines.join(' '))) {
    return first('bypass', firstWords('bypass', keyOf('No, exit')), /^(?:No, exit|Yes, I accept)$/);
  }
  // Another choice of its own (a numbered list and "Enter to confirm" on the last line): what it asks is not known.
  if (flat.some((l) => /^❯\s*1\.\s+\S/.test(l)) && /^Enter to confirm/.test(flat[flat.length - 1] || '')) {
    return first('first', FIRST_WORDS.first);
  }
  return null;
}

/** What the card says for each first-time question of Claude Code (noticeOnScreen); where to answer is the card's. */
export const FIRST_WORDS = Object.freeze({
  // The question in plain words; the safe answer and how to give it follow (firstWords), from what the screen shows.
  imports: 'Claude Code asks you something before it starts: may it read files that this project\'s rules file (CLAUDE.md) brings in from outside its folder?',
  bypass: 'Claude Code asks you something before it starts: do you accept Bypass permissions mode, where it runs commands without asking? It asks once.',
  first: 'Claude Code asks you something before it starts.',
});
// The safe answer of each question, as its line reads, and when it is the safe one.
const SAFE = Object.freeze({
  imports: ['If you did not set this up', 'No, disable external imports'],
  bypass: ['If you did not choose it', 'No, exit'],
});

/**
 * The card's words for first-time question `type`, with `key` the number that stands on the safe answer's own line
 * of the screen ('' when none could be read). With a number it says how to give it, also from a phone (the message
 * box sends the number); without one it names the line by its words and no key at all.
 */
export function firstWords(type, key = '') {
  const q = FIRST_WORDS[type] || FIRST_WORDS.first;
  if (!Object.hasOwn(SAFE, type)) return q;
  const [when, line] = SAFE[type];
  const how = /^\d$/.test(String(key))
    ? `press ${key} in the terminal, or type ${key} in the message box and send it.`
    : `choose "${line}" in the terminal.`;
  return `${q} ${when}, No is the safe answer: ${how}`;
}

// ---- the wall's card: an act that is the owner's alone, held before it ran (wall.mjs, hook.mjs preToolHold) ----

/** As much of the held command as the card shows whole; a longer one is cut plainly, never only its start shown. */
export const HELD_SHOWN = 400;
const PART_KEPT = 4000; // what the run record keeps of it (the wall reads no longer line: it holds it unread)
// How many of a line's held acts the record keeps, the card lists and the terminal line names; the rest are counted.
export const ACTS_LISTED = 10;
// What each answer does, true to what Hoprig does: the page's Allow types the dialog's "Yes" (once, never "don't ask
// again"), and Do not allow its Esc, which stops the turn (web/lib.js permissionActions).
export const HELD_YES = 'Allow runs it this once.';
// Allow types Yes to the tool's dialog, which runs the whole line, so a line with more than one held act says so.
export const HELD_YES_ALL = 'Allow runs the whole command once, including everything listed here.';
export const HELD_NO = 'Do not allow: it does not run, and the session stops and waits for your message.';

/**
 * What the hook keeps in the run record of a hold (`wallHeld`'s result for tool call `tool`): { kind, why, part,
 * length, partOf, tool, at, more? }. The part is masked for secrets first, then kept up to PART_KEPT; `length` is its
 * whole length, so the card can say how much more there is. `more` holds the other acts the same Allow would run
 * (each { why, part, length, partOf }), present only when the line holds more than one — a single hold is unchanged.
 */
export function heldRecord(held, tool, at = Date.now()) {
  if (!held || typeof held !== 'object') return null;
  const one = (h) => {
    const part = redact(String((h && h.part) || ''));
    return { why: h && Object.hasOwn(WALL_REASON, h.why) ? h.why : 'unreadable', part: part.slice(0, PART_KEPT), length: part.length, partOf: (h && h.partOf) === true };
  };
  const acts = Array.isArray(held.acts) && held.acts.length ? held.acts : [held];
  const rec = { kind: String(acts[0].kind || 'unreadable').slice(0, 40), ...one(acts[0]), tool: String(tool || '').slice(0, 40), at };
  const more = acts.slice(1, ACTS_LISTED).map(one);
  if (more.length) rec.more = more;
  // A line of hundreds of held parts: the record stays small, and how many were left out is kept, so no card or line
  // says fewer acts than Allow would run.
  if (acts.length > ACTS_LISTED) rec.notListed = acts.length - ACTS_LISTED;
  return rec;
}

// One held act as the card shows it: { title, what, more, partOf, reason }. The title and the reason come from the
// wall's own tables by the reason id, never from the record's words.
function actView(x) {
  const why = typeof x.why === 'string' && Object.hasOwn(WALL_REASON, x.why) ? x.why : 'unreadable';
  const text = redact(typeof x.part === 'string' ? x.part : '');
  const whole = Number.isInteger(x.length) && x.length >= text.length ? x.length : text.length;
  return { title: WALL_TITLE[why], what: text.slice(0, HELD_SHOWN), more: Math.max(0, whole - Math.min(text.length, HELD_SHOWN)), partOf: x.partOf === true, reason: WALL_REASON[why] };
}

/**
 * The card of a hold, from the run record's `held` (heldRecord): { title, what, more, partOf, file, reason, yes, no,
 * tool, at, acts? }. `what`: the held part whole up to HELD_SHOWN characters, `more`: how many characters are not
 * shown. When the line holds more than one act (record `more`), `acts` lists every one (the primary first) and `yes`
 * says the whole command runs; a single hold keeps its old shape (no `acts`).
 */
export function heldCard(h) {
  if (!h || typeof h !== 'object') return null;
  const tool = typeof h.tool === 'string' ? h.tool.slice(0, 40) : '';
  const extra = Array.isArray(h.more) ? h.more.filter((m) => m && typeof m === 'object') : [];
  const acts = [actView(h), ...extra.slice(0, ACTS_LISTED - 1).map(actView)];
  const notListed = Number.isInteger(h.notListed) && h.notListed > 0 ? h.notListed : 0;
  const multi = acts.length > 1;
  return {
    ...acts[0],
    file: tool !== '' && tool !== 'Bash', // a file a tool would write, not a command
    yes: multi ? HELD_YES_ALL : HELD_YES,
    no: HELD_NO,
    tool,
    at: Number.isFinite(h.at) ? h.at : 0,
    ...(multi ? { acts, count: acts.length + notListed, notListed } : {}),
  };
}

/** The same in one line, for the coding tool's own dialog (permissionDecisionReason), whose answers are Yes and No. */
export function heldLine(held) {
  const c = heldCard(heldRecord(held, 'Bash', 0));
  if (!c) return '';
  const one = (a) => {
    const what = a.what.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 200);
    const more = a.more + Math.max(0, a.what.length - 200);
    return `${what}${more ? ` … (${more} more characters)` : ''}${a.partOf ? ' (part of a longer command)' : ''}`;
  };
  if (c.acts && c.acts.length > 1) {
    const rest = c.notListed ? `; and ${c.notListed} more` : '';
    return `Hoprig holds this for you — the whole command runs ${c.count} things that are yours: ${c.acts.map((a) => `${a.title}: ${one(a)}`).join('; ')}${rest}. Yes runs the whole command once; No does not run it.`;
  }
  return `Hoprig holds this for you: ${one(c)}. ${c.reason} Yes runs it once; No does not run it.`;
}
