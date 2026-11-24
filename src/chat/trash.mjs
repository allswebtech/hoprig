// Hoprig's trash for Claude Code conversations (a deleted session or chat): <stateDir>/trash/<entry>/, kept for
// KEEP_DAYS, then removed with its transcript. Only the files Claude Code made for that one conversation are moved:
// <claudeDir>/projects/<slug>/<id>.jsonl and its own folder <id>/ (subagents, workflows), never a project's files.
//
// Each move is written in a journal first (<entry>/entry.json, state "moving", "restoring" or "purging"), so a
// dashboard killed half way is put right at its next start (recover): a conversation is either where it was or whole
// in the trash, never split. A move is a rename on one disk; a trash on another disk than the conversations is
// refused (nothing is copied, so nothing is half copied).
//
//   entry.json { v, id, state: moving | trashed | restoring | purging, conversationId, cwd, title, at,
//                items: [{ from, name }] (name: under <entry>/files/), chat (the App session's record, to open it
//                again), archived (its Archived row) }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, stateDir, tilde } from '../paths.mjs';
import { isSessionId, projectDir } from '../sessions.mjs';
import { dropOwnName } from '../titles.mjs';

export const KEEP_DAYS = 30;
export const WRITTEN_WHY = 'It is still being written: is it open in a terminal? End it there first, or try again in a moment.';
const DAY_MS = 86_400_000;
const ENTRY_RE = /^[0-9a-f]{16}$/;

export const trashDir = () => path.join(stateDir(), 'trash');
const fail = (status, message) => Object.assign(new Error(message), { status });
const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const exists = (p) => !!lstat(p);
const entryDir = (eid) => path.join(trashDir(), eid);
const filesOf = (eid) => path.join(entryDir(eid), 'files');
const placeOf = (eid, it) => path.join(filesOf(eid), it.name);

function writeEntry(e) {
  const f = path.join(entryDir(e.id), 'entry.json');
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, f);
}
function readEntry(eid) {
  if (!ENTRY_RE.test(String(eid))) return null;
  try {
    const e = JSON.parse(fs.readFileSync(path.join(entryDir(eid), 'entry.json'), 'utf8'));
    return e && e.id === eid && Array.isArray(e.items) ? e : null;
  } catch {
    return null;
  }
}
/** The entry's folder goes once nothing of a conversation is left in it. */
function dropEmpty(eid) {
  let left = [];
  try {
    left = fs.readdirSync(filesOf(eid));
  } catch {
    /* no files folder */
  }
  if (!left.length) fs.rmSync(entryDir(eid), { recursive: true, force: true });
}
function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') throw fail(409, 'The trash is on another disk than Claude Code\'s conversations, so nothing was moved. Set HOPRIG_STATE_DIR to a folder on the same disk.');
    throw e;
  }
}

/** Claude Code's projects folder, as a real path (null: there is none). */
function projectsRoot() {
  try {
    return fs.realpathSync(path.join(claudeDir(), 'projects'));
  } catch {
    return null;
  }
}

/**
 * The files of conversation `id` of folder `cwd`, checked: its .jsonl (a plain file) and its own folder (when there
 * is one), both straight inside the folder's own directory of Claude Code's projects folder, which is no link to
 * somewhere else. [] when it has no file (a session nobody has typed into). Throws 400 for anything else.
 */
export function conversationFiles(cwd, id) {
  if (!isSessionId(id)) throw fail(400, 'that is no conversation id');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail(400, 'that is no folder');
  const root = projectsRoot();
  const dir = projectDir(cwd);
  if (!root || !exists(dir)) return [];
  const real = fs.realpathSync(dir);
  if (path.dirname(real) !== root || path.basename(real) !== path.basename(dir)) throw fail(400, 'that conversation is not in Claude Code\'s projects folder');
  const out = [];
  const file = path.join(real, `${id}.jsonl`);
  const f = lstat(file);
  if (f && !f.isFile()) throw fail(400, 'that conversation\'s file is not a plain file: it is left alone');
  if (f) out.push(file);
  const folder = path.join(real, id);
  const d = lstat(folder);
  if (d && !d.isDirectory()) throw fail(400, 'that conversation\'s folder is not a plain folder: it is left alone');
  if (d) out.push(folder);
  if (!f && d) throw fail(400, 'that conversation has no transcript, only its folder: it is left alone');
  return out;
}

const view = (e) => ({
  id: e.id, conversationId: e.conversationId, cwd: e.cwd, short: tilde(e.cwd), title: e.title || '', at: e.at,
  until: e.at + KEEP_DAYS * DAY_MS, kind: e.chat ? 'session' : 'conversation', files: e.items.length,
});

/**
 * o: { now() (the clock: tests), step(name) (called after each step of the journal: tests stop the process there) }
 * → { put, restore, purge, recover, list, get }
 */
