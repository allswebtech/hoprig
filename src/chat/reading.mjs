// Reading a chat's conversation back (chat.mjs): from the coding tool's file (Claude Code), or through its server
// (OpenCode), which answers later. The page starts over with what was read; a terminal that went on with the
// conversation is followed by reading it again when it changed.
import fs from 'node:fs';
import { oneLine } from './events.mjs';
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
  const t = chat.engine.transcript({ cwd: chat.cwd, id }, chat.o.engineOpts, { start: wake });
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
  if (f) t = cutAt(t, f.messageId);
  chat.reset(t.events);
  chat.todos = t.todos;
  chat.tasks.load(t.tasks);
  const last = [...t.events].reverse().find((e) => e.kind === 'text' && !e.agent);
  chat.lastText = last ? last.text : '';
  if (t.title && !chat.named) chat.title = t.title;
  if (!chat.title) {
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

/** The transcript changed without the chat (a terminal ran it): read it again. Cheap when nothing changed. */
export function refresh(chat) {
  if (chat.session) return false;
  if (chat.engine.stamp) return restamp(chat);
  let size = 0;
  try {
    size = fs.statSync(chat.file()).size;
  } catch {
    /* not written yet */
  }
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
 * What the coding tool wrote last is the chat's own: the next look does not read it again. A chat of hers saves what
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
  try {
    known(fs.statSync(chat.file()).size);
  } catch {
    /* nothing written */
  }
}

/** A transcript up to (not with) the owner's message `messageId`: the view of a conversation rewound to there. */
function cutAt(t, messageId) {
  const at = t.events.findIndex((e) => e.kind === 'user' && e.messageId === messageId);
  if (at < 0) return t;
  const events = t.events.slice(0, at);
  const tools = new Set(events.filter((e) => e.kind === 'tool').map((e) => e.id));
  return { ...t, events, tasks: t.tasks.filter((x) => tools.has(x.toolId)), todos: [] };
}
