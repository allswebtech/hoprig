// What a chat does with each event its running coding tool gives (src/chat/events.mjs): the numbered list, the
// state the page reads (activity, mode, usage, limits, title, to-dos), the task table, the open questions, the queue
// and the turn. The Chat class (chat.mjs) calls hear() for the events of its current process only.
import { askArrived, askCancelled, cancelAsks } from './asks.mjs';
import { workSeen } from './handsoff.mjs';
import { mergeLimit } from './controls.mjs';
import { rememberTurn } from './turns.mjs';
import { ownEndpoint, retryCause } from '../codetools/ownsettings.mjs';

// Errors that mean "this provider cannot serve now" (the coding tool's error categories).
export const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);
// A full context ("Context limit reached · /compact or /clear to continue") is not one: another provider would not help.
export const LIMIT_TEXT = /usage limit|(?<!context )limit reached|rate.?limit|out of (credit|quota)|credit balance/i;

const strip = ({ full, ...rest }) => rest; // a tool's whole input stays on the server (an answer needs it)

export function hear(chat, ev) {
  switch (ev.kind) {
    case 'session':
      chat.info = { version: ev.version, tools: ev.tools, commands: ev.commands, skills: ev.skills, agents: ev.agents };
      chat.liveModel = ev.model;
      chat.liveMode = ev.mode;
      if (ev.mode === 'auto') chat.autoSeen = true;
      chat.bypass = ev.mode === 'bypassPermissions';
      chat.tasks.turnStarted();
      // A turn nobody asked for: the coding tool goes on by itself (a background task ended). Unless it holds a
      // message of the owner's (queued while the last turn ran): then this turn is that message's, and its echo (or
      // its "started") names it in a moment (taken). Claude Code may say the turn starts before it says whose it is.
      if (!chat.turn) {
        clearTimeout(chat.idleTimer);
        const owners = chat.queue.items.some((q) => q.state === 'sent');
        chat.turn = { messageId: null, auto: !owners, at: Date.now() };
        if (!owners) chat.push({ kind: 'turn-start', auto: true });
      }
      chat.changed();
      return;
    case 'conversation': // a coding tool that names its conversations itself made this chat's (engine ownIds)
      if (ev.id && ev.id !== chat.conversationId) {
        chat.conversationId = ev.id;
        chat.emit('record');
      }
      return;
    case 'mode': // the coding tool entered or left plan mode, or a switch was confirmed
      chat.liveMode = ev.mode;
      if (ev.mode === 'auto') chat.autoSeen = true;
      chat.emit('state');
      return;
    case 'status':
      // requesting (the model is asked), compacting, retrying, or null: that step is over. A tool that runs or text
      // that streams ends "requesting" too (below), so the status line says what runs now, not "thinking".
      chat.activity = ev.state || null;
      if (ev.retry) {
        const e = ev.retry.error;
        // Claude Code's refusals only: another coding tool's "rate limit" while it tries again is a passing one.
        if (LIMIT_ERRORS.has(e) && chat.engine.id === 'claude') chat.limit = { at: Date.now(), error: e, text: `The provider refused (${e})` };
        const plain = `The provider did not answer (${e.replace(/_/g, ' ')}); trying again…`;
        // Claude Code's own settings may send it to an address no profile chose (codetools/ownsettings.mjs): when
        // nothing answers there, that is the cause, and the notice says it instead of "unknown".
        if (ev.retry.attempt === 1 && !LIMIT_ERRORS.has(e) && chat.engine.id === 'claude' && ownEndpoint(chat.claudeDir)) {
          (chat.retryCause || retryCause)(chat.claudeDir)
            .catch(() => null)
            .then((cause) => chat.push({ kind: 'notice', level: 'warning', text: cause ? `${cause} Trying again…` : plain }));
        } else if (ev.retry.attempt === 1 || LIMIT_ERRORS.has(e)) chat.push({ kind: 'notice', level: 'warning', text: plain });
      }
      chat.emit('state');
      return;
    case 'text-delta':
    case 'thinking-delta':
    case 'tool-start':
    case 'tool-progress':
      if (chat.activity === 'requesting' && !ev.agent) {
        chat.activity = null; // the answer comes: what streams or runs says the rest
        chat.emit('state');
      }
      chat.live.add(ev);
      chat.emit('live', ev);
      return;
    case 'text':
    case 'thinking':
    case 'tool':
    case 'tool-result':
      chat.live.final(ev);
      if (ev.kind === 'text' && !ev.agent) chat.lastText = ev.text;
      if (ev.kind === 'tool' || ev.kind === 'tool-result') chat.emit('state'); // a tool runs now, or ran: the status line
      if (ev.kind === 'tool' && !ev.agent) workSeen(chat, ev); // work between Hands-off's answers
      chat.push(strip(ev));
      return;
    case 'todos': // a TodoWrite or a task call of this turn: newer than anything read from the earlier part (reading.mjs)
      chat.todos = ev.list;
      chat.todosGen++;
      chat.emit('state');
      return;
    case 'task':
      chat.tasks.apply(ev);
      chat.emit('state');
      chat.settle();
      return;
    case 'tasks-running':
      chat.tasks.running(ev.ids);
      chat.emit('state');
      chat.settle();
      return;
    case 'ask':
      askArrived(chat, ev);
      return;
    case 'ask-cancelled':
      askCancelled(chat, ev.request);
      return;
    case 'user':
      taken(chat, ev.messageId, ev);
      return;
    case 'queue-state':
      if (ev.state === 'started') taken(chat, ev.messageId, null);
      else if (ev.state === 'cancelled' && chat.queue.take(ev.messageId)) chat.gaveBack(ev.messageId);
      return;
    case 'session-changed':
      if (ev.reason === 'clear' && ev.id && ev.id !== chat.conversationId) {
        chat.cleared(ev.id);
        chat.fork = null;
        chat.emit('record');
        chat.emit('state');
      }
      chat.push(ev);
      return;
    case 'usage':
      // A new size of the context: the percent and the parts of an older /context answer (controls.mjs usageNow)
      // were of another size, so the page reckons the percent from the size again and shows no old parts.
      if (Number.isFinite(ev.contextUsed) && ev.contextUsed !== chat.usage.contextUsed) {
        delete chat.usage.contextPercent;
        delete chat.usage.contextCategories;
      }
      for (const k of ['contextUsed', 'contextWindow', 'costTotal']) if (ev[k] !== undefined && ev[k] !== null) chat.usage[k] = ev[k];
      chat.emit('state');
      return;
    case 'limits':
      mergeLimit(chat.limits, ev.window, { status: ev.status, percent: Number.isFinite(ev.utilization) ? Math.round(ev.utilization * 100) : null, resetsAt: ev.resetsAt });
      if (ev.status === 'rejected') chat.limit = { at: Date.now(), error: 'rate_limit', text: `The plan's limit is reached (${ev.window.replace(/_/g, ' ')})` };
      chat.emit('state');
      return;
    case 'title':
      if (ev.text) chat.heardTitle(ev.text); // a name given here still wins (titles.mjs)
      chat.emit('record');
      chat.emit('state');
      return;
    case 'turn-end':
      turnEnd(chat, ev);
      return;
    case 'exit':
      exited(chat, ev);
      return;
    case 'notice':
      chat.push(ev);
      return;
    default:
  }
}

