// Delete, as the Claude Code desktop app deletes a session: an App session or an ended conversation of a folder
// (one a terminal ran, from the folder's Earlier conversations) goes to Hoprig's trash (trash.mjs) for KEEP_DAYS:
// Undo at once, Put back from the trash, removed with its transcript after that. Never one that runs: a chat at
// work or waiting for an OK, a conversation a terminal runs now; the answer says why.
//
//   POST /api/chats/delete               { chats: [chat id], conversations: [{ dir, id }] } (at most DELETE_MAX)
//                                        → { deleted: [{ trash, title, chat? }], refused: [{ chat?, id?, title, why }] }
//                                        (409 with the first reason when nothing could be deleted; 400, with
//                                        nothing moved, for a folder or id a browser may not name)
//   GET  /api/chats/trash                → { list: [{ id, title, short, at, until, kind }], keepDays }
//   POST /api/chats/trash/<entry>/restore  Put back (Undo too) → { chat (the App session opened again) | null }
// The purge runs when the dashboard starts and once a day (purgeEvery), on the clock it is given (tests).
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from '../paths.mjs';
import { alive, statStart } from '../procid.mjs';
import { parentLookup } from '../server/platform.mjs';
import { isSessionId } from '../sessions.mjs';
import { insideRoots } from '../server/folders.mjs';
import * as v from '../server/validate.mjs';
import { readTitles, sessionName } from '../titles.mjs';
import { WRITING_MS, look, unchanged, writtenNow } from './growth.mjs';
import { KEEP_DAYS, WRITTEN_WHY as WRITING_WHY, conversationFiles, trash } from './trash.mjs';

export const DELETE_MAX = 50;
const TITLE_WAIT_MS = 3000; // how long a delete waits for a title answer the session owes (its line is its own)
export { WRITING_MS };

/** `pid` is `root` or runs below it (parentOf: platform.mjs's lookup; a parent it cannot tell ends the walk). */
const below = (pid, root, parentOf) => {
  for (let p = pid, i = 0; p > 1 && i < 64; i++, p = parentOf(p)) if (p === root) return true;
  return false;
};
/**
 * A Claude Code the dashboard did not start runs conversation `id` (the owner's own terminal): Claude Code's own
 * record of what runs, <claudeDir>/sessions/<pid>.json { pid, sessionId, … } (2.1.327 writes one for every running
 * session, headless too, and removes it at the end), names it and that process lives. own: the pid of the App
 * session's own Claude Code, whose record (its own, or a child's under a wrapper) does not count.
 */
export async function runsOutside(id, own = null) {
  const dir = path.join(claudeDir(), 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const live = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (j && j.sessionId === id && Number.isInteger(j.pid) && j.pid > 0 && alive(j.pid) && sameStart(j)) live.push(j.pid);
    } catch {
      /* half written, or not Claude Code's */
    }
  }
  if (!live.length || !own) return live.length > 0;
  const parentOf = await parentLookup();
  return live.some((pid) => !below(pid, own, parentOf));
}
/**
 * The process behind a record's pid is the one that wrote it. A killed Claude Code leaves its record behind, and its pid
 * goes to another process later: Claude Code writes its start (procStart, on Linux the clock ticks since boot of
 * /proc/<pid>/stat field 22), compared where it can be. A record without it, or a system without /proc: the pid decides.
 */
function sameStart(j) {
  if (typeof j.procStart !== 'string' || !/^\d+$/.test(j.procStart)) return true;
  try {
    const now = statStart(fs.readFileSync(`/proc/${j.pid}/stat`, 'utf8'));
    return !now || now === j.procStart;
  } catch {
    return true;
  }
}
const OUTSIDE_WHY = 'It runs in Claude Code outside the dashboard. End it there first.';
const OPEN_WHY = 'It is open in an App session: delete that session there.';
const DAY_MS = 86_400_000;
const ENTRY = '([0-9a-f]{16})';

/**
 * o (from feature.mjs): { chats, load, save, make, chatOr404, openChatOf, freeId, terminalOf, serial, roots(),
 * closeChat(c) (it leaves the list and its process ends), now (clock), step (tests) }
 */
