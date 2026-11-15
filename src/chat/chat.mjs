// One coding chat: a Claude Code conversation that the dashboard runs headless (protocol.mjs) instead of in a
// terminal. One long-lived process per open chat, started on the first message and stopped after a quiet while; the
// next message starts it again with --resume, so nothing but the process is lost.
//
// What the page shows is a list of events (protocol.mjs parseLine), numbered from 0. When the transcript changed
// without this process (a terminal ran the conversation meanwhile), the list is read again from the transcript and
// `epoch` changes, so the page starts over.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { claudeCommand, providerEnv } from '../assistant/engine.mjs';
import { modelArgs } from '../launch.mjs';
import { projectDir } from '../sessions.mjs';
import { allowLine, chatArgs, denyLine, interruptLine, newTodos, parseLine, todoStep, transcriptEvents, userLine } from './protocol.mjs';

export const EVENTS_MAX = 5000; // kept in memory; the page asks for the last few hundred at a time
export const IDLE_MS = 20 * 60_000; // a process with nothing to do is stopped after this (the next message resumes)
const STOP_GRACE_MS = 8000; // after Stop, how long Claude Code gets to end the turn itself
// Errors that mean "this provider cannot serve now" (Claude Code's error categories, headless docs "api_retry").
const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);
const LIMIT_TEXT = /usage limit|limit reached|rate.?limit|out of (credit|quota)|credit balance/i;

const fail = (status, message) => Object.assign(new Error(message), { status });
const strip = ({ full, ...rest }) => rest; // the full tool input stays on the server (an answer needs it), not in the list

export class Chat extends EventEmitter {
  /**
   * o: { id, cwd, profile, model, effort, permissionMode, title, openedAt, costTotal,
   *      resolveEnv(profile) (tests), command { command, args } (tests: instead of claude), spawnImpl (tests) }
   */
  constructor(o) {
    super();
    this.o = o;
    this.id = o.id;
    this.cwd = o.cwd;
    this.profile = o.profile;
    this.model = o.model || null;
    this.effort = o.effort || null;
    this.permissionMode = o.permissionMode || null;
    this.title = o.title || '';
    this.openedAt = o.openedAt || Date.now();
    this.costTotal = Number.isFinite(o.costTotal) ? o.costTotal : null; // what Claude Code reported last (a running total)
    this.events = [];
    this.base = 0; // the number of the first event in `events`
    this.epoch = 1;
    this.todos = newTodos();
    this.pending = new Map(); // request id → the ask event (with the full input)
    this.state = 'idle'; // idle | working
    this.statusAt = Date.now();
    this.child = null;
    this.liveModel = null;
    this.lastText = '';
    this.lastError = null;
    this.limit = null;
    this.restart = false; // a setting for the next turn changed while Claude worked: start again after this turn
    this.knownSize = -1;
    this.idleTimer = null;
    this.stopTimer = null;
    // Goes up with every change, so a page that waits for news (a long poll) knows when to ask again.
    this.version = 0;
    const bump = () => this.version++;
    this.on('change', bump);
    this.on('status', bump);
    this.load();
  }

  file() {
    return path.join(projectDir(this.cwd), `${this.id}.jsonl`);
  }

  /** Read the conversation from its transcript (the page starts over). */
  load() {
    const t = transcriptEvents(this.file());
    this.todos = newTodos();
    for (const e of t.events) todoStep(this.todos, e);
    const kept = t.events.slice(-EVENTS_MAX);
    this.base = 0;
    this.events = kept.map((e, i) => ({ ...strip(e), i }));
    const last = [...kept].reverse().find((e) => e.kind === 'text');
    this.lastText = last ? last.text : '';
    if (!this.title) {
      const first = kept.find((e) => e.kind === 'user');
      if (first) this.title = oneLine(first.text, 80);
    }
    this.knownSize = t.size;
    this.epoch++;
    this.emit('change');
  }

  /** The transcript changed without us (a terminal ran it): read it again. Cheap when nothing changed. */
  refresh() {
    if (this.child) return false;
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

  push(ev) {
    const e = { ...ev, i: this.base + this.events.length, at: ev.at || Date.now() };
    this.events.push(e);
    if (this.events.length > EVENTS_MAX) {
      const drop = this.events.length - EVENTS_MAX + 500;
      this.events.splice(0, drop);
      this.base += drop;
    }
    this.emit('change');
    return e;
  }

  get next() {
    return this.base + this.events.length;
  }

  /** Events numbered from `from` on, at most `max` of the newest when `from` is older than what is kept. */
  since(from, max = 400) {
    const at = Math.max(0, from - this.base);
    const out = this.events.slice(at);
    return out.length > max ? out.slice(-max) : out;
  }

  /** Up to `n` events before number `before`. */
  before(before, n = 300) {
    const end = Math.max(0, before - this.base);
    return this.events.slice(Math.max(0, end - n), end);
  }

  /** working | attention (a tool use waits for the owner's OK) | waiting (for the owner's next message) */
  status() {
    if (this.pending.size) return 'attention';
    return this.state === 'idle' ? 'waiting' : 'working';
  }

  #setState(s) {
    const before = this.status();
    this.state = s;
    if (this.status() !== before) this.statusAt = Date.now();
    this.emit('status');
  }

