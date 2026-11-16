// The OpenCode engine of the coding chat (the contract is in index.mjs), on OpenCode's server: the ONE server per
// computer that Hoprig runs for OpenCode (src/codetools/servers.mjs), which its terminal sessions use too, always
// with its password. A chat is a conversation on that server: its messages go in by HTTP and its events come from
// the server's event stream (opencode-events.mjs). Nothing of the server is passed to the browser (some of its
// routes return a provider's key).
//
// What it changes in a running conversation, without a restart: the permission mode (the conversation's rules), the
// model and the effort (the model's variant; ultracode is the highest variant the model lists), the name. What it
// cannot do (capabilities false): rewind, a fork, Claude Code's commands, compact, plan usage.
import { loadConfig } from '../../config.mjs';
import { opencodeClient } from '../../codetools/clients.mjs';
import { enabledToolIds } from '../../codetools/index.mjs';
import { isToolSessionId, opencodeSessions } from '../../codetools/stores.mjs';
import { ensureServer, readServer } from '../../codetools/servers.mjs';
import { OpencodeEvents } from './opencode-events.mjs';
import { readTranscript } from './opencode-transcript.mjs';
import { modeOf, modeRules, onServer, providerFor, startModel, topEffort } from './served.mjs';

const TOOL = 'opencode';
const fail = (status, message) => Object.assign(new Error(message), { status });
const enc = encodeURIComponent;

// Turned off in Settings → Coding tools: an open chat of it runs no turn and starts no server any more. o.enabled: a
// stand-in (tests).
const isOn = (o) => (o.enabled ? o.enabled() : enabledToolIds(loadConfig()).includes(TOOL));
function assertOn(o) {
  if (!isOn(o)) throw fail(409, 'OpenCode is off on this computer: turn it on under Settings → Coding tools to go on with this chat');
}

/** A turn runs on the server now (its last start is later than its last end). */
const runsNow = (s) => !!(s && s.time && Number(s.time.busy) > (Number(s.time.idle) || 0));