export function deleteRoutes(ctx, o) {
  const { HttpError } = ctx;
  const bad = (m) => new HttpError(400, m);
  const bin = trash({ now: o.now, step: o.step });
  const writingMs = o.writingMs ?? WRITING_MS; // tests: a shorter window (the real clock: o.now is the trash's)
  const working = (c) => c.busy() || c.pending.size > 0 || !!c.starting;
  const who = (c) => (c.engine.id === 'claude' ? 'Claude' : c.engine.label);
  const workingWhy = (c) => (c.pending.size ? `${who(c)} waits for your OK in it. Answer it first.` : `${who(c)} is working in it. Stop it first, or wait until it is done.`);
  const termWhy = (t) => (t.name ? `It runs in the terminal session "${t.name}". End it there first.` : 'It runs in a terminal outside the dashboard. End it there first.');

  /**
   * Delete open chat `c` (checked: not working, no terminal runs it, nobody else writes it). Its own process ends
   * first and writes its last lines (2.1.327: its cost, at the exit), which the session takes as its own; then the
   * check runs again with no process of the session left, and the move is refused when the file changed after it.
   */
  async function deleteChat(c) {
    const file = c.file();
    if (c.engine.id !== 'claude') throw new HttpError(409, `Delete is for Claude Code's sessions; archive this ${c.engine.label} session instead.`);
    const title = c.currentTitle() || 'New session';
    const record = c.record();
    // The journal first, with the session's record (a bad path refuses here, before anything closes): a dashboard
    // stopped while the coding tool ends finds the session in the list or in the trash at its next start.
    const entry = bin.begin(c.cwd, c.conversationId, { title, chat: record });
    const reopen = () => {
      if (o.chats.has(c.id)) return;
      o.make(record); // it could not be moved: the session is open as before
      o.save();
    };
    try {
      await o.closeChat(c);
    } catch (e) {
      bin.drop(entry);
      reopen();
      throw e;
    }
    o.step?.('closed'); // tests: the session left the list, nothing moved yet
    const now = await elsewhere(c.conversationId, file, c);
    if (now.why) {
      bin.drop(entry);
      reopen();
      throw new HttpError(409, now.why);
    }
    entry.chat = c.record(); // with what its process left at its end: after Put back the file is known as its own
    try {
      const e = bin.finish(entry, () => !now.seen || unchanged(file, now.seen));
      o.deleted?.(c.conversationId, c.id);
      return { trash: e.id, title, chat: c.id };
    } catch (e) {
      reopen();
      throw e;
    }
  }

  /**
   * Whether conversation `id` (its transcript `file`) may be moved now: not while a Claude Code outside the dashboard
   * runs it, nor while someone else writes it (moved meanwhile, it would be split between the trash and the folder).
   * c: the App session that has it open; what its own process runs and wrote does not count (growth.mjs: only its own
   * turn end, exit and control answers set what is its own; a page's read never does). → { why ('' when it may),
   * seen (the file's { size, mtimeMs } now: the move is refused when it changed by then) }
   */
  async function elsewhere(id, file, c = null) {
    if (c && c.titlePending) {
      let t;
      await Promise.race([c.titlePending, new Promise((r) => (t = setTimeout(r, TITLE_WAIT_MS)))]);
      clearTimeout(t);
    }
    const own = c && c.session ? c.session.pid : null;
    if (await runsOutside(id, own)) return { why: OUTSIDE_WHY };
    const l = look(file, c ? c.ownStat : null);
    if (writtenNow(l, writingMs)) return { why: WRITING_WHY };
    return { why: '', seen: l ? { size: l.size, mtimeMs: l.mtimeMs } : null };
  }

  /** An App session's record from the trash is listed again (not when its conversation is open already). → its id */
  function giveBack(r) {
    if (!r || !isSessionId(r.id) || typeof r.cwd !== 'string' || !path.isAbsolute(r.cwd) || typeof r.profile !== 'string') return null;
    if (o.openChatOf(r.conversationId || r.id)) return null; // open again meanwhile: not twice
    const id = o.freeId(r.id);
    o.make({ ...r, id, ...(id !== r.id && !r.conversationId ? { conversationId: r.id } : {}) });
    o.save();
    return id;
  }

  /** What a browser may not ask (a folder outside the roots, a bad id): refused before anything of the request moves. */
  function check(item) {
    if (item.chat !== undefined) return;
    const dir = insideRoots(v.absPath(item.dir), o.roots());
    if (!dir) throw bad('choose a folder inside the allowed roots');
    if (!isSessionId(item.id)) throw bad('that is no conversation id');
    conversationFiles(dir, item.id); // a conversation outside Claude Code's projects folder, or not plain files
  }

  /** One item; what cannot be deleted now (gone meanwhile, another coding tool's) is refused with the reason. */
  async function one(item) {
    try {
      return await oneOf(item);
    } catch (e) {
      if (![404, 409].includes(e.status)) throw e;
      return { refused: { ...(item.chat !== undefined ? { chat: item.chat } : { id: item.id }), title: '', why: e.message } };
    }
  }

  async function oneOf(item) {
    if (item.chat !== undefined) {
      const c = o.chatOr404(item.chat);
      return o.serial(c.conversationId, async () => {
        if (working(c)) return { refused: { chat: c.id, title: c.title, why: workingWhy(c) } };
        const t = await o.terminalOf(c.conversationId);
        if (t) return { refused: { chat: c.id, title: c.title, why: termWhy(t) } };
        const { why } = await elsewhere(c.conversationId, c.file(), c);
        if (why) return { refused: { chat: c.id, title: c.title, why } };
        return { deleted: await deleteChat(c) };
      });
    }
    const dir = insideRoots(v.absPath(item.dir), o.roots());
    if (!dir) throw bad('choose a folder inside the allowed roots');
    if (!isSessionId(item.id)) throw bad('that is no conversation id');
    return o.serial(item.id, async () => {
      const open = o.openChatOf(item.id);
      const c = open && o.chats.get(open);
      if (c && working(c)) return { refused: { id: item.id, title: c.title, why: workingWhy(c) } };
      const t = await o.terminalOf(item.id);
      if (t) return { refused: { id: item.id, title: '', why: termWhy(t) } };
      if (c) {
        // Open in an App session: not an ended conversation. Asked as one (a folder's list drawn before the session took
        // it up, another tab), the session is never deleted with it: only its own Delete ({ chats }) does that.
        const { why } = await elsewhere(item.id, c.file(), c);
        return { refused: { id: item.id, title: c.title, why: why || OPEN_WHY } };
      }
      const files = conversationFiles(dir, item.id);
      if (!files.length) throw new HttpError(404, 'that conversation is not in this folder');
      await readTitles([files[0]]);
      const title = sessionName(files[0], item.id) || 'Untitled conversation';
      const { why, seen } = await elsewhere(item.id, files[0]);
      if (why) return { refused: { id: item.id, title, why } };
      const e = bin.put(dir, item.id, { title }, () => !seen || unchanged(files[0], seen));
      o.deleted?.(item.id);
      return { deleted: { trash: e.id, title } };
    });
  }

  function start() {
    try {
      bin.recover((e) => giveBack(e.chat)); // a delete, Put back or purge a stopped dashboard left half done
      bin.purge();
    } catch {
      /* the next day's look tries again */
    }
    const t = setInterval(() => {
      try {
        bin.purge();
      } catch {
        /* tried again tomorrow */
      }
    }, o.purgeEvery || DAY_MS);
    t.unref?.();
    return () => clearInterval(t);
  }

  const routes = [
    ['POST', /^\/api\/chats\/delete$/, async (req) => {
      o.load();
      const b = await ctx.readJson(req);
      const chats = b.chats === undefined ? [] : b.chats;
      const convs = b.conversations === undefined ? [] : b.conversations;
      if (!Array.isArray(chats) || !Array.isArray(convs)) throw bad('say what to delete: chats and conversations are lists');
      if (!chats.length && !convs.length) throw bad('say what to delete');
      if (chats.length + convs.length > DELETE_MAX) throw bad(`at most ${DELETE_MAX} at once`);
      for (const id of chats) if (!isSessionId(id)) throw bad('that is no session id');
      for (const x of convs) if (!x || typeof x !== 'object' || typeof x.dir !== 'string' || typeof x.id !== 'string') throw bad('a conversation is { dir, id }');
      const items = [...chats.map((chat) => ({ chat })), ...convs];
      for (const item of items) check(item);
      const deleted = [];
      const refused = [];
      for (const item of items) {
        const r = await one(item);
        if (r.deleted) deleted.push(r.deleted);
        else refused.push(r.refused);
      }
      ctx.poke?.();
      if (!deleted.length) throw Object.assign(new HttpError(409, refused[0].why), { details: { refused } });
      return { deleted, refused };
    }],
    ['GET', /^\/api\/chats\/trash$/, async () => ({ list: bin.list().map(({ conversationId, cwd, files, ...x }) => x), keepDays: KEEP_DAYS })],
    ['POST', new RegExp(`^/api/chats/trash/${ENTRY}/restore$`), async (req, m) => {
      o.load();
      await ctx.readJson(req);
      const e = bin.get(m[1]);
      if (!e) throw new HttpError(404, 'that is not in the trash (any more)');
      const open = o.openChatOf(e.conversationId);
      if (open) throw new HttpError(409, 'A session with this conversation is open again, so this one was not put back over it.');
      let chat = null;
      bin.restore(e.id, (x) => (chat = giveBack(x.chat))); // listed before the trash forgets it
      ctx.poke?.();
      return { chat };
    }],
  ];
  return { routes, start, trash: bin };
}
