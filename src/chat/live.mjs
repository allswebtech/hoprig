// The routes of a running chat beside the basic ones of feature.mjs: the stream of its events, the settings that
// change without a restart, the queue, one task's stop, rewind, and what the composer's menus need.
//
//   GET  /api/chats/<id>/stream?from=N&epoch=E    server-sent events: "events" { epoch, reset, events, next },
//                                                 "state" (the chat's state, as in the long poll), "live" [deltas …],
//                                                 last "closed" { closed } (what a 404 of the chat would carry), only
//                                                 when the chat left the open list for good; at a restart, or a
//                                                 hand-off that failed, the stream just ends and the page looks again
//   POST /api/chats/<id>/mode                     { mode }   the permission mode, in the running process
//   POST /api/chats/<id>/settings                 { model?, effort?, ultracode?, lead? }   (null: Auto) → { restart }
//   GET  /api/chats/<id>/parts                    who did what (Lead model): { lead, parts: [{ agent, kind, tier, model, tokens }], tiers }
//   POST /api/chats/<id>/title                    { title }  the owner names the chat
//   POST /api/chats/<id>/unqueue                  { id }     take a queued message back
//   POST /api/chats/<id>/tasks/<task>/stop                   stop one background agent, shell or workflow
//   POST /api/chats/<id>/rewind                   { messageId, dryRun?, files? (default true), conversation? }   go back
//                                                 to before a message: its files, the conversation, or both
//   GET  /api/chats/<id>/files?q=                 the @ picker: files of the chat's folder
//   GET  /api/chats/<id>/commands                 the / menu: the coding tool's commands and skills
//   GET  /api/chats/<id>/usage                    context and plan usage, asked of the running process
//   GET  /api/chats/<id>/changes                  what changed in the folder (git): the session rail's Changes card
//   GET  /api/chats/<id>/pr                       the branch's pull request and its checks (gh): the rail's PR line; POST .../pr/merge (confirm: true) merges when ready
//   GET  /api/chats/<id>/tasks/<task>/output      a background task opened: a shell's last 2000 lines, an agent's report
//   GET  /api/chats/<id>/diff?path=               one changed file's diff (git): the App's diff pane
//   POST /api/chats/<id>/shell                    { command }   "!" in the box: the owner's shell command, run in the
//                                                 folder (bang.mjs) → { code, output, cut, timedOut, stopped, ms }
//   GET  /api/chats/<id>/shell                    the one that runs now: { running, command, output (its end), ms }
//   POST /api/chats/<id>/shell/stop               stop it (its whole process group)
//   GET  /api/chats/<id>/history                  the folder's conversations (to continue one in a chat)
//   GET  /api/chats/<id>/attachment?name=         a picture sent with a message (the timeline's thumbnail)
// The stream and the pictures are for a page on this computer (behind its login); a chat of another computer is read
// through the relay with the long poll of feature.mjs, which stays.
import fs from 'node:fs';
import path from 'node:path';
import { chatSwitch } from './handsoff.mjs';
import { handsOffOffered } from '../handsoff.mjs';
import { within } from '../server/folders.mjs';
import { bangCommand, runBang } from './bang.mjs';
import { fileDiff, folderChanges } from './changes.mjs';
import { mergeWhenReady, prState } from './pr.mjs';
import { taskOutput } from './tasks.mjs';
import { LEAD_ONLY_CLAUDE, leadPlan } from '../models/lead.mjs';
import { partsOf } from '../models/parts.mjs';
import { cleanOthers } from '../models/others.mjs';
import { IMAGE_MAX, IMAGE_TYPES, searchFiles, uploadsReal } from './files.mjs';
import { listRuns, runsConversation } from '../runs.mjs';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const STREAM = new RegExp(`^/api/chats/${ID}/(stream|attachment)$`);
const UPLOAD_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,150}$/; // what the upload route names a file (uploads.mjs)
const BATCH_MS = 50; // deltas and changes sent together at most this often
const PING_MS = 20_000;

/** The chat's state for the page: everything but the numbered events. */
/** The one line under "Lead model" for chat `c`: which models it uses on this provider, or why it cannot lead. */
function leadLineOf(c) {
  const p = leadPlan(c.profile, { tool: c.engine.id });
  return p.can ? p.line : p.why;
}

