// One conversation never runs in two places at once (the owner's rule): a chat (chat.mjs) and a terminal session.
// A terminal runs it when a run record (src/runs.mjs) carries its id; then the chat does not send, and offers to
// take it over. The routes that hand a conversation from one place to the other:
//
//   POST /api/chats/from-session              { session } → { id }   the conversation of a terminal session, as a chat
//   POST /api/chats/<id>/take                 the terminal that runs this conversation stops; the chat goes on (twice:
//                                             the second finds it done)
//   POST /api/chats/<id>/terminal             open the conversation in a terminal → { name } (the chat closes); when a
//                                             terminal runs it already → { name, existing: true } (the chat stays)
import crypto from 'node:crypto';
import { assertServes, readProfile } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { toolFlags } from '../codetools/start.mjs';
import { matchRuns } from '../server/deck.mjs';
import { parentLookup, procParent } from '../server/platform.mjs';
import * as v from '../server/validate.mjs';
import { chatTools, choicesOf, conversationIdOk, modeFor, modelOk } from './tools.mjs';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/**
 * terminalOf(id, tool): the terminal that runs conversation `id` of coding tool `tool` (Claude Code unless said): { name,
 * termId, cwd, run } (null name: one outside the dashboard), or null.
 * claim(id, fn, { tool, self }): one conversation, one process. Whatever starts a process on a conversation (a terminal,
 * a chat's message) does it in `fn`, run here one at a time per conversation, and only when no terminal runs it (else →
 * { terminal }) and no open chat but `self` has a process on it (o.chatOf(id, tool); else → { chat: its id }). → { started:
 * what fn returned }. A start that returns { name } (a terminal) is known as the conversation's from then on.
 */