/** A message of the owner was taken by the coding tool: shown (once), out of the queue, its turn runs. */
function taken(chat, messageId, ev) {
  const item = messageId ? chat.queue.take(messageId) : null;
  if (!messageId || !chat.shown.has(messageId)) {
    // What the owner wrote and sent (its files by their upload names: thumbnails, chips) over Claude Code's echo of
    // it (the files named only inside the text, the pictures without a name).
    const src = item || ev;
    if (src) {
      if (messageId) chat.shown.add(messageId);
      chat.push({ kind: 'user', text: src.text, attachments: src.attachments || [], messageId });
    }
  }
  if (!chat.turn && (item || ev)) {
    clearTimeout(chat.idleTimer);
    chat.turn = { messageId, auto: false, at: Date.now() };
    chat.changed();
  } else if (chat.turn && !chat.turn.auto && !chat.turn.messageId && messageId) {
    chat.turn.messageId = messageId; // the turn that started for a queued message: now it knows which (its end is kept)
  } else if (chat.turn && messageId && messageId !== chat.turn.messageId) {
    // Taken inside a turn that runs for another message (or for none): it has no turn of its own, so it ends with this one.
    const took = chat.turn.took || (chat.turn.took = []);
    if (!took.includes(messageId)) took.push(messageId);
  }
}

