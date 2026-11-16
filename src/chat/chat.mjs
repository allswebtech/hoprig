// One coding chat: a conversation with a coding tool that the dashboard runs headless (src/chat/engines/) instead of
// in a terminal. One long-lived process per open chat, started on the first message and stopped after a quiet
// while; the next message starts it again with the conversation resumed, so nothing but the process is lost. This
// class knows no coding tool: it keeps the list of events (timeline.mjs), the tasks, the open questions, the queue
// and the idle timer, and calls the engine for the rest.
//
// A result is not the end. The coding tool may go on by itself (a background agent, shell or workflow ended and it
// starts a turn of its own), so the chat is idle only when no turn runs and no background task runs; until then
// its card says "working" and the idle timer leaves the process alone.
//
// The process: run.mjs. What each of its events does: hear.mjs. Who answers when the coding tool asks for an OK, and
// how: asks.mjs. What changes live: controls.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { engineOf } from './engines/index.mjs';
import { allowPending, answerAsk, cancelAsks, keepGrants } from './asks.mjs';
import { applySettings, renameChat, usageNow } from './controls.mjs';
import { oneLine } from './events.mjs';
import { MessageQueue } from './queue.mjs';
import { ensure, start, stop, stopAndWait } from './run.mjs';
import { LiveBlocks } from './streaming.mjs';
import { OWED_MS, TaskTable } from './tasks.mjs';
import { Timeline } from './timeline.mjs';
import { readTurns, withTurns } from './turns.mjs';

export { EVENTS_MAX, WINDOW_MAX } from './timeline.mjs';
export const IDLE_MS = 20 * 60_000; // a process with nothing to do is stopped after this (the next message resumes)
const STOP_GRACE_MS = 8000; // after Stop, how long the coding tool gets to end the turn itself
const STAMP_MS = 3000; // a conversation kept by a tool's server is looked at no more often than this

const fail = (status, message) => Object.assign(new Error(message), { status });
const busyWords = (chat) => `${chat.engine.id === 'claude' ? 'Claude' : chat.engine.label} is working. Wait until it is done, or press Stop first.`;

export class Chat extends Timeline {
  /**
   * o: { id, conversationId, engine, cwd, profile, model, effort, ultracode, permissionMode, title, openedAt,
   *      costTotal, grants, fork, turnsDir (where each turn's end is kept), resolveEnv(profile) (tests), command { command, args } and spawnImpl (tests),
   *      engineOpts (stand-ins of a tool's server, tests), idleMs,
   *      stopGraceMs, termMs, killMs, drainMs, owedMs }
   */
  constructor(o) {
    super();
    this.o = o;
    this.id = o.id; // the chat's own id: its page and card
    this.conversationId = o.conversationId || o.id; // the coding tool's conversation (a clear or a rewind gives a new one)
    // A rewind to an earlier message: { from (the old conversation), at (the message it goes on after; null: from
    // the start), messageId (the owner's message it went back to) }, until the new conversation has its own file.
    this.fork = o.fork && typeof o.fork === 'object' && typeof o.fork.from === 'string' ? o.fork : null;
    this.engine = engineOf(o.engine);
    this.cwd = o.cwd;
    this.profile = o.profile;
    this.model = o.model || null; // null: Auto (the coding tool's own choice)
    this.effort = o.effort || null;
    this.ultracode = o.ultracode === true;
    this.permissionMode = o.permissionMode || null;
    this.title = o.title || '';
    this.named = o.named === true; // the owner named it in the dashboard: that name wins over the transcript's
    this.openedAt = o.openedAt || Date.now();
    this.costTotal = Number.isFinite(o.costTotal) ? o.costTotal : null; // what the coding tool reported last (a running total)
    this.grants = keepGrants(o.grants); // what "allow in this chat" covered (asks.mjs)
    this.session = null; // the running coding tool
    this.turn = null; // the turn that runs: { messageId, auto, at }
    this.stopping = false; // Stop was pressed: the turn's end is the owner's, not a failure
    this.pending = new Map(); // request id → the ask event (with the full input)
    this.tasks = new TaskTable(); // subagents, background shells and workflows (tasks.mjs)
    this.queue = new MessageQueue(() => this.emit('state')); // messages written while a turn runs (queue.mjs)
    this.live = new LiveBlocks(); // what still streams (streaming.mjs)
    this.shown = new Set(); // ids of the owner's messages shown (the coding tool's echo of one is not shown twice)
    this.todos = [];
    this.info = {}; // what the coding tool says of itself: version, tools, commands, skills
    this.knownCommands = null; // the / menu as the coding tool gave it last
    this.usage = {}; // contextUsed, contextWindow, costTotal
    this.limits = {}; // window → { status, percent, resetsAt } (controls.mjs)
    this.activity = null; // requesting | compacting | retrying (live, for the status line)
    this.liveModel = null;
    this.liveMode = null; // the permission mode the running process reports
    this.bypass = false; // … and whether it allows everything (the chat answers asks then)
    this.statusAt = Date.now();
    this.lastStatus = 'waiting';
    this.lastText = '';
    this.lastError = null;
    this.lastEnd = null; // how the last turn ended: ok | stopped | limit | error
    this.limit = null;
    this.restart = false; // a setting the process cannot change live changed: start again once it is idle
    this.knownSize = -1;
    this.idleTimer = null;
    this.stopTimer = null;
    this.gen = 0; // goes up with every stop(): a start that was under way when it came does not go on
    this.closed = false;
    this.ending = null; // the previous process's exit, while it is still stopping
    this.starting = null; // the start under way
    this.unread = false; // a tool read through its server: not read yet (its server did not run at the first look)
    this.load({ wake: false });
  }

