// The process of a chat (chat.mjs): started once for a message (or a menu, a rewind), heard through hear.mjs, and
// stopped after a quiet while, on Stop, on a restart or when the chat closes. The conversation stays in its
// transcript, so the next start resumes it; nothing but the process is lost.
import { providerEnv } from '../assistant/engine.mjs';
import { startAsHers } from '../assistant/hersignin.mjs';
import { loadConfig } from '../config.mjs';
import { credsDir } from '../workspace/credlinks.mjs';
import { cancelAsks, syncAllMark } from './asks.mjs';
import { createChatRun, heldBefore, removeChatLeftovers, removeRun, updateRun } from '../runs.mjs';
import { hear, lostWork, processGone } from './hear.mjs';
import { leadPlan, withOthers } from '../models/lead.mjs';
import { modelsFor } from '../models/catalog.mjs';

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
    await (await import('../workspace/instep.mjs')).lookBeforeStart(chat.cwd); // 3 seconds at most; never throws
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
  let env = await (chat.o.resolveEnv || providerEnv)(chat.profile);
  // A session Tia started is marked hers (the hold src/hook.mjs sessionByTia reads to hold her administrator commands
  // below Full, hermark.mjs) and signs in to the git server with the file the owner chose in place of his own;
  // both through the one startAsHers, keyed to this chat's run record. With no file chosen the sign-in is his, as
  // today. Only hers: his own chats keep his sign-in and are not marked. The mark goes with the record (runs.mjs
  // removeRun) when the process ends, a restart on a new record re-marks here.
  if (chat.byTia || chat.hers || chat.restoredMark) {
    env = startAsHers(hold.file, env, { cfg: loadConfig(), credsDir: credsDir(), onProblem: (why) => chat.push({ kind: 'notice', level: 'warning', text: `Tia's git sign-in could not be used (${why}); her session signs in to git with no token until the file is fixed.` }) });
  }
  if (gen !== chat.gen || chat.closed) return null;
  const resume = await chat.engine.exists(chat.cwd, chat.conversationId, chat.o.engineOpts); // a promise for a tool read through its server
  if (gen !== chat.gen || chat.closed) return null;
  // A conversation rewound to an earlier message goes on as a copy of the old one up to there (a fork): until its
  // first turn has written a file of its own.
  const fork = !resume && chat.fork && chat.fork.at ? { from: chat.fork.from, at: chat.fork.at } : null;
  if (!resume && !fork) chat.costTotal = 0; // a new conversation starts at nothing
  // The extra folders, decided at this start (workspace/needs.mjs): Claude Code only (another coding tool is told).
  const extras = await chatExtras(chat);
  if (gen !== chat.gen || chat.closed) return null;
  // "Lead model": its helpers from the provider's own list, given at this start; nothing when off. The list is asked
  // here when it is not known (a first start after a restart, a chat Tia or a schedule starts): the picker's own ask,
  // shared and kept ten minutes, so nothing more is asked when it is known. With "Use other providers" ticked, also the
  // one tool that hands a part to one of them (partdoor.mjs).
  let lead = null;
  if (chat.lead && chat.engine.id === 'claude') {
    await modelsFor(chat.profile).catch(() => null);
    if (gen !== chat.gen || chat.closed) return null;
    const plan = leadPlan(chat.profile);
    // Said once per start where it cannot lead: the switch still reads on, and every part runs on the lead's own model.
    if (!plan.can) chat.push({ kind: 'notice', level: 'warning', text: `Lead model started without helpers: ${plan.why}` });
    lead = withOthers(plan, chat.others, chat.o.partsConfig ? chat.o.partsConfig(chat) : null);
  }
  // A part's budget (feature.mjs partBudget) is asked here, after the last wait and before anything of the coding tool
  // starts: a later start with no room left throws, so its process is never spawned (the send says it could not start).
  const budgetOf = chat.o.engineOpts ? chat.o.engineOpts.maxBudgetUsd : undefined;
  const budget = typeof budgetOf === 'function' ? budgetOf() : undefined;
  let session = null;
  syncAllMark(chat, hold.file); // "Allow everything": the floor's pre-check reads it (asks.mjs syncAllMark)
  session = chat.engine.open({
    extras,
    cwd: chat.cwd, env, profile: chat.profile, sessionId: chat.conversationId, resume, fork, model: chat.model, effort: chat.effort, ultracode: chat.ultracode,
    mode: chat.permissionMode, grants: [...chat.grants], runFile: hold.file, emit: (ev) => heard(chat, session, ev),
    hers: !!(chat.byTia || chat.hers || chat.restoredMark), // the wall's hook with no Hands-off gate (launch.mjs chatHooks)
    ...(lead ? { lead } : {}),
    allowBypass: chat.o.allowBypass ? chat.o.allowBypass() : true, // the owner's switch (bypassgate.mjs)
    command: chat.o.command, spawnImpl: chat.o.spawnImpl, termMs: chat.o.termMs, killMs: chat.o.killMs, drainMs: chat.o.drainMs,
    ...(chat.o.engineOpts || {}), // stand-ins of a tool's server (tests)
    ...(budget !== undefined ? { maxBudgetUsd: budget } : {}), // asked once, above
  });
  // The record goes with the process from here on (release), and follows it into another conversation (heard).
  session.hold = hold.file;
  session.holds = chat.conversationId;
  chat.session = session;
  chat.liveMode = null;
  chat.modeLater = null; // this process starts in the mode set
  chat.autoSeen = false; // auto mode is a fact about one process (its provider and model): it says so again or not at all
  chat.bypass = false; // until this process says so itself
  return session;
}

