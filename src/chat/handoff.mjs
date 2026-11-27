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
import { BYPASS, bypassAllowed, bypassInArgs, runsAsRoot } from '../bypassgate.mjs';
import { handsOffOffered } from '../handsoff.mjs';
import { listRuns, runsConversation, stillRuns } from '../runs.mjs';
import { toolFlags } from '../codetools/start.mjs';
import { matchRuns, queue } from '../server/deck.mjs';
import { parentLookup, procParent } from '../server/platform.mjs';
import * as v from '../server/validate.mjs';
import { handedChats } from './handed.mjs';
import { isMarkedHers } from '../hermark.mjs';
import { runsDir } from '../paths.mjs';
import { noteTaken } from '../automation/taken.mjs';
import path from 'node:path';
import { chatTools, choicesOf, conversationIdOk, modeFor, modelOk } from './tools.mjs';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/**
 * terminalOf(id, tool): the terminal that runs conversation `id` of coding tool `tool` (Claude Code unless said): { name,
 * termId, cwd, run } (null name: one outside the dashboard), or null.
 * o: { chatOf(id, tool) }.
 * claim(id, fn, { tool, self }): one conversation, one process. Whatever starts a process on a conversation (a terminal,
 * a chat's message) does it in `fn`, run here one at a time per conversation, and only when no terminal runs it (else →
 * { terminal }) and no open chat but `self` has a process on it (o.chatOf(id, tool); else → { chat: its id }). → { started:
 * what fn returned }. A start that returns { name } (a terminal) is known as the conversation's from then on.
 */
export function terminals(ctx, o = {}) {
  const { HttpError } = ctx;
  // A run record runs conversation `id` when the coding tool reported it (sessionId), or, until the tool reports one,
  // when its launcher named it at the start (runs.mjs: conversation; written before the tool starts, so it holds from
  // the first moment, after a restart of the dashboard and for a terminal started outside it). The tool's own report
  // decides once there is one: after /clear it runs another conversation.
  async function terminalOf(id, tool = 'claude') {
    // A record without `tool` is an older one of Claude Code's.
    // The note is read before the terminals are listed: one written meanwhile is not judged by an older list.
    const note = ctx.deck?.launchOf?.(id, tool);
    const all = listRuns().filter((r) => r.status !== 'ended');
    const runs = all.filter((r) => runsConversation(r, id, tool));
    const parents = all.some((r) => r.tmuxPane) ? await parentLookup() : procParent;
    const terms = await ctx.backend.list();
    const byId = matchRuns(terms, runs, parents);
    const t = terms.find((x) => byId.has(x.id));
    // The moment before a launcher has written its record (deck.mjs noteLaunch): the terminal it was started in runs
    // the conversation while it lives, holds no record written since, and has not come back to its own shell. It ends
    // at the first record seen there (any record, whatever it runs), when the terminal is back at its shell (deck.mjs
    // launchEnded: a launcher that ended at once, or never ran), or with the terminal: from then on only records say
    // what runs.
    const nt = note && terms.find((x) => x.session === note.name);
    const written = nt && matchRuns([nt], all.filter((r) => r.startedAt >= note.at), parents).has(nt.id);
    const holds = nt && !written && !ctx.deck.launchEnded(note);
    if (note && !holds && ctx.deck.launchOf(id, tool) === note) ctx.deck.launchOf(id, tool, { drop: true });
    if (t) return { name: t.session, termId: t.id, cwd: t.cwd, run: byId.get(t.id) };
    if (holds) return { name: nt.session, termId: nt.id, cwd: nt.cwd, run: null };
    return runs.length ? { name: null, run: runs[0] } : null;
  }
  const inTerminal = (term) => Object.assign(new HttpError(409, term.name
    ? `This conversation runs in the terminal session "${term.name}". Continue it here (that terminal stops), or read along.`
    : 'This conversation runs in a terminal outside the dashboard. Continue it here (that terminal stops), or read along.'), { code: 'in-terminal' });
  // The conversation's own queue: the Deck's, which its moves to another provider share (deck.mjs move).
  const own = ctx.deck?.serial ? ctx.deck.serial : queue();
  /** `fn` after every earlier step on conversation `id` (a start, a take-over, a move): one at a time. */
  const serial = (id, fn, tool = 'claude') => own(`${tool}:${id}`, fn);
  function claim(id, fn, { tool = 'claude', self = null } = {}) {
    return serial(id, async () => {
      const term = await terminalOf(id, tool);
      if (term) return { terminal: term };
      // A chat's process: this dashboard's chats, and every chat record (runs.mjs createChatRun).
      const chat = (o.chatOf ? o.chatOf(id, tool) : null) || (listRuns({ chats: true, usage: false }).find((r) => r.kind === 'chat' && r.chat !== self && runsConversation(r, id, tool)) || {}).chat;
      if (chat && chat !== self) return { chat };
      // A start on the conversation is noted by the Deck as it creates the terminal (deck.mjs create).
      return { started: await fn() };
    }, tool);
  }
  /** The terminal of conversation `id` was told to stop (Continue here): what was known of its start goes. */
  const forget = (id, tool = 'claude') => ctx.deck?.launchOf?.(id, tool, { drop: true });
  return { terminalOf, inTerminal, claim, serial, forget };
}