  /** The conversation's file (null for a tool whose conversations are kept by its server). */
  file() {
    return this.engine.file(this.cwd, this.conversationId);
  }

  /**
   * Read the conversation from its files (the page starts over). A rewound one: the old one up to its message. A tool
   * whose store is read through its server answers later: what it read is taken unless a turn started meanwhile.
   * wake: false (when the dashboard starts) reads such a store only from a server that runs already; the chat reads
   * it once a page looks at it (refresh), so a saved chat never starts the tool's server by itself.
   */
  load({ wake = true } = {}) {
    if (this.fork && this.engine.exists(this.cwd, this.conversationId) === true) this.fork = null;
    const f = this.fork;
    const id = f ? f.from : this.conversationId;
    const t = this.engine.transcript({ cwd: this.cwd, id }, this.o.engineOpts, { start: wake });
    if (!t || typeof t.then !== 'function') return this.#loaded(t, f, id);
    const gen = this.gen;
    this.loading = t.then((x) => {
      if (!x) this.unread = true;
      else if (!this.closed && gen === this.gen && !this.session && !this.turn && id === this.conversationId) this.#loaded(x, f, id);
    }, () => {
      this.unread = true; // asked again at the next look
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  #loaded(t, f, id) {
    this.unread = false;
    t = { ...t, events: withTurns(t.events, readTurns(this.o.turnsDir, id)) }; // each turn's cost and time (turns.mjs)
    if (f) t = cutAt(t, f.messageId);
    this.reset(t.events);
    this.todos = t.todos;
    this.tasks.load(t.tasks);
    const last = [...t.events].reverse().find((e) => e.kind === 'text' && !e.agent);
    this.lastText = last ? last.text : '';
    if (t.title && !this.named) this.title = t.title;
    if (!this.title) {
      const first = t.events.find((e) => e.kind === 'user');
      if (first) this.title = oneLine(first.text, 80);
    }
    for (const e of t.events) if (e.kind === 'user' && e.messageId) this.shown.add(e.messageId);
    this.knownSize = f ? 0 : t.size; // a rewound conversation has no file of its own yet
    this.emit('change');
    this.emit('state');
  }

  /** The transcript changed without us (a terminal ran it): read it again. Cheap when nothing changed. */
  refresh() {
    if (this.session) return false;
    if (this.engine.stamp) return this.#restamp();
    let size = 0;
    try {
      size = fs.statSync(this.file()).size;
    } catch {
      /* not written yet */
    }
    if (size === this.knownSize || (size === 0 && this.knownSize <= 0)) return false;
    this.load();
    return true;
  }

  // A tool read through its server: when the conversation last changed there, at most every few seconds.
  #restamp() {
    if (this.loading || Date.now() - (this.stampAt || 0) < STAMP_MS) return false;
    this.stampAt = Date.now();
    if (this.unread) {
      this.load();
      return false;
    }
    Promise.resolve(this.engine.stamp({ cwd: this.cwd, id: this.conversationId }, this.o.engineOpts)).then((n) => {
      if (n && n !== this.knownSize && !this.session && !this.turn) this.load();
    }, () => {});
    return false;
  }

  knowSize() {
    if (this.engine.stamp) {
      this.stampAt = 0; // asked again at the next look
      Promise.resolve(this.engine.stamp({ cwd: this.cwd, id: this.conversationId }, this.o.engineOpts)).then((n) => {
        if (n) this.knownSize = n;
      }, () => {});
      return;
    }
    try {
      this.knownSize = fs.statSync(this.file()).size;
    } catch {
      /* nothing written */
    }
  }

  /** A turn runs, or background work (tasks.mjs: also the turn the coding tool owes after a background task). */
  busy() {
    return !!this.turn || this.tasks.busy();
  }
  /** idle | working: the word the rest of the dashboard asks for. */
  get state() {
    return this.busy() ? 'working' : 'idle';
  }

  /** working | attention (a tool use waits for the owner's OK) | waiting (for the owner's next message) */
  status() {
    if (this.pending.size) return 'attention';
    return this.busy() ? 'working' : 'waiting';
  }

  /** The status may have changed: say so (and when it did). */
  changed() {
    const s = this.status();
    if (s !== this.lastStatus) {
      this.lastStatus = s;
      this.statusAt = Date.now();
    }
    this.emit('status');
  }

  /** Idle now? Then a restart asked for happens, or the idle timer starts. */
  settle() {
    if (!this.turn) this.tasks.waitOwed(this.o.owedMs ?? OWED_MS, () => this.settle());
    if (!this.busy() && !this.pending.size) {
      if (this.restart && this.session) {
        this.restart = false;
        this.stop();
        return;
      }
      this.idleLater();
    }
    this.changed();
  }

  idleLater() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => !this.busy() && !this.pending.size && this.stop(), this.o.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }

