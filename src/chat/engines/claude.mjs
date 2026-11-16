// The Claude Code engine of the coding chat (the contract is in index.mjs): one headless process per open chat,
// spoken to in stream-json (claude-lines.mjs), heard through claude-parse.mjs, read back by claude-transcript.mjs.
// Everything the chat changes while it runs (permission mode, model, effort, ultracode, stopping a task, undoing a
// turn's edits, taking back a queued message) is a control request to the running process: no restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claudeCommand } from '../../assistant/engine.mjs';
import { modelArgs } from '../../launch.mjs';
import { projectDir, sessionsIn } from '../../sessions.mjs';
import { CHAT_ENV, allowLine, chatArgs, controlLine, denyLine, grantSettings, interruptLine, sdkMode, userLine } from './claude-lines.mjs';
import { ClaudeParser } from './claude-parse.mjs';
import { forkPoint, readTranscript } from './claude-transcript.mjs';
import { folderHistory } from '../history.mjs';

const TERM_MS = 3000; // after its input ends, how long a process gets to exit before SIGTERM
const KILL_MS = 8000; // … and before SIGKILL
const DRAIN_MS = 2000; // after it exits, how long its output may take to arrive (a child that holds the pipe open)
const CONTROL_MS = 15_000; // how long an answer to a control request may take

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

