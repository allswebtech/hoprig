// The plans of Work (docs/WORK.md "Plans"): what stands above a task. A plan is a file of its own beside the task
// list, `plans/<id>.json`, and its research note a Markdown file beside it, `plans/<id>.md`. Its tasks are ordinary
// items of the list that carry `plan` (the plan's id), optionally `milestone` (one of its milestones' ids) and
// `after` (the ids of the tasks they wait for).
//
// A plan: { v: 1, id, title, goal (one sentence), projects: [name], milestones: [{ id, title, date }], note
//   ("<id>.md" or null: the research note it was made from), made: { at, how ("hand" | "proposal") }, status
//   ("active" | "done" | "dropped") }.
// Both files are checked strictly when they are read (a file that does not pass is not a plan: it is named and left
// alone) and when they are written, and written atomically. A planning tool may keep files of its own in that folder
// (prose notes, its own JSON): those are never read as plans, never written, never committed by a save. A note is
// Work's only when a plan of Work names it (isNoteFile), and a new plan never takes a name a file there has.
//
// A note is plain Markdown: no HTML and no image in it, and links only to http and https addresses (checkNoteText), so the page
// can show it as text and a link as its address.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { ID_RE, PROJECT_RE, checkText, checkTitle, findItem, hiddenIn, isYmd, makeId, rawItems, setKey, turnsDirection } from './model.mjs';
import { writeText } from './store.mjs';