/**
 * A chat's extra folders: its project's needs that are here and the names "Also open" chose (`chat.withs`, checked
 * again here). Said once in the chat, at its first start: which folders, each missing need with its get, and for a
 * coding tool that cannot keep them read-only that none is opened. → { dirs, refs, settings } | null
 */
async function chatExtras(chat) {
  let ex;
  try {
    ex = await (await import('../workspace/needs.mjs')).sessionExtras(chat.cwd, { withs: chat.withs || [] });
  } catch (e) {
    ex = { dirs: [], refs: [], missing: [], warnings: [`the extra folders could not be read: ${e.message}`], refused: [] };
  }
  const claude = !chat.engine.id || chat.engine.id === 'claude';
  const N = await import('../workspace/needs.mjs');
  const lines = [...N.startNote(claude ? ex : { ...ex, refs: [] }), ...ex.refused.map((r) => `not opened: ${r}`)];
  if (!claude && ex.refs.length) lines.unshift(`${chat.engine.label || 'this coding tool'} gets no extra folders: Hoprig cannot keep them read-only there (${ex.refs.join(', ')})`);
  const said = lines.join(' · ');
  if (said && chat.extrasSaid !== said) {
    chat.extrasSaid = said;
    chat.push({ kind: 'notice', level: ex.missing.length || ex.refused.length || ex.warnings.length ? 'warning' : 'info', text: said });
  }
  chat.extras = claude ? ex.refs : [];
  if (!claude || !ex.dirs.length) return null;
  return { dirs: ex.dirs, refs: ex.refs, settings: await N.extraSettings(ex.dirs, { walked: ex.walked }) };
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
  if (chat.session !== session) return; // a stopped process: stop() took what it wrote when it ended
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
  if (session) processGone(chat, !!chat.turn); // a turn cut short has not reported its cost
  chat.restart = false;
  // What the ended process reported is not the chat's mode any more: the next one starts in the mode set.
  chat.liveMode = null;
  chat.modeLater = null;
  chat.bypass = false;
  chat.stopping = false;
  if (chat.turn || chat.pending.size) {
    cancelAsks(chat);
    chat.push({ kind: 'notice', level: 'info', text: 'Stopped.' });
    chat.endMessages(null); // stopped: no cost reported, its hold stays for the day
    chat.turn = null;
  }
  lostWork(chat);
  for (const q of chat.queue.items) chat.gaveBack(q.id); // they never ran
  chat.queue.clear();
  if (session) {
    const ended = session.close().then(() => {
      // What it wrote until it ended is the chat's own: taken now, before its record goes. Its 'exit' event comes
      // later (its output is read to the end first), when a terminal may already have gone on with the conversation.
      chat.knowSize();
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