export function trash({ now = () => Date.now(), step = () => {} } = {}) {
  /**
   * Move conversation `id` of folder `cwd` to the trash. t: { title, chat (an App session's record), archived (its
   * Archived row) }. A session with no file yet gets an entry with no files (its record, to open it again).
   */
  function put(cwd, id, t = {}, still = null) {
    return finish(begin(cwd, id, t), still);
  }

  /**
   * The journal of a delete, before anything moves (state "moving", with the App session's record): a delete that
   * must first end the coding tool writes it before the session leaves the list, so a dashboard stopped in between
   * finds the session in the list or in the trash (recover). → the entry, for finish()
   */
  function begin(cwd, id, { title = '', chat = null, archived = null } = {}) {
    const items = conversationFiles(cwd, id).map((from) => ({ from, name: path.basename(from) }));
    const e = { v: 1, id: crypto.randomBytes(8).toString('hex'), state: 'moving', conversationId: id, cwd, title: String(title || '').slice(0, 200), at: now(), items, ...(chat ? { chat } : {}), ...(archived ? { archived } : {}) };
    fs.mkdirSync(filesOf(e.id), { recursive: true, mode: 0o700 });
    writeEntry(e);
    step('journal');
    return e;
  }

  /**
   * Move the files of begin()'s entry `e`. still(): asked at the moment of the move, with the journal written and
   * nothing moved yet, whether the conversation is still as its check saw it (nobody wrote it since); when it is not,
   * nothing moves and the entry goes (409). → the entry as the list shows it
   */
  function finish(e, still = null) {
    const { items } = e;
    const done = [];
    try {
      if (still && !still()) throw fail(409, WRITTEN_WHY);
      for (const [i, it] of items.entries()) {
        move(it.from, placeOf(e.id, it));
        done.push(it);
        step(`moved:${i}`);
      }
    } catch (err) {
      for (const it of done.reverse()) move(placeOf(e.id, it), it.from);
      fs.rmSync(entryDir(e.id), { recursive: true, force: true });
      throw err;
    }
    e.state = 'trashed';
    writeEntry(e);
    step('done');
    return view(e);
  }

  /**
   * Put entry `eid` back where it was. Refused while a conversation with its id is there again. opened(entry): the
   * files are back; called before the journal goes, so the App session is listed again before the trash forgets it.
   * → the entry
   */
  function restore(eid, opened = () => {}) {
    const e = readEntry(eid);
    if (!e || e.state !== 'trashed') throw fail(404, 'that is not in the trash (any more)');
    const root = projectsRoot() || path.join(claudeDir(), 'projects');
    for (const it of e.items) {
      if (path.dirname(path.dirname(it.from)) !== root) throw fail(409, 'Claude Code\'s projects folder moved since: it cannot be put back there');
      if (exists(it.from)) throw fail(409, 'A conversation with the same id is in that folder again, so this one was not put back over it. Delete that one first, or leave this one in the trash.');
    }
    for (const it of e.items) fs.mkdirSync(path.dirname(it.from), { recursive: true, mode: 0o700 });
    e.state = 'restoring';
    writeEntry(e);
    step('journal');
    for (const [i, it] of e.items.entries()) {
      move(placeOf(e.id, it), it.from);
      step(`moved:${i}`);
    }
    opened(e);
    fs.rmSync(entryDir(e.id), { recursive: true, force: true });
    step('done');
    return e;
  }

  /** What was deleted more than KEEP_DAYS ago goes for good, with its transcript. → how many went */
  function purge() {
    let n = 0;
    for (const e of entries()) {
      if (e.state !== 'trashed' || now() - e.at < KEEP_DAYS * DAY_MS) continue;
      gone(e);
      n++;
    }
    return n;
  }
  function gone(e) {
    e.state = 'purging';
    writeEntry(e);
    step('journal');
    fs.rmSync(entryDir(e.id), { recursive: true, force: true });
    forget(e.conversationId);
    step('done');
  }
  /** What Hoprig kept of conversation `id` beside it: its name given here, its turns' ends and OKs (chat-turns). */
  function forget(id) {
    dropOwnName(id);
    if (isSessionId(id)) fs.rmSync(path.join(stateDir(), 'chat-turns', `${id}.jsonl`), { force: true });
  }

  /**
   * After a dashboard that stopped half way: every journal is finished or undone. Never removes what it does not know.
   * back(entry): a delete was undone or a Put back finished, so its App session (entry.chat) is listed again.
   */
  function recover(back = () => {}) {
    let names = [];
    try {
      names = fs.readdirSync(trashDir());
    } catch {
      return;
    }
    for (const eid of names) {
      if (!ENTRY_RE.test(eid)) continue;
      const e = readEntry(eid);
      if (!e) {
        dropEmpty(eid); // made before its journal was written: nothing was moved into it
        continue;
      }
      if (e.state === 'purging') {
        fs.rmSync(entryDir(eid), { recursive: true, force: true });
        forget(e.conversationId);
      } else if (e.state === 'moving') {
        const inTrash = e.items.filter((it) => exists(placeOf(eid, it)) && !exists(it.from));
        // A session with no file yet moved nothing: its delete is undone (its record decides, below).
        if (e.items.length && inTrash.length === e.items.length) {
          e.state = 'trashed'; // all of it got there: it is deleted
          writeEntry(e);
        } else {
          for (const it of inTrash) move(placeOf(eid, it), it.from); // a part got there: all of it goes back
          back(e);
          dropEmpty(eid);
        }
      } else if (e.state === 'restoring') {
        let left = false;
        for (const it of e.items) {
          if (!exists(placeOf(eid, it))) continue;
          if (exists(it.from)) left = true;
          else move(placeOf(eid, it), it.from);
        }
        if (left) {
          e.state = 'trashed';
          writeEntry(e);
        } else {
          back(e);
          dropEmpty(eid);
        }
      }
    }
  }

  function entries() {
    let names = [];
    try {
      names = fs.readdirSync(trashDir());
    } catch {
      return [];
    }
    return names.map(readEntry).filter(Boolean);
  }

  return {
    put,
    begin,
    finish,
    /** Forget begin()'s entry `e`: nothing of it was moved. */
    drop: (e) => fs.rmSync(entryDir(e.id), { recursive: true, force: true }),
    restore,
    purge,
    recover,
    /** What is in the trash, newest first. */
    list: () => entries().filter((e) => e.state === 'trashed').sort((a, b) => b.at - a.at).map(view),
    get: (eid) => {
      const e = readEntry(eid);
      return e && e.state === 'trashed' ? e : null;
    },
  };
}
