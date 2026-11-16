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
// Who answers when the coding tool asks for an OK:
//   - bypassPermissions ("Run anything without asking"): the chat allows it at once, with no card. Three things stay
//     the owner's, because they are his own word or cannot be taken back (the engine marks them `owner`): a question
//     to him or a plan to approve, what his own settings insist on (an "ask" rule, a hook that says ask), and the
//     coding tool's stop before a delete that could empty the disk. This holds only while the coding tool itself
//     reports the mode: where its settings turn it off, cards show.
//   - every other mode: a card. "Allow in this chat" adds the coding tool's own suggestion for the running process
//     and is remembered in the chat (grants): a process started again gets them with its start, and an ask that a
//     remembered grant covers is answered from it when a rule settles that kind of ask (the engine's `settled`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { providerEnv } from '../assistant/engine.mjs';
import { engineOf } from './engines/index.mjs';
import { oneLine } from './events.mjs';
import { Timeline } from './timeline.mjs';

export { EVENTS_MAX, WINDOW_MAX } from './timeline.mjs';
export const IDLE_MS = 20 * 60_000; // a process with nothing to do is stopped after this (the next message resumes)
const STOP_GRACE_MS = 8000; // after Stop, how long the coding tool gets to end the turn itself
const GRANTS_MAX = 500; // what "allow in this chat" covered, kept per chat (the oldest go first)
const QUEUE_MAX = 20; // messages waiting for the turn that runs
const TASKS_MAX = 200;
const LIVE_TEXT_MAX = 200_000; // of one block still streaming
// A background task that ended is followed by a turn of the coding tool's own (it reads the task's result), also
// when it ended while a turn ran; that turn starts right after. Until it does, the chat still works; it does not
// wait for it longer than this.
const OWED_MS = 10_000;
// Errors that mean "this provider cannot serve now" (the coding tool's error categories).
const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);
const LIMIT_TEXT = /usage limit|limit reached|rate.?limit|out of (credit|quota)|credit balance/i;

const fail = (status, message) => Object.assign(new Error(message), { status });
const strip = ({ full, ...rest }) => rest; // a tool's whole input stays on the server (an answer needs it)

export class Chat extends Timeline {
  /**
   * o: { id, conversationId, engine, cwd, profile, model, effort, ultracode, permissionMode, title, openedAt,
   *      costTotal, grants, resolveEnv(profile) (tests), command { command, args } and spawnImpl (tests), idleMs,
   *      stopGraceMs, termMs, killMs, drainMs }
   */
  constructor(o) {
    super();
    this.o = o;
    this.id = o.id; // the chat's own id: its page and card
    this.conversationId = o.conversationId || o.id; // the coding tool's conversation (a "clear" gives a new one)
    this.engine = engineOf(o.engine);
    this.cwd = o.cwd;
    this.profile = o.profile;
    this.model = o.model || null; // null: Auto (the coding tool's own choice)
    this.effort = o.effort || null;
    this.ultracode = o.ultracode === true;
    this.permissionMode = o.permissionMode || null;
    this.title = o.title || '';
    this.openedAt = o.openedAt || Date.now();
    this.costTotal = Number.isFinite(o.costTotal) ? o.costTotal : null; // what the coding tool reported last (a running total)
    this.grants = new Set((Array.isArray(o.grants) ? o.grants : []).filter((g) => typeof g === 'string').slice(-GRANTS_MAX));
    this.session = null; // the running coding tool
    this.turn = null; // the turn that runs: { messageId, auto, at }
    this.pending = new Map(); // request id → the ask event (with the full input)
    this.tasks = new Map(); // task id → { taskId, toolId, type, title, status, background, usage, phases, agents, … }
    this.bg = new Set(); // the background tasks the coding tool says run
    this.owed = 0; // background tasks that ended, whose turn has not started yet
    this.owedTimer = null;
    this.queue = []; // messages written while a turn runs: { id, text, attachments, images, state: held | sent }
    this.live = new Map(); // what still streams: text and thinking blocks, tool calls being written or running
    this.shown = new Set(); // ids of the owner's messages shown (the coding tool's echo of one is not shown twice)
    this.todos = [];
    this.info = {}; // what the coding tool says of itself: version, tools, commands, skills
    this.usage = {}; // contextUsed, contextWindow, costTotal
    this.limits = {}; // window → { status, utilization, resetsAt }
    this.activity = null; // requesting | compacting | retrying (live, for the status line)
    this.liveModel = null;
    this.liveMode = null; // the permission mode the running process reports
    this.bypass = false; // … and whether it allows everything (the chat answers asks then)
    this.statusAt = Date.now();
    this.lastStatus = 'waiting';
    this.lastText = '';
    this.lastError = null;
    this.limit = null;
    this.restart = false; // a setting the process cannot change live changed: start again once it is idle
    this.knownSize = -1;
    this.idleTimer = null;
    this.stopTimer = null;
    this.gen = 0; // goes up with every stop(): a start that was under way when it came does not go on
    this.closed = false;
    this.ending = null; // the previous process's exit, while it is still stopping
    this.starting = null; // the start under way
    this.load();
  }