class OpencodeSession {
  /** o: see opencode.open */
  constructor(o) {
    this.o = o;
    this.alive = true;
    this.id = isToolSessionId(TOOL, o.sessionId) ? o.sessionId : null; // the conversation, once it exists
    this.map = null; // opencode-events.mjs, once the conversation is known
    this.inbox = new Map(); // the chat's message id → OpenCode's (a queued message can be taken back)
    this.byInbox = new Map(); // and back
    this.early = new Map(); // what OpenCode said of a message before it answered for it: inbox id → state
    this.busy = false; // a turn runs on the server
    this.model = null; // { providerID, id, variant }
    this.variants = []; // what the model offers as its effort
    this.contextWindow = null;
    this.abort = new AbortController();
    this.chain = Promise.resolve(); // the messages go in one after the other
    let endedResolve;
    this.ended = new Promise((r) => (endedResolve = r));
    this.endedResolve = endedResolve;
    this.ready = this.#start().catch((e) => {
      this.#gone(e.status === 400 ? 'provider' : 'start', e.message);
      throw e;
    });
    this.ready.catch(() => {});
  }

  async #start() {
    const o = this.o;
    assertOn(o);
    const profile = (o.providerFor || providerFor)(o.profile, TOOL);
    const { server, prov, release } = await onServer(TOOL, profile, o.served || {});
    this.release = release;
    this.prov = prov;
    this.profile = profile;
    if (!this.alive) return release();
    this.client = (o.client || opencodeClient)({ ...server, fetchImpl: o.fetchImpl });
    // The stream first: nothing of the conversation's start is missed.
    const connected = new Promise((resolve, reject) => {
      this.client.events((ev) => {
        if (ev.type === 'server.connected') resolve();
        this.#event(ev);
      }, { signal: this.abort.signal }).then(() => this.#gone('server', 'OpenCode\'s server ended the event stream'), (e) => {
        reject(e);
        if (!this.abort.signal.aborted) this.#gone('server', `OpenCode's event stream: ${e.message}`);
      });
    });
    await Promise.race([connected, new Promise((r) => setTimeout(r, 5000).unref?.())]);
    const modelId = await startModel(o.model, prov, profile, o.served || {});
    await this.#modelInfo(modelId);
    // A chat closed meanwhile goes no further: it would leave an empty conversation behind in OpenCode's list.
    if (!this.alive) return;
    const variant = this.#variant(o.effort, o.ultracode);
    const model = modelId ? { providerID: prov.id, id: modelId, ...(variant ? { variant } : {}) } : null;
    let running = false;
    if (this.id && o.resume) {
      const r = await this.client.req('GET', `/api/session/${enc(this.id)}`).catch(() => null);
      if (!r || !r.data) throw fail(409, 'OpenCode does not know this conversation any more');
      // Its turn may still run on the server (a terminal that ran it was stopped, the event stream was lost).
      running = runsNow(r.data);
      if (model) await this.client.req('POST', `/api/session/${enc(this.id)}/model`, { model });
      // A conversation keeps the rules it was made with: the chat's mode replaces them.
      await this.client.req('PATCH', `/api/session/${enc(this.id)}`, { permissions: modeRules(o.mode) });
    } else {
      if (!this.alive) return;
      // OpenCode said it has no such conversation any more (a 404: run.mjs asked): the chat goes on in a new one, and
      // says so. A conversation that could not be asked for never gets here (the start fails instead).
      const lost = !!this.id;
      const r = await this.client.req('POST', '/api/session', { location: { directory: o.cwd }, ...(model ? { model } : {}), permissions: modeRules(o.mode) });
      this.id = r && r.data && r.data.id;
      if (!isToolSessionId(TOOL, this.id)) throw fail(502, 'OpenCode did not make a conversation');
      if (lost) o.emit({ kind: 'notice', level: 'warning', text: 'OpenCode no longer has this chat\'s earlier conversation: this message starts a new one.' });
    }
    this.model = model;
    this.map = new OpencodeEvents({ id: this.id, contextWindow: () => this.contextWindow });
    o.emit({ kind: 'conversation', id: this.id });
    if (running) {
      this.busy = true;
      this.map.turn = { at: Date.now(), usage: null };
    }
    this.#hello();
    if (running) await this.#waiting();
  }

  /** What the conversation waits for already (asked before this chat listened): the OKs and questions, as cards. */
  async #waiting() {
    const list = async (p) => {
      const j = await this.client.req('GET', `/api/session/${enc(this.id)}/${p}`).catch(() => null);
      return Array.isArray(j && j.data) ? j.data : [];
    };
    for (const p of await list('permission')) this.#event({ type: 'permission.asked', data: { ...p, sessionID: this.id } });
    for (const f of await list('form')) this.#event({ type: 'form.created', data: { form: { ...f, sessionID: this.id } } });
  }

  /** The model's context and efforts, from the server's list of models (only these two facts are kept). */
  async #modelInfo(modelId) {
    if (!modelId) return;
    try {
      const j = await this.client.req('GET', '/api/model');
      const m = (Array.isArray(j && j.data) ? j.data : []).find((x) => x && x.providerID === this.prov.id && (x.id === modelId || x.modelID === modelId));
      this.variants = m && Array.isArray(m.variants) ? m.variants.map((x) => x && x.id).filter((x) => typeof x === 'string') : [];
      this.contextWindow = m && m.limit && Number.isFinite(m.limit.context) ? m.limit.context : null;
    } catch {
      /* the chips work without them */
    }
  }

  #variant(effort, ultracode) {
    if (ultracode) return topEffort(this.variants);
    return effort && (!this.variants.length || this.variants.includes(effort)) ? effort : null;
  }

  /** What the chat reads at a turn's start (as Claude Code's init): the conversation, its model and mode. */
  #hello() {
    this.o.emit({ kind: 'session', id: this.id, model: this.model ? this.model.id : null, mode: modeOf(this.o.mode), cwd: this.o.cwd, tools: [], commands: [], skills: [], agents: [] });
  }

  #event(ev) {
    if (!this.map || !this.alive) return;
    for (const out of this.map.feed(ev)) {
      if (out.kind === 'turn-begin') {
        this.busy = true;
        this.#hello();
      } else if (out.kind === 'inbox') {
        const mine = this.byInbox.get(out.inboxId);
        if (mine) this.o.emit({ kind: 'queue-state', state: out.state, messageId: mine });
        else if (out.inboxId && this.early.size < 50) this.early.set(out.inboxId, out.state); // its answer is still on the way
      } else {
        if (out.kind === 'turn-end') this.busy = false;
        this.o.emit(out);
      }
    }
  }

  #gone(code, why) {
    if (!this.alive) return;
    this.alive = false;
    this.abort.abort();
    this.release?.();
    this.endedResolve();
    this.o.emit({ kind: 'exit', code, why: String(why || '').slice(0, 300) });
  }

  /** In order: a message waits for the conversation, and for the one before it. */
  #then(fn) {
    this.chain = this.chain.then(() => this.ready).then(fn).catch((e) => {
      if (this.alive) this.o.emit({ kind: 'notice', level: 'error', text: `OpenCode: ${e.message}` });
    });
    return this.chain;
  }

  send({ id, text, images }) {
    if (!this.alive) throw fail(409, 'OpenCode is not running in this chat');
    const files = (images || []).map((im, n) => ({ uri: `data:${im.mime};base64,${im.data}`, name: `picture-${n + 1}` }));
    this.#then(async () => {
      const r = await this.client.req('POST', `/api/session/${enc(this.id)}/prompt`, { text, ...(files.length ? { files } : {}) });
      const inboxId = r && r.data && r.data.id;
      if (inboxId) {
        this.inbox.set(id, inboxId);
        this.byInbox.set(inboxId, id);
        const state = this.early.get(inboxId);
        this.early.delete(inboxId);
        if (state) this.o.emit({ kind: 'queue-state', state, messageId: id });
      }
    });
  }

  /** a: { allow, input (a question: { answers }), message (no) }. */
  answer(request, a) {
    this.#then(async () => {
      if (this.map.isForm(request)) {
        if (a.allow && a.input && a.input.answers) await this.client.req('POST', `/api/session/${enc(this.id)}/form/${enc(request)}/reply`, { answer: this.map.formAnswer(request, a.input.answers) || {} });
        else await this.client.req('DELETE', `/api/session/${enc(this.id)}/form/${enc(request)}`);
        return;
      }
      await this.client.req('POST', `/api/session/${enc(this.id)}/permission/${enc(request)}/reply`, a.allow ? { decision: 'once' } : { decision: 'reject', ...(a.message ? { message: a.message } : {}) });
    });
  }

  interrupt() {
    this.#then(() => this.client.req('POST', `/api/session/${enc(this.id)}/interrupt`));
  }

  /** Stop one subagent: its own conversation's turn (the task's id is that conversation's). */
  async stopTask(taskId) {
    await this.ready;
    if (!this.map || !this.map.running.has(taskId)) throw fail(409, 'that task is not running');
    await this.client.req('POST', `/api/session/${enc(taskId)}/interrupt`);
  }

  async setMode(mode) {
    await this.ready;
    this.o.mode = mode;
    const permissions = modeRules(mode);
    await this.client.req('PATCH', `/api/session/${enc(this.id)}`, { permissions });
    // A subagent's conversation took its parent's rules when it was made (proven on OpenCode 2.3): it follows too.
    for (const sid of this.map ? this.map.running : []) await this.client.req('PATCH', `/api/session/${enc(sid)}`, { permissions }).catch(() => {});
  }

  /** null: the provider's own model, else the first it lists. */
  async setModel(model) {
    await this.ready;
    const id = await startModel(model, this.prov, this.profile, this.o.served || {});
    if (!id) return;
    await this.#modelInfo(id);
    const variant = this.#variant(this.o.effort, this.o.ultracode);
    this.model = { providerID: this.prov.id, id, ...(variant ? { variant } : {}) };
    await this.client.req('POST', `/api/session/${enc(this.id)}/model`, { model: this.model });
  }

  async setEffort({ effort, ultracode }) {
    await this.ready;
    Object.assign(this.o, { effort, ultracode });
    if (!this.model) return;
    const variant = this.#variant(effort, ultracode);
    this.model = { providerID: this.model.providerID, id: this.model.id, ...(variant ? { variant } : {}) };
    await this.client.req('POST', `/api/session/${enc(this.id)}/model`, { model: this.model });
  }

  async rename(title) {
    await this.ready;
    await this.client.req('PATCH', `/api/session/${enc(this.id)}`, { title });
  }

  /** Take back a message written while a turn ran, before OpenCode starts on it. */
  async cancel(messageId) {
    await this.chain;
    const inboxId = this.inbox.get(messageId);
    if (!inboxId) return false;
    try {
      await this.client.req('DELETE', `/api/session/${enc(this.id)}/inbox/${enc(inboxId)}`);
      return true;
    } catch {
      return false;
    }
  }

  contextUsage() {
    return Promise.resolve(null);
  }
  usage() {
    return Promise.resolve(null);
  }
  async commands() {
    return [];
  }

  /** The chat lets go of the conversation: a turn or a subagent that still runs on the server is stopped first. */
  close() {
    if (this.alive && this.client && this.id) {
      // What still runs on the server would go on with nobody watching: the turn and every subagent of the chat.
      const running = [...(this.busy ? [this.id] : []), ...(this.map ? this.map.running : [])];
      for (const sid of running) this.client.req('POST', `/api/session/${enc(sid)}/interrupt`).catch(() => {});
    }
    this.#gone(0, '');
    return this.ended;
  }
  kill() {
    this.close();
  }
}

