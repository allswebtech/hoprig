// Reading and writing Work's list file: one writer at a time, an atomic write, and a file that comes back as it
// went in. The page, Tia and the commands are the one kind of writer of this file; each change runs under the lock
// (lock.mjs), reads the file fresh, changes it and writes it through a temporary file and a rename.
//
// The file's own way of writing JSON is kept: its indent (or one line), its line ends, its final newline and a
// byte-order mark. Before any change the file is checked to come back byte for byte when written unchanged in that
// style; when it would not (a number JSON cannot hold, escapes, a key written twice, mixed line ends, a list on one
// line: jsontext.mjs), Work changes nothing and offers to tidy it once, showing the exact difference first. When a
// change leaves the content as it was, nothing is written at all.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alterText, bytesShown, checkLimits, decodeBytes, limitText, lineDiff, readTree, wouldAlter } from './jsontext.mjs';
import { readJournal } from './journal.mjs';
import { withLock } from './lock.mjs';
import { CLOSED, addItem, fromOf, hiddenIn, insertItem, setKey, doubledIds, editItem, findItem, fixIds, likelyOwnerId, needsOwnerId, placedItems, plannerShape, removeItem, setStatus, statusOf, todayIn, viewItem } from './model.mjs';
import { dayAtOrBefore, nextDay } from '../automation/schedules.mjs';
import { checkRepeat, checkRunAt, nextOccurrence, rollRepeats, ruleOf, setRepeat, setRunAt, takeBackNext } from './repeat.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rawItemsOf = (doc) => (isObj(doc) && Array.isArray(doc.items) ? doc.items.filter(isObj) : []);
/** An item's input without Work's repeat keys, and those checked: { rest, repeat, runAt } (undefined: not given). */
function repeatKeys(input) {
  if (!isObj(input)) return { rest: input };
  const { repeat, runAt, ...rest } = input;
  return { rest, repeat: repeat === undefined ? undefined : checkRepeat(repeat), runAt: runAt === undefined ? undefined : checkRunAt(runAt) };
}
/** Put a rule on an item; one without a date gets the rule's first day from today. */
function applyRepeat(item, rule, runAt, today) {
  if (rule !== undefined) {
    setRepeat(item, rule);
    if (rule && !(typeof item.date === 'string' && item.date)) item.date = dayAtOrBefore(rule, today) === today ? today : nextDay(rule, today);
  }
  if (runAt !== undefined) setRunAt(item, runAt);
}
/**
 * After an item's status changed: closed (done or dropped), its next occurrence when it repeats (→ the new item);
 * opened again, the occurrence that close made is taken back while untouched (repeat.mjs takeBackNext). → new item or null.
 */
export function afterClose(doc, item, today) {
  if (!ruleOf(item)) return null;
  if (CLOSED.has(statusOf(item))) return nextOccurrence(doc, item, today);
  takeBackNext(doc, item);
  return null;
}


/**
 * The file's way of writing JSON: { indent, eol, finalNewline, bom }. One line (no line break before its end): indent
 * 0. A new file: two spaces, "\n", a final newline.
 */