function turnEnd(chat, ev) {
  clearTimeout(chat.stopTimer);
  let turnCost = null;
  if (ev.costUsd !== null && chat.costTotal !== null && ev.costUsd >= chat.costTotal) turnCost = ev.costUsd - chat.costTotal;
  if (ev.costUsd !== null) chat.costTotal = ev.costUsd;
  // Stop was pressed: the end is the owner's, not an error. A usage limit says itself in the banner (with what to do
  // next): not also as the turn's error box.
  const stopped = !ev.ok && (ev.error === 'stopped' || chat.stopping);
  // LIMIT_TEXT is Claude Code's own words for a usage limit. Another coding tool's turn is a usage limit only when its
  // engine says so (ev.limited): a gateway's passing "rate limit" through it is an error, and never marks the provider
  // as at its limit for hours (providerlimit.mjs).
  const limited = !ev.ok && !stopped && (ev.limited === true || (chat.engine.id === 'claude' && !!ev.error && LIMIT_TEXT.test(ev.error)));
  chat.stopping = false;
  chat.lastError = ev.ok || stopped || limited ? null : ev.error;
  chat.lastEnd = ev.ok ? 'ok' : stopped ? 'stopped' : limited ? 'limit' : 'error';
  chat.limit = limited ? { at: Date.now(), error: 'rate_limit', text: ev.error.slice(0, 300) } : ev.ok ? null : chat.limit;
  cancelAsks(chat);
  chat.live.turnEnded();
  const end = chat.push({ kind: 'turn-end', ok: ev.ok, subtype: ev.subtype, error: ev.ok || stopped || limited ? null : ev.error, limited, turnCostUsd: turnCost, usage: ev.usage, durationMs: ev.durationMs, stopped });
  if (chat.turn && chat.turn.messageId) rememberTurn(chat.o.turnsDir, chat.conversationId, chat.turn.messageId, end); // read back on a reload
  chat.endMessages(turnCost);
  chat.knowSize();
  // A rewound conversation now has its own file: it is read from there from now on.
  if (chat.fork && chat.engine.exists(chat.cwd, chat.conversationId)) {
    chat.fork = null;
    chat.emit('record');
  }
  chat.turn = null;
  chat.activity = null;
  chat.nextHeld();
  chat.settle();
  chat.emit('turn', ev);
  if (ev.ok) chat.askTitle?.(); // a conversation without a name gets Claude Code's title (chat.mjs)
}

// What an engine's own end codes mean, in the owner's words (a process's exit code or signal is shown as it is).
const ENDS = { start: 'could not start', provider: 'cannot use this provider', server: 'lost its server' };

function exited(chat, { code, why }) {
  chat.session = null;
  processGone(chat, !!chat.turn);
  clearTimeout(chat.stopTimer);
  if (chat.turn || chat.pending.size) {
    cancelAsks(chat);
    const head = `${chat.engine.label} ${Object.hasOwn(ENDS, code) ? ENDS[code] : `stopped (${code})`}`;
    chat.push({ kind: 'turn-end', ok: false, subtype: 'exit', error: `${head}${why ? `: ${why}` : ''}`, stopped: false });
    chat.lastError = head;
    chat.lastEnd = 'error';
    chat.endMessages(null);
    chat.turn = null;
  }
  lostWork(chat);
  chat.knowSize();
  chat.changed();
}

/**
 * The chat's process ended (`cut`: inside a turn, whose cost it never reported): its own callback, when it has one (a
 * part's chat settles its budget hold, feature.mjs make). A failure there never stops the chat from noting the end.
 */
export function processGone(chat, cut = false) {
  if (typeof chat.o.processEnded !== 'function') return;
  try {
    chat.o.processEnded({ cut });
  } catch {
    /* the record could not be written: the hold counts for the day (the safe side) */
  }
}

/** The process is gone: what it ran in the background and what was queued in it went with it. */
export function lostWork(chat) {
  chat.tasks.lost();
  const gone = chat.queue.items.filter((q) => q.state === 'sent').map((q) => q.id);
  const lost = chat.queue.lose();
  for (const id of gone) chat.gaveBack(id); // they never ran
  if (lost) chat.push({ kind: 'notice', level: 'warning', text: lost === 1 ? 'The message you sent was lost with the process: send it again.' : `The ${lost} messages you sent were lost with the process: send them again.` });
  chat.live.clear();
  chat.activity = null;
  chat.emit('state');
}
