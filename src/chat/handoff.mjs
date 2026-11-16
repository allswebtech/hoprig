// One conversation never runs in two places at once (the owner's rule): a chat (chat.mjs) and a terminal session.
// A terminal runs it when a run record (src/runs.mjs) carries its id; then the chat does not send, and offers to
// take it over. The routes that hand a conversation from one place to the other:
//
//   POST /api/chats/from-session              { session } → { id }   the conversation of a terminal session, as a chat
//   POST /api/chats/<id>/take                 the terminal that runs this conversation stops; the chat goes on
//   POST /api/chats/<id>/terminal             open the conversation in a terminal → { name } (the chat closes)
import fs from 'node:fs';
import { EFFORTS, PERMISSION_MODES } from '../config.mjs';
import { assertServes, readProfile } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { isSessionId } from '../sessions.mjs';
import { matchRuns } from '../server/deck.mjs';
import { parentLookup, procParent } from '../server/platform.mjs';
import * as v from '../server/validate.mjs';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/** terminalOf(id): the terminal that runs conversation `id`: { name } (null name: one outside the dashboard), or null. */
export function terminals(ctx) {
  const { HttpError } = ctx;
  async function terminalOf(id) {
    // Only Claude Code's run records: a chat's conversation is Claude Code's (a record without `tool` is an older one of it).
    const runs = listRuns().filter((r) => r.sessionId === id && r.status !== 'ended' && (r.tool || 'claude') === 'claude');
    if (!runs.length) return null;
    const terms = await ctx.backend.list();
    const byId = matchRuns(terms, runs, runs.some((r) => r.tmuxPane) ? await parentLookup() : procParent);
    const t = terms.find((x) => byId.has(x.id));
    return t ? { name: t.session, termId: t.id, cwd: t.cwd, run: byId.get(t.id) } : { name: null, run: runs[0] };
  }
  const inTerminal = (term) => Object.assign(new HttpError(409, term.name
    ? `This conversation runs in the terminal session "${term.name}". Continue it here (that terminal stops), or read along.`
    : 'This conversation runs in a terminal outside the dashboard. Continue it here (that terminal stops), or read along.'), { code: 'in-terminal' });
  return { terminalOf, inTerminal };
}

/**
 * o (from feature.mjs): { chats, make, save, chatOr404, memory, models, openChatOf, freeId, terminalOf, auto: { name,
 * on() } (the Auto provider) }
 */
export function handoffRoutes(ctx, o) {
  const { HttpError } = ctx;
  const { chats, make, save, chatOr404, memory, models, openChatOf, freeId, terminalOf, auto } = o;
  const bad = (msg) => new HttpError(400, msg);
  const cfg = () => ctx.config();
  return [
    ['POST', /^\/api\/chats\/from-session$/, async (req) => {
      o.load();
      const b = await ctx.readJson(req);
      if (!v.sessionName(b.session)) throw bad('bad session name');
      const found = await ctx.deck.find(b.session);
      if (!found) throw new HttpError(404, 'no such session');
      const run = found.run;
      // A chat runs Claude Code: a Codex or OpenCode conversation stays in its terminal.
      if (run && (run.tool || 'claude') !== 'claude') throw new HttpError(409, 'Open as chat is for Claude Code sessions only: this conversation stays in its terminal');
      if (!run || !isSessionId(run.sessionId)) throw new HttpError(409, 'Claude has not reported its conversation yet; try again in a moment');
      const open = openChatOf(run.sessionId);
      if (open) return { id: open };
      const prof = run.profile && run.profile !== auto.name ? readProfile(run.profile) : null;
      if (prof) assertServes(prof, 'claude'); // says why, as a 400
      // As the terminal ran it (its flags), else as the last chat in that folder, else Settings: a conversation
      // taken back from a terminal keeps its model, effort and mode.
      const d = cfg().sessionDefaults || {};
      const last = memory.last(run.cwd) || {};
      const args = Array.isArray(run.carryArgs) ? run.carryArgs.filter((x) => typeof x === 'string') : [];
      const flag = (name) => {
        const i = args.indexOf(name);
        const eq = args.find((x) => x.startsWith(`${name}=`));
        return i >= 0 && i + 1 < args.length ? args[i + 1] : eq ? eq.slice(name.length + 1) : null;
      };
      const one = (name, key, list) => [flag(name), last[key], d[key]].find((x) => typeof x === 'string' && list.includes(x)) || null;
      const id = freeId(run.sessionId);
      make({
        id, ...(id !== run.sessionId ? { conversationId: run.sessionId } : {}), cwd: run.cwd, profile: run.profile,
        model: one('--model', 'model', models()), effort: one('--effort', 'effort', EFFORTS), permissionMode: one('--permission-mode', 'permissionMode', PERMISSION_MODES),
        ultracode: last.ultracode === true,
      });
      save();
      return { id };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/take$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      const term = await terminalOf(c.conversationId);
      if (!term) return { ok: true };
      if (term.termId) {
        // The terminal stays, as a plain shell: Claude stops in it, the conversation goes on here.
        await ctx.backend.respawn(term.termId, term.cwd || c.cwd, [process.execPath, '-e', '']);
      } else if (v.pid(term.run.pid)) {
        try {
          process.kill(term.run.pid, 'SIGTERM'); // the launcher ends Claude Code and removes its run record
        } catch {
          /* already gone */
        }
      }
      for (let i = 0; i < 40 && (await terminalOf(c.conversationId)); i++) await new Promise((r) => setTimeout(r, 200));
      if (await terminalOf(c.conversationId)) throw new HttpError(409, 'the terminal did not stop; stop Claude there and try again');
      c.refresh();
      c.emit('state'); // a page that streams leaves its read-along mode now, not at the next news
      ctx.poke?.();
      return { ok: true };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/terminal$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      if (!fs.existsSync(c.file())) throw new HttpError(409, 'send a first message: a conversation that has not started cannot be resumed in a terminal');
      if (c.busy()) throw new HttpError(409, 'Claude is working. Wait until it is done, or press Stop first.');
      const profile = c.profile === auto.name ? (auto.on() ? { name: auto.name, env: {} } : null) : readProfile(c.profile);
      if (!profile) throw bad('the provider of this chat is gone; choose another one first');
      chats.delete(c.id);
      await c.close();
      const flags = [
        ...(c.permissionMode ? ['--permission-mode', c.permissionMode] : []),
        ...(c.effort ? ['--effort', c.effort] : []),
        ...(c.model ? ['--model', c.model] : []),
      ];
      let name;
      try {
        name = await ctx.deck.start({ dir: c.cwd, profile, mode: 'resume', sessionId: c.conversationId, flags });
      } catch (e) {
        make(c.record()); // the terminal did not start: the chat stays open
        throw e;
      }
      save();
      ctx.poke?.();
      return { name };
    }],
  ];
}
