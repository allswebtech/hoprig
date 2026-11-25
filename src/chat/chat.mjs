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
// how: asks.mjs. What changes live: controls.mjs. Reading the conversation back: reading.mjs.
import crypto from 'node:crypto';
import { engineOf } from './engines/index.mjs';
import { allowPending, answerAsk, cancelAsks, keepGrants } from './asks.mjs';
import { applySettings, renameChat, usageNow } from './controls.mjs';
import { oneLine, plainText } from './events.mjs';
import { conversationTitle, ownEntry, sessionName, setOwnName, sizeOf } from '../titles.mjs';
import { MessageQueue } from './queue.mjs';
import { checkWaiting, earlier, knowSize, load, markRecord, refresh, restoredMark } from './reading.mjs';
import { ensure, start, stop, stopAndWait } from './run.mjs';
import { LiveBlocks } from './streaming.mjs';
import { OWED_MS, TaskTable } from './tasks.mjs';
import { Timeline } from './timeline.mjs';

import { ticksOf } from '../models/others.mjs';
export { EVENTS_MAX, WINDOW_MAX } from './timeline.mjs';
export const IDLE_MS = 20 * 60_000; // a process with nothing to do is stopped after this (the next message resumes)
const STOP_GRACE_MS = 8000; // after Stop, how long the coding tool gets to end the turn itself
const MESSAGE_ENDS_MAX = 1000; // the newest message ends a chat keeps in memory (messageEnd)

