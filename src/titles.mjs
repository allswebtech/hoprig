// A session's name, as Claude Code names the conversation, everywhere a session is named (the lists, the title bar,
// the tab, Home, a notification). What Claude Code 2.1.327 records in <id>.jsonl, AFTER the conversation's start:
//   {"type":"ai-title","aiTitle":"…"}          the title its small model wrote from the first prompt (written again
//                                              when it changes, e.g. a plan accepted); the newest counts
//   {"type":"custom-title","customTitle":"…"}  a name the person gave it (/rename, the session picker's Ctrl+R)
//   {"type":"summary","summary":"…"}           older versions' summary
// Claude Code's own order (its session picker): the name set, else the generated title, else the summary, else the
// first prompt. THE PERSON'S NEWEST RENAME WINS, WHEREVER IT WAS TYPED (here, or /rename in the coding tool). A
// GENERATED TITLE NEVER WINS OVER A RENAME. A rename made in Hoprig is kept here (<stateDir>/session-names.json, per
// conversation, with the transcript's size then, so a /rename line written after it is known to be newer).
//
// Reading stays cheap: a transcript is only ever appended to, so each file is read once and after that only the bytes
// added since (by size and mtime); a file that shrank is read again from its start. Only short lines are parsed.
import fs from 'node:fs';
import path from 'node:path';
import { inTurn } from './oneturn.mjs';
import { stateDir } from './paths.mjs';
import { replaceFile } from './replacefile.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK = 256 * 1024;
const LINE_MAX = 1024 * 1024; // a longer line (a big tool result) is skipped: no title line is ever that long
const CACHE_MAX = 2000;
const NAME_MAX = 200; // Claude Code caps a name at 200 characters
const cache = new Map(); // file → { size, mtimeMs, at, rest (a Buffer: the cut last line), skip, custom, ai, summary, first }

const plain = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ');
  return '';
};

function readLine(st, buf, end) {
  if (buf.length > LINE_MAX) return;
  const l = buf.toString('utf8');
  const isTitle = l.includes('"custom-title"') || l.includes('"ai-title"') || l.includes('"summary"');
  if (!isTitle && (st.first || !l.includes('"type":"user"'))) return;
  let m;
  try {
    m = JSON.parse(l);
  } catch {
    return;
  }
  if (!m || typeof m !== 'object') return;
  if (m.type === 'custom-title' && plain(m.customTitle)) {
    st.custom = plain(m.customTitle);
    st.customAt = end; // where it ends: a rename made in Hoprig before it is older
  }
  else if (m.type === 'ai-title' && plain(m.aiTitle)) {
    st.ai = plain(m.aiTitle);
    st.aiAt = end;
  }
  else if (m.type === 'summary' && plain(m.summary)) st.summary = plain(m.summary);
  else if (!st.first && m.type === 'user' && !m.isMeta && !m.isSidechain && m.message) {
    const t = textOf(m.message.content).trim();
    // Machine-made turns (command wrappers, reminders, tool results) are not the person's words.
    if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) st.first = plain(t);
  }
}

/** The `n` bytes of `buf` read at offset st.at: its whole lines are read, a cut last line waits for the next piece. */
function eat(st, buf, n) {
  const base = st.at;
  st.at += n;
  let from = 0;
  for (let i = buf.indexOf(10, 0); i >= 0 && i < n; i = buf.indexOf(10, i + 1)) {
    const part = buf.subarray(from, i);
    if (!st.skip) readLine(st, st.rest.length ? Buffer.concat([st.rest, part]) : part, base + i + 1);
    st.rest = Buffer.alloc(0);
    st.skip = false;
    from = i + 1;
  }
  if (from < n && !st.skip) {
    st.rest = Buffer.concat([st.rest, buf.subarray(from, n)]);
    if (st.rest.length > LINE_MAX) {
      st.rest = Buffer.alloc(0);
      st.skip = true; // the rest of this long line is dropped up to its end
    }
  }
}

/** Read what was added to `file` since the last look (at once: only what readTitles() did not read before). */
function catchUp(file, st, size) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(CHUNK);
    while (st.at < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - st.at), st.at);
      if (n <= 0) break;
      eat(st, buf, n);
    }
  } finally {
    fs.closeSync(fd);
  }
}

const fresh = () => ({ size: 0, mtimeMs: 0, at: 0, rest: Buffer.alloc(0), skip: false, custom: '', customAt: 0, ai: '', aiAt: 0, summary: '', first: '' });
const reading = new Map(); // file → the piecewise read under way

