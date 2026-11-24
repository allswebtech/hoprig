// Reading a chat's conversation back (chat.mjs): from the coding tool's file (Claude Code), or through its server
// (OpenCode), which answers later. The page starts over with what was read; a terminal that went on with the
// conversation is followed by reading it again when it changed.
import fs from 'node:fs';
import { oneLine } from './events.mjs';
import { look, statOf } from './growth.mjs';
import { EVENTS_MAX } from './timeline.mjs';
import { readAllowed, readTurns, withAllowed, withTurns } from './turns.mjs';

const STAMP_MS = 3000; // a conversation kept by a tool's server is looked at no more often than this

/**
 * Read the conversation (the page starts over). A rewound one: the old one up to its message. A tool whose store is
 * read through its server answers later: what it read is taken unless a turn started meanwhile. wake: false (when the
 * dashboard starts) reads such a store only from a server that runs already; the chat reads it once a page looks at
 * it (refresh), so a saved chat never starts the tool's server by itself.
 */
export function load(chat, { wake = true } = {}) {
  if (chat.fork && chat.engine.exists(chat.cwd, chat.conversationId) === true) chat.fork = null;
  const f = chat.fork;
  const id = f ? f.from : chat.conversationId;
  // At the start (wake: false) a long conversation's last part comes first, read in pieces that give the thread back;
  // the rest when the page asks for it (earlier below). Any later read (a terminal went on with it) reads it whole.
  const tail = !wake && !f && chat.engine.tail ? chat.engine.tail({ cwd: chat.cwd, id }) : null;
  const t = tail || chat.engine.transcript({ cwd: chat.cwd, id }, chat.o.engineOpts, { start: wake });
  if (tail) {
    chat.tailing = true;
    tail.finally(() => (chat.tailing = false)).catch(() => {});
  }
  if (!t || typeof t.then !== 'function') return loaded(chat, t, f, id);
  const gen = chat.gen;
  chat.loading = t.then((x) => {
    if (!x) chat.unread = true;
    else if (!chat.closed && gen === chat.gen && !chat.session && !chat.turn && id === chat.conversationId) loaded(chat, x, f, id);
  }, () => {
    chat.unread = true; // asked again at the next look
  }).finally(() => {
    chat.loading = null;
  });
  return chat.loading;
}

function loaded(chat, t, f, id) {
  chat.unread = false;
  // Each turn's cost and time, and what Hoprig allowed by itself (turns.mjs).
  t = { ...t, events: withAllowed(withTurns(t.events, readTurns(chat.o.turnsDir, id)), readAllowed(chat.o.turnsDir, id)) };
  if (f && f.messageId) t = cutAt(t, f.messageId); // a fork of the whole conversation shows all of it
  // { start, id }: its earlier part is not read yet. The id stays the conversation read: after /clear the chat's id is
  // the new conversation's, while the events before the clear (and their earlier part) are still the old one's.
  chat.partial = t.partial ? { ...t.partial, id } : null;
  chat.reset(t.events, chat.partial ? EVENTS_MAX : 0);
  chat.todos = t.todos;
  chat.todosGen++;
  // The to-do list of the earlier part: read when a page (or a message) first looks at the session, not at the start
  // for every open one (most are never looked at before their next read).
  chat.todosOwed = chat.partial && t.raw && chat.engine.todosBefore ? { id, raw: t.raw, gen: chat.todosGen } : null;
  if (chat.looked) todosNow(chat);
  chat.tasks.load(t.tasks);
  const last = [...t.events].reverse().find((e) => e.kind === 'text' && !e.agent);
  chat.lastText = last ? last.text : '';
  if (t.title && !chat.named) chat.title = t.title;
  if (!chat.title && !chat.partial) {
    const first = t.events.find((e) => e.kind === 'user');
    if (first) chat.title = oneLine(first.text, 80);
  }
  for (const e of t.events) if (e.kind === 'user' && e.messageId) chat.shown.add(e.messageId);
  chat.knownSize = f ? 0 : t.size; // a rewound conversation has no file of its own yet
  // A chat of hers from before a restart: hers again only when the conversation is exactly what its record knew.
  if (chat.restoredMark) {
    const { known } = chat.restoredMark;
    chat.restoredMark = null;
    if (known !== null && known === chat.knownSize) chat.byTia = true;
    chat.emit('record');
  }
  chat.emit('change');
  chat.emit('state');
}

/**
 * A conversation read from its last part: the to-do list its earlier part's calls leave (one written before the last
 * part, or tasks created there), read in pieces once the session is looked at (refresh). By construction a list that came
 * after the read that left this debt (a live TodoWrite or task call of the tool, a read again) always wins: the debt
 * keeps the count of lists it was left at (todosGen), and the earlier part's list is taken only while that count holds.
 */
function todosNow(chat) {
  const owed = chat.todosOwed;
  if (!owed || chat.todosRead || !chat.partial) return;
  chat.todosOwed = null;
  if (owed.gen !== chat.todosGen) return; // a newer list came before the look: nothing older to read
  chat.todosRead = chat.engine.todosBefore({ cwd: chat.cwd, id: owed.id }, chat.partial.start, owed.raw).then((list) => {
    if (chat.closed || chat.todosGen !== owed.gen) return; // a newer list came while it was read
    chat.todos = list;
    chat.todosGen++;
    chat.emit('state');
  }, () => {}).finally(() => {
    chat.todosRead = null;
  });
}

/**
 * Tia's mark on a chat saved before the dashboard stopped (feature.mjs load: `restored`): hers again only once its
 * conversation has been read and is exactly what the record knew of it (`known`: the file's size, or the stamp of a
 * tool whose server keeps the conversation), since the owner may have gone on with it while the dashboard was down. A
 * record without `known` (saved by an older version) is never hers again. Null when there is no mark to check.
 */