  file() {
    return this.engine.file(this.cwd, this.conversationId);
  }

  /** Read the conversation from its files (the page starts over). */
  load() {
    const t = this.engine.transcript({ cwd: this.cwd, id: this.conversationId });
    this.reset(t.events);
    this.todos = t.todos;
    for (const task of t.tasks) if (!this.tasks.has(task.taskId)) this.tasks.set(task.taskId, (({ kind, ...x }) => x)(task));
    const last = [...t.events].reverse().find((e) => e.kind === 'text' && !e.agent);
    this.lastText = last ? last.text : '';
    if (t.title) this.title = t.title;
    if (!this.title) {
      const first = t.events.find((e) => e.kind === 'user');
      if (first) this.title = oneLine(first.text, 80);
    }
    for (const e of t.events) if (e.kind === 'user' && e.messageId) this.shown.add(e.messageId);
    this.knownSize = t.size;
    this.emit('change');
  }

  /** The transcript changed without us (a terminal ran it): read it again. Cheap when nothing changed. */
  refresh() {
    if (this.session) return false;
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

  /** Background work runs: the coding tool says so, or a task started in the background has not ended. */
  bgBusy() {
    if (this.bg.size) return true;
    for (const t of this.tasks.values()) if (t.background && t.status === 'running') return true;
    return false;
  }
  busy() {
    return !!this.turn || this.bgBusy() || this.owed > 0;
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

  #changed() {
    const s = this.status();
    if (s !== this.lastStatus) {
      this.lastStatus = s;
      this.statusAt = Date.now();
    }
    this.emit('status');
  }

  /** Idle now? Then a restart asked for happens, or the idle timer starts. */
  #settle() {
    if (this.owed && !this.turn && !this.bgBusy() && !this.owedTimer) {
      this.owedTimer = setTimeout(() => {
        this.owedTimer = null;
        this.owed = 0;
        this.#settle();
      }, this.o.owedMs ?? OWED_MS);
      this.owedTimer.unref?.();
    }
    if (!this.busy() && !this.pending.size) {
      if (this.restart && this.session) {
        this.restart = false;
        this.stop();
        return;
      }
      this.#idleLater();
    }
    this.#changed();
  }

  #idleLater() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => !this.busy() && !this.pending.size && this.stop(), this.o.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }

  // ---------- the process ----------