/**
 * A client of the running OpenCode server (started when it does not run; no provider needed to read). start: false
 * only looks: null when no server runs (then nobody changed a conversation meanwhile, and none is started for that).
 */
async function reader(o = {}, { start = true } = {}) {
  if (!start) {
    const s = o.running ? o.running() : readServer(TOOL);
    return s ? (o.client || opencodeClient)({ ...s, fetchImpl: o.fetchImpl }) : null;
  }
  assertOn(o);
  const r = await (o.ensure || ensureServer)(TOOL);
  if (!r || !r.ok) throw fail(409, (r && r.why) || 'OpenCode\'s server did not start');
  return (o.client || opencodeClient)({ ...r.server, fetchImpl: o.fetchImpl });
}

export const opencode = {
  id: TOOL,
  label: 'OpenCode',
  capabilities: { liveMode: true, liveModel: true, liveEffort: true, ultracode: true, queue: true, stopTask: true, rewind: false, fork: false, commands: false, compact: false, usage: false, rename: true, ownIds: true },
  /** Its conversations are in OpenCode's database, read through its server: no file of Hoprig's. */
  file: () => null,
  /**
   * Whether OpenCode has conversation `id` (async: through the server): false only when it says it has none (404).
   * When it could not be asked (the server busy or not started), this throws: the chat must not start a new, empty
   * conversation in place of the one it has.
   */
  exists: async (cwd, id, o = {}) => {
    if (!isToolSessionId(TOOL, id)) return false;
    const c = await reader(o);
    try {
      const r = await c.req('GET', `/api/session/${enc(id)}`);
      return !!(r && r.data);
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  },
  /**
   * Open the conversation for one chat. o: { cwd, profile (the provider's name), sessionId, resume, model, effort,
   * ultracode, mode, emit(event) }, and stand-ins (tests): served { ensure, providers, hold }, client, providerFor,
   * fetchImpl.
   */
  open: (o) => new OpencodeSession(o),
  /**
   * The conversation from OpenCode's store (async). start: false (the chat's first read, when the dashboard starts)
   * reads only from a server that runs already, else null: a saved chat does not start OpenCode's server by itself.
   */
  transcript: async ({ id }, o = {}, { start = true } = {}) => {
    if (!isToolSessionId(TOOL, id)) return { events: [], tasks: [], todos: [], title: '', size: 0 };
    const c = await reader(o, { start });
    return c ? readTranscript(c, id) : null;
  },
  /** When the conversation last changed (the chat reads it again when that moves), or 0. */
  stamp: async ({ id }, o = {}) => {
    if (!isToolSessionId(TOOL, id)) return 0;
    const c = await reader(o, { start: false });
    const r = c ? await c.req('GET', `/api/session/${enc(id)}`).catch(() => null) : null;
    return Number(r && r.data && r.data.time && r.data.time.updated) || 0;
  },
  /** The folder's conversations, newest first: [{ id, at, title }]. */
  history: async (cwd, o = {}) => {
    assertOn(o);
    return opencodeSessions(cwd, o);
  },
  sessions: async (cwd, o = {}) => {
    assertOn(o);
    return opencodeSessions(cwd, o);
  },
  /** Stop the turn of conversation `id` that runs on the server, if one does (a terminal that ran it was stopped). */
  interrupt: async (id, o = {}) => {
    if (!isToolSessionId(TOOL, id)) return;
    const c = await reader(o, { start: false });
    if (c) await c.req('POST', `/api/session/${enc(id)}/interrupt`).catch(() => {});
  },
};
