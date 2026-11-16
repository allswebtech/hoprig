// The process of a chat (chat.mjs): started once for a message (or a menu, a rewind), heard through hear.mjs, and
// stopped after a quiet while, on Stop, on a restart or when the chat closes. The conversation stays in its
// transcript, so the next start resumes it; nothing but the process is lost.
import { providerEnv } from '../assistant/engine.mjs';
import { cancelAsks } from './asks.mjs';
import { hear, lostWork } from './hear.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Start the coding tool (once). Resolves false when a stop() came while it was getting ready. */
export function start(chat) {
  if (chat.session) return Promise.resolve(true);
  if (chat.starting) return chat.starting;
  const gen = chat.gen;
  chat.starting = (async () => {
    // The same conversation must not run twice: a process that is still stopping ends first.
    if (chat.ending) await chat.ending;
    // The provider's environment may take a while (its PRERUN starts a gateway, Auto mode starts the router).
    const env = await (chat.o.resolveEnv || providerEnv)(chat.profile);
    if (gen !== chat.gen || chat.closed) return false;
    const resume = await chat.engine.exists(chat.cwd, chat.conversationId, chat.o.engineOpts); // a promise for a tool read through its server
    if (gen !== chat.gen || chat.closed) return false;
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
    chat.session = session;
    chat.liveMode = null;
    chat.bypass = false; // until this process says so itself
    return true;
  })().finally(() => {
    chat.starting = null;
  });
  return chat.starting;
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
  if (chat.session !== session) {
    if (ev.kind === 'exit') chat.knowSize(); // what it wrote last is ours: no reason to read it again
    return;
  }
  hear(chat, ev);
}

/** End the process (the conversation stays in its transcript). */
export function stop(chat) {
  chat.gen++; // a start that is still getting ready does not go on
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