export function terminals(ctx, o = {}) {
  const { HttpError } = ctx;
  // A terminal started just now runs its conversation before its run record says so (the launcher writes it once
  // the coding tool starts): for that while, this says it.
  const recent = new Map(); // `${tool}:${id}` → { name, at }
  const RECENT_MS = 30_000;
  async function terminalOf(id, tool = 'claude') {
    // A record without `tool` is an older one of Claude Code's.
    const runs = listRuns().filter((r) => r.sessionId === id && r.status !== 'ended' && (r.tool || 'claude') === tool);
    if (!runs.length) {
      const just = recent.get(`${tool}:${id}`);
      if (!just || Date.now() - just.at > RECENT_MS) return null;
      const t = (await ctx.backend.list()).find((x) => x.session === just.name);
      return t ? { name: t.session, termId: t.id, cwd: t.cwd, run: null } : null;
    }
    recent.delete(`${tool}:${id}`); // its run record says it from now on
    const terms = await ctx.backend.list();
    const byId = matchRuns(terms, runs, runs.some((r) => r.tmuxPane) ? await parentLookup() : procParent);
    const t = terms.find((x) => byId.has(x.id));
    return t ? { name: t.session, termId: t.id, cwd: t.cwd, run: byId.get(t.id) } : { name: null, run: runs[0] };
  }
  const inTerminal = (term) => Object.assign(new HttpError(409, term.name
    ? `This conversation runs in the terminal session "${term.name}". Continue it here (that terminal stops), or read along.`
    : 'This conversation runs in a terminal outside the dashboard. Continue it here (that terminal stops), or read along.'), { code: 'in-terminal' });
  const lines = new Map(); // `${tool}:${id}` → the step in flight on that conversation
  /** `fn` after every earlier step on conversation `id` (a start, a take-over): one at a time. */
  function serial(id, fn, tool = 'claude') {
    const key = `${tool}:${id}`;
    const p = (lines.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    lines.set(key, p);
    p.catch(() => {}).finally(() => lines.get(key) === p && lines.delete(key));
    return p;
  }
  function claim(id, fn, { tool = 'claude', self = null } = {}) {
    return serial(id, async () => {
      const term = await terminalOf(id, tool);
      if (term) return { terminal: term };
      const chat = o.chatOf ? o.chatOf(id, tool) : null;
      if (chat && chat !== self) return { chat };
      const started = await fn();
      if (started && typeof started.name === 'string') recent.set(`${tool}:${id}`, { name: started.name, at: Date.now() });
      return { started };
    }, tool);
  }
  /** The terminal of conversation `id` was told to stop (Continue here): what was known of its start goes. */
  const forget = (id, tool = 'claude') => recent.delete(`${tool}:${id}`);
  return { terminalOf, inTerminal, claim, serial, forget };
}

/**
 * o (from feature.mjs): { chats, make, save, chatOr404, memory, models, openChatOf, freeId, and terminals()' terminalOf,
 * claim, serial, forget, auto: { name, on() } (the Auto provider) }
 */
export function handoffRoutes(ctx, o) {
  const { HttpError } = ctx;
  const { chats, make, save, chatOr404, memory, models, openChatOf, freeId, terminalOf, claim, serial, forget, auto } = o;
  const bad = (msg) => new HttpError(400, msg);
  const cfg = () => ctx.config();
  const handed = new Map(); // a chat's id → its conversation, for the chats closed by "Open in terminal" (the last 50)
  /** Continue here: the terminal that runs chat `c`'s conversation stops (it stays, as a plain shell); the chat goes on. */
  async function take(c) {
    const tool = c.engine.id;
    const term = await terminalOf(c.conversationId, tool);
    if (!term) return { ok: true };
    if (term.termId) {
      // The terminal stays, as a plain shell: the coding tool stops in it, the conversation goes on here.
      await ctx.backend.respawn(term.termId, term.cwd || c.cwd, [process.execPath, '-e', '']);
    } else if (term.run && v.pid(term.run.pid)) {
      try {
        process.kill(term.run.pid, 'SIGTERM'); // the launcher ends the coding tool and removes its run record
      } catch {
        /* already gone */
      }
    }
    forget(c.conversationId, tool);
    for (let i = 0; i < 40 && (await terminalOf(c.conversationId, tool)); i++) await new Promise((r) => setTimeout(r, 200));
    if (await terminalOf(c.conversationId, tool)) throw new HttpError(409, `the terminal did not stop; stop ${tool === 'claude' ? 'Claude' : c.engine.label} there and try again`);
    // A coding tool whose turns run on its server (OpenCode) goes on without its terminal: that turn stops too, as
    // Claude Code's does with its process. The chat goes on from where it ended.
    if (c.engine.interrupt) await c.engine.interrupt(c.conversationId, c.o.engineOpts);
    if (c.engine.stamp) c.load(); // kept by the tool's server: read it again now
    else c.refresh();
    c.emit('state'); // a page that streams leaves its read-along mode now, not at the next news
    ctx.poke?.();
    return { ok: true };
  }
  return [
    ['POST', /^\/api\/chats\/from-session$/, async (req) => {
      o.load();
      const b = await ctx.readJson(req);
      if (!v.sessionName(b.session)) throw bad('bad session name');
      const found = await ctx.deck.find(b.session);
      if (!found) throw new HttpError(404, 'no such session');
      const run = found.run;
      // A chat runs the coding tools that have a chat here; another tool's conversation stays in its terminal.
      const tool = run ? run.tool || 'claude' : 'claude';
      if (run && !chatTools(cfg()).includes(tool)) throw new HttpError(409, 'Open as chat is not offered for this coding tool: this conversation stays in its terminal');
      if (!run || !conversationIdOk(tool, run.sessionId)) throw new HttpError(409, 'The coding tool has not reported its conversation yet; try again in a moment');
      const open = openChatOf(run.sessionId);
      if (open) return { id: open };
      const prof = run.profile && run.profile !== auto.name ? readProfile(run.profile) : null;
      if (prof) assertServes(prof, tool); // says why, as a 400
      // As the terminal ran it (its flags), else as the last chat in that folder, else Settings: a conversation
      // taken back from a terminal keeps its model, effort and mode.
      const d = cfg().sessionDefaults || {};
      const before = memory.last(run.cwd) || {};
      const last = (before.engine || 'claude') === tool ? before : {};
      const ch = choicesOf(tool, run.profile, models);
      const args = Array.isArray(run.carryArgs) ? run.carryArgs.filter((x) => typeof x === 'string') : [];
      const flag = (name) => {
        const i = args.indexOf(name);
        const eq = args.find((x) => x.startsWith(`${name}=`));
        return i >= 0 && i + 1 < args.length ? args[i + 1] : eq ? eq.slice(name.length + 1) : null;
      };
      const one = (name, key, list) => [flag(name), last[key], d[key]].find((x) => typeof x === 'string' && list.includes(x)) || null;
      // Another tool's model: one the provider lists, or (its list not known yet) a well-formed model id.
      const toolModel = [flag('--model'), last.model].find((x) => typeof x === 'string' && modelOk(tool, x, ch)) || null;
      // OpenCode's terminal words for its modes: "ask" is the chat's "manual".
      const mode = tool === 'claude' ? one('--permission-mode', 'permissionMode', ch.modes) : modeFor(tool, flag('--permission-mode') === 'ask' ? 'manual' : flag('--permission-mode')) || modeFor(tool, last.permissionMode);
      const id = tool === 'claude' ? freeId(run.sessionId) : crypto.randomUUID();
      make({
        id, ...(id !== run.sessionId ? { conversationId: run.sessionId } : {}), engine: tool, cwd: run.cwd, profile: run.profile,
        model: tool === 'claude' ? one('--model', 'model', ch.models) : toolModel,
        effort: one('--effort', 'effort', ch.efforts), permissionMode: mode,
        ultracode: last.ultracode === true,
      });
      save();
      return { id };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/take$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      return serial(c.conversationId, () => take(c), c.engine.id); // pressed twice, or in two tabs: the second finds it done
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/terminal$`), async (req, m) => {
      await ctx.readJson(req);
      // A terminal that runs the conversation already is the one it opens in (asked twice, from two tabs, by Tia):
      // a second one would write the same conversation at the same time.
      const there = (term) => {
        if (term.name) return { name: term.name, existing: true };
        throw new HttpError(409, 'This conversation runs in a terminal outside the dashboard: it cannot open in another one.');
      };
      if (!chats.has(m[1]) && handed.has(m[1])) {
        // Handed to a terminal a moment ago (the other tab was first): that terminal, while it runs the conversation.
        const h = handed.get(m[1]);
        const term = await terminalOf(h.conversation, h.tool);
        if (term) return there(term);
      }
      const c = chatOr404(m[1]);
      const conversation = c.conversationId;
      const tool = c.engine.id;
      if (tool !== 'claude' && !chatTools(cfg()).includes(tool)) throw new HttpError(409, `${c.engine.label} is off on this computer: turn it on to open its conversations in a terminal`);
      const r = await claim(conversation, async () => {
        if (!chats.has(c.id)) throw new HttpError(404, 'this chat is not open (it was closed or opened in a terminal)');
        if (!(await c.engine.exists(c.cwd, conversation, c.o.engineOpts))) throw new HttpError(409, 'send a first message: a conversation that has not started cannot be resumed in a terminal');
        if (c.busy()) throw new HttpError(409, `${tool === 'claude' ? 'Claude' : c.engine.label} is working. Wait until it is done, or press Stop first.`);
        const profile = c.profile === auto.name ? (auto.on() ? { name: auto.name, env: {} } : null) : readProfile(c.profile);
        if (!profile) throw bad('the provider of this chat is gone; choose another one first');
        // The terminal's flags first: a choice it refuses leaves the chat as it is.
        // OpenCode's terminal has fewer modes: it asks (for edits too) unless the chat allowed everything.
        const flags = tool === 'claude' ? [
          ...(c.permissionMode ? ['--permission-mode', c.permissionMode] : []),
          ...(c.effort ? ['--effort', c.effort] : []),
          ...(c.model ? ['--model', c.model] : []),
        ] : toolFlags(tool, { permissionMode: c.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'ask', effort: c.effort, model: c.model });
        chats.delete(c.id);
        handed.set(c.id, { conversation, tool });
        if (handed.size > 50) handed.delete(handed.keys().next().value);
        await c.close();
        try {
          return { name: await ctx.deck.start({ ...(tool === 'claude' ? {} : { tool }), dir: c.cwd, profile, mode: 'resume', sessionId: conversation, flags }) };
        } catch (e) {
          make(c.record()); // the terminal did not start: the chat stays open
          throw e;
        }
      }, { tool, self: c.id });
      if (r.terminal) return there(r.terminal);
      if (r.chat) throw new HttpError(409, 'another chat runs this conversation right now');
      save();
      ctx.poke?.();
      return { name: r.started.name };
    }],
  ];
}