export const restoredMark = (o, byTia) => (o.restored === true && byTia ? { known: Number.isFinite(o.known) ? o.known : null } : null);

/** Her mark as it is saved: with what the chat knew of its conversation then (see restoredMark). */
export function markRecord(chat) {
  if (chat.restoredMark) return { byTia: true, ...(chat.restoredMark.known !== null ? { known: chat.restoredMark.known } : {}) };
  if (!chat.byTia) return {};
  return { byTia: true, ...(Number.isFinite(chat.knownSize) && chat.knownSize >= 0 ? { known: chat.knownSize } : {}) };
}

/**
 * The earlier part of a conversation read from its last part (load at the start): read in pieces and put before the
 * events kept, once, when the page asks for events before them (the older route). Again with nothing left: at once.
 */
export function earlier(chat) {
  const p = chat.partial;
  if (!p || !chat.engine.earlier) return Promise.resolve();
  if (chat.earlierRead) return chat.earlierRead;
  const id = p.id || chat.conversationId;
  chat.earlierRead = chat.engine.earlier({ cwd: chat.cwd, id }, p.start).then(({ events }) => {
    if (chat.partial !== p) return; // read again whole meanwhile
    chat.prepend(withAllowed(withTurns(events, readTurns(chat.o.turnsDir, id)), readAllowed(chat.o.turnsDir, id)));
    chat.partial = null;
  }).finally(() => {
    chat.earlierRead = null;
  });
  return chat.earlierRead;
}

/** The transcript changed without the chat (a terminal ran it): read it again. Cheap when nothing changed. */
export function refresh(chat) {
  // A page or a message looks at the session: what its first read left for later is read now (todosNow).
  chat.looked = true;
  todosNow(chat);
  // While its process ends it still writes (its cost, at the exit): that is the session's own, taken when it has ended.
  // While its first read is under way (in pieces, at the start) that read says what it holds.
  if (chat.session || chat.ending || chat.loading) return false;
  if (chat.engine.stamp) return restamp(chat);
  // Someone else's growth is stamped when it is seen, also by this look (growth.mjs: Delete asks it). knownSize is what
  // the page has read; it is never the session's own state (ownStat), which only the session's own writes set.
  const st = look(chat.file(), chat.ownStat);
  const size = st ? st.size : 0;
  if (size === chat.knownSize || (size === 0 && chat.knownSize <= 0)) return false;
  grewElsewhere(chat);
  chat.load();
  return true;
}

/** The conversation went on elsewhere, where the owner may have written in it: a chat of Tia's is hers no more. */
function grewElsewhere(chat) {
  if (chat.dropMark()) chat.emit('record');
}

/**
 * A conversation kept by a tool's server that waits for an OK while no process of the chat runs (the dashboard was
 * restarted while a command waited): the chat starts again on it, and the OK arrives as if it had just been asked
 * (answered in bypass mode where the rule allows, else a card with its command). Only from a server that runs already.
 */
export function checkWaiting(chat) {
  if (!chat.engine.waiting || chat.session || chat.starting || chat.closed) return;
  Promise.resolve(chat.engine.waiting({ cwd: chat.cwd, id: chat.conversationId }, chat.o.engineOpts)).then((n) => {
    if (n > 0 && !chat.session && !chat.starting && !chat.closed) chat.wake();
  }, () => {});
}

// A tool read through its server: when the conversation last changed there, at most every few seconds.
function restamp(chat) {
  if (chat.loading || Date.now() - (chat.stampAt || 0) < STAMP_MS) return false;
  chat.stampAt = Date.now();
  checkWaiting(chat);
  if (chat.unread) {
    chat.load();
    return false;
  }
  Promise.resolve(chat.engine.stamp({ cwd: chat.cwd, id: chat.conversationId }, chat.o.engineOpts)).then((n) => {
    if (n && n !== chat.knownSize && !chat.session && !chat.turn) {
      grewElsewhere(chat);
      chat.load();
    }
  }, () => {});
  return false;
}

/**
 * What the coding tool wrote last is the chat's own: the next look does not read it again. Called only where the
 * session's own process wrote (its turn's end, its exit, its answer to a control request), never by a page's look. A chat of hers saves what
 * it knows now (its record carries it), so a restart can tell whether the conversation went on while it was down.
 */
export function knowSize(chat) {
  const known = (n) => {
    if (n === chat.knownSize) return;
    chat.knownSize = n;
    if (chat.byTia) chat.emit('record');
  };
  if (chat.engine.stamp) {
    chat.stampAt = 0; // asked again at the next look
    Promise.resolve(chat.engine.stamp({ cwd: chat.cwd, id: chat.conversationId }, chat.o.engineOpts)).then((n) => {
      if (n) known(n);
    }, () => {});
    return;
  }
  const st = statOf(chat.file());
  // What the session's own process left: Delete compares the file with this (growth.mjs). It goes into the chat's
  // record with the save each turn's end makes (feature.mjs), and Delete puts the record as it is into the trash.
  chat.ownStat = st;
  if (st) known(st.size);
}

/** A transcript up to (not with) the owner's message `messageId`: the view of a conversation rewound to there. */
function cutAt(t, messageId) {
  const at = t.events.findIndex((e) => e.kind === 'user' && e.messageId === messageId);
  if (at < 0) return t;
  const events = t.events.slice(0, at);
  const tools = new Set(events.filter((e) => e.kind === 'tool').map((e) => e.id));
  return { ...t, events, tasks: t.tasks.filter((x) => tools.has(x.toolId)), todos: [] };
}