  // ---------- the process ----------

  async #spawn() {
    const resume = fs.existsSync(this.file());
    if (!resume) this.costTotal = 0; // a new conversation starts at nothing
    const env = await (this.o.resolveEnv || providerEnv)(this.profile);
    // A provider that names its own model (ANTHROPIC_MODEL) says what its endpoint can serve: no --model then.
    // A resume otherwise starts on the model named in the transcript, which another provider may not know.
    const own = !!env.ANTHROPIC_MODEL;
    let model = own ? null : this.model;
    if (!model && !own && resume) model = modelArgs({ env: {} }, ['--resume', this.id])[1] || null;
    const args = chatArgs({ sessionId: this.id, resume, permissionMode: this.permissionMode, effort: this.effort, model });
    const plan = this.o.command ? { command: this.o.command.command, args: [...this.o.command.args, ...args], options: {} } : claudeCommand(args, env);
    const child = (this.o.spawnImpl || spawn)(plan.command, plan.args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...plan.options });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (this.child === child) for (const ev of parseLine(l)) this.#on(ev);
      }
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    const gone = (code) => {
      // What it wrote last is ours: no reason to read the transcript again because of it.
      try {
        this.knownSize = fs.statSync(this.file()).size;
      } catch {
        /* nothing written */
      }
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(this.stopTimer);
      if (this.state !== 'idle') {
        const why = String(err).trim().split('\n').slice(-2).join(' ').slice(0, 300);
        this.#cancelAsks();
        this.push({ kind: 'done', ok: false, subtype: 'exit', error: `Claude Code stopped (${code})${why ? `: ${why}` : ''}` });
        this.lastError = `Claude Code stopped (${code})`;
        this.#setState('idle');
      }
      this.emit('status');
    };
    child.on('exit', (code, signal) => gone(code ?? signal));
    child.on('error', (e) => {
      err = e.code === 'ENOENT' ? 'Claude Code was not found on this computer' : e.message;
      gone(127);
    });
    child.stdin.on('error', () => {}); // a process that died early must not take the dashboard with it
  }

  #write(line) {
    if (!this.child) throw fail(409, 'Claude Code is not running in this chat');
    this.child.stdin.write(line);
  }

  #on(ev) {
    switch (ev.kind) {
      case 'init':
        this.liveModel = ev.model;
        this.emit('status');
        return;
      case 'text':
        this.lastText = ev.text;
        this.push(ev);
        return;
      case 'tool':
      case 'result':
        todoStep(this.todos, ev);
        this.push(strip(ev));
        return;
      case 'ask': {
        this.pending.set(ev.request, ev);
        // The page gets the input to show and whether "allow in this chat" exists; Claude Code's rule suggestions
        // and the full input stay here (an answer needs them).
        const { full, suggestions, ...shown } = ev;
        this.push({ ...shown, canAlways: suggestions.some((x) => x && x.destination === 'session') });
        this.#setState(this.state);
        return;
      }
      case 'ask-cancelled':
        if (this.pending.delete(ev.request)) this.push({ kind: 'answer', request: ev.request, cancelled: true });
        this.#setState(this.state);
        return;
      case 'retry':
        if (LIMIT_ERRORS.has(ev.error)) this.limit = { at: Date.now(), error: ev.error, text: `The provider refused (${ev.error})` };
        if (ev.attempt === 1 || LIMIT_ERRORS.has(ev.error)) this.push({ kind: 'notice', text: `The provider did not answer (${ev.error.replace(/_/g, ' ')}); trying again…` });
        return;
      case 'done': {
        clearTimeout(this.stopTimer);
        let turnCost = null;
        if (ev.costUsd !== null && this.costTotal !== null && ev.costUsd >= this.costTotal) turnCost = ev.costUsd - this.costTotal;
        if (ev.costUsd !== null) this.costTotal = ev.costUsd;
        this.lastError = ev.ok ? null : ev.error;
        this.limit = !ev.ok && ev.error && LIMIT_TEXT.test(ev.error) ? { at: Date.now(), error: 'rate_limit', text: ev.error.slice(0, 300) } : ev.ok ? null : this.limit;
        this.#cancelAsks();
        this.push({ kind: 'done', ok: ev.ok, subtype: ev.subtype, error: ev.ok ? null : ev.error, turnCostUsd: turnCost, usage: ev.usage, durationMs: ev.durationMs });
        try {
          this.knownSize = fs.statSync(this.file()).size;
        } catch {
          /* nothing written */
        }
        this.#setState('idle');
        if (this.restart) {
          this.restart = false;
          this.stop();
        } else this.#idleLater();
        this.emit('turn', ev);
        return;
      }
      default:
        if (ev.kind === 'notice') this.push(ev);
    }
  }

  #cancelAsks() {
    for (const r of this.pending.keys()) this.push({ kind: 'answer', request: r, cancelled: true });
    this.pending.clear();
  }

  #idleLater() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.state === 'idle' && this.stop(), this.o.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }

  // ---------- what the owner does ----------

  /** One message of the owner. Starts Claude Code when it is not running. */
  async send(text) {
    if (this.state !== 'idle') throw fail(409, 'Claude is still working on the last message. Wait, or press Stop.');
    clearTimeout(this.idleTimer);
    // A terminal may have gone on with the conversation meanwhile: read it first, so the page shows it all.
    if (!this.child) this.refresh();
    if (!this.title) this.title = oneLine(text, 80);
    this.push({ kind: 'user', text });
    this.#setState('working');
    if (!this.child) {
      try {
        await this.#spawn();
      } catch (e) {
        this.push({ kind: 'done', ok: false, subtype: 'start', error: `Claude Code could not start: ${e.message}` });
        this.lastError = e.message;
        this.#setState('idle');
        return;
      }
    }
    this.#write(userLine(text));
  }

  /**
   * The owner's answer to a tool use that waits for an OK. a: { allow, always (only for this chat: Claude Code's
   * own session suggestions, never a settings file), answers (AskUserQuestion: question → chosen label), message }.
   */
  answer(request, a) {
    const ask = this.pending.get(request);
    if (!ask) throw fail(409, 'that question was already answered');
    if (a.allow) {
      const input = ask.tool === 'AskUserQuestion' && a.answers ? { ...ask.full, answers: a.answers } : ask.full;
      const rules = a.always ? ask.suggestions.filter((s) => s && s.destination === 'session') : null;
      this.#write(allowLine(request, input, rules));
    } else {
      const why = a.message ? `: ${a.message}` : '.';
      this.#write(denyLine(request, `The user said no to this ${ask.tool} call in the dashboard${why} Do not do it another way; wait for the user to say how to go on.`));
    }
    this.pending.delete(request);
    this.push({ kind: 'answer', request, allow: !!a.allow, always: !!(a.allow && a.always) });
    this.#setState(this.state);
  }

  /** Stop: Claude Code ends the turn (and the tool it runs). If it does not, the process is stopped. */
  interrupt() {
    if (!this.child || this.state === 'idle') return false;
    this.#write(interruptLine(`stop-${Date.now().toString(36)}`));
    this.#cancelAsks();
    this.#setState(this.state);
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.state === 'idle' || !this.child) return;
      this.push({ kind: 'done', ok: false, subtype: 'stopped', error: 'stopped' });
      this.#setState('idle');
      this.stop();
    }, this.o.stopGraceMs ?? STOP_GRACE_MS);
    this.stopTimer.unref?.();
    return true;
  }

  /** End the process (the conversation stays in its transcript). */
  stop() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.stopTimer);
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (this.state !== 'idle') {
      this.#cancelAsks();
      this.push({ kind: 'notice', text: 'Stopped.' });
      this.#setState('idle');
    }
    try {
      child.stdin.end(); // Claude Code cancels a waiting permission prompt when its input ends
    } catch {
      /* gone */
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }, 3000);
    t.unref?.();
    child.once('exit', () => clearTimeout(t));
    this.emit('status');
  }

  /** stop(), and resolve once the process has really ended: nothing else may run the conversation before. */
  async stopAndWait(ms = 6000) {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, ms);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Model and effort for the next turn: a new process with --resume, after the current turn if one runs. */
  setNext({ model, effort }) {
    let changed = false;
    if (model !== undefined && model !== this.model) {
      this.model = model;
      changed = true;
    }
    if (effort !== undefined && effort !== this.effort) {
      this.effort = effort;
      changed = true;
    }
    if (!changed || !this.child) return;
    if (this.state === 'idle') this.stop();
    else this.restart = true;
  }

  /** Continue on another provider: the next turn starts there with --resume. */
  setProfile(name) {
    if (this.state !== 'idle') throw fail(409, 'Claude is working. Wait until the reply ends, or press Stop first.');
    this.stop();
    this.profile = name;
    this.limit = null;
    this.push({ kind: 'notice', text: `The next message goes to another provider (${name}).` });
  }

  record() {
    return {
      id: this.id, cwd: this.cwd, profile: this.profile, model: this.model, effort: this.effort, permissionMode: this.permissionMode,
      title: this.title, openedAt: this.openedAt, costTotal: this.costTotal,
    };
  }
}

const oneLine = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
