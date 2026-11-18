// The item model of Work (docs/WORK.md): one list of things to do, each a plain JSON object in a file of the
// workspace. The file may also have been written by a planning tool that keeps the same list (a `deadlines.json`
// with `brands`, `owner` and `client` on its items): it is opened as it is and saved without losing or moving a key
// that this model does not know.
//
// An item: { id, date, approx, title, kind, status, source, note?, priority?, created?, doneAt?,   (the planning
//   tool's keys) project?, by?, plan?, after?, repeat?, work?, runs? }   (Work's own; `plan`, `after`, `repeat`,
//   `work` and `runs` are kept and shown, and filled by later parts of Work: plans, "Do it", repeating items).
// `by` is who does it: "me", "ai" or a role name. A planning-tool file names that `owner`, with the owner's own id
// for "me" (the "ownerId" setting): such an item keeps `owner`, and a new item in such a file gets `owner` too.
// `source` is where an item came from: the owner's id for one he added (only those can be removed), else the plan
// note it was made from (those are dropped instead, so the plan still shows it was decided).
//
// Read tolerantly (a value this model does not understand is shown as the nearest plain value and left in the
// file), checked strictly on a write (every value given is checked before anything changes). Pure: no files here.

export const STATUSES = ['open', 'doing', 'review', 'waiting', 'done', 'dropped'];
// The statuses a planning tool's file knows (it counts only "open" as open work).
export const PLANNER_STATUSES = ['open', 'done', 'dropped'];
export const CLOSED = new Set(['done', 'dropped']);
export const KINDS = ['task', 'deadline', 'gate', 'opportunity'];
export const PRIORITIES = ['high', 'normal', 'low'];
// The order keys take when one is added: the planning tool's order first, then Work's own fields.
export const KEY_ORDER = ['id', 'date', 'approx', 'title', 'brands', 'kind', 'owner', 'by', 'status', 'state', 'source', 'note', 'client', 'priority', 'created', 'doneAt', 'project', 'plan', 'after', 'repeat', 'work', 'runs'];
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const TITLE_MAX = 200;
export const NOTE_MAX = 2000;

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- dates ----------