  /** Start the coding tool (once). Resolves false when a stop() came while it was getting ready. */
  #start() {
    if (this.session) return Promise.resolve(true);
    if (this.starting) return this.starting;
    const gen = this.gen;
    this.starting = (async () => {
      // The same conversation must not run twice: a process that is still stopping ends first.
      if (this.ending) await this.ending;
      // The provider's environment may take a while (its PRERUN starts a gateway, Auto mode starts the router).
      const env = await (this.o.resolveEnv || providerEnv)(this.profile);
      if (gen !== this.gen || this.closed) return false;
      const resume = this.engine.exists(this.cwd, this.conversationId);
      if (!resume) this.costTotal = 0; // a new conversation starts at nothing
      let session = null;
      session = this.engine.open({
        cwd: this.cwd, env, sessionId: this.conversationId, resume, model: this.model, effort: this.effort, ultracode: this.ultracode,
        mode: this.permissionMode, grants: [...this.grants], emit: (ev) => this.#from(session, ev),
        command: this.o.command, spawnImpl: this.o.spawnImpl, termMs: this.o.termMs, killMs: this.o.killMs, drainMs: this.o.drainMs,
      });
      this.session = session;
      this.liveMode = null;
      this.bypass = false; // until this process says so itself
      return true;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** The process runs (started for a menu or a rewind, not for a message: the idle timer applies). */
  async #ensure() {
    if (this.closed) throw fail(409, 'this chat is closed');
    if (this.session) return this.session;
    if (!(await this.#start()) || !this.session) throw fail(409, `${this.engine.label} did not start`);
    if (!this.busy()) this.#idleLater();
    return this.session;
  }

  #from(session, ev) {
    if (this.session !== session) {
      if (ev.kind === 'exit') this.#knowSize(); // what it wrote last is ours: no reason to read it again
      return;
    }
    this.#on(ev);
  }

  #knowSize() {
    try {
      this.knownSize = fs.statSync(this.file()).size;
    } catch {
      /* nothing written */
    }
  }

  #on(ev) {
    switch (ev.kind) {
      case 'session':
        this.info = { version: ev.version, tools: ev.tools, commands: ev.commands, skills: ev.skills, agents: ev.agents };
        this.liveModel = ev.model;
        this.liveMode = ev.mode;
        this.bypass = ev.mode === 'bypassPermissions';
        this.owed = 0;
        clearTimeout(this.owedTimer);
        this.owedTimer = null;
        // A turn nobody asked for: the coding tool goes on by itself (a background task ended).
        if (!this.turn) {
          clearTimeout(this.idleTimer);
          this.turn = { messageId: null, auto: true, at: Date.now() };
          this.push({ kind: 'turn-start', auto: true });
        }
        this.#changed();
        return;
      case 'mode': // the coding tool entered or left plan mode, or a switch was confirmed
        this.liveMode = ev.mode;
        this.emit('state');
        return;
      case 'status':
        this.activity = ev.state;
        if (ev.retry) {
          const e = ev.retry.error;
          if (LIMIT_ERRORS.has(e)) this.limit = { at: Date.now(), error: e, text: `The provider refused (${e})` };
          if (ev.retry.attempt === 1 || LIMIT_ERRORS.has(e)) this.push({ kind: 'notice', level: 'warning', text: `The provider did not answer (${e.replace(/_/g, ' ')}); trying again…` });
        }
        this.emit('state');
        return;
      case 'text-delta':
      case 'thinking-delta': {
        const b = this.live.get(ev.blockId) || { kind: ev.kind === 'text-delta' ? 'text' : 'thinking', blockId: ev.blockId, text: '', agent: ev.agent };
        b.text = (b.text + ev.text).slice(-LIVE_TEXT_MAX);
        if (ev.tokens !== undefined) b.tokens = ev.tokens;
        this.live.set(ev.blockId, b);
        this.emit('live', ev);
        return;
      }
      case 'tool-start':
      case 'tool-progress': {
        const key = `tool:${ev.id}`;
        const t = this.live.get(key) || { kind: 'tool', id: ev.id, agent: ev.agent };
        if (ev.kind === 'tool-start') Object.assign(t, { name: ev.name, title: ev.title || t.title || '', toolKind: ev.toolKind });
        else t.elapsedS = ev.elapsedS;
        this.live.set(key, t);
        this.emit('live', ev);
        return;
      }
      case 'text':
      case 'thinking':
        this.live.delete(ev.blockId);
        if (ev.kind === 'text' && !ev.agent) this.lastText = ev.text;
        this.push(ev);
        return;
      case 'tool': {
        const t = this.live.get(`tool:${ev.id}`);
        if (t) t.written = true; // stays while it runs (its progress), until its result
        this.push(strip(ev));
        return;
      }
      case 'tool-result':
        this.live.delete(`tool:${ev.id}`);
        this.push(ev);
        return;
      case 'todos':
        this.todos = ev.list;
        this.emit('state');
        return;
      case 'task':
        this.#task(ev);
        return;
      case 'tasks-running':
        this.bg = new Set(ev.ids);
        // This line comes before the task's own start, and is what marks a workflow as background.
        for (const id of ev.ids) {
          const t = this.tasks.get(id) || { taskId: id, status: 'running', startedAt: Date.now() };
          t.background = true;
          this.tasks.set(id, t);
        }
        this.emit('state');
        this.#settle();
        return;
      case 'ask':
        this.#ask(ev);
        return;
      case 'ask-cancelled':
        if (this.pending.delete(ev.request)) this.push({ kind: 'ask-closed', request: ev.request, outcome: 'cancelled' });
        this.#changed();
        return;
      case 'user':
        this.#taken(ev.messageId, ev);
        return;
      case 'queue-state':
        if (ev.state === 'started') this.#taken(ev.messageId, null);
        else if (ev.state === 'cancelled') this.#dequeue(ev.messageId);
        return;
      case 'session-changed':
        if (ev.reason === 'clear' && ev.id && ev.id !== this.conversationId) {
          this.conversationId = ev.id;
          this.emit('record');
        }
        this.push(ev);
        return;
      case 'usage':
        for (const k of ['contextUsed', 'contextWindow', 'costTotal']) if (ev[k] !== undefined && ev[k] !== null) this.usage[k] = ev[k];
        this.emit('state');
        return;
      case 'limits':
        this.limits[ev.window] = { status: ev.status, utilization: ev.utilization, resetsAt: ev.resetsAt, at: Date.now() };
        if (ev.status === 'rejected') this.limit = { at: Date.now(), error: 'rate_limit', text: `The plan's limit is reached (${ev.window.replace(/_/g, ' ')})` };
        this.emit('state');
        return;
      case 'title':
        if (ev.text) this.title = ev.text;
        this.emit('record');
        this.emit('state');
        return;
      case 'turn-end':
        this.#turnEnd(ev);
        return;
      case 'exit':
        this.#exit(ev);
        return;
      case 'notice':
        this.push(ev);
        return;
      default:
    }
  }