export function stateOf(c) {
  return {
    // working: a turn or background work runs; turn: a turn runs (only that one Stop ends, and only then is a
    // message queued). now: this computer's clock, so a page elsewhere counts a tool's seconds right.
    status: c.status(), running: !!c.session, working: c.busy(), turn: !!c.turn, activity: c.activity, pending: [...c.pending.keys()], now: Date.now(),
    asking: c.pending.size ? [...c.pending.values()][0].type : null, // permission | question | plan: the status line's words
    todos: c.todos, tasks: c.tasks.forPage(), queue: c.queue.list(),
    live: [...c.live.values()], usage: c.usage, limits: c.limits, limit: c.limit, lastError: c.lastError, lastEnd: c.lastEnd, hasMessage: c.events.some((e) => e.kind === 'user'), title: c.currentTitle(),
    engine: { id: c.engine.id, label: c.engine.label, capabilities: c.engine.capabilities, version: c.info.version || null },
    // lead: the switch; leadLine: which models it uses on this provider (or why it cannot), said before the next start.
    lead: c.lead, leadLine: c.lead ? leadLineOf(c) : null, others: c.others,
    model: c.model, effort: c.effort, ultracode: c.ultracode, permissionMode: c.permissionMode, liveModel: c.liveModel, liveMode: c.liveMode, modeLater: c.modeLater || null,
    autoMode: c.autoSeen === true, // auto mode shown to be there (a plan's first answer, words.js planModes)
    costTotal: c.costTotal,
    // Hands-off's state only where it is offered on this computer; otherwise the field is absent and the page shows
    // nothing of it (no bar, no menu entry), whatever the chat record holds.
    ...(() => {
      const cfg = c.o && c.o.handsOffConfig ? c.o.handsOffConfig() : {};
      if (!handsOffOffered(cfg)) return {};
      const st = chatSwitch(c, cfg);
      return { handsOff: { on: st.on, stale: st.stale, loop: st.loop, ...(st.stopped ? { stopped: st.stopped } : {}), own: !!c.handsOff } };
    })(),
  };
}

/**
 * o: { chatOr404, toolStillOn(chat) (throws while its coding tool is off), save, remember(chat, req) (its settings are
 * its folder's last, unless Tia made the change or the chat is hers), bad, choices(chat) (its coding tool's modes, efforts and models), pickModel(value, tool,
 * choices), folderOf(chat) (its folder while inside the allowed roots), about(chat) (what the page shows beside the
 * state: folder, provider, choices), terminalOf(chat) → { name } | null (a terminal that runs the conversation now),
 * shutOf(id) (what is kept of a chat that closed: { cwd, conversationId, title, tool } or null), openNow(chat) (it is
 * still the open chat of its id: its process ends at a restart, not the chat) } from feature.mjs. The feature emits
 * 'gone' on a chat that left the list for good, and 'kept' on one whose hand-off to a terminal failed.
 */