export function formatOf(text) {
  if (typeof text !== 'string' || !text) return { indent: 2, eol: '\n', finalNewline: true, bom: false };
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const m = /\n([ \t]+)["{[\]}]/.exec(body);
  const oneLine = !body.replace(/\r?\n$/, '').includes('\n');
  return { indent: oneLine ? 0 : m ? m[1] : 2, eol: body.includes('\r\n') ? '\r\n' : '\n', finalNewline: /\n$/.test(body), bom };
}

/** A document as text in that format. */
export function serialize(doc, fmt = formatOf('')) {
  let s = JSON.stringify(doc, null, fmt.indent);
  if (fmt.eol !== '\n') s = s.replace(/\n/g, fmt.eol);
  return `${fmt.bom ? '\uFEFF' : ''}${s}${fmt.finalNewline ? fmt.eol : ''}`;
}

/**
 * What a write would alter in a file's text (jsontext.mjs wouldAlter): [] when writing it back unchanged gives the
 * same bytes. Only asked when it does not (the usual file comes back the same at once). `bad`: the file's bytes were
 * not all UTF-8 (decodeBytes): the text then differs from the bytes, and a write would replace those bytes.
 */
export function untidy(text, bad = null) {
  if (text === null) return [];
  const first = bad ? [{ kind: 'bytes', line: bad.line }] : [];
  const fmt = formatOf(text);
  if (serialize(JSON.parse(text.replace(/^\uFEFF/, '')), fmt) === text) return first;
  const list = wouldAlter(text, fmt);
  return [...first, ...(list.length ? list : [{ kind: 'layout' }])];
}

/**
 * A version of the Work file as JSON, read the way readDoc reads one: a file past what Work reads (checkLimits) is
 * refused with the reason before it is parsed. `name`: how the refusal names it.
 */
export function parseText(text, name) {
  const limit = checkLimits(text);
  if (limit) throw Object.assign(new Error(`${name} ${limitText(limit)}: Work changes nothing in it`), { status: 409, code: 'limits', details: { code: 'limits' } });
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

const untidyError = (alters) => Object.assign(new Error(`the Work file has things a write would change (${alters.slice(0, 3).map(alterText).join('; ')}${alters.length > 3 ? `; ${alters.length - 3} more` : ''}): Work changes nothing in it until you tidy it once (Tidy the file once on the Work page, or hoprig tasks tidy)`), { status: 409, code: 'untidy', details: { code: 'untidy' } });

/**
 * Read the list file: { doc, text, bytes, bad, exists }. A missing file is an empty list (made on the first change).
 * The bytes are decoded strictly: `bad` says where the first byte that is not UTF-8 is (untidy then lists it). A file
 * that is not JSON, or deeper or with longer numbers than Work reads, is an error (409) that names it: it is never
 * overwritten.
 */
export function readDoc(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { doc: { items: [] }, text: null, bytes: null, bad: null, exists: false };
    throw Object.assign(new Error(`${path.basename(file)} cannot be read (${plainCode(e)})`), { status: 409, details: { code: 'unreadable' }, detail: e.message });
  }
  const { text, bad } = decodeBytes(bytes);
  const limit = checkLimits(text);
  if (limit) throw Object.assign(new Error(`${path.basename(file)} ${limitText(limit)}: Work reads lists of tasks and changes nothing in this file`), { status: 409, details: { code: 'limits' } });
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // Where it breaks, by line and column: never a piece of its content (it may be private, and it goes to a page).
    let where = '';
    try {
      readTree(text.replace(/^\uFEFF/, ''));
    } catch (e) {
      if (e.line) where = ` at line ${e.line}, column ${e.column}`;
    }
    throw Object.assign(new Error(`${path.basename(file)} is not valid JSON${where}: fix it by hand; Work changes nothing in it until then`), { status: 409, details: { code: 'broken' } });
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw Object.assign(new Error(`${path.basename(file)} is not a JSON object: Work changes nothing in it`), { status: 409, details: { code: 'broken' } });
  return { doc, text, bytes, bad, exists: true };
}

const PLAIN = { EACCES: 'no permission', EPERM: 'no permission', EROFS: 'the disk is read-only', ENOSPC: 'the disk is full', EISDIR: 'it is a folder', ENOENT: 'its folder is gone', EBUSY: 'it is in use' };
/** A system error in a few plain words, without the path the system puts in its message. */
const plainCode = (e) => PLAIN[e && e.code] || (e && /^E[A-Z]+$/.test(e.code) ? e.code : 'a system error');

/** Write atomically (a temporary file next to it, then a rename). Keeps the file's mode when it existed. */
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* a new file */
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    // The system's words name the temporary file's full path: they go to the server's log (`detail`), not the page.
    throw Object.assign(new Error(`the Work file could not be written (${plainCode(e)})`), { status: 409, details: { code: 'unwritable' }, detail: e.message });
  }
}

/** A short hash of a file's bytes (null for a file that is not there). */
const bytesHash = (bytes) => (bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32));

// What the Tidy sheet shows of the difference; the command shows all of it.
export const TIDY_SHOWN = { max: 400, width: 300 };

// ---------- one writer (lock.mjs) ----------

export { lockFile, withLock } from './lock.mjs';

/**
 * One change: read the file fresh, `change(doc)` (may throw: nothing is written), write it when its content moved.
 * `dryRun`: everything but the write. → { result, changed, written }.
 */
export function changeDoc(file, change, { dryRun = false, wait } = {}) {
  return withLock(file, () => changeHeld(file, change, { dryRun }), wait === undefined ? {} : { wait });
}

