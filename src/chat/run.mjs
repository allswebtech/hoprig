// The process of a chat (chat.mjs): started once for a message (or a menu, a rewind), heard through hear.mjs, and
// stopped after a quiet while, on Stop, on a restart or when the chat closes. The conversation stays in its
// transcript, so the next start resumes it; nothing but the process is lost.
import { providerEnv } from '../assistant/engine.mjs';
import { cancelAsks } from './asks.mjs';
import { createChatRun, heldBefore, removeChatLeftovers, removeRun, updateRun } from '../runs.mjs';
import { hear, lostWork } from './hear.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

// The record files of this dashboard's chat processes that have not ended yet, and of starts getting ready: of every
// chat, so a record a closing chat's process still holds is never taken for a leftover by a new chat with the same id
// (a chat closed and opened again at once: the closed one's process may take seconds to end).
const live = new Set();
const drop = (file) => {
  live.delete(file);
  removeRun(file);
};

/** Start the coding tool (once). Resolves false when a stop() came while it was getting ready. */
export function start(chat) {
  if (chat.session) return Promise.resolve(true);
  if (chat.starting) return chat.starting;
  const gen = chat.gen;
  chat.starting = (async () => {
    // The same conversation must not run twice: a process that is still stopping ends first.
    if (chat.ending) await chat.ending;
    if (gen !== chat.gen || chat.closed) return false;
    // The record that this chat runs the conversation (runs.mjs createChatRun), first: a launcher in any terminal reads
    // it before it starts the coding tool there. A launcher whose record came first keeps the conversation.
    const hold = createChatRun({ chat: chat.id, conversation: chat.conversationId, tool: chat.engine.id, cwd: chat.cwd, profile: chat.profile });
    live.add(hold.file);
    chat.startHold = hold.file; // a stop() while it gets ready removes it at once (stop below)
    let session = null;
    try {
      removeChatLeftovers(chat.id, live); // a record of this chat's that no process of it holds any more
      const other = heldBefore(hold.run, chat.conversationId, chat.engine.id);
      // The code says which, for a caller that started the chat and must not report a message as sent (feature.mjs).
      if (other) throw Object.assign(fail(409, other.kind === 'chat' ? 'another chat runs this conversation right now' : 'This conversation runs in a terminal now. Continue it here (that terminal stops), or read along.'), { code: other.kind === 'chat' ? 'in-chat' : 'in-terminal' });
      session = await open(chat, gen, hold);
      return !!session;
    } finally {
      if (chat.startHold === hold.file) chat.startHold = null;
      if (!session) drop(hold.file);
    }
  })().finally(() => {
    chat.starting = null;
  });
  return chat.starting;
}

/** The coding tool's process for chat `chat` (its record `hold` is written): the session, or null when a stop() came meanwhile. */
async function open(chat, gen, hold) {
  // The provider's environment may take a while (its PRERUN starts a gateway, Auto mode starts the router).
  const env = await (chat.o.resolveEnv || providerEnv)(chat.profile);
  if (gen !== chat.gen || chat.closed) return null;
  const resume = await chat.engine.exists(chat.cwd, chat.conversationId, chat.o.engineOpts); // a promise for a tool read through its server
  if (gen !== chat.gen || chat.closed) return null;
  // A conversation rewound to an earlier message goes on as a copy of the old one up to there (a fork): until its
  // first turn has written a file of its own.
  const fork = !resume && chat.fork && chat.fork.at ? { from: chat.fork.from, at: chat.fork.at } : null;
  if (!resume && !fork) chat.costTotal = 0; // a new conversation starts at nothing
  let session = null;
  session = chat.engine.open({
    cwd: chat.cwd, env, profile: chat.profile, sessionId: chat.conversationId, resume, fork, model: chat.model, effort: chat.effort, ultracode: chat.ultracode,
    mode: chat.permissionMode, grants: [...chat.grants], emit: (ev) => heard(chat, session, ev),
    command: chat.o.command, spawnImpl: chat.o.spawnImpl, termMs: chat.o.termMs, killMs: chat.o.killMs, drainMs: chat.o.drainMs,
    ...(chat.o.engineOpts || {}), // stand-ins of a tool's server (tests)
  });
  // The record goes with the process from here on (release), and follows it into another conversation (heard).
  session.hold = hold.file;
  session.holds = chat.conversationId;
  chat.session = session;
  chat.liveMode = null;
  chat.bypass = false; // until this process says so itself
  return session;
}

/** The process of `session` has ended: its record goes (it held the conversation; now nothing does). */
function release(session) {
  if (!session || !session.hold) return;
  drop(session.hold);
  session.hold = null;
}

/**
 * The process of `session` goes on in conversation `id` (a clear in Claude Code; OpenCode names a new chat's
 * conversation itself): its record says so (runs.mjs runsConversation reads sessionId first), so a launcher on `id`
 * finds it, and the conversation it left is free at once.
 */
function moved(session, id) {
  if (!session || !session.hold || !id || id === session.holds) return;
  session.holds = id;
  updateRun(session.hold, { sessionId: id });
}

/** The process runs (started for a menu or a rewind, not for a message: the idle timer applies). */
export async function ensure(chat) {
  if (chat.closed) throw fail(409, 'this chat is closed');
  if (chat.session) return chat.session;
  if (!(await start(chat)) || !chat.session) throw fail(409, `${chat.engine.label} did not start`);
  if (!chat.busy()) chat.idleLater();
  return chat.session;
}

function heard(chat, session, ev) {
  if (ev.kind === 'exit') release(session);
  else if (ev.kind === 'conversation' || (ev.kind === 'session-changed' && ev.reason === 'clear')) moved(session, ev.id);
  if (chat.session !== session) {
    if (ev.kind === 'exit') chat.knowSize(); // what it wrote last is ours: no reason to read it again
    return;
  }
  hear(chat, ev);
}

/** End the process (the conversation stays in its transcript). */
export function stop(chat) {
  chat.gen++; // a start that is still getting ready does not go on
  // …and holds nothing from now on: its record goes at once, not when its provider's environment is ready (a terminal
  // the chat is handed to must not find it).
  if (chat.startHold) {
    drop(chat.startHold);
    chat.startHold = null;
  }
  clearTimeout(chat.idleTimer);
  clearTimeout(chat.stopTimer);
  const session = chat.session;
  chat.session = null;
  chat.restart = false;
  chat.stopping = false;
  if (chat.turn || chat.pending.size) {
    cancelAsks(chat);
    chat.push({ kind: 'notice', level: 'info', text: 'Stopped.' });
    chat.turn = null;
  }
  lostWork(chat);
  chat.queue.clear();
  if (session) {
    const ended = session.close().then(() => {
      release(session);
      if (chat.ending === ended) chat.ending = null;
    });
    chat.ending = ended;
    chat.endingSession = session;
  }
  chat.changed();
}

/** stop(), and resolve once the process has really ended (SIGKILL after `ms`): nothing else may run it before. */
export async function stopAndWait(chat, ms = 6000) {
  stop(chat);
  if (!chat.ending) return;
  let t;
  await Promise.race([chat.ending, new Promise((r) => (t = setTimeout(r, ms)))]);
  clearTimeout(t);
  if (chat.ending && chat.endingSession) {
    chat.endingSession.kill();
    await chat.ending;
  }
}