const fail = (status, message) => Object.assign(new Error(message), { status });
const ownStatOf = (x) => (x && Number.isFinite(x.size) && x.size >= 0 && Number.isFinite(x.mtimeMs) ? { size: x.size, mtimeMs: x.mtimeMs } : null);
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
    // "Lead model" (src/models/lead.mjs): off unless chosen; an old record without it reads as off.
    this.lead = o.lead === true;
    // "Use other providers": the providers ticked for this chat (src/models/others.mjs); none in an old record.
    this.others = ticksOf(o.others);
    this.permissionMode = o.permissionMode || null;
    this.title = o.title || '';
    this.named = o.named === true; // the owner named it in the dashboard: that name wins over the transcript's
    // Tia started this very chat (feature.mjs openChat): a fact of this chat, never of its id, which a chat opened
    // later on the same conversation may get again. Her rules let her answer OKs only in a chat of hers.
    this.byTia = o.byTia === true;
    // After a restart her mark waits until the conversation is read (reading.mjs restoredMark); until then not hers.
    this.restoredMark = restoredMark(o, this.byTia);
    if (this.restoredMark) this.byTia = false;
    // The session is Tia's for her safety (the mark and her git sign-in, run.mjs), apart from byTia, which also lets
    // her rules answer its OKs: a terminal of hers shown as a chat, or a chat of hers the owner then wrote in. It stays
    // so until the chat ends; nothing the owner types takes it off, since it only ever adds his card.
    this.hers = o.hers === true;
    // A part of Tia's Lead session that started by itself inside her daily limit for paid use (partdoor.mjs): kept with
    // the record, so every start of its process, also after a restart of the dashboard, gets a share of what is left of
    // that limit as its budget, and the end of its process settles it (feature.mjs make: o.processEnded).
    this.paidBudget = o.paidBudget === true;
    this.openedAt = o.openedAt || Date.now();
    this.costTotal = Number.isFinite(o.costTotal) ? o.costTotal : null; // what the coding tool reported last (a running total)
    this.grants = keepGrants(o.grants); // what "allow in this chat" covered (asks.mjs)
    // Hands-off (chat/handsoff.mjs): the chat's own switch ({ on, version }; null: the project's), a loop's stop, the count.
    this.handsOff = o.handsOff && typeof o.handsOff === 'object' && typeof o.handsOff.on === 'boolean' ? { on: o.handsOff.on, version: String(o.handsOff.version || ''), at: Number(o.handsOff.at) || 0 } : null;
    this.handsOffStop = o.handsOffStop === 'loop' || o.handsOffStop === 'hour' ? o.handsOffStop : null;
    // Kept with the chat's record, so a restart of the dashboard does not start the count again.
    this.handsOffRow = Number.isInteger(o.handsOffRow) && o.handsOffRow > 0 ? o.handsOffRow : 0;
    this.handsOffTimes = Array.isArray(o.handsOffTimes) ? o.handsOffTimes.filter(Number.isFinite).slice(-10) : []; // when it answered (handsoff.mjs hourFull)
    // "Also open": map names of extra folders for this chat only (workspace/needs.mjs decides each at every start).
    this.withs = Array.isArray(o.withs) ? o.withs.filter((x) => typeof x === 'string').slice(0, 10) : [];
    this.extras = []; // the extra folders of its last start, by map name (its card says them)
    this.session = null; // the running coding tool
    this.turn = null; // the turn that runs: { messageId, auto, at }
    this.stopping = false; // Stop was pressed: the turn's end is the owner's, not a failure
    this.pending = new Map(); // request id → the ask event (with the full input)
    this.held = new Map(); // request id → { timer, ev } of an ask the hook may still answer (asks.mjs): no card yet
    this.allowedShown = new Set(); // record file#number of what the hook allowed that the chat has shown (asks.mjs hookAllowed)
    this.tasks = new TaskTable(); // subagents, background shells and workflows (tasks.mjs)
    this.queue = new MessageQueue(() => this.emit('state')); // messages written while a turn runs (queue.mjs)
    this.live = new LiveBlocks(); // what still streams (streaming.mjs)
    this.shown = new Set(); // ids of the owner's messages shown (the coding tool's echo of one is not shown twice)
    this.messageEnds = new Map(); // the owner's message id → how its turn ended, or that it never ran (messageEnd)
    this.todos = [];
    this.todosGen = 0; // one more for each new list (read or live): the earlier part's list is taken only while none came after
    this.info = {}; // what the coding tool says of itself: version, tools, commands, skills
    this.knownCommands = null; // the / menu as the coding tool gave it last
    this.usage = {}; // contextUsed, contextWindow, costTotal
    this.limits = {}; // window → { status, percent, resetsAt } (controls.mjs)
    this.activity = null; // requesting | compacting | retrying (live, for the status line)
    this.liveModel = null;
    this.liveMode = null; // the permission mode the running process reports
    this.modeLater = null; // a mode set that the running process takes only when it starts again (controls.mjs)
    // Claude Code said it runs in auto mode (started in it, or a switch confirmed): auto mode is there for this
    // session's model and settings, so a plan's first answer may offer it (else "auto-accept edits").
    this.autoSeen = false;
    this.bypass = false; // … and whether it allows everything (the chat answers asks then)
    this.statusAt = Date.now();
    this.lastStatus = 'waiting';
    this.lastText = '';
    this.lastError = null;
    this.lastEnd = null; // how the last turn ended: ok | stopped | limit | error
    this.limit = null;
    this.restart = false; // a setting the process cannot change live changed: start again once it is idle
    this.knownSize = -1;
    // { size, mtimeMs } of the transcript as the session's own process left it (reading.mjs knowSize); kept in its
    // record, so after a restart or a Put back the file it left is still known as its own (growth.mjs).
    this.ownStat = ownStatOf(o.own);
    this.idleTimer = null;
    this.stopTimer = null;
    this.gen = 0; // goes up with every stop(): a start that was under way when it came does not go on
    this.closed = false;
    this.ending = null; // the previous process's exit, while it is still stopping
    this.starting = null; // the start under way
    this.unread = false; // a tool read through its server: not read yet (its server did not run at the first look)
    this.partial = null; // read from its last part at the start: { start } (the byte its earlier part ends at)
    this.tailing = false; // that read is under way
    this.earlierRead = null;
    this.todosRead = null; // the to-do list of a conversation read from its last part, under way (reading.mjs)
    this.todosOwed = null; // …or left for the first look at the session (reading.mjs refresh)
    this.looked = false; // a page or a message looked at the session since the dashboard started
    this.load({ wake: false });
    checkWaiting(this); // an OK that waited while the dashboard was down (reading.mjs)
  }

  /** Start the coding tool again for what its conversation waits for (reading.mjs checkWaiting). */
  wake() {
    ensure(this).catch(() => {});
  }

  /** The conversation's file (null for a tool whose conversations are kept by its server). */
  file() {
    return this.engine.file(this.cwd, this.conversationId);
  }

  /**
   * Read the conversation from its files or its tool's server (the page starts over); wake: false (when the dashboard
   * starts) never starts a tool's server for it (reading.mjs).
   */
  load({ wake = true } = {}) {
    return load(this, { wake });
  }

  /** The conversation's earlier part, when it was read from its last part at the start (reading.mjs earlier). */
  earlier() {
    return earlier(this);
  }

  /** The transcript changed without us (a terminal ran it): read it again. Cheap when nothing changed. */
  refresh() {
    return refresh(this);
  }

  /** What the coding tool wrote last is ours: no reason to read it again. */
  knowSize() {
    knowSize(this);
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
      // Or its first read in pieces (a long Claude Code transcript, at the start) is still under way: it ends first.
      // A tool read through its server is not waited for: its late read gives way to the turn (reading.mjs load).
      if ((this.unread || this.tailing) && !this.turn) await (this.loading || this.load());
      else this.refresh();
    }
    if (!this.title) this.title = oneLine(text, 80);
    this.handsOffRow = 0; // a message of the owner's: work between Hands-off's answers
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
      this.endMessages(null);
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
  async unqueue(id) {
    await this.queue.remove(id, this.session, this.engine.label);
    this.gaveBack(id);
  }

  /**
   * How the owner's message `id` ended, as this chat saw it (Tia's spending ledger asks, spend.mjs measureChats):
   * { ended: true, cost, total } once the turn that ran it ended (cost: what that turn reported, null when it reported
   * none; total: the chat's costTotal after it), { back: true } when it never ran (taken back, or lost with the
   * process), null while it waits or runs, or when this chat does not know it.
   */
  messageEnd(id) {
    return this.messageEnds.get(id) || null;
  }

  /** The running turn ended (`cost`: what it reported, or null): so did its message and each message it took. */
  endMessages(cost) {
    const t = this.turn;
    if (!t) return;
    for (const id of [t.messageId, ...(t.took || [])]) if (id) this.#endOf(id, { ended: true, cost: Number.isFinite(cost) ? cost : null, total: this.costTotal });
  }

  /** The owner's message `id` left the queue without running. */
  gaveBack(id) {
    if (id && !this.messageEnds.has(id)) this.#endOf(id, { back: true });
  }

  /**
   * The owner's message `id` was taken by the coding tool (it refused to give it back), and its process went before a
   * turn of it was heard: it ended without a reported cost, so its hold stays for the day.
   */
  endedWithoutCost(id) {
    if (id && !this.messageEnds.has(id)) this.#endOf(id, { ended: true, cost: null, total: this.costTotal });
  }

  #endOf(id, end) {
    this.messageEnds.delete(id);
    this.messageEnds.set(id, end);
    if (this.messageEnds.size > MESSAGE_ENDS_MAX) this.messageEnds.delete(this.messageEnds.keys().next().value);
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
        this.gaveBack(q.id);
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
      this.endMessages(null);
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

  /**
   * Where a copy of this conversation as it is now starts (the session menu's Fork): { from, at, messageId } for a
   * new chat's `fork`, or null when there is nothing to copy yet. A conversation rewound and not written to since is
   * copied as the rewind left it (cut at the same message); else all of it, up to its newest line (engine.endPoint).
   */
  forkSource() {
    // Mid-turn the newest line may be a tool call whose result is not written yet: the copy waits for the turn's end.
    if (this.turn) throw fail(409, `${busyWords(this).split('.')[0]}: a fork copies the conversation once the turn is over. Wait, or press Stop first.`);
    if (this.fork && !this.engine.exists(this.cwd, this.conversationId)) return this.fork.at ? { ...this.fork } : null;
    const at = typeof this.engine.endPoint === 'function' ? this.engine.endPoint(this.cwd, this.conversationId) : null;
    return at ? { from: this.conversationId, at, messageId: null } : null;
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

  /**
   * The session's name, as Claude Code names its conversation (titles.mjs: a name given here, else the one given in
   * Claude Code, its generated title, the first words), read again only when its file changed. A chat named here
   * before names were kept per conversation keeps the name of its record.
   */
  currentTitle() {
    const f = this.engine.id === 'claude' ? this.file() : null;
    if (!f || (this.named && !ownEntry(this.conversationId))) return this.title;
    const live = this.liveTitle && this.liveTitle.id === this.conversationId ? this.liveTitle : null;
    const n = sessionName(f, this.conversationId, live, this.title);
    if (n) this.title = n;
    return this.title;
  }

  /** The running coding tool gave the conversation a title (hear.mjs): the newest generated one from now on. */
  heardTitle(text) {
    const f = this.engine.id === 'claude' ? this.file() : null;
    this.liveTitle = { id: this.conversationId, title: text, size: f ? sizeOf(f) : 0 };
    if (!this.named) this.title = text;
  }

  /**
   * Claude Code names a conversation by itself only in its terminal: started headless (-p), as the App starts it, it
   * writes no title (2.1.327). So after a turn of a conversation that has no name yet, the App asks for one as the
   * terminal gets it: from the first prompt, kept in the transcript, where every list reads it. Once per conversation
   * while the chat is open; a Claude Code that does not know the request leaves the first words as the name. It is one
   * small request to the session's own provider (its model's tokens, as the terminal spends them); Settings → "Name
   * sessions with a short title" turns it off (config sessionTitles: false), and then nothing is sent.
   */
  askTitle() {
    const s = this.session;
    if (this.o.titles && !this.o.titles()) return;
    if (!s || !s.alive || !this.engine.capabilities.titles || this.named || this.titleAsked === this.conversationId) return;
    const cc = conversationTitle(this.file());
    if (cc.custom || cc.ai || !cc.first || ownEntry(this.conversationId)) return;
    const id = this.conversationId;
    this.titleAsked = id;
    // titlePending: Delete waits for it, since the title line written before the answer is the session's own.
    this.titlePending = s.generateTitle(cc.first).then((r) => {
      if (this.conversationId !== id) return;
      this.knowSize(); // it wrote the title line before it answered (2.1.327): that line is the session's own
      const t = r && typeof r.title === 'string' ? plainText(r.title, 200) : '';
      if (!t) return;
      this.heardTitle(t);
      this.emit('record');
      this.emit('state');
    }).catch(() => {}).finally(() => {
      this.titlePending = null;
    });
  }

  /**
   * /clear started conversation `id`. As Claude Code does: a name the owner gave stays (kept for the new conversation
   * too, so every list of the folder agrees), a generated title or the first words do not (the new conversation is
   * named after its own first prompt). A name given in Hoprig outside this chat (a terminal's Rename) is one he gave.
   */
  cleared(id) {
    const name = this.named || ownEntry(this.conversationId) ? this.currentTitle() : '';
    this.conversationId = id;
    this.liveTitle = null;
    if (name) setOwnName(id, name);
    else this.title = '';
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
    this.emit('closed'); // the pages that follow it learn it at once (live.mjs ends their streams)
    return this.stopAndWait(ms);
  }

  /** Continue on another provider (`label`: its name as the owner reads it): the next turn starts there with the conversation resumed. */
  setProfile(name, label = name) {
    if (this.busy()) throw fail(409, busyWords(this));
    this.stop();
    this.profile = name;
    this.limit = null;
    this.autoSeen = false; // another provider may not have auto mode: its own process says so
    this.push({ kind: 'notice', level: 'info', text: `The next message goes to another provider (${label}).` });
  }

  /** Tia's mark goes for good (also one still waiting for its check after a restart). Did it have one? */
  dropMark() {
    const had = this.byTia || !!this.restoredMark;
    if (had) this.hers = true; // her OKs go, her safety stays (see the constructor)
    this.byTia = false;
    this.restoredMark = null;
    return had;
  }

  record() {
    return {
      id: this.id, ...(this.conversationId !== this.id ? { conversationId: this.conversationId } : {}), engine: this.engine.id,
      cwd: this.cwd, profile: this.profile, model: this.model, effort: this.effort, ultracode: this.ultracode, permissionMode: this.permissionMode,
      ...(this.lead ? { lead: true } : {}), ...(this.others.length ? { others: [...this.others] } : {}),
      title: this.currentTitle(), ...(this.named ? { named: true } : {}), ...markRecord(this), openedAt: this.openedAt, costTotal: this.costTotal, grants: [...this.grants],
      ...(this.fork ? { fork: this.fork } : {}), ...(this.withs.length ? { withs: [...this.withs] } : {}), ...(this.ownStat ? { own: this.ownStat } : {}),
      ...(this.hers ? { hers: true } : {}), ...(this.paidBudget ? { paidBudget: true } : {}), ...(this.handsOff ? { handsOff: this.handsOff } : {}), ...(this.handsOffStop ? { handsOffStop: this.handsOffStop } : {}),
      ...(this.handsOffRow ? { handsOffRow: this.handsOffRow } : {}), ...(this.handsOffTimes.length ? { handsOffTimes: this.handsOffTimes } : {}),
    };
  }
}