/** changeDoc for a caller that holds the file's lock already (a run writes its record and the task's status under one). */
export async function changeHeld(file, change, { dryRun = false } = {}) {
  const { doc, text, bad } = readDoc(file);
  // Work never changes what it was not asked to change: a file that would not come back the same is left alone.
  const alters = untidy(text, bad);
  if (alters.length) throw untidyError(alters);
  const before = JSON.stringify(doc);
  const result = await change(doc);
  const changed = JSON.stringify(doc) !== before;
  if (changed && !dryRun) writeText(file, serialize(doc, formatOf(text)));
  return { result, changed, written: changed && !dryRun };
}

// ---------- the store of one place ----------

/**
 * The store for a resolved place (place.mjs resolvePlace) and the projects of the workspace. Every method returns
 * views (model.mjs viewItem), never the raw file.
 */
export function workStore(place, { projects = [], now = () => new Date() } = {}) {
  const s = place.settings;
  const ctx = () => ({ today: todayIn(s.timeZone, now()), ownerId: s.ownerId, projects });
  // A view carries the item's place in the list, read again after the change (an add or a date moves it).
  const view = (raw, doc) => viewItem(raw, { ...ctx(), at: doc && Array.isArray(doc.items) ? doc.items.indexOf(raw) : null });
  const run = async (fn, opts) => {
    let doc;
    const r = await changeDoc(place.file, (d) => fn((doc = d), ctx()), opts);
    return { ...r, doc };
  };
  return {
    place,
    today: () => ctx().today,
    list() {
      const { doc, exists, text, bad } = readDoc(place.file);
      // A planning tool's file: said once, with "your id in this file" filled with the id it uses most.
      const planner = plannerShape(doc) ? { needsId: needsOwnerId(doc, s.ownerId), suggested: likelyOwnerId(doc) } : null;
      return { items: placedItems(doc).map(([x, at]) => viewItem(x, { ...ctx(), at })), exists, untidy: untidy(text, bad), doubles: doubledIds(doc), planner };
    },
    /**
     * What "Tidy the file once" would write: { alters, diff, hash, changed, shownChanged } (alters empty: nothing to
     * tidy). `full`: all of the difference (the command); else as much as the sheet shows (TIDY_SHOWN), and
     * `changed` / `shownChanged` say how many changed lines there are and how many of them are shown.
     */
    tidyPlan({ full = false } = {}) {
      const { doc, text, bytes, bad } = readDoc(place.file);
      const alters = untidy(text, bad);
      if (!alters.length) return { alters, diff: [], hash: bytesHash(bytes), changed: 0, shownChanged: 0 };
      // Bytes that are not UTF-8 are shown as \xNN on the side of the file as it is.
      const before = bad ? bytesShown(bytes) : text;
      const after = serialize(doc, formatOf(text));
      const count = (d) => d.filter((x) => x.op === '+' || x.op === '-').length;
      const all = lineDiff(before, after, { max: Infinity, width: Infinity });
      const diff = full ? all : lineDiff(before, after, TIDY_SHOWN);
      return { alters, diff, hash: bytesHash(bytes), changed: count(all), shownChanged: count(diff), cut: !full && (diff.length < all.length || diff.some((x, i) => x.text !== all[i]?.text)) };
    },
    /** Write the file back once in its own style, only while it still has the bytes whose difference was shown. */
    async tidy(hash, { dryRun = false } = {}) {
      return withLock(place.file, async () => {
        const { doc, text, bytes, bad } = readDoc(place.file);
        if (hash !== bytesHash(bytes)) throw Object.assign(new Error('the Work file changed since its difference was shown: look at it again'), { status: 409, code: 'moved', details: { code: 'moved' } });
        const alters = untidy(text, bad);
        if (alters.length && !dryRun) writeText(place.file, serialize(doc, formatOf(text)));
        return { alters, written: alters.length > 0 && !dryRun };
      });
    },
    // `ref`: { id, at } from the page (its place and its id), or an id alone from the command (model.mjs findItem).
    async add(input, opts) {
      const r = await run((doc, c) => {
        const { rest, repeat, runAt } = repeatKeys(input);
        const item = addItem(doc, rest, c);
        if (repeat || runAt) {
          const at = doc.items.indexOf(item);
          applyRepeat(item, repeat, runAt, c.today);
          // a date given by the rule moves the item to its place
          doc.items.splice(at, 1);
          insertItem(doc.items, item);
        }
        return item;
      }, opts);
      return { item: view(r.result, r.doc), written: r.written };
    },
    /**
     * Add a task for another program (a Work token, tokenfeature.mjs): only a title, a note, a project and a date; the
     * item carries who added it (`from`). Under the file's lock: the token is looked up again (a revoke a moment ago
     * refuses it) and its tasks of today are counted against `perDay`. → { item, written }.
     */
    async addFrom(input, from, { live = () => true, perDay = Infinity } = {}, opts) {
      if (!isObj(input)) throw Object.assign(new Error('send the task as a JSON object'), { status: 400 });
      for (const k of Object.keys(input)) if (!['title', 'note', 'project', 'date'].includes(k)) throw Object.assign(new Error(`"${String(k).slice(0, 30)}" is not something a Work token can set (title, note, project, date)`), { status: 400 });
      // Someone else's words: a character nobody can see is refused, as in a brief (model.mjs checkBrief).
      for (const k of ['title', 'note']) {
        const ch = typeof input[k] === 'string' ? hiddenIn(input[k]) : null;
        if (ch) throw Object.assign(new Error(`the ${k} has a character that cannot be seen (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}): take it out`), { status: 400, details: { code: 'hidden' } });
      }
      const r = await run((doc, c) => {
        if (!live()) throw Object.assign(new Error('this Work token was revoked'), { status: 401, details: { code: 'token' } });
        const mine = rawItemsOf(doc).filter((x) => { const f = fromOf(x); return f && f.token === from.token && x.created === c.today; }).length;
        if (mine >= perDay) throw Object.assign(new Error(`this Work token added ${perDay} tasks today, its limit: try again tomorrow`), { status: 429, details: { code: 'day-limit' } });
        const item = addItem(doc, input, c);
        setKey(item, 'from', { token: from.token, name: from.name, at: now().toISOString() });
        return item;
      }, opts);
      return { item: view(r.result, r.doc), written: r.written };
    },
    async edit(ref, changes, opts) {
      let made = null;
      const r = await run((doc, c) => {
        const { rest, repeat, runAt } = repeatKeys(changes);
        // A task another program added is never run by a schedule: the owner starts it himself (docs/WORK.md).
        if (runAt && fromOf(findItem(doc, ref))) throw Object.assign(new Error('this task came from another program, so it runs only when you start it: no run time'), { status: 400, details: { code: 'from-program' } });
        const has = isObj(rest) && Object.keys(rest).length;
        if (!has && repeat === undefined && runAt === undefined) return editItem(doc, ref, rest, c); // "nothing to change"
        const item = has ? editItem(doc, ref, rest, c) : findItem(doc, ref);
        applyRepeat(item, repeat, runAt, c.today);
        if (has && rest.status !== undefined) made = afterClose(doc, item, c.today);
        return item;
      }, opts);
      return { item: view(r.result, r.doc), written: r.written, ...(made ? { next: view(made, r.doc) } : {}) };
    },
    async status(ref, status, opts) {
      let made = null;
      const r = await run((doc, c) => {
        const out = setStatus(doc, ref, status, c);
        made = afterClose(doc, out.item, c.today);
        return out;
      }, opts);
      return { item: view(r.result.item, r.doc), before: r.result.before, written: r.written, ...(made ? { next: view(made, r.doc) } : {}) };
    },
    /** Move on the repeating items whose day came round again (repeat.mjs rollRepeats). → { moved, written }. */
    async roll(opts) {
      // A save that was interrupted is finished (resume.mjs) before anything else writes the file: a roll on top of
      // its half-written state would make the automatic finish impossible, and the owner's changes would be left only
      // in the journal. Until then nothing moves on.
      if (readJournal(place.file)) return { moved: [], written: false, interrupted: true };
      const { doc } = readDoc(place.file);
      if (!rollRepeats(structuredClone(doc), ctx().today).length) return { moved: [], written: false };
      const r = await run((d, c) => rollRepeats(d, c.today), opts);
      return { moved: r.result, written: r.written };
    },
    async remove(ref, opts) {
      const r = await run((doc, c) => removeItem(doc, ref, c), opts);
      return { item: view(r.result), written: r.written };
    },
    /** "Give the doubles new ids": every item whose id an earlier one has gets one of its own. → { fixed, written }. */
    async fixIds(opts) {
      const r = await run((doc, c) => fixIds(doc, c), opts);
      return { fixed: r.result, written: r.written };
    },
  };
}