  // ---------- what the owner does ----------

  /**
   * One message of the owner. Starts the coding tool when it is not running. While a turn runs, the message is
   * queued: handed to the coding tool at once where it queues by itself (it takes it at its next step, or after the
   * turn), else held here until the turn ends. m: { images: [{ mime, data }], attachments: [{ type, name, mime }] }
   * → { id, queued }.
   */
  async send(text, { images = [], attachments = [] } = {}) {
    if (this.closed) throw fail(409, 'this chat is closed');
    clearTimeout(this.idleTimer);
    // A terminal may have gone on with the conversation meanwhile: read it first, so the page shows it all.
    if (!this.session && !this.starting) {
      // Never read yet (its server did not run when the dashboard started): the conversation first, then the message.
      if (this.unread && !this.turn) await (this.loading || this.load());
      else this.refresh();
    }
    if (!this.title) this.title = oneLine(text, 80);
    const msg = { id: crypto.randomUUID(), text, images, attachments };
    if (this.turn) {
      this.queue.add(msg, this.engine.capabilities.queue ? this.session : null);
      return { id: msg.id, queued: true };
    }
    this.limit = null; // it is tried again (the limit may have reset, or another account signed in); a refusal sets it anew
    this.#begin(msg);
    try {
      if (!(await start(this))) return { id: msg.id, queued: false }; // stopped (or closed) while it got ready
    } catch (e) {
      this.push({ kind: 'turn-end', ok: false, subtype: 'start', error: `${this.engine.label} could not start: ${e.message}` });
      this.lastError = e.message;
      this.lastEnd = 'error';
      this.turn = null;
      this.settle();
      return { id: msg.id, queued: false };
    }
    // A coding tool that could not start at all has said so already (its exit ended the turn).
    if (!this.session) return { id: msg.id, queued: false };
    this.session.send(msg);
    // What was written while it started goes in behind it.
    if (this.engine.capabilities.queue) this.queue.sendHeld(this.session);
    return { id: msg.id, queued: false };
  }