export function liveRoutes(ctx, { chatOr404, toolStillOn = () => {}, save, remember, bad, choices, modeCheck = () => {}, pickModel, folderOf, uploadsDir, openChatOf, about, terminalOf, shutOf = () => null, openNow = () => true, handed = () => [] }) {
  const { HttpError } = ctx;
  const pick = (val, list, what) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    if (!list.includes(val)) throw bad(`the ${what} must be one of: ${list.join(', ')}`);
    return val;
  };
  /** 409 (code in-terminal) while a terminal runs the chat's conversation. */
  async function notInTerminal(c) {
    const t = await terminalOf(c);
    if (t) throw Object.assign(new HttpError(409, `This conversation runs in ${t.name ? `the terminal session "${t.name}"` : 'a terminal outside the dashboard'}. Continue it here first.`), { code: 'in-terminal' });
  }

  /** The stream: GET only, behind the dashboard's login (a cookie; other computers use the long poll). */
  function handle(req, res) {
    if (req.method !== 'GET' || !req.url.startsWith('/api/chats/')) return false;
    const url = new URL(req.url, 'http://x');
    const m = STREAM.exec(url.pathname);
    if (!m) return false;
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!ctx.authed(req)) {
      json(401, { error: 'log in first' });
      return true;
    }
    let c;
    try {
      c = chatOr404(m[1]);
    } catch (e) {
      json(e.status || 404, { error: e.message });
      return true;
    }
    if (m[2] === 'attachment') {
      picture(c, url.searchParams.get('name'), res, json);
      return true;
    }
    c.refresh();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    let epoch = Number(url.searchParams.get('epoch')) || 0;
    let deltas = [];
    let terminal = null; // a terminal that runs the conversation (the page then reads along)
    let dirty = { events: true, state: true };
    let timer = null;
    const flush = () => {
      timer = null;
      if (dirty.events) {
        const w = c.window(from, epoch);
        // A page that starts over learns the coding tool with the events, before its state: what it draws first is
        // said in that tool's words ("OpenCode wants to…"), not the default's.
        const tool = w.reset ? { engine: { id: c.engine.id, label: c.engine.label, capabilities: c.engine.capabilities } } : {};
        if (w.reset || w.events.length) send('events', { epoch: c.epoch, reset: w.reset, events: w.events, next: c.next, ...tool });
        from = c.next;
        epoch = c.epoch;
      }
      if (deltas.length) send('live', deltas);
      if (dirty.state) send('state', { ...stateOf(c), ...about(c), terminal });
      deltas = [];
      dirty = { events: false, state: false };
    };
    const later = () => {
      if (!timer) timer = setTimeout(flush, BATCH_MS);
    };
    const onChange = () => {
      dirty.events = true;
      later();
    };
    const onState = () => {
      dirty.state = true;
      later();
    };
    const onLive = (ev) => {
      deltas.push(ev);
      later();
    };
    c.on('change', onChange);
    c.on('status', onState);
    c.on('state', onState);
    c.on('live', onLive);
    // The page learns it here, with what a look would answer, so it does not ask once more for a chat that is gone
    // (at a hand-off to a terminal that request was a 404 in its console). Only for a chat closed for good: its
    // process also ends at every restart of the dashboard (the chat is loaded again after it) and while a hand-off
    // runs (which can fail and keep the chat); then the stream just ends and the page looks again, as it always did.
    let waitEnd = null;
    const end = (gone) => {
      if (res.writableEnded) return;
      clearTimeout(waitEnd);
      if (gone) {
        if (timer) {
          clearTimeout(timer); // what waited is sent first; nothing is written after the end
          flush();
        }
        send('closed', { closed: shutOf(c.id) });
      }
      res.end();
    };
    const onGone = () => end(true);
    const onKept = () => end(false);
    const onClosed = () => {
      if (openNow(c)) return end(false);
      waitEnd = setTimeout(() => end(false), 60_000); // the hand-off says gone or kept; never hold the page for ever
    };
    c.once('closed', onClosed);
    c.once('gone', onGone);
    c.once('kept', onKept);
    let closed = false;
    const lookTerminal = async () => {
      const t = await terminalOf(c).catch(() => null);
      if (!closed && JSON.stringify(t) !== JSON.stringify(terminal)) {
        terminal = t;
        onState();
      }
    };
    flush();
    lookTerminal();
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), PING_MS);
    // A terminal that runs it: follow along, and say so.
    // A title written to the conversation's file (Claude Code's, a rename in a terminal) reaches the title bar and the
    // tab too: the state is sent again when the name changed.
    let title = c.currentTitle();
    const look = setInterval(() => {
      if (c.currentTitle() !== title) {
        title = c.currentTitle();
        onState();
      }
      if (c.session) return;
      c.refresh();
      lookTerminal();
    }, 1500);
    res.on('close', () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(waitEnd);
      clearInterval(ping);
      clearInterval(look);
      c.off('change', onChange);
      c.off('status', onState);
      c.off('state', onState);
      c.off('live', onLive);
      c.off('closed', onClosed);
      c.off('gone', onGone);
      c.off('kept', onKept);
    });
    return true;
  }

  /** A picture of this chat's uploads folder, by the name the upload route gave it: nothing else is served. */
  function picture(c, name, res, json) {
    const type = IMAGE_TYPES[path.extname(String(name || '')).toLowerCase()];
    if (!type || !UPLOAD_NAME.test(name)) return json(400, { error: 'bad picture name' });
    let file;
    try {
      const dir = uploadsReal(folderOf(c), uploadsDir(c)); // itself inside the chat's folder, not a symlink out
      file = fs.realpathSync(path.join(dir, name));
      if (!within(file, dir) || file === dir) throw new Error('outside');
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > IMAGE_MAX) throw new Error('not a picture');
    } catch {
      return json(404, { error: 'no such picture' });
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  const shells = new Map(); // chat id → its "!" command that runs now: { command, output (its end), started, stop }
  const SHOWN_MAX = 4000; // what of a running command's output the page sees while it runs
  const routes = [
    ['GET', new RegExp(`^/api/chats/${ID}/history$`), async (req, m) => {
      const c = chatOr404(m[1]);
      toolStillOn(c);
      // The coding tool's own store: a conversation stays in the tool it was started with.
      const list = await c.engine.history(folderOf(c), c.o.engineOpts);
      const runs = listRuns().filter((r) => r.status !== 'ended'); // terminal: a terminal session runs it now
      return {
        tool: c.engine.id,
        conversations: list.slice(0, 50).map((x) => ({ ...x, current: x.id === c.conversationId, chat: openChatOf(x.id), terminal: runs.some((r) => runsConversation(r, x.id, c.engine.id)) })),
      };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/mode$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      const mode = pick(b.mode, choices(c).modes, 'permission mode');
      if (!mode) throw bad('say which mode');
      modeCheck(req, c, mode);
      const r = await c.setSettings({ mode });
      save();
      remember(c, req);
      return { permissionMode: c.permissionMode, liveMode: c.liveMode, restart: r.restart };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/settings$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (b.ultracode !== undefined && typeof b.ultracode !== 'boolean') throw bad('ultracode is true or false');
      if (b.lead !== undefined && typeof b.lead !== 'boolean') throw bad('lead is true or false');
      if (b.lead === true && c.engine.id !== 'claude') throw bad(LEAD_ONLY_CLAUDE);
      let others;
      try {
        if (b.others !== undefined) others = cleanOthers(b.others, c.profile);
      } catch (e) {
        throw bad(e.message);
      }
      const ch = choices(c);
      const r = await c.setSettings({ model: pickModel(b.model, c.engine.id, ch), effort: pick(b.effort, ch.efforts, 'effort'), ultracode: b.ultracode, lead: b.lead, others });
      save();
      remember(c, req);
      // lead only where it was asked for or is on: with the switch off the answer is the one of before.
      return { model: c.model, effort: c.effort, ultracode: c.ultracode, ...(b.lead !== undefined || c.lead ? { lead: c.lead } : {}), ...(b.others !== undefined || c.others.length ? { others: c.others } : {}), restart: r.restart };
    }],
    // Who did what (Lead model): per helper its kind, model and tokens, from Claude Code's own records.
    ['GET', new RegExp(`^/api/chats/${ID}/parts$`), async (req, m) => {
      const c = chatOr404(m[1]);
      if (c.engine.id !== 'claude') return { lead: null, parts: [], tiers: [], others: [] };
      const out = partsOf(c.cwd, c.conversationId);
      // Parts handed to another provider ("Use other providers"): each its own session, its model and tokens read from
      // Claude Code's records of that session, never from what a model says.
      const others = handed(c).map((p) => {
        const got = p.cwd && p.conversationId ? partsOf(p.cwd, p.conversationId) : null;
        const lead = got && got.lead;
        return { provider: p.provider, kind: p.kind, model: lead ? lead.model : null, tokens: lead ? lead.tokens : 0, use: lead ? lead.use : null, open: p.open };
      });
      return { ...out, others };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/title$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      const title = typeof b.title === 'string' ? b.title.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() : '';
      if (!title || title.length > 200) throw bad('the name must be 1 to 200 characters');
      await c.rename(title);
      save();
      return { title: c.title };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/unqueue$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (typeof b.id !== 'string' || b.id.length > 100) throw bad('bad message id');
      await c.unqueue(b.id);
      return { ok: true };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/tasks/([A-Za-z0-9_-]{1,100})/stop$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      await c.stopTask(m[2]);
      return { ok: true };
    }],
    // A task's output (a shell's last lines, an agent's report): read from the table, so only a file the coding tool named.
    ['GET', new RegExp(`^/api/chats/${ID}/tasks/([A-Za-z0-9_-]{1,100})/output$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const t = c.tasks.get(m[2]);
      if (!t) throw new HttpError(404, 'no such task in this chat');
      return taskOutput(t);
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/rewind$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (typeof b.messageId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(b.messageId)) throw bad('bad message id');
      // A rewind runs the coding tool on the conversation: never while a terminal runs it (one place at a time).
      await notInTerminal(c);
      const r = await c.rewind(b.messageId, { dryRun: b.dryRun === true, files: b.files !== false, conversation: b.conversation === true });
      return {
        conversation: r && r.conversation ? { messages: r.conversation.messages, text: String(r.conversation.text || '').slice(0, 100_000) } : null,
        canRewind: !!(r && r.canRewind !== false), error: r && r.error ? String(r.error).slice(0, 300) : null,
        files: Array.isArray(r && r.filesChanged) ? r.filesChanged.slice(0, 200).map(String) : [], insertions: r && Number.isFinite(r.insertions) ? r.insertions : null,
        deletions: r && Number.isFinite(r.deletions) ? r.deletions : null,
      };
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/files$`), async (req, m, q) => {
      const c = chatOr404(m[1]);
      const query = String(q.get('q') || '').slice(0, 200);
      return { files: await searchFiles(folderOf(c), query) };
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/commands$`), async (req, m) => {
      const c = chatOr404(m[1]);
      // While a terminal runs the conversation the menu shows what the chat knew last: asking would start a second
      // process on it.
      const list = (await terminalOf(c)) ? c.knownCommands || [] : await c.commands();
      return {
        commands: (Array.isArray(list) ? list : []).slice(0, 500).filter((x) => x && typeof x.name === 'string').map((x) => ({
          name: x.name.slice(0, 100), description: typeof x.description === 'string' ? x.description.slice(0, 300) : '',
          argumentHint: typeof x.argumentHint === 'string' ? x.argumentHint.slice(0, 100) : '', builtin: x.builtin === true,
        })),
      };
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/usage$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const r = await c.usageNow();
      if (!r) throw new HttpError(409, 'the chat is not running; usage comes with the next message');
      return r;
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/changes$`), async (req, m) => {
      const c = chatOr404(m[1]);
      return folderChanges(folderOf(c)); // the chat's own folder, inside the allowed roots (feature.mjs)
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/pr$`), async (req, m) => prState(folderOf(chatOr404(m[1])))],
    ['POST', new RegExp(`^/api/chats/${ID}/pr/merge$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (b.confirm !== true) throw bad('a merge needs the owner\'s confirmation: others see it');
      if (!Number.isInteger(b.number)) throw bad('say which pull request: the number is missing');
      const r = await mergeWhenReady(folderOf(c), { number: b.number });
      if (!r.ok) throw new HttpError(409, r.error);
      return { ok: true };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/shell$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      const command = bangCommand(b.command);
      if (!command) throw bad('write a command of 1 to 4000 characters');
      // One at a time in a session: a second one waits for the owner to see the first one's output.
      if (shells.has(c.id)) throw new HttpError(409, 'a command runs in this session already; wait for its output');
      const ctl = new AbortController();
      const run = { command, output: '', started: Date.now(), stop: () => ctl.abort() };
      shells.set(c.id, run);
      try {
        return await runBang(folderOf(c), command, { signal: ctl.signal, onOutput: (t) => (run.output = (run.output + t).slice(-SHOWN_MAX)) });
      } finally {
        shells.delete(c.id);
      }
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/shell$`), async (req, m) => {
      const run = shells.get(chatOr404(m[1]).id);
      return run ? { running: true, command: run.command, output: run.output, ms: Date.now() - run.started } : { running: false };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/shell/stop$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      const run = shells.get(c.id);
      if (run) run.stop();
      return { stopped: !!run };
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/diff$`), async (req, m, q) => {
      const c = chatOr404(m[1]);
      const d = await fileDiff(folderOf(c), q.get('path'));
      if (!d) throw new HttpError(404, 'that file has no change in this folder');
      return d;
    }],
  ];
  return { routes, handle };
}
