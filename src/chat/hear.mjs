// What a chat does with each event its running coding tool gives (src/chat/events.mjs): the numbered list, the
// state the page reads (activity, mode, usage, limits, title, to-dos), the task table, the open questions, the queue
// and the turn. The Chat class (chat.mjs) calls hear() for the events of its current process only.
import { askArrived, cancelAsks } from './asks.mjs';
import { mergeLimit } from './controls.mjs';
import { rememberTurn } from './turns.mjs';

// Errors that mean "this provider cannot serve now" (the coding tool's error categories).
export const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);
export const LIMIT_TEXT = /usage limit|limit reached|rate.?limit|out of (credit|quota)|credit balance/i;

const strip = ({ full, ...rest }) => rest; // a tool's whole input stays on the server (an answer needs it)

export function hear(chat, ev) {
  switch (ev.kind) {
    case 'session':
      chat.info = { version: ev.version, tools: ev.tools, commands: ev.commands, skills: ev.skills, agents: ev.agents };
      chat.liveModel = ev.model;
      chat.liveMode = ev.mode;
      chat.bypass = ev.mode === 'bypassPermissions';
      chat.tasks.turnStarted();
      // A turn nobody asked for: the coding tool goes on by itself (a background task ended).
      if (!chat.turn) {
        clearTimeout(chat.idleTimer);
        chat.turn = { messageId: null, auto: true, at: Date.now() };
        chat.push({ kind: 'turn-start', auto: true });
      }
      chat.changed();
      return;
    case 'mode': // the coding tool entered or left plan mode, or a switch was confirmed
      chat.liveMode = ev.mode;
      chat.emit('state');
      return;
    case 'status':
      // requesting (the model is asked), compacting, retrying, or null: that step is over. A tool that runs or text
      // that streams ends "requesting" too (below), so the status line says what runs now, not "thinking".
      chat.activity = ev.state || null;
      if (ev.retry) {
        const e = ev.retry.error;
        if (LIMIT_ERRORS.has(e)) chat.limit = { at: Date.now(), error: e, text: `The provider refused (${e})` };
        if (ev.retry.attempt === 1 || LIMIT_ERRORS.has(e)) chat.push({ kind: 'notice', level: 'warning', text: `The provider did not answer (${e.replace(/_/g, ' ')}); trying again…` });
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
      chat.push(strip(ev));
      return;
    case 'todos':
      chat.todos = ev.list;
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
      if (chat.pending.delete(ev.request)) chat.push({ kind: 'ask-closed', request: ev.request, outcome: 'cancelled' });
      chat.changed();
      return;
    case 'user':
      taken(chat, ev.messageId, ev);
      return;
    case 'queue-state':
      if (ev.state === 'started') taken(chat, ev.messageId, null);
      else if (ev.state === 'cancelled') chat.queue.take(ev.messageId);
      return;
    case 'session-changed':
      if (ev.reason === 'clear' && ev.id && ev.id !== chat.conversationId) {
        chat.conversationId = ev.id;
        chat.fork = null;
        chat.emit('record');
      }
      chat.push(ev);
      return;
    case 'usage':
      for (const k of ['contextUsed', 'contextWindow', 'costTotal']) if (ev[k] !== undefined && ev[k] !== null) chat.usage[k] = ev[k];
      chat.emit('state');
      return;
    case 'limits':
      mergeLimit(chat.limits, ev.window, { status: ev.status, percent: Number.isFinite(ev.utilization) ? Math.round(ev.utilization * 100) : null, resetsAt: ev.resetsAt });
      if (ev.status === 'rejected') chat.limit = { at: Date.now(), error: 'rate_limit', text: `The plan's limit is reached (${ev.window.replace(/_/g, ' ')})` };
      chat.emit('state');
      return;
    case 'title':
      if (ev.text) chat.title = ev.text;
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
    const src = ev || item;
    if (src) {
      if (messageId) chat.shown.add(messageId);
      chat.push({ kind: 'user', text: src.text, attachments: src.attachments || [], messageId });
    }
  }
  if (!chat.turn && (item || ev)) {
    clearTimeout(chat.idleTimer);
    chat.turn = { messageId, auto: false, at: Date.now() };
    chat.changed();
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
  const limited = !ev.ok && !stopped && !!ev.error && LIMIT_TEXT.test(ev.error);
  chat.stopping = false;
  chat.lastError = ev.ok || stopped || limited ? null : ev.error;
  chat.lastEnd = ev.ok ? 'ok' : stopped ? 'stopped' : limited ? 'limit' : 'error';
  chat.limit = limited ? { at: Date.now(), error: 'rate_limit', text: ev.error.slice(0, 300) } : ev.ok ? null : chat.limit;
  cancelAsks(chat);
  chat.live.turnEnded();
  const end = chat.push({ kind: 'turn-end', ok: ev.ok, subtype: ev.subtype, error: ev.ok || stopped || limited ? null : ev.error, limited, turnCostUsd: turnCost, usage: ev.usage, durationMs: ev.durationMs, stopped });
  if (chat.turn && chat.turn.messageId) rememberTurn(chat.o.turnsDir, chat.conversationId, chat.turn.messageId, end); // read back on a reload
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
}

function exited(chat, { code, why }) {
  chat.session = null;
  clearTimeout(chat.stopTimer);
  if (chat.turn || chat.pending.size) {
    cancelAsks(chat);
    chat.push({ kind: 'turn-end', ok: false, subtype: 'exit', error: `${chat.engine.label} stopped (${code})${why ? `: ${why}` : ''}`, stopped: false });
    chat.lastError = `${chat.engine.label} stopped (${code})`;
    chat.lastEnd = 'error';
    chat.turn = null;
  }
  lostWork(chat);
  chat.knowSize();
  chat.changed();
}

/** The process is gone: what it ran in the background and what was queued in it went with it. */
export function lostWork(chat) {
  chat.tasks.lost();
  const lost = chat.queue.lose();
  if (lost) chat.push({ kind: 'notice', level: 'warning', text: `${lost === 1 ? 'A queued message was' : `${lost} queued messages were`} not sent.` });
  chat.live.clear();
  chat.activity = null;
  chat.emit('state');
}