  #task(ev) {
    const { kind, at, ...fields } = ev;
    const t = this.tasks.get(ev.taskId) || { taskId: ev.taskId, status: 'running', startedAt: Date.now() };
    const was = t.status;
    Object.assign(t, fields, { updatedAt: Date.now() });
    if (t.background && was === 'running' && (t.status === 'completed' || t.status === 'failed')) this.owed++;
    this.tasks.set(t.taskId, t);
    if (t.status !== 'running') this.bg.delete(t.taskId);
    if (this.tasks.size > TASKS_MAX) {
      const old = [...this.tasks.values()].find((x) => x.status !== 'running');
      if (old) this.tasks.delete(old.taskId);
    }
    this.emit('state');
    this.#settle();
  }

  #ask(ev) {
    const grant = ev.grant;
    // No card: the mode allows everything, or the owner already allowed exactly this for the chat and only the
    // process is new (it gets the rule again with the answer).
    const allowedBefore = !!grant && ev.settled && grant.atoms.every((a) => this.grants.has(a));
    if (!ev.owner && (this.bypass || allowedBefore) && this.session) {
      this.session.answer(ev.request, { allow: true, input: ev.full, permissions: this.bypass ? null : grant.updates });
      return;
    }
    this.pending.set(ev.request, ev);
    // The page gets the input to show and what "allow in this chat" covers; the rest stays here.
    const { full, interactive, reasonType, reason, ruleForced, manualOnly, noAlways, settled, owner, grant: g, ...shown } = ev;
    this.push({ ...shown, canAlways: !!grant, always: grant ? (grant.edits ? 'edits' : 'rule') : null, alwaysText: grant && !grant.edits ? grant.text : '' });
    this.#changed();
  }

  /** A message of the owner was taken by the coding tool: shown (once), out of the queue, its turn runs. */
  #taken(messageId, ev) {
    const item = messageId ? this.queue.find((q) => q.id === messageId) : null;
    if (item) this.#dequeue(messageId);
    if (!messageId || !this.shown.has(messageId)) {
      const src = ev || item;
      if (src) {
        if (messageId) this.shown.add(messageId);
        this.push({ kind: 'user', text: src.text, attachments: src.attachments || [], messageId });
      }
    }
    if (!this.turn && (item || ev)) {
      clearTimeout(this.idleTimer);
      this.turn = { messageId, auto: false, at: Date.now() };
      this.#changed();
    }
  }

  #dequeue(id) {
    const n = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id);
    if (this.queue.length !== n) this.emit('state');
  }

  #turnEnd(ev) {
    clearTimeout(this.stopTimer);
    let turnCost = null;
    if (ev.costUsd !== null && this.costTotal !== null && ev.costUsd >= this.costTotal) turnCost = ev.costUsd - this.costTotal;
    if (ev.costUsd !== null) this.costTotal = ev.costUsd;
    this.lastError = ev.ok ? null : ev.error;
    this.limit = !ev.ok && ev.error && LIMIT_TEXT.test(ev.error) ? { at: Date.now(), error: 'rate_limit', text: ev.error.slice(0, 300) } : ev.ok ? null : this.limit;
    this.#cancelAsks();
    for (const [k, v] of this.live) if (v.kind !== 'tool' || !v.written) this.live.delete(k);
    const stopped = ev.subtype === 'error_during_execution' || ev.error === 'stopped';
    this.push({ kind: 'turn-end', ok: ev.ok, subtype: ev.subtype, error: ev.ok ? null : ev.error, turnCostUsd: turnCost, usage: ev.usage, durationMs: ev.durationMs, stopped });
    this.#knowSize();
    this.turn = null;
    this.activity = null;
    this.#nextHeld();
    this.#settle();
    this.emit('turn', ev);
  }

  #exit({ code, why }) {
    this.session = null;
    clearTimeout(this.stopTimer);
    if (this.turn || this.pending.size) {
      this.#cancelAsks();
      this.push({ kind: 'turn-end', ok: false, subtype: 'exit', error: `${this.engine.label} stopped (${code})${why ? `: ${why}` : ''}`, stopped: false });
      this.lastError = `${this.engine.label} stopped (${code})`;
      this.turn = null;
    }
    this.#lostWork();
    this.#knowSize();
    this.#changed();
  }

  /** The process is gone: what it ran in the background and what was queued in it went with it. */
  #lostWork() {
    for (const t of this.tasks.values()) if (t.status === 'running') t.status = 'stopped';
    this.bg.clear();
    this.owed = 0;
    clearTimeout(this.owedTimer);
    this.owedTimer = null;
    const lost = this.queue.filter((q) => q.state === 'sent');
    if (lost.length) {
      this.queue = this.queue.filter((q) => q.state !== 'sent');
      this.push({ kind: 'notice', level: 'warning', text: `${lost.length === 1 ? 'A queued message was' : `${lost.length} queued messages were`} not sent.` });
    }
    this.live.clear();
    this.activity = null;
    this.emit('state');
  }

  #cancelAsks() {
    for (const r of this.pending.keys()) this.push({ kind: 'ask-closed', request: r, outcome: 'cancelled' });
    this.pending.clear();
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
    if (!this.session && !this.starting) this.refresh();
    if (!this.title) this.title = oneLine(text, 80);
    const msg = { id: crypto.randomUUID(), text, images, attachments };
    if (this.turn) {
      if (this.queue.length >= QUEUE_MAX) throw fail(409, `${QUEUE_MAX} messages are queued already; wait for them, or remove one`);
      const item = { ...msg, state: 'held', at: Date.now() };
      this.queue.push(item);
      if (this.session && this.engine.capabilities.queue) {
        this.session.send(msg);
        item.state = 'sent';
      }
      this.emit('state');
      return { id: msg.id, queued: true };
    }
    this.#begin(msg);
    try {
      if (!(await this.#start())) return { id: msg.id, queued: false }; // stopped (or closed) while it got ready
    } catch (e) {
      this.push({ kind: 'turn-end', ok: false, subtype: 'start', error: `${this.engine.label} could not start: ${e.message}` });
      this.lastError = e.message;
      this.turn = null;
      this.#settle();
      return { id: msg.id, queued: false };
    }
    this.session.send(msg);
    // What was written while it started goes in behind it.
    if (this.engine.capabilities.queue) {
      for (const q of this.queue) {
        if (q.state !== 'held') continue;
        this.session.send(q);
        q.state = 'sent';
      }
    }
    return { id: msg.id, queued: false };
  }

  #begin(msg) {
    this.turn = { messageId: msg.id, auto: false, at: Date.now() };
    this.shown.add(msg.id);
    this.push({ kind: 'user', text: msg.text, attachments: msg.attachments, messageId: msg.id });
    this.#changed();
  }

  /** After a turn: a message held here (the coding tool does not queue) becomes the next turn. */
  #nextHeld() {
    const q = this.queue.find((x) => x.state === 'held');
    if (!q || !this.session) return;
    this.#dequeue(q.id);
    this.#begin(q);
    this.session.send(q);
  }

  /** Take a queued message back. Refused once the coding tool has started on it. */
  async unqueue(id) {
    const q = this.queue.find((x) => x.id === id);
    if (!q) throw fail(409, 'that message is not queued any more');
    if (q.state === 'sent' && this.session) {
      if (!(await this.session.cancel(id).catch(() => false))) throw fail(409, `${this.engine.label} has already taken that message`);
    }
    this.#dequeue(id);
  }

  /**
   * The owner's answer to a tool use that waits for an OK. a: { allow, always (only for this chat: the coding tool's
   * own session suggestions, never a settings file), answers (a question: question → chosen label), mode (a plan
   * approved: the permission mode to go on in), message }.
   */
  answer(request, a) {
    const ask = this.pending.get(request);
    if (!ask) throw fail(409, 'that question was already answered');
    if (!this.session) throw fail(409, `${this.engine.label} is not running in this chat`);
    let outcome = 'denied';
    if (a.allow) {
      const input = ask.tool === 'AskUserQuestion' && a.answers ? { ...ask.full, answers: a.answers } : ask.full;
      const grant = a.always ? ask.grant : null;
      let permissions = grant ? grant.updates : null;
      if (ask.type === 'plan' && a.mode) {
        permissions = [{ type: 'setMode', mode: a.mode === 'manual' ? 'default' : a.mode, destination: 'session' }];
        this.permissionMode = a.mode;
        this.bypass = a.mode === 'bypassPermissions';
        this.emit('record');
      }
      this.session.answer(request, { allow: true, input, permissions });
      outcome = grant ? 'allowed-always' : 'allowed';
      if (grant) {
        for (const g of grant.atoms) this.grants.add(g);
        for (const g of [...this.grants].slice(0, Math.max(0, this.grants.size - GRANTS_MAX))) this.grants.delete(g);
        this.emit('record'); // kept with the chat (feature.mjs saves the open chats)
      }
    } else {
      const why = a.message ? `: ${a.message}` : '.';
      this.session.answer(request, { allow: false, message: `The user said no to this ${ask.tool} call in the dashboard${why} Do not do it another way; wait for the user to say how to go on.` });
    }
    this.pending.delete(request);
    this.push({ kind: 'ask-closed', request, outcome });
    this.#changed();
  }

  /** Stop: the coding tool ends the turn (and the tool it runs), not its background tasks. If it does not, the process is stopped. */
  interrupt() {
    if (!this.turn) return false;
    if (!this.session) {
      this.stop(); // still getting ready: it does not start
      return true;
    }
    this.session.interrupt();
    this.#cancelAsks();
    this.#changed();
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (!this.turn || !this.session) return;
      this.push({ kind: 'turn-end', ok: false, subtype: 'stopped', error: 'stopped', stopped: true });
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

  /** Undo the file changes since message `messageId` (dryRun: only say what they are). */
  async rewind(messageId, { dryRun = false } = {}) {
    if (!this.engine.capabilities.rewind) throw fail(409, `${this.engine.label} cannot undo changes`);
    if (this.busy()) throw fail(409, 'Claude is working. Wait until it is done, or press Stop first.');
    const s = await this.#ensure();
    return s.rewind(messageId, { dryRun });
  }

  /** The / menu: the coding tool's commands and skills for this folder. */
  async commands() {
    if (!this.engine.capabilities.commands) return (this.info.commands || []).map((name) => ({ name, description: '' }));
    const s = await this.#ensure();
    return s.commands();
  }

  /** Context and plan usage, asked of the running process (null when it does not run). */
  async usageNow() {
    if (!this.session || !this.engine.capabilities.usage) return null;
    const [context, usage] = await Promise.all([this.session.contextUsage().catch(() => null), this.session.usage().catch(() => null)]);
    if (context && Number.isFinite(context.totalTokens)) Object.assign(this.usage, { contextUsed: context.totalTokens, contextWindow: context.maxTokens, contextPercent: context.percentage });
    if (usage && usage.rate_limits && typeof usage.rate_limits === 'object') {
      for (const [w, r] of Object.entries(usage.rate_limits)) if (r && typeof r === 'object') this.limits[w] = { status: r.status ?? null, utilization: r.utilization ?? null, resetsAt: r.resetsAt ?? r.resets_at ?? null, at: Date.now() };
    }
    this.emit('state');
    return { usage: this.usage, limits: this.limits, subscription: usage ? usage.subscription_type || null : null, limitsKnown: !!(usage && usage.rate_limits_available) };
  }

  /**
   * Model, effort, ultracode and the permission mode, changed in the running process where the engine can (no
   * restart, the conversation's cache stays); where it cannot, it starts again with the conversation resumed once
   * it is idle. → { restart }
   */
  async setSettings({ model, effort, ultracode, mode }) {
    const caps = this.engine.capabilities;
    const live = () => !!(this.session && this.session.alive);
    const tryLive = async (can, fn) => {
      if (!live()) return true; // the next start has it
      if (!can) return false;
      try {
        await fn(this.session);
        return true;
      } catch {
        return false;
      }
    };
    let restart = false;
    if (model !== undefined && model !== this.model) {
      this.model = model;
      if (!(await tryLive(caps.liveModel, (s) => s.setModel(model)))) restart = true;
    }
    const effortChanged = effort !== undefined && effort !== this.effort;
    const ultraChanged = ultracode !== undefined && ultracode !== this.ultracode;
    if (effortChanged || ultraChanged) {
      if (effortChanged) this.effort = effort;
      if (ultraChanged) this.ultracode = ultracode;
      // An effort change always carries the ultracode value (without it Claude Code turns ultracode off).
      if (!(await tryLive(caps.liveEffort && (!ultraChanged || caps.ultracode), (s) => s.setEffort({ effort: this.effort, ultracode: this.ultracode })))) restart = true;
    }
    if (mode !== undefined && mode !== this.permissionMode) {
      this.permissionMode = mode;
      if (await tryLive(caps.liveMode, (s) => s.setMode(mode))) {
        if (live()) {
          this.bypass = mode === 'bypassPermissions';
          this.liveMode = mode === 'manual' ? 'default' : mode;
          this.#allowPending();
        }
      } else restart = true;
    }
    if (restart && this.session) {
      if (this.busy()) this.restart = true;
      else this.stop();
    }
    this.emit('record');
    this.emit('state');
    return { restart };
  }

  /** Switched to bypass: what waits for an OK that is not the owner's own word is allowed now. */
  #allowPending() {
    if (!this.bypass) return;
    for (const [r, ask] of [...this.pending]) {
      if (ask.owner) continue;
      this.session.answer(r, { allow: true, input: ask.full, permissions: null });
      this.pending.delete(r);
      this.push({ kind: 'ask-closed', request: r, outcome: 'allowed' });
    }
    this.#changed();
  }

  /** End the process (the conversation stays in its transcript). */
  stop() {
    this.gen++; // a start that is still getting ready does not go on
    clearTimeout(this.idleTimer);
    clearTimeout(this.stopTimer);
    const session = this.session;
    this.session = null;
    this.restart = false;
    if (this.turn || this.pending.size) {
      this.#cancelAsks();
      this.push({ kind: 'notice', level: 'info', text: 'Stopped.' });
      this.turn = null;
    }
    this.#lostWork();
    this.queue = [];
    if (session) {
      const ended = session.close().then(() => {
        if (this.ending === ended) this.ending = null;
      });
      this.ending = ended;
      this.endingSession = session;
    }
    this.#changed();
  }

  /** stop(), and resolve once the process has really ended (SIGKILL after `ms`): nothing else may run it before. */
  async stopAndWait(ms = 6000) {
    this.stop();
    if (!this.ending) return;
    let t;
    await Promise.race([this.ending, new Promise((r) => (t = setTimeout(r, ms)))]);
    clearTimeout(t);
    if (this.ending && this.endingSession) {
      this.endingSession.kill();
      await this.ending;
    }
  }

  /** Close the chat for good: what is still getting ready never starts, what runs ends. */
  close(ms) {
    this.closed = true;
    return this.stopAndWait(ms);
  }

  /** Continue on another provider: the next turn starts there with the conversation resumed. */
  setProfile(name) {
    if (this.busy()) throw fail(409, 'Claude is working. Wait until it is done, or press Stop first.');
    this.stop();
    this.profile = name;
    this.limit = null;
    this.push({ kind: 'notice', level: 'info', text: `The next message goes to another provider (${name}).` });
  }

  record() {
    return {
      id: this.id, ...(this.conversationId !== this.id ? { conversationId: this.conversationId } : {}), engine: this.engine.id,
      cwd: this.cwd, profile: this.profile, model: this.model, effort: this.effort, ultracode: this.ultracode, permissionMode: this.permissionMode,
      title: this.title, openedAt: this.openedAt, costTotal: this.costTotal, grants: [...this.grants],
    };
  }
}