/** One file read in pieces off the server's thread, on a copy of its state that is kept only when nothing read it meanwhile. */
async function catchUpLater(file) {
  let s;
  try {
    s = await fs.promises.stat(file);
  } catch {
    return;
  }
  const had = cache.get(file);
  if (had && s.size === had.size && s.mtimeMs === had.mtimeMs) return; // up to date
  const old = had && !(s.size < had.at || (s.size === had.at && s.mtimeMs < had.mtimeMs)) ? had : null;
  const st = old ? { ...old, rest: Buffer.from(old.rest) } : fresh();
  const startAt = had ? had.at : -1; // a read at once meanwhile moves it: then that one is newer and this one is dropped
  let h;
  try {
    h = await fs.promises.open(file, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(CHUNK);
    let end = false;
    // One piece at a time with every other long read (oneturn.mjs): the list's eight readers ran theirs back to back.
    while (st.at < s.size && !end) await inTurn(async () => {
      const { bytesRead } = await h.read(buf, 0, Math.min(CHUNK, s.size - st.at), st.at);
      if (bytesRead <= 0) end = true;
      else eat(st, buf, bytesRead);
    });
  } finally {
    await h.close();
  }
  if (cache.get(file) !== had || (had && had.at !== startAt)) return; // read meanwhile at once: that one is newer
  st.size = s.size;
  st.mtimeMs = s.mtimeMs;
  if (had) Object.assign(had, st);
  else {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(file, st);
  }
}

/**
 * Bring the names of `files` up to date before a list shows them, in pieces of CHUNK bytes read off the server's one
 * thread, a few files at a time: a request that names fifty conversations never holds the thread for a whole file (a
 * conversation of 45 MB was 75 ms at once). After it, conversationTitle() of those files reads nothing more.
 */
export async function readTitles(files, { at = 8 } = {}) {
  const list = [...new Set((files || []).filter((f) => typeof f === 'string' && f))];
  let i = 0;
  const one = async () => {
    while (i < list.length) {
      const f = list[i++];
      if (!reading.has(f)) reading.set(f, catchUpLater(f).catch(() => {}).finally(() => reading.delete(f)));
      await reading.get(f);
    }
  };
  await Promise.all(Array.from({ length: Math.min(at, list.length) }, one));
}

/** Forget every name read (tests: a first look after a start, in one process). */
export const forgetTitles = () => cache.clear();

/**
 * What Claude Code recorded of conversation file `file`: { title (its name for it by Claude Code's order, or ''),
 * custom, customAt and aiAt (the byte each line ends at), ai, summary, first } (each '' when there is none).
 */
export function conversationTitle(file) {
  let s;
  try {
    s = fs.statSync(file);
  } catch {
    cache.delete(file);
    return { title: '', custom: '', customAt: 0, ai: '', aiAt: 0, summary: '', first: '' };
  }
  let st = cache.get(file);
  if (!st || s.size < st.at || (s.size === st.at && s.mtimeMs < st.mtimeMs)) {
    st = fresh();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(file, st);
  }
  if (s.size !== st.size || s.mtimeMs !== st.mtimeMs) {
    catchUp(file, st, s.size);
    st.size = s.size;
    st.mtimeMs = s.mtimeMs;
  }
  return { title: st.custom || st.ai || st.summary || st.first, custom: st.custom, customAt: st.customAt, ai: st.ai, aiAt: st.aiAt, summary: st.summary, first: st.first };
}

// ---------- the names given in Hoprig ----------

const namesFile = () => path.join(stateDir(), 'session-names.json');
let names = { file: null, mtimeMs: -1, map: {} };
function readNames() {
  const f = namesFile();
  let m = -1;
  try {
    m = fs.statSync(f).mtimeMs;
  } catch {
    /* none yet */
  }
  if (names.file !== f || names.mtimeMs !== m) {
    let map = {};
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) map = j;
    } catch {
      /* none yet, or unreadable: no names */
    }
    names = { file: f, mtimeMs: m, map };
  }
  return names.map;
}
function writeNames(map) {
  const f = namesFile();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(map)}\n`, { mode: 0o600 });
  replaceFile(tmp, f);
  names = { file: null, mtimeMs: -1, map: {} }; // read again at the next look
}

/** The name conversation `id` was given in Hoprig: { title, size (its file's size then) } or null. */
export function ownEntry(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  const x = readNames()[id];
  return x && typeof x.title === 'string' && plain(x.title) ? { title: plain(x.title), size: Number.isFinite(x.size) ? x.size : 0 } : null;
}

/** The name conversation `id` was given in Hoprig, or ''. */
export const ownName = (id) => (ownEntry(id) || { title: '' }).title;

/**
 * Keep a name given in Hoprig to conversation `id` (file: its transcript, where it has one). The person's newest
 * rename wins, wherever it was typed: a generated title never replaces it; a /rename made later in the coding tool
 * (a custom-title line after this point of the file) is newer and wins.
 */
export function setOwnName(id, title, file = null) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || !plain(title)) return;
  let size = 0;
  try {
    if (file) size = fs.statSync(file).size;
  } catch {
    /* no file yet */
  }
  writeNames({ ...readNames(), [id]: { title: plain(title), size, at: Date.now() } });
}

/** Forget the name of conversation `id` (it was removed for good). */
export function dropOwnName(id) {
  const map = readNames();
  if (!(id in map)) return;
  const { [id]: gone, ...rest } = map;
  writeNames(rest);
}

/**
 * A session's name: the one given in Hoprig, unless the person renamed it in Claude Code after that; else Claude
 * Code's own name of the conversation in `file` (named, generated, summary, first words).
 */
export function sessionName(file, id = path.basename(String(file || ''), '.jsonl'), live = null, known = '') {
  const own = ownEntry(id);
  const cc = file ? conversationTitle(file) : conversationTitle('');
  if (own && !(cc.custom && cc.customAt > own.size)) return own.title;
  if (cc.custom) return cc.custom;
  // live: { title, size } a title the running coding tool reported (its file may not hold it): the newest generated
  // one, unless the file has a generated title written after it.
  if (live && live.title && !(cc.ai && cc.aiAt > live.size)) return live.title;
  // known: a title kept from before (a chat's record) is more than the first words, which come last.
  return cc.ai || cc.summary || known || cc.first;
}

/** The size of `file` now (0: none). */
export function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
