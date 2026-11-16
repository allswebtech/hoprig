// The routes of a running chat beside the basic ones of feature.mjs: the stream of its events, the settings that
// change without a restart, the queue, one task's stop, rewind, and what the composer's menus need.
//
//   GET  /api/chats/<id>/stream?from=N&epoch=E    server-sent events: "events" { epoch, reset, events, next },
//                                                 "state" (the chat's state, as in the long poll), "live" [deltas …]
//   POST /api/chats/<id>/mode                     { mode }   the permission mode, in the running process
//   POST /api/chats/<id>/settings                 { model?, effort?, ultracode? }   (null: Auto) → { restart }
//   POST /api/chats/<id>/title                    { title }  the owner names the chat
//   POST /api/chats/<id>/unqueue                  { id }     take a queued message back
//   POST /api/chats/<id>/tasks/<task>/stop                   stop one background agent, shell or workflow
//   POST /api/chats/<id>/rewind                   { messageId, dryRun? }   undo the file changes since a message
//   GET  /api/chats/<id>/files?q=                 the @ picker: files of the chat's folder
//   GET  /api/chats/<id>/commands                 the / menu: the coding tool's commands and skills
//   GET  /api/chats/<id>/usage                    context and plan usage, asked of the running process
// The stream is for a page on this computer (behind its login); a chat of another computer is read through the
// relay with the long poll of feature.mjs, which stays.
import { EFFORTS, PERMISSION_MODES } from '../config.mjs';
import { searchFiles } from './files.mjs';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const STREAM = new RegExp(`^/api/chats/${ID}/stream$`);
const BATCH_MS = 50; // deltas and changes sent together at most this often
const PING_MS = 20_000;

/** The chat's state for the page: everything but the numbered events. */
export function stateOf(c) {
  return {
    status: c.status(), running: !!c.session, working: c.busy(), activity: c.activity, pending: [...c.pending.keys()],
    todos: c.todos, tasks: [...c.tasks.values()], queue: c.queue.list(),
    live: [...c.live.values()], usage: c.usage, limits: c.limits, limit: c.limit, lastError: c.lastError, title: c.title,
    engine: { id: c.engine.id, label: c.engine.label, capabilities: c.engine.capabilities, version: c.info.version || null },
    model: c.model, effort: c.effort, ultracode: c.ultracode, permissionMode: c.permissionMode, liveModel: c.liveModel, liveMode: c.liveMode,
    costTotal: c.costTotal,
  };
}

/**
 * o: { chatOr404, save, bad, models(), folderOf(chat) (its folder while inside the allowed roots), about(chat) (what
 * the page shows beside the state: folder, provider, choices), terminalOf(chat) → { name } | null (a terminal that
 * runs the conversation now) } from feature.mjs
 */
export function liveRoutes(ctx, { chatOr404, save, bad, models, folderOf, about, terminalOf }) {
  const { HttpError } = ctx;
  const pick = (val, list, what) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    if (!list.includes(val)) throw bad(`the ${what} must be one of: ${list.join(', ')}`);
    return val;
  };

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
    c.refresh();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
        if (w.reset || w.events.length) send('events', { epoch: c.epoch, reset: w.reset, events: w.events, next: c.next });
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
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    // A terminal that runs it: follow along, and say so.
    const look = setInterval(() => {
      if (c.session) return;
      c.refresh();
      lookTerminal();
    }, 1500);
    res.on('close', () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      clearInterval(look);
      c.off('change', onChange);
      c.off('status', onState);
      c.off('state', onState);
      c.off('live', onLive);
    });
    return true;
  }

  const routes = [
    ['POST', new RegExp(`^/api/chats/${ID}/mode$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      const mode = pick(b.mode, PERMISSION_MODES, 'permission mode');
      if (!mode) throw bad('say which mode');
      const r = await c.setSettings({ mode });
      save();
      return { permissionMode: c.permissionMode, liveMode: c.liveMode, restart: r.restart };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/settings$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (b.ultracode !== undefined && typeof b.ultracode !== 'boolean') throw bad('ultracode is true or false');
      const r = await c.setSettings({ model: pick(b.model, models(), 'model'), effort: pick(b.effort, EFFORTS, 'effort'), ultracode: b.ultracode });
      save();
      return { model: c.model, effort: c.effort, ultracode: c.ultracode, restart: r.restart };
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
    ['POST', new RegExp(`^/api/chats/${ID}/rewind$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (typeof b.messageId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(b.messageId)) throw bad('bad message id');
      const r = await c.rewind(b.messageId, { dryRun: b.dryRun === true });
      return {
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
      const list = await c.commands();
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
  ];
  return { routes, handle };
}