  #begin(msg) {
    this.turn = { messageId: msg.id, auto: false, at: Date.now() };
    this.shown.add(msg.id);
    this.push({ kind: 'user', text: msg.text, attachments: msg.attachments, messageId: msg.id });
    this.changed();
  }

  /** After a turn: a message held here (the coding tool does not queue) becomes the next turn. */
  nextHeld() {
    const q = this.session ? this.queue.nextHeld() : null;
    if (!q) return;
    this.#begin(q);
    this.session.send(q);
  }

  /** Take a queued message back. Refused once the coding tool has started on it. */
  unqueue(id) {
    return this.queue.remove(id, this.session, this.engine.label);
  }

  /**
   * Before Stop: every queued message the coding tool has not started on is taken back (else it would start on it
   * the moment the turn ends, and keep working after Stop). → [{ text, files }] for the composer.
   */
  async takeBack() {
    const back = [];
    for (const q of [...this.queue.items]) {
      try {
        await this.queue.remove(q.id, this.session, this.engine.label);
        back.push({ text: q.text, files: (q.attachments || []).map((a) => a.name) });
      } catch {
        /* already taken: it is part of the turn that stops */
      }
    }
    return back;
  }

  /** The owner's answer to a tool use that waits for an OK (asks.mjs). */
  answer(request, a) {
    answerAsk(this, request, a);
  }

  /** Stop: the coding tool ends the turn (and the tool it runs), not its background tasks. If it does not, the process is stopped. */
  interrupt() {
    if (!this.turn) return false;
    if (!this.session) {
      this.stop(); // still getting ready: it does not start
      return true;
    }
    this.stopping = true;
    this.session.interrupt();
    cancelAsks(this);
    this.changed();
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (!this.turn || !this.session) return;
      this.push({ kind: 'turn-end', ok: false, subtype: 'stopped', error: null, stopped: true });
      this.lastEnd = 'stopped';
      this.turn = null;
      this.stop();
    }, this.o.stopGraceMs ?? STOP_GRACE_MS);
    this.stopTimer.unref?.();
    return true;
  }

  /** Stop one task (a background agent, shell or workflow); the turn goes on. */
  async stopTask(taskId) {
    if (!this.tasks.has(taskId)) throw fail(404, 'no such task in this chat');
    if (!this.session) throw fail(409, 'that task is not running');
    if (!this.engine.capabilities.stopTask) throw fail(409, `${this.engine.label} cannot stop one task; press Stop`);
    await this.session.stopTask(taskId);
  }

  /**
   * Go back to before the owner's message `messageId`, as Claude Code's own rewind does: its files (the changes made
   * since), the conversation (it goes on from before that message; the old one stays in the folder's history), or
   * both. dryRun: only say what would change. → { canRewind, filesChanged, insertions, deletions, error,
   * conversation: { messages (of the owner's, from that one on), text (that message, for the composer) } | null }
   */
  async rewind(messageId, { dryRun = false, files = true, conversation = false } = {}) {
    const caps = this.engine.capabilities;
    if (files && !caps.rewind) throw fail(409, `${this.engine.label} cannot undo changes`);
    if (conversation && !caps.fork) throw fail(409, `${this.engine.label} cannot go back in a conversation`);
    if (!files && !conversation) throw fail(400, 'say what to rewind: the files, the conversation, or both');
    if (this.busy()) throw fail(409, busyWords(this));
    let point = null;
    if (conversation) {
      point = this.engine.forkPoint(this.cwd, this.fork ? this.fork.from : this.conversationId, messageId);
      if (!point) throw fail(409, 'that message is not in the conversation\'s file yet; send it again instead');
    }
    let r = { canRewind: true, filesChanged: [] };
    if (files) r = await (await ensure(this)).rewind(messageId, { dryRun });
    const ok = r && r.canRewind !== false && !r.error;
    const n = ok && Array.isArray(r.filesChanged) ? r.filesChanged.length : 0;
    const at = this.events.findIndex((e) => e.kind === 'user' && e.messageId === messageId);
    const conv = point ? { messages: at < 0 ? 1 : this.events.slice(at).filter((e) => e.kind === 'user').length, text: point.text } : null;
    if (dryRun) return { ...r, conversation: conv };
    if (point && (ok || !files)) await this.#forkAt(messageId, point);
    const fileWords = files && ok ? `Files rewound to before your message${n ? ` (${n === 1 ? '1 file' : `${n} files`})` : ''}.` : '';
    const convWords = point ? 'The conversation went back to before your message; the earlier one is still in History.' : files && ok ? 'The conversation itself goes on as it was.' : '';
    if (fileWords || point) this.push({ kind: 'notice', level: 'info', text: [fileWords, convWords].filter(Boolean).join(' ') });
    return { ...r, conversation: conv };
  }

  /** The conversation goes on from before message `messageId` as a new one (point: engine.forkPoint). */
  async #forkAt(messageId, point) {
    await this.stopAndWait();
    const from = this.fork ? this.fork.from : this.conversationId;
    this.fork = { from, at: point.at, messageId };
    this.conversationId = crypto.randomUUID();
    this.costTotal = null;
    this.usage = {};
    this.lastError = null;
    this.lastEnd = null;
    this.load();
    this.push({ kind: 'session-changed', id: this.conversationId, reason: 'fork' });
    this.emit('record');
    this.emit('state');
  }

  /** The / menu: the coding tool's commands and skills for this folder. */
  async commands() {
    if (!this.engine.capabilities.commands) return (this.info.commands || []).map((name) => ({ name, description: '' }));
    const s = await ensure(this);
    this.knownCommands = await s.commands(); // kept for while a terminal runs the conversation (no second process)
    return this.knownCommands;
  }

  /** The owner names the chat (controls.mjs). */
  rename(title) {
    return renameChat(this, title);
  }

  /** Context and plan usage, asked of the running process (null when it does not run). */
  usageNow() {
    return usageNow(this);
  }

  /** Model, effort, ultracode and the permission mode: live where the engine can (controls.mjs). → { restart } */
  setSettings(o) {
    return applySettings(this, o);
  }

  /** Switched to bypass: what waits for an OK that is not the owner's own word is allowed now. */
  allowPending() {
    allowPending(this);
  }

  /** End the process (the conversation stays in its transcript). */
  stop() {
    stop(this);
  }

  /** stop(), and resolve once the process has really ended (SIGKILL after `ms`): nothing else may run it before. */
  stopAndWait(ms) {
    return stopAndWait(this, ms);
  }

  /** Close the chat for good: what is still getting ready never starts, what runs ends. */
  close(ms) {
    this.closed = true;
    return this.stopAndWait(ms);
  }

  /** Continue on another provider: the next turn starts there with the conversation resumed. */
  setProfile(name) {
    if (this.busy()) throw fail(409, busyWords(this));
    this.stop();
    this.profile = name;
    this.limit = null;
    this.push({ kind: 'notice', level: 'info', text: `The next message goes to another provider (${name}).` });
  }

  record() {
    return {
      id: this.id, ...(this.conversationId !== this.id ? { conversationId: this.conversationId } : {}), engine: this.engine.id,
      cwd: this.cwd, profile: this.profile, model: this.model, effort: this.effort, ultracode: this.ultracode, permissionMode: this.permissionMode,
      title: this.title, ...(this.named ? { named: true } : {}), openedAt: this.openedAt, costTotal: this.costTotal, grants: [...this.grants],
      ...(this.fork ? { fork: this.fork } : {}),
    };
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