export const PLANS_FOLDER = 'plans';
export const PLAN_FILE_RE = /^[a-z0-9][a-z0-9-]{0,79}\.json$/;
export const NOTE_FILE_RE = /^[a-z0-9][a-z0-9-]{0,79}\.md$/;
export const PLAN_STATUSES = ['active', 'done', 'dropped'];
export const PLAN_FILE_MAX = 64 * 1024;
export const NOTE_MAX = 16_000; // characters of a research note
export const NOTE_FILE_MAX = 64 * 1024;
export const GOAL_MAX = 300;
export const MILESTONES_MAX = 12;
export const PROJECTS_MAX = 10;
export const AFTER_MAX = 20;
const KEYS = ['v', 'id', 'title', 'goal', 'projects', 'milestones', 'note', 'made', 'status'];
const DAY_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const bad = (message, code = null) => Object.assign(new Error(message), { status: 400, ...(code ? { details: { code } } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

// ---------- texts ----------

/** Text checked as a title or a note is, and with no character that cannot be seen (the brief's own check). */
export function plainText(s, what) {
  noTurn(s, what);
  checkText(s, what);
  const h = hiddenIn(s);
  if (h) throw bad(`the ${what} has a character that cannot be seen (U+${h.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) in it: take it out`, 'hidden');
  return s;
}

/** A mark that turns the direction around cannot be seen either: refused as one, so "Take them out" applies to it. */
function noTurn(s, what) {
  if (typeof s === 'string' && turnsDirection(s)) throw bad(`the ${what} has a mark that turns the direction of the text around: take it out`, 'hidden');
}

/** A title: one line of 3 to 200 characters, nothing in it that cannot be seen. */
export const cleanTitle = (v, what = 'title') => {
  noTurn(v, what);
  const s = checkTitle(v, what);
  return plainText(s, what);
};

/** A plan's goal: one sentence on one line, 1 to GOAL_MAX characters. */
export function cleanGoal(v) {
  if (typeof v !== 'string') throw bad('the goal must be text');
  const s = v.trim();
  if (/[\r\n]/.test(s)) throw bad('the goal is one sentence on one line');
  plainText(s, 'goal');
  if (!s || s.length > GOAL_MAX) throw bad(`the goal is 1 to ${GOAL_MAX} characters`);
  return s;
}

/**
 * The lines of a Markdown text that are prose: all but what is inside a fenced code block whose two fence lines start
 * at the first column (three or more backticks whose info string holds no backtick, or three or more tildes; closed
 * by a line of the same mark, at least as long, with nothing but blanks after it). Only such a block is code here,
 * because every viewer takes it for code; inline code is prose (viewers read code spans each in its own way), and so
 * is a fence that is indented or in a list or a quote. After a line where such a fence may start, a viewer may be in
 * a block this does not see (its end may be a line this takes for a start), so from there on nothing is code:
 * stricter, never looser. Refused: a block never closed, and a line in a block that ends it for some viewers and not
 * for others (indented, or marks of the other kind after it). `code` false: nothing is code from the start. → the prose.
 */
function proseOf(md, what, code = true) {
  const prose = [];
  let fence = null;
  const run = (s) => {
    let k = 0;
    while (s[k] === fence[0]) k += 1;
    return k;
  };
  for (const line of md.split('\n')) {
    if (fence) {
      const end = /^( {0,3})([`~]+) *$/.exec(line);
      if (end && run(end[2]) >= fence.length) {
        if (end[1] || run(end[2]) < end[2].length) throw bad(`the ${what} has a line that ends a code block for some viewers and not for others ("${line.trim().slice(0, 40)}"): end it with a line of only ${fence}, at the start of the line`, 'fence');
        fence = null;
      }
      continue;
    }
    const open = code && /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      prose.push(open[2]); // its info string is not code
      continue;
    }
    if (FENCE_ELSEWHERE.test(line)) code = false;
    prose.push(line);
  }
  if (fence) throw bad(`the ${what} has a code block that is never closed: end it with a line of ${fence}`, 'fence');
  return prose.join('\n');
}
// A line where a fence may start that does not start at the first column: indented, in a list or in a quote.
const FENCE_ELSEWHERE = /^(?:[ >]|[-+*] |\d{1,9}[.)] )+(?:`{3,}|~{3,})/;

// In a note's prose a "<" before a letter, "/", "!" or "?" is refused: every HTML tag, comment, declaration,
// processing instruction and HTML block starts so, in every viewer. A "<" before anything else is text (a < b, <3, <=).
const HTML_AT = /<[A-Za-z/!?][^\n]{0,38}/;
const htmlIn = (what, tag) => bad(`the ${what} has HTML in it ("${tag}"): a note is plain Markdown, so name the tag in words, put it in a fenced code block of its own (a line of \`\`\` before it and after it, at the start of the line), or write &lt; for the "<"`, 'html');

const WEB_RE = /^https?:\/\/[^\s<>"]+$/i;
const DEF_RE = /^\s{0,3}\[([^\]\n]+)\]:\s*<?(\S*?)>?(?:\s|$)/gm;
/** The targets of the links a Markdown text holds: [text](target), [ref]: target (an autolink is refused as HTML). */
function linkTargets(prose) {
  const out = [];
  for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]*)/g)) out.push(m[1]);
  for (const m of prose.matchAll(DEF_RE)) out.push(m[2]);
  return out;
}

const label = (x) => x.trim().replace(/\s+/g, ' ').toLowerCase();
const escaped = (text, i) => text[i - 1] === '\\';
/**
 * The links of a Markdown text with their words: [{ words, target }] for [words](target), [words][ref], [words][] and
 * [words] with a definition [ref]: target in the text.
 */
function linkPairs(prose) {
  const defs = new Map();
  for (const m of prose.matchAll(DEF_RE)) if (!defs.has(label(m[1]))) defs.set(label(m[1]), m[2]);
  const out = [];
  // Each "]" with its own "[" (brackets in the words counted), in one pass; a blank line ends a paragraph.
  const stack = [];
  for (let k = 0; k < prose.length; k++) {
    const c = prose[k];
    if (c === '\n' && prose[k + 1] === '\n') stack.length = 0;
    if ((c !== '[' && c !== ']') || escaped(prose, k)) continue;
    if (c === '[') {
      stack.push(k);
      continue;
    }
    if (!stack.length) continue;
    const open = stack.pop();
    const words = prose.slice(open + 1, k);
    const rest = prose.slice(k + 1, k + 4097);
    if (rest.startsWith(':') && /^\s{0,3}$/.test(prose.slice(prose.lastIndexOf('\n', open) + 1, open))) continue; // a definition
    const inline = /^\(\s*<?([^)\s>]*)/.exec(rest);
    const ref = /^\[([^\]\n]*)\]/.exec(rest);
    const target = inline ? inline[1] : ref ? defs.get(label(ref[1] || words)) : defs.get(label(words));
    if (target !== undefined) out.push({ words, target });
  }
  return out;
}
// An entity in a link's words (&colon;, &#58;, &#x200b;) is refused: the words hold the character itself.
const ENTITY_RE = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;
/**
 * A link's words as a viewer shows them, near enough to find an address in them: a backslash escape is its
 * character, and the marks of emphasis and code (*, ~, ` and a _ that is not inside a word) are not shown.
 */
function shownWords(words) {
  return words
    .replace(/\\([!-\/:-@[-`{-~])/g, '$1')
    .replace(/[*~`]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '');
}
/** The site of a web address (its host, lower case, without "www."), or null. */
const siteOf = (a) => {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?=www\.))(?:[^@/\s]*@)?([^/\s:?#]+)/i.exec(a);
  return m ? m[1].toLowerCase().replace(/^www\./, '').replace(/\.$/, '') : null;
};

/**
 * A research note, checked: Markdown text of at most NOTE_MAX characters (a tab counts as four spaces), no control
 * character, no character that cannot be seen, no HTML outside a fenced code block (proseOf), no image, links only
 * to http and https addresses (also no "javascript:" or "data:" written out), and no link whose words show another
 * site's address or write a character as an entity. → the note as it is kept.
 */
export function checkNoteText(v, what = 'note') {
  if (typeof v !== 'string') throw bad(`the ${what} must be text`);
  const text = v.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const s = text.trim();
  plainText(s, what);
  if (s.length > NOTE_MAX) throw bad(`the ${what} is ${NOTE_MAX.toLocaleString('en')} characters at most`, 'too-big');
  // Nothing is code when a viewer of the file may read its start otherwise: a first line that was indented (trimmed
  // here it would be a fence, in the file it is none) or a mark of front matter (a viewer shows that block its own way).
  const lead = text.slice(0, text.length - text.trimStart().length);
  const oddStart = (lead && !lead.endsWith('\n') && /^(?:`{3}|~{3})/.test(s)) || /^(?:-{3,}|\+{3,}|;{3,}) *(?:\n|$)/.test(s);
  const prose = proseOf(s, what, !oddStart);
  const tag = HTML_AT.exec(prose);
  if (tag) throw htmlIn(what, tag[0]);
  // An image is loaded by a viewer whenever the note is opened (a tracker learns when it is read): none in a note.
  if (/!\[/.test(prose)) throw bad(`the ${what} has an image in it: a note holds no images, so write the address as a link`, 'image');
  for (const t of linkTargets(prose)) {
    if (!WEB_RE.test(t)) throw bad(`the ${what} has a link that is not a web address ("${t.slice(0, 60)}"): only http and https links are kept`, 'link');
  }
  // A link whose words show a web address leads to that address's site: in a viewer of the repository the words are
  // all one sees of a link.
  for (const { words, target } of linkPairs(prose)) {
    const entity = ENTITY_RE.exec(words);
    if (entity) throw bad(`the ${what} has a link whose words write a character by its name or number ("${entity[0].slice(0, 20)}"): write the character itself`, 'link');
    const seen = shownWords(words);
    const shown = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/i.exec(seen);
    if (shown && siteOf(shown[0]) !== siteOf(target)) throw bad(`the ${what} has a link whose words show another address than the one it leads to ("${seen.slice(0, 60)}" leads to ${String(target).slice(0, 60)}): write the address itself`, 'link');
  }
  const scheme = /\b(javascript|vbscript|data|file):/i.exec(prose);
  if (scheme) throw bad(`the ${what} has a "${scheme[1].toLowerCase()}:" address in it: only http and https links are kept`, 'link');
  return s;
}

// ---------- a plan ----------

/** A milestone, checked: { id, title, date }. */
function checkMilestone(m, i) {
  if (!sameKeys(m, ['id', 'title', 'date'])) throw bad(`milestone ${i + 1} must have exactly an id, a title and a date`);
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw bad(`milestone ${i + 1} has a bad id`);
  cleanTitle(m.title, `title of milestone ${i + 1}`);
  if (m.date !== null && !isYmd(m.date)) throw bad(`milestone ${i + 1}: "${String(m.date).slice(0, 20)}" is not a date (use YYYY-MM-DD)`, 'date');
}

/**
 * Check a plan strictly: every key there and known, every value of its kind and size. `projects`: the workspace's
 * projects, on a write (a plan read from another computer may name a project this one does not have).
 */
export function checkPlan(p, { projects = null } = {}) {
  if (!isObj(p)) throw bad('a plan is an object');
  for (const k of Object.keys(p)) if (!KEYS.includes(k)) throw bad(`"${String(k).slice(0, 30)}" is not a field of a plan`);
  for (const k of KEYS) if (!(k in p)) throw bad(`a plan has a "${k}"`);
  if (p.v !== 1) throw bad('a plan is of version 1');
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) throw bad('a plan\'s id is lower-case letters, digits and "-"');
  if (p.title !== checkTitle(p.title)) throw bad('the title has spaces around it');
  plainText(p.title, 'title');
  if (p.goal !== cleanGoal(p.goal)) throw bad('the goal has spaces around it');
  if (!Array.isArray(p.projects) || p.projects.length > PROJECTS_MAX) throw bad(`a plan names up to ${PROJECTS_MAX} projects`);
  for (const n of p.projects) {
    if (typeof n !== 'string' || !PROJECT_RE.test(n)) throw bad('a project is named by its folder name');
    if (projects && !projects.includes(n)) throw bad(`"${n}" is not a project of the workspace`, 'project');
  }
  if (new Set(p.projects).size !== p.projects.length) throw bad('a project is named once');
  if (!Array.isArray(p.milestones) || p.milestones.length > MILESTONES_MAX) throw bad(`a plan has up to ${MILESTONES_MAX} milestones`);
  p.milestones.forEach(checkMilestone);
  if (new Set(p.milestones.map((m) => m.id)).size !== p.milestones.length) throw bad('two milestones have one id');
  if (p.note !== null && p.note !== `${p.id}.md`) throw bad('a plan\'s note is the Markdown file of its own name, or none');
  if (!sameKeys(p.made, ['at', 'how']) || typeof p.made.at !== 'string' || !DAY_TIME_RE.test(p.made.at) || !['hand', 'proposal'].includes(p.made.how)) throw bad('a plan says when and how it was made');
  if (!PLAN_STATUSES.includes(p.status)) throw bad(`a plan's status is one of: ${PLAN_STATUSES.join(', ')}`);
  return p;
}

/** The text of a plan file: Work's own file, so its own style (two spaces, a final newline). */
export const planText = (p) => `${JSON.stringify(p, null, 2)}\n`;

/** Milestones as the page or a proposal gives them ([{ id?, title, date }]), checked, each with an id of its own. */
export function cleanMilestones(list, keep = []) {
  if (!Array.isArray(list) || list.length > MILESTONES_MAX) throw bad(`a plan has up to ${MILESTONES_MAX} milestones`);
  const out = [];
  for (const [i, m] of list.entries()) {
    if (!isObj(m)) throw bad(`milestone ${i + 1} is an object`);
    for (const k of Object.keys(m)) if (!['id', 'title', 'date'].includes(k)) throw bad(`"${String(k).slice(0, 30)}" is not a field of a milestone`);
    const title = cleanTitle(m.title, `title of milestone ${i + 1}`);
    const date = m.date === undefined || m.date === null || m.date === '' ? null : m.date;
    if (date !== null && !isYmd(date)) throw bad(`milestone ${i + 1}: "${String(date).slice(0, 20)}" is not a date (use YYYY-MM-DD)`, 'date');
    let id = typeof m.id === 'string' && ID_RE.test(m.id) && keep.includes(m.id) && !out.some((x) => x.id === m.id) ? m.id : null;
    if (!id) id = slugOf(title, new Set([...out.map((x) => x.id), ...keep]), 'milestone');
    out.push({ id, title, date });
  }
  return out;
}

// ---------- the files ----------

/** The plans folder of a Work place, checked: a plain folder inside the Work folder (no link). */
export function plansDir(place, { make = false } = {}) {
  const dir = path.join(place.folder, PLANS_FOLDER);
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    /* none yet */
  }
  if (st && !st.isDirectory()) throw Object.assign(new Error(`${place.label}/${PLANS_FOLDER} is not a plain folder (a link or a file): Work leaves it alone`), { status: 409, details: { code: 'plans-folder' } });
  if (!st && make) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A plain file's text (not a link), at most `max` bytes, UTF-8 strictly; null otherwise. */
function readSmall(file, max) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > max) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** A plan file read strictly: { plan } or { why } (why it is not read as a plan), or null when it is not there. */
function readPlanFile(file) {
  if (!fs.existsSync(file) && !isLink(file)) return null;
  const text = readSmall(file, PLAN_FILE_MAX);
  if (text === null) return { why: 'it is not a plain file of at most 64 KiB in UTF-8' };
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    return { why: 'it is not valid JSON' };
  }
  try {
    checkPlan(p);
  } catch (e) {
    return { why: e.message, foreign: !(isObj(p) && p.v === 1) };
  }
  if (`${p.id}.json` !== path.basename(file)) return { why: 'its id is not its name' };
  return { plan: p };
}
const isLink = (file) => {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

/** One plan by its id (checked against the id pattern first), or null. */
export function readPlan(place, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  let dir;
  try {
    dir = plansDir(place);
  } catch {
    return null;
  }
  const r = readPlanFile(path.join(dir, `${id}.json`));
  return r && r.plan ? r.plan : null;
}

/**
 * The plans of a place: { plans (in the order of their names), unreadable: [{ name, why }] }. A JSON file that does not
 * read as a plan of version 1 is a planning tool's own, or anything else: not listed. One that says it is a plan and
 * does not pass the check is named, so the owner can look at it.
 */
export function listPlans(place) {
  let dir;
  let names = [];
  try {
    dir = plansDir(place);
    names = fs.readdirSync(dir).filter((n) => PLAN_FILE_RE.test(n)).sort();
  } catch (e) {
    if (e.status) throw e;
    return { plans: [], unreadable: [] };
  }
  const plans = [];
  const unreadable = [];
  for (const n of names) {
    const r = readPlanFile(path.join(dir, n));
    if (r && r.plan) plans.push(r.plan);
    else if (r && !r.foreign && r.why !== 'it is not valid JSON') unreadable.push({ name: n, why: r.why });
  }
  return { plans, unreadable };
}

/** A plan's research note (its text), or null when it has none or the file does not read as one. */
export function readNote(place, plan) {
  if (!plan || !plan.note) return null;
  let dir;
  try {
    dir = plansDir(place);
  } catch {
    return null;
  }
  const text = readSmall(path.join(dir, plan.note), NOTE_FILE_MAX);
  return text === null ? null : readsAsNote(text);
}

/**
 * A note file's text as Work reads it: the note (checkNoteText: CRLF and tabs as an editor may save them, blanks around
 * it), or null when it does not pass. The page shows exactly what a save takes for Work's (isNoteFile), and a save
 * commits the file as it is. A lone carriage return is refused: viewers do not agree on what it is.
 */
export function readsAsNote(text) {
  if (typeof text !== 'string' || /\r(?!\n)/.test(text)) return null;
  try {
    return checkNoteText(text);
  } catch {
    return null;
  }
}

/** True when `file` is a plan file of Work's: a plain file that reads strictly as a plan of its own name. */
export const isPlanFile = (file) => {
  const r = readPlanFile(file);
  return !!(r && r.plan);
};

/**
 * True when `file` is a research note of Work's: a plain Markdown file of a plan's name, beside a plan file of Work's
 * that names it as its note, that passes the note's check. A planning tool's own note is none of that.
 */
export function isNoteFile(file) {
  const name = path.basename(file);
  if (!NOTE_FILE_RE.test(name)) return false;
  const r = readPlanFile(path.join(path.dirname(file), `${name.slice(0, -3)}.json`));
  if (!r || !r.plan || r.plan.note !== name) return false;
  const text = readSmall(file, NOTE_FILE_MAX);
  return text !== null && readsAsNote(text) !== null;
}

/**
 * What a file of a plan's name is: "plan" or "note" (Work's), "broken" (it says it is Work's and does not pass: named,
 * left alone), or null (a planning tool's own, or anything else: passed over in silence).
 */
export function planFileKind(file) {
  const name = path.basename(file);
  if (PLAN_FILE_RE.test(name)) {
    const r = readPlanFile(file);
    if (!r) return null;
    if (r.plan) return 'plan';
    return r.foreign || r.why === 'it is not valid JSON' ? null : 'broken';
  }
  if (NOTE_FILE_RE.test(name)) {
    if (isNoteFile(file)) return 'note';
    const r = readPlanFile(path.join(path.dirname(file), `${name.slice(0, -3)}.json`));
    return r && r.plan && r.plan.note === name ? 'broken' : null;
  }
  return null;
}

/** A plan from a commit's text, checked, of the name it has there; null when it is no plan of Work's. */
function planOfText(text, name) {
  try {
    const p = JSON.parse(text);
    checkPlan(p);
    return `${p.id}.json` === name ? p : null;
  } catch {
    return null;
  }
}

/**
 * Mark the files of plans' names in commits not sent yet (git.mjs unsentCommits) that are not Work's at that commit (a
 * planning tool's own file of such a name, a file removed): such a path gets a mark before it, so the rule of what a
 * save may send (git.mjs sortUnsent) counts that commit as the owner's own. → the commits.
 */
export async function checkPlanCommits(top, commits, plansRel, run) {
  const blob = async (rev, rel) => {
    const r = await gitRead(top, ['cat-file', 'blob', `${rev}:${rel}`], { run });
    return r.ok ? r.stdout : null;
  };
  for (const c of commits || []) {
    if (!c || !Array.isArray(c.files)) continue;
    for (let i = 0; i < c.files.length; i++) {
      const f = c.files[i];
      if (!f.startsWith(`${plansRel}/`)) continue;
      const name = f.slice(plansRel.length + 1);
      let ok = false;
      if (PLAN_FILE_RE.test(name)) {
        const text = await blob(c.sha, f);
        ok = text !== null && text.length <= PLAN_FILE_MAX && !!planOfText(text, name);
      } else if (NOTE_FILE_RE.test(name)) {
        const text = await blob(c.sha, f);
        const json = await blob(c.sha, `${plansRel}/${name.slice(0, -3)}.json`);
        const plan = json === null ? null : planOfText(json, `${name.slice(0, -3)}.json`);
        ok = !!plan && plan.note === name && text !== null && text.length <= NOTE_FILE_MAX && readsAsNote(text) !== null;
      } else continue;
      if (!ok) c.files[i] = `(not Work's) ${f}`;
    }
  }
  return commits;
}

/** The text of a note file: the note and a final newline. */
export const noteText = (s) => `${s}\n`;

/**
 * A new plan's id: its title's slug and a short mark of the moment it was made (`at`, an ISO time), so the same title
 * planned on two computers gives two plans, never one id for both (a save would have to throw one away). Never a name a
 * file in the plans folder has (a plan's, a note's, any), nor a plan id a task of the list (`items`) still names: a
 * plan whose files are gone does not hand its tasks to a new one.
 */
export function newPlanId(place, title, { at, items = [] } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(plansDir(place));
  } catch {
    /* none yet */
  }
  const taken = new Set([...names.map((n) => n.replace(/\.(json|md)$/i, '').toLowerCase()), ...items.filter((x) => isObj(x) && typeof x.plan === 'string').map((x) => x.plan)]);
  const base = makeId(title, [], '1970-01-01');
  const slug = base.startsWith('task-19700101-') ? 'plan' : base.slice(0, 33).replace(/-+$/, '');
  const mark = crypto.createHash('sha256').update(`${at}\n${title}`).digest('hex').slice(0, 6);
  const id = `${slug}-${mark}`;
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) if (!taken.has(`${id}-${n}`)) return `${id}-${n}`;
}

/** An id made from a title (model.mjs makeId), not in `taken`; a title with no letter a slug can hold: "<prefix>-<n>". */
export function slugOf(title, taken, prefix) {
  const id = makeId(title, [...taken].map((x) => ({ id: x })), '1970-01-01');
  if (!id.startsWith('task-19700101-')) return id;
  for (let n = 1; ; n++) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

/** Where a plan's files go, checked: { dir, json, md } (a file there that is not a plain file is refused). */
export function planPaths(place, id, { make = false } = {}) {
  const dir = plansDir(place, { make });
  const json = path.join(dir, `${id}.json`);
  const md = path.join(dir, `${id}.md`);
  for (const f of [json, md]) {
    let st = null;
    try {
      st = fs.lstatSync(f);
    } catch {
      /* new */
    }
    if (st && !st.isFile()) throw Object.assign(new Error(`${place.label}/${PLANS_FOLDER}/${path.basename(f)} is not a plain file: Work leaves it alone`), { status: 409, details: { code: 'plans-folder' } });
  }
  return { dir, json, md };
}

/** Write a plan (checked strictly against the workspace's projects), atomically. */
export function writePlan(place, plan, { projects = null } = {}) {
  checkPlan(plan, { projects });
  writeText(planPaths(place, plan.id, { make: true }).json, planText(plan));
  return plan;
}

// ---------- tasks and plans (on the list: a change of store.mjs's changeDoc) ----------

/** Ids that wait for each other in a ring (a task that waits for itself through others): the first ring found, or null. */
export function ringIn(edges) {
  const state = new Map();
  const walk = (n, trail) => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...trail.slice(trail.indexOf(n)), n];
    state.set(n, 1);
    for (const m of edges.get(n) || []) {
      const r = walk(m, [...trail, n]);
      if (r) return r;
    }
    state.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) {
    const r = walk(n, []);
    if (r) return r;
  }
  return null;
}

/**
 * Put a task into `plan` (a plan read and checked by the caller): `milestone` one of its milestones' ids or null,
 * `after` the ids of tasks it waits for (undefined: as it is). Checked: the ids are tasks of the list, not the task
 * itself, and no ring of tasks that wait for each other. → the item.
 */
export function putInPlan(doc, ref, { plan, milestone = null, after }) {
  const item = findItem(doc, ref);
  if (milestone !== null && !plan.milestones.some((m) => m.id === milestone)) throw bad(`"${String(milestone).slice(0, 80)}" is not a milestone of this plan`);
  checkAfter(doc, item, after);
  setKey(item, 'plan', plan.id);
  if (milestone) setKey(item, 'milestone', milestone);
  else delete item.milestone;
  setAfter(item, after);
  return item;
}

/**
 * Change only what a task waits for (`after`: [] stops its waiting): its plan and milestone are left as they are and
 * not looked at, so a task whose plan or milestone is gone (a save brought another computer's removal) can stop
 * waiting too. → the item.
 */
export function setWaits(doc, ref, after) {
  const item = findItem(doc, ref);
  if (after === undefined) throw bad('say what the task waits for');
  checkAfter(doc, item, after);
  setAfter(item, after);
  return item;
}

/** `after` for `item` checked (undefined: as it is): tasks of the list, not the task itself, and no ring. */
function checkAfter(doc, item, after) {
  if (after === undefined) return;
  if (!Array.isArray(after) || after.length > AFTER_MAX) throw bad(`a task waits for up to ${AFTER_MAX} others`);
  const ids = new Set(rawItems(doc).map((x) => x.id));
  for (const id of after) {
    if (typeof id !== 'string' || !ID_RE.test(id) || !ids.has(id)) throw bad(`"${String(id).slice(0, 80)}" is not a task of the list`);
    if (id === item.id) throw bad('a task does not wait for itself');
  }
  const edges = new Map(rawItems(doc).filter((x) => typeof x.id === 'string').map((x) => [x.id, x === item ? after : Array.isArray(x.after) ? x.after : []]));
  const ring = ringIn(edges);
  if (ring) throw bad(`these tasks would wait for each other for ever: ${ring.join(' → ')}`, 'ring');
}
const setAfter = (item, after) => {
  if (after === undefined) return;
  if (after.length) setKey(item, 'after', [...new Set(after)]);
  else delete item.after;
};

/**
 * Take a task out of its plan (its plan and milestone go; what it waits for stays, it is about tasks), and/or change what
 * it waits for (`after`: [] stops its waiting; a task in no plan may do that too). → the item.
 */
export function takeOutOfPlan(doc, ref, { after } = {}) {
  const item = findItem(doc, ref);
  if (typeof item.plan !== 'string' && after === undefined) throw Object.assign(new Error(`"${item.id}" is in no plan`), { status: 409 });
  checkAfter(doc, item, after);
  delete item.plan;
  delete item.milestone;
  setAfter(item, after);
  return item;
}