/**
 * o (from feature.mjs): { chats, make, save, chatOr404, memory, models, openChatOf, freeId, and terminals()' terminalOf,
 * claim, serial, forget, auto: { name, on() } (the Auto provider), handedTo(id, name) (what is kept of the closed chat
 * names the terminal it went to), handedFile() (where the handed chats' titles are kept) }
 */
export function handoffRoutes(ctx, o) {
  const { HttpError } = ctx;
  const { chats, make, save, chatOr404, memory, models, openChatOf, freeId, terminalOf, claim, serial, forget, auto, handedTo = () => {} } = o;
  const bad = (msg) => new HttpError(400, msg);
  const cfg = () => ctx.config();
  const asRoot = ctx.root !== undefined ? ctx.root === true : runsAsRoot(); // as feature.mjs: no bypass as root
  // The chats closed by "Continue in Terminal", with their titles (handed.mjs: kept over a restart of the dashboard).
  const handed = handedChats(o.handedFile || null);
  const titleOf = (conversation, tool) => handed.titleOf(conversation, tool);
  // One "Continue in Terminal" start per conversation: `${tool}:${conversation}` → the promise of the terminal name it is
  // opening in. A second request for the same conversation (a double tap, two tabs) waits for that one and opens in
  // the same terminal, never a second process and never a 404 in the window before the new terminal's record is seen.
  const openingTerminal = new Map();
  /** Continue here: the terminal that runs chat `c`'s conversation stops (it stays, as a plain shell); the chat goes on. */
  async function take(c) {
    const tool = c.engine.id;
    const term = await terminalOf(c.conversationId, tool);
    if (!term) return { ok: true };
    let takeBack = () => {};
    if (term.termId) {
      // The terminal stays, as a plain shell: the coding tool stops in it, the conversation goes on here. (`-e 0`: a
      // program that ends at once, with no empty word on the typed line.)
      // Its launcher holds the conversation until its coding tool has saved and ended: waited for, as in a move.
      const hold = term.run && v.pid(term.run.pid) ? term.run.pid : null;
      // Written down first, so a restore after a restart at any moment from now does not reopen this terminal on the
      // conversation (src/automation/taken.mjs); taken back when the terminal could not be stopped.
      takeBack = noteTaken({ tool, conversation: c.conversationId, runId: term.run && term.run.runId });
      try {
        await ctx.deck.respawn(term.termId, term.cwd || c.cwd, [process.execPath, '-e', '0'], { hold });
      } catch (e) {
        takeBack();
        throw e;
      }
    } else if (term.run && v.pid(term.run.pid) && (await stillRuns(term.run))) {
      // Judged again right before the signal: a record whose process has ended (its pid another process's now) goes
      // instead, and nothing is sent to that other process.
      try {
        process.kill(term.run.pid, 'SIGTERM'); // the launcher ends the coding tool and removes its run record
      } catch {
        /* already gone */
      }
    }
    forget(c.conversationId, tool);
    for (let i = 0; i < 40 && (await terminalOf(c.conversationId, tool)); i++) await new Promise((r) => setTimeout(r, 200));
    if (await terminalOf(c.conversationId, tool)) {
      takeBack(); // it still runs the conversation: a restore may bring it back as before
      throw new HttpError(409, `the terminal did not stop; stop ${tool === 'claude' ? 'Claude' : c.engine.label} there and try again`);
    }
    // The conversation ran in that terminal, where the owner may have written in it: not Tia's chat any more.
    if (c.dropMark()) save();
    // It started again here, outside the dashboard's own move, so its Hands-off state was not carried: it is the
    // owner's until he turns it on for the chat (chatSwitch reads this stop; the wall still holds by the switch).
    if (handsOffOffered(cfg()) && c.handsOffStop !== 'reset') { c.handsOffStop = 'reset'; save(); }
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
      // The conversation the terminal runs: the coding tool's own report, else the one its launcher named at the start.
      const run = found.run && { ...found.run, sessionId: found.run.sessionId || found.run.conversation || null };
      // A chat runs the coding tools that have a chat here; another tool's conversation stays in its terminal.
      const tool = run ? run.tool || 'claude' : 'claude';
      if (run && !chatTools(cfg()).includes(tool)) throw new HttpError(409, 'Open as chat is not offered for this coding tool: this conversation stays in its terminal');
      if (!run || !conversationIdOk(tool, run.sessionId)) throw new HttpError(409, 'The coding tool has not reported its conversation yet; try again in a moment');
      const open = openChatOf(run.sessionId);
      if (open) {
        // The terminal ran its conversation: the owner's words may be in it now, so a chat of Tia's is hers no more.
        const c = chats.get(open);
        if (c.dropMark()) save();
        return { id: open };
      }
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
      // A terminal started in bypass (either spelling) goes on in it, while this dashboard allows it; else as before.
      const mode = tool === 'claude' && bypassInArgs(args) && bypassAllowed(cfg(), asRoot) ? BYPASS
        : tool === 'claude' ? one('--permission-mode', 'permissionMode', ch.modes) : modeFor(tool, flag('--permission-mode') === 'ask' ? 'manual' : flag('--permission-mode')) || modeFor(tool, last.permissionMode);
      const id = tool === 'claude' ? freeId(run.sessionId) : crypto.randomUUID();
      make({
        id, ...(id !== run.sessionId ? { conversationId: run.sessionId } : {}), engine: tool, cwd: run.cwd, profile: run.profile,
        // Claude Code: also an exact name the terminal ran with, while the provider's list does not leave it out.
        model: tool === 'claude' ? [flag('--model'), last.model, d.model].find((x) => typeof x === 'string' && modelOk(tool, x, ch)) || null : toolModel,
        effort: one('--effort', 'effort', ch.efforts), permissionMode: mode,
        ultracode: last.ultracode === true, ...titleOf(run.sessionId, tool),
        // A terminal of Tia's shown as a chat stays hers for her safety (the mark and her sign-in), read from the mark
        // the dashboard wrote for its run; its OKs stay the owner's (byTia is never set for an existing conversation).
        ...(run.runId && isMarkedHers(path.join(runsDir(), `${path.basename(String(run.runId))}.json`)) ? { hers: true } : {}),
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
        // The other tab's start may still be under way (its record not written yet): wait for it, not a stale look.
        const pk = `${h.tool}:${h.conversation}`;
        if (openingTerminal.has(pk)) return { name: await openingTerminal.get(pk), existing: true };
        const term = await terminalOf(h.conversation, h.tool);
        if (term) return there(term);
      }
      const c = chatOr404(m[1]);
      const conversation = c.conversationId;
      const tool = c.engine.id;
      if (tool !== 'claude' && !chatTools(cfg()).includes(tool)) throw new HttpError(409, `${c.engine.label} is off on this computer: turn it on to open its conversations in a terminal`);
      // A start for this very conversation already under way (a double tap, two tabs): open in that terminal. The
      // check and the set below are synchronous (no await between), so a concurrent request always sees the start.
      const key = `${tool}:${conversation}`;
      if (openingTerminal.has(key)) return { name: await openingTerminal.get(key), existing: true };
      let settle;
      const pending = new Promise((res, rej) => { settle = { res, rej }; });
      pending.catch(() => {}); // a lone request need not await it: do not warn on a rejection nobody reads
      openingTerminal.set(key, pending);
      try {
      const r = await claim(conversation, async () => {
        if (!chats.has(c.id)) throw new HttpError(404, 'this chat is not open (it was archived or opened in a terminal)');
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
        // Read before the chat closes: a chat of hers (her own start, a terminal of hers shown as a chat) stays hers.
        const wasHers = c.byTia === true || c.hers === true || !!c.restoredMark;
        chats.delete(c.id);
        handed.set(c.id, { conversation, tool, title: c.title || null, named: c.named === true });
        await c.close();
        // Its page learns the outcome only now (live.mjs): gone once the terminal runs, kept when it did not start.
        let name;
        try {
          // The conversation starts again in a terminal, outside the dashboard's own move: its Hands-off state is not
          // carried, so the new run starts with its answers stopped (a reset hand); the owner turns it on there.
          // A chat of Tia's goes on in the terminal as hers (the mark, her sign-in), whoever pressed.
          name = await ctx.deck.start({ ...(tool === 'claude' ? {} : { tool }), dir: c.cwd, profile, mode: 'resume', sessionId: conversation, flags, resetHandsOff: true, hers: wasHers });
        } catch (e) {
          make(c.record()); // the terminal did not start: the chat stays open
          c.emit('kept');
          throw e;
        }
        handedTo(c.id, name); // its page can open that terminal
        c.emit('gone');
        return { name };
      }, { tool, self: c.id });
      if (r.terminal) { const t = there(r.terminal); settle.res(t.name); return t; }
      if (r.chat) throw new HttpError(409, 'another chat runs this conversation right now');
      save();
      ctx.poke?.();
      settle.res(r.started.name);
      return { name: r.started.name };
      } catch (e) {
        settle.rej(e); // a request waiting on this start gets the same outcome
        throw e;
      } finally {
        openingTerminal.delete(key);
      }
    }],
  ];
}