/** A real calendar day written YYYY-MM-DD. */
export function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** True when the computer knows this time zone name ("" means the computer's own). */
export function validZone(tz) {
  if (tz === '') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's date (YYYY-MM-DD) in `timeZone`, or in the computer's own when none is named. */
export function todayIn(timeZone = '', now = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// "This week" is today and the six days after it: the one rule for Today's "Needs you" and "This week", the Tasks
// part's "Next seven days" (each item's view carries it as `inWeek`) and the command.
export const WEEK_DAYS = 7;
export const inWeek = (days) => typeof days === 'number' && days >= 0 && days < WEEK_DAYS;
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// ---------- keys in place ----------

/**
 * Set `key` on `obj` without moving any key already there: a new key goes right after the last key that comes before
 * it in KEY_ORDER (else before the first that comes after it, else at the end). Keys are redefined as own data
 * properties (a key named "__proto__" stays a key).
 */
export function setKey(obj, key, value) {
  if (own(obj, key)) {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
    return obj;
  }
  const keys = Object.keys(obj);
  let at = keys.length;
  if (KEY_ORDER.includes(key)) {
    const before = KEY_ORDER.slice(0, KEY_ORDER.indexOf(key));
    const after = KEY_ORDER.slice(KEY_ORDER.indexOf(key) + 1);
    const last = keys.findLastIndex((k) => before.includes(k));
    const next = keys.findIndex((k) => after.includes(k));
    if (last >= 0) at = last + 1;
    else if (next >= 0) at = next;
  }
  const entries = keys.map((k) => [k, obj[k]]);
  entries.splice(at, 0, [key, value]);
  for (const k of keys) delete obj[k];
  for (const [k, v] of entries) Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
  return obj;
}

// ---------- reading ----------

/** The items of a file as they are (objects only; anything else stays in the file and is not shown). */
export const rawItems = (doc) => (isObj(doc) && Array.isArray(doc.items) ? doc.items.filter(isObj) : []);
/** The same with each item's place in the list (what the page sends back with its id): [[item, at]]. */
export const placedItems = (doc) => (isObj(doc) && Array.isArray(doc.items) ? doc.items.map((x, at) => [x, at]).filter(([x]) => isObj(x)) : []);

/** Who does an item, in Work's words: "me", "ai" or a role name. */
export function whoOf(raw, ownerId = 'me') {
  const v = typeof raw.by === 'string' ? raw.by : typeof raw.owner === 'string' ? raw.owner : null;
  if (!v) return 'me';
  return v === ownerId ? 'me' : v;
}

/**
 * One item as the page and the commands show it. Unknown values become the nearest plain one (a status this model
 * does not know reads as open); `days` counts from `today` to its date (negative: overdue).
 */
export function viewItem(raw, { ownerId = 'me', today, at = null } = {}) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const date = isYmd(raw.date) ? raw.date : null;
  const status = statusOf(raw);
  return {
    id: str(raw.id),
    at,
    title: str(raw.title) || str(raw.id),
    date,
    approx: raw.approx === true,
    kind: KINDS.includes(raw.kind) ? raw.kind : 'task',
    status,
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
    note: str(raw.note),
    source: str(raw.source),
    created: isYmd(raw.created) ? raw.created : null,
    doneAt: status === 'done' && isYmd(raw.doneAt) ? raw.doneAt : null,
    project: str(raw.project) || null,
    by: whoOf(raw, ownerId),
    brands: Array.isArray(raw.brands) ? raw.brands.filter((b) => typeof b === 'string') : [],
    client: str(raw.client) || null,
    plan: str(raw.plan) || null,
    after: Array.isArray(raw.after) ? raw.after.filter((x) => typeof x === 'string') : [],
    repeat: isObj(raw.repeat) ? raw.repeat : null,
    work: isObj(raw.work) ? raw.work : null,
    runs: Array.isArray(raw.runs) ? raw.runs.filter(isObj) : [],
    days: date && today ? daysBetween(today, date) : null,
    inWeek: !!(date && today) && inWeek(daysBetween(today, date)),
    removable: str(raw.source) === ownerId,
    editable: ID_RE.test(str(raw.id)),
  };
}

// ---------- checks (a write) ----------

// Characters that are not text: control characters (a terminal or a log may act on them) and the marks that turn the
// direction of the text around (a title can then read as something it is not). A line break in a note is text.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const DIRECTION = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
function checkText(s, what) {
  if (CONTROL.test(s)) throw bad(`the ${what} has a control character in it (one that is not text): take it out`);
  if (DIRECTION.test(s)) throw bad(`the ${what} has a mark that turns the direction of the text around: take it out`);
  if (/[\u2028\u2029]/.test(s)) throw bad(`the ${what} has a line separator in it: use a plain line break${what === 'title' ? ' in the note instead' : ''}`);
}
function checkTitle(v) {
  if (typeof v !== 'string') throw bad('the title must be text');
  const s = v.trim();
  if (/[\r\n]/.test(s)) throw bad('the title is one line');
  checkText(s, 'title');
  if (s.length < 3 || s.length > TITLE_MAX) throw bad(`the title is 3 to ${TITLE_MAX} characters`);
  return s;
}
function checkNote(v) {
  if (v === null) return '';
  if (typeof v !== 'string') throw bad('the note must be text');
  const s = v.replace(/\r\n?/g, '\n').trim();
  checkText(s, 'note');
  if (s.length > NOTE_MAX) throw bad(`the note is ${NOTE_MAX} characters at most`);
  return s;
}
function checkDate(v) {
  if (v === null) return null;
  if (!isYmd(v)) throw bad(`"${String(v).slice(0, 20)}" is not a date (use YYYY-MM-DD)`);
  return v;
}
const checkEnum = (name, v, list) => {
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
};
function checkBy(v) {
  if (v === 'me' || v === 'ai' || (typeof v === 'string' && ROLE_RE.test(v))) return v;
  throw bad('who does it is "me", "ai" or a role name (lower-case letters, digits and "-")');
}
function checkProject(v, projects) {
  if (v === null) return null;
  if (typeof v !== 'string' || !PROJECT_RE.test(v)) throw bad('a project is named by its folder name');
  if (!Array.isArray(projects) || !projects.includes(v)) throw bad(`"${v}" is not a project of the workspace`);
  return v;
}
function checkApprox(v) {
  if (typeof v !== 'boolean') throw bad('approx is true or false');
  return v;
}

const ADD_KEYS = ['title', 'date', 'approx', 'kind', 'priority', 'note', 'project', 'by'];
const EDIT_KEYS = [...ADD_KEYS, 'status'];

/** Every value given, checked; nothing changes yet. → the clean values (undefined = not given). */
function checkFields(input, keys, ctx) {
  if (!isObj(input)) throw bad('the item must be an object');
  for (const k of Object.keys(input)) if (!keys.includes(k)) throw bad(`"${String(k).slice(0, 30)}" is not a field of an item`);
  const out = {};
  if (input.title !== undefined) out.title = checkTitle(input.title);
  if (input.date !== undefined) out.date = checkDate(input.date);
  if (input.approx !== undefined) out.approx = checkApprox(input.approx);
  if (input.kind !== undefined) out.kind = checkEnum('kind', input.kind, KINDS);
  if (input.priority !== undefined) out.priority = input.priority === null ? 'normal' : checkEnum('priority', input.priority, PRIORITIES);
  if (input.note !== undefined) out.note = checkNote(input.note);
  if (input.project !== undefined) out.project = checkProject(input.project, ctx.projects);
  if (input.by !== undefined) out.by = checkBy(input.by);
  if (input.status !== undefined) out.status = checkEnum('status', input.status, STATUSES);
  return out;
}

// ---------- ids and order ----------

/** A kebab-case slug of the title (40 characters at most), unique among the items; the planning tool's rule. */
export function makeId(title, items, today) {
  const taken = new Set(items.map((x) => x.id));
  const base = String(title).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  if (!base) {
    const day = String(today).replace(/-/g, '');
    for (let n = 1; ; n++) if (!taken.has(`task-${day}-${n}`)) return `task-${day}-${n}`;
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const dated = (it) => isYmd(it.date);
/** Put an item in its place without moving another one: before the first later (or undated) item; undated last. */
export function insertItem(list, item) {
  let i = list.length;
  if (dated(item)) {
    const j = list.findIndex((x) => x !== item && isObj(x) && (!dated(x) || x.date > item.date));
    if (j >= 0) i = j;
  }
  list.splice(i, 0, item);
}

/** True when the file speaks the planning tool's words: its items name `owner`, and none `by`. */
export const plannerShape = (doc) => {
  const items = rawItems(doc);
  return items.some((x) => own(x, 'owner')) && !items.some((x) => own(x, 'by'));
};

/**
 * The item `ref` names: { id, at } (its place in the list and its id, as the page sends them: both must still fit,
 * so the right one of two items with one id is changed), or an id alone (the command: refused when two items share
 * it, with how to fix that).
 */
export function findItem(doc, ref) {
  const { id, at } = typeof ref === 'string' ? { id: ref } : ref || {};
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('that is not an item id');
  const list = Array.isArray(doc.items) ? doc.items : [];
  if (at !== undefined) {
    if (!Number.isInteger(at) || at < 0) throw bad('the place of an item is a whole number');
    if (!isObj(list[at]) || list[at].id !== id) throw Object.assign(new Error('the list changed since it was shown: look at it again, then try again'), { status: 409, code: 'moved', details: { code: 'moved' } });
    return list[at];
  }
  const found = list.filter((x) => isObj(x) && x.id === id);
  if (!found.length) throw Object.assign(new Error(`there is no item "${id}"`), { status: 404 });
  if (found.length > 1) {
    const which = found.map((x) => `"${String(x.title || '').slice(0, 60)}"`).join(' and ');
    throw Object.assign(new Error(`${found.length} items share the id "${id}" (${which}), so it does not say which one: give the doubles new ids first (hoprig tasks fix-ids), then use the new id`), { status: 409, code: 'doubled', details: { code: 'doubled' } });
  }
  return found[0];
}

/** The ids that more than one item has: [{ id, count, titles }] (two computers that added the same title make them). */
export function doubledIds(doc) {
  const by = new Map();
  for (const x of rawItems(doc)) if (typeof x.id === 'string') by.set(x.id, [...(by.get(x.id) || []), x]);
  return [...by].filter(([, list]) => list.length > 1).map(([id, list]) => ({ id, count: list.length, titles: list.map((x) => viewItem(x).title) }));
}

/** Give every item whose id an earlier item has already a new one of its own (the first keeps it). → [{ from, to, title }]. */
export function fixIds(doc, ctx) {
  const seen = new Set();
  const out = [];
  for (const x of rawItems(doc)) {
    if (typeof x.id !== 'string') continue;
    if (!seen.has(x.id)) {
      seen.add(x.id);
      continue;
    }
    const to = makeId(ID_RE.test(x.id) ? x.id : x.title || 'item', rawItems(doc), ctx.today);
    out.push({ from: x.id, to, title: viewItem(x).title });
    setKey(x, 'id', to);
    seen.add(to);
  }
  return out;
}

/** Write `by` the way the item (or the file) names it: `owner` with the owner's id for "me" in a planner file. */
function setWho(item, by, ctx, planner) {
  if (planner || (own(item, 'owner') && !own(item, 'by'))) setKey(item, 'owner', by === 'me' ? ctx.ownerId : by);
  else setKey(item, 'by', by);
}

/**
 * Write a status. In a planning tool's file a status that tool does not know (doing, review, waiting) is written as
 * status "open" with the real one in Work's own key `state`: that tool counts only "open" as open work, so the item
 * stays in its open lists, and Work reads `state` back as the status (viewItem).
 */
function setStatusKey(item, status, today, planner = false) {
  const before = statusOf(item);
  if (planner && !PLANNER_STATUSES.includes(status)) {
    setKey(item, 'status', 'open');
    setKey(item, 'state', status);
  } else {
    setKey(item, 'status', status);
    delete item.state;
  }
  if (status === 'done') {
    if (before !== 'done' || !isYmd(item.doneAt)) setKey(item, 'doneAt', today);
  } else delete item.doneAt;
}

/** An item's status as Work reads it: `state` (Work's own key) where the file says "open", else `status`. */
export function statusOf(raw) {
  if (raw.status === 'open' && typeof raw.state === 'string' && STATUSES.includes(raw.state)) return raw.state;
  return STATUSES.includes(raw.status) ? raw.status : 'open';
}

/** The owner id a planning tool's file uses most for `owner` (what "your id in this file" is filled with), or null. */
export function likelyOwnerId(doc) {
  const n = new Map();
  for (const x of rawItems(doc)) if (typeof x.owner === 'string' && ID_RE.test(x.owner) && x.owner !== 'ai') n.set(x.owner, (n.get(x.owner) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

/**
 * Whether a planning tool's file still needs the owner's id in it: it does not use `ownerId` anywhere (as an owner or
 * a source). Until it is set, Work writes nothing that would put a word for "me" into such a file (an add, "who
 * does it: me"): the planning tool would not know that word.
 */
export const needsOwnerId = (doc, ownerId) => plannerShape(doc) && !rawItems(doc).some((x) => x.owner === ownerId || x.source === ownerId);
const ownerIdFirst = () => Object.assign(new Error('this list is a planning tool\'s file: say your id in this file first (the line on the Work page, Settings → Work, or hoprig tasks owner <id>), so a new item is written in its words'), { status: 409, code: 'owner-id', details: { code: 'owner-id' } });

// ---------- changes (ctx: { today, ownerId, projects }) ----------

/** Add an item the owner made; returns it. */
export function addItem(doc, input, ctx) {
  const v = checkFields(input, ADD_KEYS, ctx);
  if (v.title === undefined) throw bad('an item needs a title');
  if (!Array.isArray(doc.items)) {
    if (own(doc, 'items')) throw bad('"items" in the file is not a list: fix the file by hand first');
    doc.items = [];
  }
  const planner = plannerShape(doc);
  if (planner && needsOwnerId(doc, ctx.ownerId)) throw ownerIdFirst();
  const item = {};
  setKey(item, 'id', makeId(v.title, rawItems(doc), ctx.today));
  setKey(item, 'date', v.date ?? null);
  setKey(item, 'approx', v.approx ?? false);
  setKey(item, 'title', v.title);
  if (planner) setKey(item, 'brands', []);
  setKey(item, 'kind', v.kind ?? 'task');
  setWho(item, v.by ?? 'me', ctx, planner);
  setKey(item, 'status', 'open');
  setKey(item, 'source', ctx.ownerId);
  if (v.note) setKey(item, 'note', v.note);
  if (v.priority && v.priority !== 'normal') setKey(item, 'priority', v.priority);
  setKey(item, 'created', ctx.today);
  if (v.project) setKey(item, 'project', v.project);
  insertItem(doc.items, item);
  return item;
}

/** Change an item: undefined leaves a field, null clears date, note, project and priority. Returns the item. */
export function editItem(doc, ref, changes, ctx) {
  const item = findItem(doc, ref);
  const v = checkFields(changes, EDIT_KEYS, ctx);
  if (!Object.keys(v).length) throw bad('nothing to change');
  const planner = plannerShape(doc);
  if (v.by === 'me' && planner && needsOwnerId(doc, ctx.ownerId)) throw ownerIdFirst();
  if (v.title !== undefined) setKey(item, 'title', v.title);
  if (v.approx !== undefined) setKey(item, 'approx', v.approx);
  if (v.kind !== undefined) setKey(item, 'kind', v.kind);
  if (v.by !== undefined) setWho(item, v.by, ctx, planner);
  if (v.note !== undefined) (v.note ? setKey(item, 'note', v.note) : delete item.note);
  if (v.priority !== undefined) (v.priority === 'normal' ? delete item.priority : setKey(item, 'priority', v.priority));
  if (v.project !== undefined) (v.project ? setKey(item, 'project', v.project) : delete item.project);
  if (v.status !== undefined) setStatusKey(item, v.status, ctx.today, planner);
  if (v.date !== undefined && v.date !== (dated(item) ? item.date : null)) {
    setKey(item, 'date', v.date);
    doc.items.splice(doc.items.indexOf(item), 1);
    insertItem(doc.items, item);
  }
  return item;
}

/** done | open | drop (and the other statuses by name). → { item, before }. */
export function setStatus(doc, ref, status, ctx) {
  const word = status === 'drop' ? 'dropped' : status;
  checkEnum('status', word, STATUSES);
  const item = findItem(doc, ref);
  const before = statusOf(item);
  if (before === word) throw Object.assign(new Error(`"${item.id}" is ${word} already`), { status: 409 });
  setStatusKey(item, word, ctx.today, plannerShape(doc));
  return { item, before };
}

export const BRIEF_MAX = 4000;
// Characters nobody sees: format characters (zero-width ones, invisible tags, a byte-order mark), the others Unicode
// says are drawn as nothing (variation selectors, Hangul fillers: the way to hide words behind an emoji) and the
// blank braille pattern. In a brief they would reach the coding tool unseen. What is text: a joiner between two
// pictographs (one emoji, also after a skin tone: a person at a laptop with a skin tone), the emoji or text form
// chosen right after an emoji or a keycap's digit, one variation selector right after a CJK character, a math sign or
// a Myanmar letter (where Unicode names such forms), the tags of a region's flag right after the black flag (Scotland:
// a few lower-case letters and digits, then the end tag), and one joiner or non-joiner between two letters or marks of
// a script whose letters join (Arabic and Persian, Syriac, the Indic scripts) or right after an Indic virama, where it
// chooses how they join. After a plain letter a selector shows nothing and changes nothing: one after each letter
// would hide words too, and so would a joiner between Latin letters or a long run of tags.
const HIDDEN = '[\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u2800]';
const JOINING = '[\\p{sc=Arabic}\\p{sc=Syriac}\\p{sc=Devanagari}\\p{sc=Bengali}\\p{sc=Gurmukhi}\\p{sc=Gujarati}\\p{sc=Oriya}\\p{sc=Tamil}\\p{sc=Telugu}\\p{sc=Kannada}\\p{sc=Malayalam}\\p{sc=Sinhala}]';
// The viramas of the Indic scripts: a joiner after one chooses the letter's half form, also at a word's end
// (Malayalam's old way of writing a chillu).
const VIRAMA = '[\\u094D\\u09CD\\u0A4D\\u0ACD\\u0B4D\\u0BCD\\u0C4D\\u0CCD\\u0D4D\\u0DCA]';
const SEEN = [
  '(?<=[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]\\uFE0F?)\\u200D(?=\\p{Extended_Pictographic})',
  '(?<=\\u{1F3F4})[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{2,7}\\u{E007F}',
  `(?<=[\\p{L}\\p{M}])(?<=${JOINING})[\\u200C\\u200D](?=[\\p{L}\\p{M}])(?=${JOINING})`,
  `(?<=\\p{L}${VIRAMA})[\\u200C\\u200D]`,
  '(?<=[\\p{Extended_Pictographic}0-9#*])[\\uFE0E\\uFE0F]',
  '(?<=[\\p{sc=Han}\\p{Sm}\\p{sc=Myanmar}])[\\uFE00-\\uFE0D]',
];
const HIDDEN_RE = new RegExp(`(${SEEN.join('|')})|${HIDDEN}`, 'gu');
/** The first character of `s` that cannot be seen, or null. */
function hiddenIn(s) {
  for (const m of s.matchAll(HIDDEN_RE)) if (m[1] === undefined) return m[0];
  return null;
}
/**
 * `s` without the characters that cannot be seen (what checkBrief refuses), for the owner to take them out at once. One
 * that shows as a blank as wide as a letter (a Hangul filler, the blank braille pattern) becomes a space: the text reads
 * as it looked.
 */
export const withoutHidden = (s) => String(s).replace(HIDDEN_RE, (m, seen) => (seen !== undefined ? m : /[\u3164\uFFA0\u2800]/.test(m) ? ' ' : ''));
/**
 * A brief for a session ("Do it"): text of 1 to BRIEF_MAX characters, line breaks allowed; checked like a note, and
 * nothing in it that cannot be seen. Also the brief made from a task (briefOf) is checked so before a session gets it:
 * a title or note that came from another computer was never checked here.
 */
export function checkBrief(v) {
  if (typeof v !== 'string') throw bad('the brief must be text');
  const s = v.replace(/\r\n?/g, '\n').trim();
  checkText(s, 'brief');
  const hidden = hiddenIn(s);
  // The brief without them comes along (details.clean): the owner cannot see where they are to take them out himself.
  if (hidden) throw Object.assign(bad(`the brief has a character that cannot be seen (U+${hidden.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) in it: take it out`), { details: { code: 'brief-hidden', clean: withoutHidden(s) } });
  if (!s || s.length > BRIEF_MAX) throw bad(`the brief is 1 to ${BRIEF_MAX} characters`);
  return s;
}

/** The brief a session of this item starts with: the one kept on it (`work.brief`), else its title and note. */
export function briefOf(raw) {
  if (isObj(raw.work) && typeof raw.work.brief === 'string' && raw.work.brief.trim()) return raw.work.brief;
  const v = viewItem(raw);
  return v.note ? `${v.title}\n\n${v.note}` : v.title;
}

/** Keep a brief on the item (`work.brief`), beside anything else its `work` holds. Nothing changes when it is the same. */
export function setBrief(item, brief) {
  const b = checkBrief(brief);
  if (briefOf(item) === b) return item;
  setKey(item, 'work', { ...(isObj(item.work) ? item.work : {}), brief: b });
  return item;
}

/** Remove an item the owner added himself; one made from a plan note is dropped instead. */
export function removeItem(doc, ref, ctx) {
  const item = findItem(doc, ref);
  if (item.source !== ctx.ownerId) {
    const from = typeof item.source === 'string' && item.source ? ` (${item.source})` : '';
    throw Object.assign(new Error(`"${item.id}" came from a plan${from}, so it is not removed: drop it instead`), { status: 409 });
  }
  doc.items.splice(doc.items.indexOf(item), 1);
  return item;
}