class ClaudeSession {
  /** o: see claude.open */
  constructor(o) {
    this.o = o;
    this.parser = new ClaudeParser();
    this.waiting = new Map(); // control request id → { resolve, reject, timer }
    this.rid = 0;
    this.alive = true;
    this.info = null; // the answer to initialize: { commands, models, … }
    // A provider that names its own model (ANTHROPIC_MODEL) says what its endpoint can serve: no --model then.
    // A resume otherwise starts on the model named in the transcript, which another provider may not know.
    const own = !!(o.env && o.env.ANTHROPIC_MODEL);
    let model = own ? null : o.model;
    if (!model && !own && (o.resume || o.fork)) model = modelArgs({ env: {} }, ['--resume', o.fork ? o.fork.from : o.sessionId])[1] || null;
    const args = chatArgs({
      sessionId: o.sessionId, resume: o.resume, fork: o.fork || null, permissionMode: o.mode, effort: o.effort, model,
      settings: grantSettings(o.grants || [], { ultracode: !!o.ultracode }),
    });
    const env = { ...o.env, ...CHAT_ENV };
    const plan = o.command ? { command: o.command.command, args: [...o.command.args, ...args], options: {} } : claudeCommand(args, env);
    const child = (o.spawnImpl || spawn)(plan.command, plan.args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...plan.options });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        for (const ev of this.parser.line(l)) this.#on(ev);
      }
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    // The end is handled once its output is read to the end ('close'), not at 'exit': a long reply right before
    // the process exits would otherwise be cut off, its result with it. A child that keeps the pipe open (a command
    // it left running) cannot hold that up for more than DRAIN_MS.
    let finished = false;
    let drain = null;
    let endedResolve;
    this.ended = new Promise((r) => (endedResolve = r));
    const gone = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(drain);
      if (buf.trim()) for (const ev of this.parser.line(buf)) this.#on(ev);
      buf = '';
      this.alive = false;
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(fail(409, 'Claude Code stopped'));
      }
      this.waiting.clear();
      const why = String(err).trim().split('\n').slice(-2).join(' ').slice(0, 300);
      o.emit({ kind: 'exit', code, why });
    };
    child.on('exit', (code, signal) => {
      endedResolve();
      drain = setTimeout(() => gone(code ?? signal), o.drainMs ?? DRAIN_MS);
      drain.unref?.();
    });
    child.on('close', (code, signal) => {
      endedResolve();
      gone(code ?? signal);
    });
    child.on('error', (e) => {
      err = e.code === 'ENOENT' ? 'Claude Code was not found on this computer' : e.message;
      endedResolve();
      gone(127);
    });
    child.stdin.on('error', () => {}); // a process that died early must not take the dashboard with it
    // First of all: with perTaskStopAffordance a Stop ends the turn and spares background agents; with
    // agentProgressSummaries a running subagent says what it does. The answer lists the commands and skills.
    this.ready = this.#control({ subtype: 'initialize', hooks: {}, agentProgressSummaries: true, perTaskStopAffordance: true, promptSuggestions: false })
      .then((r) => (this.info = r || {}))
      .catch(() => (this.info = {}));
  }

  #on(ev) {
    if (ev.kind === 'control-answer') {
      const w = this.waiting.get(ev.requestId);
      if (!w) return;
      this.waiting.delete(ev.requestId);
      clearTimeout(w.timer);
      if (ev.ok) w.resolve(ev.response);
      else w.reject(fail(409, ev.error || 'Claude Code refused', ev.code || 'refused'));
      return;
    }
    this.o.emit(ev);
  }

  #write(line) {
    if (!this.alive) throw fail(409, 'Claude Code is not running in this chat');
    this.child.stdin.write(line);
  }

  #control(request, ms = CONTROL_MS) {
    const id = `hoprig-${++this.rid}`;
    return new Promise((resolve, reject) => {
      try {
        this.#write(controlLine(id, request));
      } catch (e) {
        return reject(e);
      }
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(fail(504, `Claude Code did not answer (${request.subtype})`, 'timeout'));
      }, ms);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
    });
  }

  send({ id, text, images }) {
    this.#write(userLine(text, { id, images }));
  }
  /** a: { allow, input, permissions (allow: session rule changes), message (deny) } */
  answer(request, a) {
    this.#write(a.allow ? allowLine(request, a.input, a.permissions) : denyLine(request, a.message));
  }
  interrupt() {
    this.#control({ subtype: 'interrupt' }).catch(() => {});
  }
  stopTask(taskId) {
    return this.#control({ subtype: 'stop_task', task_id: taskId });
  }
  setMode(mode) {
    return this.#control({ subtype: 'set_permission_mode', mode: sdkMode(mode) });
  }
  /** null: Claude Code's own default model. */
  setModel(model) {
    return this.#control({ subtype: 'set_model', ...(model ? { model } : {}) });
  }
  /** An effort change carries ultracode too: without it Claude Code turns ultracode off. */
  setEffort({ effort, ultracode }) {
    return this.#control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort || null, ultracode: !!ultracode } });
  }
  /** The conversation's name (kept in its transcript, so a terminal shows it too). */
  rename(title) {
    return this.#control({ subtype: 'rename_session', title, source: 'host' });
  }
  /** Undo the file changes made since message `messageId`; dryRun: only say what would change. */
  rewind(messageId, { dryRun = false } = {}) {
    return this.#control({ subtype: 'rewind_files', user_message_id: messageId, dry_run: dryRun });
  }
  /** Take back a message written while a turn ran, before Claude Code starts on it. → true when it was taken back. */
  async cancel(messageId) {
    const r = await this.#control({ subtype: 'cancel_async_message', message_uuid: messageId });
    return !!(r && r.cancelled);
  }
  contextUsage() {
    return this.#control({ subtype: 'get_context_usage', detail: 'summary' });
  }
  usage() {
    return this.#control({ subtype: 'get_usage', skip_behaviors: true });
  }
  /** The / menu: the session's commands and skills, from the answer to initialize. */
  async commands() {
    await this.ready;
    return Array.isArray(this.info.commands) ? this.info.commands : [];
  }

  /** End the process: its input first (Claude Code cancels a waiting permission prompt then), SIGTERM, then SIGKILL. */
  close() {
    const child = this.child;
    const kill = (sig) => {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    };
    if (child.exitCode === null && child.signalCode === null) {
      const term = setTimeout(() => kill('SIGTERM'), this.o.termMs ?? TERM_MS);
      const hard = setTimeout(() => kill('SIGKILL'), this.o.killMs ?? KILL_MS);
      term.unref?.();
      hard.unref?.();
      this.ended.then(() => {
        clearTimeout(term);
        clearTimeout(hard);
      });
    }
    try {
      child.stdin.end();
    } catch {
      /* gone */
    }
    return this.ended;
  }
  kill() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  // What it changes in a running process (else the chat starts it again with --resume).
  capabilities: { liveMode: true, liveModel: true, liveEffort: true, ultracode: true, queue: true, stopTask: true, rewind: true, fork: true, commands: true, compact: true, usage: true, rename: true, ownIds: false },
  /** Where conversation `id` of folder `cwd` is kept: it exists once a first message was sent. */
  file: (cwd, id) => path.join(projectDir(cwd), `${id}.jsonl`),
  exists: (cwd, id) => fs.existsSync(claude.file(cwd, id)),
  /**
   * Start the coding tool for one chat. o: { cwd, env, sessionId, resume, fork ({ from, at }: a copy of conversation
   * `from` up to its line `at`, as sessionId), model, effort, ultracode, mode, grants,
   * emit(event), command { command, args } and spawnImpl (tests), termMs, killMs, drainMs }.
   */
  open: (o) => new ClaudeSession(o),
  /** The conversation from its files: { events, tasks, todos, title, size }. */
  transcript: ({ cwd, id }) => readTranscript(claude.file(cwd, id)),
  /** Where conversation `id` goes on from when it is rewound to before the owner's message `messageId`. */
  forkPoint: (cwd, id, messageId) => forkPoint(claude.file(cwd, id), messageId),
  /** The conversations kept for a folder. */
  sessions: (cwd) => sessionsIn(cwd),
  /** The folder's conversations for the history list: [{ id, at, title }]. */
  history: (cwd) => folderHistory(cwd),
};
