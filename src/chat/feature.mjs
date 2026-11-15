// Coding without the terminal: the chat view of a Claude Code conversation (chat.mjs), as one feature of the
// dashboard (server.mjs features list). The open chats are kept in <stateDir>/chats.json, so they are still listed
// after a restart (their process starts again with the next message).
//
//   GET  /api/chats                           the open chats, as cards
//   POST /api/chats                           { dir, profile, model?, effort?, permissionMode?, sessionId?, text? } → { id }
//   POST /api/chats/from-session              { session } → { id }   the conversation of a terminal session, as a chat
//   GET  /api/chats/<id>?from=N&epoch=E&wait=S   the chat: events from N (wait up to S seconds for news)
//   GET  /api/chats/<id>/older?before=N       earlier events
//   POST /api/chats/<id>/send                 { text }
//   POST /api/chats/<id>/answer               { request, allow, always?, answers?, message? }   a tool use's OK
//   POST /api/chats/<id>/stop                 interrupt the turn
//   POST /api/chats/<id>/next                 { model?, effort? }   for the next turn
//   POST /api/chats/<id>/provider             { profile }   continue on another provider
//   POST /api/chats/<id>/take                 the terminal that runs this conversation stops; the chat goes on
//   POST /api/chats/<id>/terminal             open the conversation in a terminal → { name } (the chat closes)
//   POST /api/chats/<id>/upload               raw bytes, X-File-Name → { path }   (the uploads folder, as for sessions)
//   POST /api/chats/<id>/close
//
// One conversation never runs in two places at once (the owner's rule). A terminal session runs it when a run record
// (src/runs.mjs) carries its id: then the chat does not send, and offers to take it over. The other way round,
// running() tells the session start (server.mjs) that a chat runs it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAutoSwitch } from '../autoswitch.mjs';
import { EFFORTS, MODELS, PERMISSION_MODES } from '../config.mjs';
import { stateDir, tilde } from '../paths.mjs';
import { listProfiles, publicProfile, readProfile } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { isSessionId, sessionsIn } from '../sessions.mjs';
import { matchRuns } from '../server/deck.mjs';
import { insideRoots, resolveRoots } from '../server/folders.mjs';
import { parentLookup, procParent } from '../server/platform.mjs';
import { DEFAULT_UPLOADS_DIR, DEFAULT_UPLOAD_MAX_MB, saveUpload, uploadsDirName } from '../server/uploads.mjs';
import * as v from '../server/validate.mjs';
import { Chat } from './chat.mjs';

const OPEN_MAX = 50;
const WAIT_MAX_S = 25; // below the relay's 30 s idle limit, so a chat of another computer can wait too
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const AUTO = { name: 'auto', label: 'Auto', kind: 'auto' };

/** The name a chat has among the sessions (Home, notifications). ":" is never in a terminal's name. */
export const cardName = (id) => `chat:${id}`;

/** o: { command, resolveEnv, spawnImpl, idleMs, stopGraceMs } (tests), file (where the open chats are kept) */
export function chatFeature(ctx, o = {}) {
  const { HttpError } = ctx;
  const bad = (msg) => new HttpError(400, msg);
  const cfg = () => ctx.config();
  const roots = () => resolveRoots(cfg().server.roots);
  const file = () => o.file || path.join(stateDir(), 'chats.json');
  const chats = new Map();
  let loaded = false;

  // ---------- the list of open chats ----------
  function make(rec) {
    const c = new Chat({ ...rec, command: o.command, resolveEnv: o.resolveEnv, spawnImpl: o.spawnImpl, idleMs: o.idleMs, stopGraceMs: o.stopGraceMs });
    c.setMaxListeners(200); // one per page that waits for news
    c.on('status', () => ctx.poke?.()); // Home and the notifications see a new state at once
    c.on('turn', save);
    chats.set(c.id, c);
    return c;
  }
  function load() {
    if (loaded) return;
    loaded = true;
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      /* none yet */
    }
    for (const r of Array.isArray(list) ? list : []) {
      if (r && isSessionId(r.id) && typeof r.cwd === 'string' && path.isAbsolute(r.cwd) && typeof r.profile === 'string') make(r);
    }
  }
  function save() {
    const out = [...chats.values()].map((c) => c.record());
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file());
  }
  function chatOr404(id) {
    load();
    const c = chats.get(id);
    if (!c) throw new HttpError(404, 'this chat is not open (it was closed or opened in a terminal)');
    return c;
  }

  // ---------- providers, models ----------
  const autoOn = () => getAutoSwitch().enabled === true;
  const profileOk = (name) => (name === AUTO.name ? autoOn() : !!readProfile(name));
  function profileView(name) {
    if (name === AUTO.name) return AUTO;
    const p = listProfiles().find((x) => x.name === name);
    return p ? publicProfile(p) : { name, label: name, kind: 'unknown' };
  }
  const models = () => {
    const saved = (cfg().sessionDefaults || {}).model;
    return saved && !MODELS.includes(saved) ? [...MODELS, saved] : [...MODELS];
  };
  const pick = (val, list, what) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    if (!list.includes(val)) throw bad(`the ${what} must be one of: ${list.join(', ')}`);
    return val;
  };

  // ---------- the one-place rule ----------
  /** The terminal that runs conversation `id`: { name } (null name: a terminal outside the dashboard), or null. */
  async function terminalOf(id) {
    const runs = listRuns().filter((r) => r.sessionId === id && r.status !== 'ended');
    if (!runs.length) return null;
    const terms = await ctx.backend.list();
    const byId = matchRuns(terms, runs, runs.some((r) => r.tmuxPane) ? await parentLookup() : procParent);
    const t = terms.find((x) => byId.has(x.id));
    return t ? { name: t.session, termId: t.id, cwd: t.cwd, run: byId.get(t.id) } : { name: null, run: runs[0] };
  }
  const inTerminal = (term) => Object.assign(new HttpError(409, term.name
    ? `This conversation runs in the terminal session "${term.name}". Continue it here (that terminal stops), or read along.`
    : 'This conversation runs in a terminal outside the dashboard. Continue it here (that terminal stops), or read along.'), { code: 'in-terminal' });

  // ---------- views ----------
  function card(c) {
    const status = c.status();
    const ask = status === 'attention' ? [...c.pending.values()][0] : null;
    return {
      name: cardName(c.id), kind: 'chat', chatId: c.id, display: c.title || 'New chat', title: c.title,
      cwd: c.cwd, short: tilde(c.cwd), profile: profileView(c.profile), status, statusAt: c.statusAt, activity: c.statusAt,
      created: c.openedAt, attached: false, panes: 0, sessionId: c.id, canSwitch: false,
      lastMessage: c.lastText.replace(/\s+/g, ' ').trim().slice(0, 300),
      note: ask ? `Allow ${ask.title}${ask.description ? `: ${ask.description}` : ''}?` : '',
      limit: c.limit ? { text: c.limit.text } : null,
    };
  }
  async function view(c, { from, epoch }) {
    const reset = epoch !== c.epoch || from < c.base;
    const events = reset ? c.since(0, 300) : c.since(from);
    return {
      id: c.id, epoch: c.epoch, reset, events, next: c.next, first: events.length ? events[0].i : c.next, older: (events.length ? events[0].i : c.next) > c.base,
      status: c.status(), running: !!c.child, pending: [...c.pending.keys()], todos: c.todos.list,
      title: c.title, cwd: c.cwd, short: tilde(c.cwd), profile: profileView(c.profile),
      model: c.model, effort: c.effort, permissionMode: c.permissionMode, liveModel: c.liveModel,
      costTotal: c.costTotal, lastError: c.lastError, limit: c.limit,
      terminal: c.child && c.state !== 'idle' ? null : await terminalOf(c.id).then((t) => (t ? { name: t.name } : null)),
      choices: { models: models(), efforts: EFFORTS },
    };
  }
  // Wait for news. The response's "close" (not the request's: that one fires as soon as a GET is read) ends the wait
  // when the browser goes away. While a terminal runs the conversation, its transcript is looked at every 1.5 s, so a
  // reader follows along.
  function waitChange(c, res, ms) {
    const at = c.version;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        clearInterval(look);
        c.off('change', check);
        c.off('status', check);
        res.off?.('close', done);
        resolve();
      };
      const check = () => c.version !== at && done();
      const t = setTimeout(done, ms);
      const look = setInterval(() => !c.child && c.refresh(), 1500);
      c.on('change', check);
      c.on('status', check);
      res.on?.('close', done);
    });
  }

  // ---------- routes ----------
  const routes = [
    ['GET', /^\/api\/chats$/, async () => {
      load();
      return { chats: [...chats.values()].map(card) };
    }],
    ['POST', /^\/api\/chats$/, async (req) => {
      load();
      const b = await ctx.readJson(req);
      const dir = insideRoots(v.absPath(b.dir), roots());
      if (!dir) throw bad('choose a folder inside the allowed roots');
      if (typeof b.profile !== 'string' || !profileOk(b.profile)) throw bad('there is no such provider');
      const d = cfg().sessionDefaults || {};
      const model = pick(b.model, models(), 'model');
      const effort = pick(b.effort, EFFORTS, 'effort');
      const permissionMode = pick(b.permissionMode, PERMISSION_MODES, 'permission mode');
      let id = crypto.randomUUID();
      if (b.sessionId !== undefined && b.sessionId !== null) {
        id = v.sessionId(b.sessionId);
        if (!id || !sessionsIn(dir).some((s) => s.id === id)) throw bad('that conversation is not in this folder');
        if (chats.has(id)) return { id };
      }
      let text = null;
      if (b.text !== undefined && b.text !== null) {
        text = v.message(b.text);
        if (!text) throw bad(`the message must be 1 to ${v.MESSAGE_MAX} bytes`);
      }
      if (chats.size >= OPEN_MAX) {
        const old = [...chats.values()].filter((c) => !c.child).sort((a, b2) => a.statusAt - b2.statusAt)[0];
        if (!old) throw new HttpError(409, `${OPEN_MAX} chats are open; close one first`);
        chats.delete(old.id);
      }
      const c = make({
        id, cwd: dir, profile: b.profile,
        model: model === undefined ? d.model || null : model,
        effort: effort === undefined ? d.effort || null : effort,
        permissionMode: permissionMode === undefined ? d.permissionMode || null : permissionMode,
      });
      save();
      if (text && !(await terminalOf(id))) await c.send(text);
      return { id };
    }],
    ['POST', /^\/api\/chats\/from-session$/, async (req) => {
      load();
      const b = await ctx.readJson(req);
      if (!v.sessionName(b.session)) throw bad('bad session name');
      const found = await ctx.deck.find(b.session);
      if (!found) throw new HttpError(404, 'no such session');
      const run = found.run;
      if (!run || !isSessionId(run.sessionId)) throw new HttpError(409, 'Claude has not reported its conversation yet; try again in a moment');
      if (!chats.has(run.sessionId)) {
        const d = cfg().sessionDefaults || {};
        make({ id: run.sessionId, cwd: run.cwd, profile: run.profile, model: d.model || null, effort: d.effort || null, permissionMode: d.permissionMode || null });
        save();
      }
      return { id: run.sessionId };
    }],
    ['GET', new RegExp(`^/api/chats/${ID}$`), async (req, m, q, res) => {
      const c = chatOr404(m[1]);
      c.refresh();
      const from = Math.max(0, Number(q.get('from')) || 0);
      const epoch = Number(q.get('epoch')) || 0;
      const wait = Math.min(WAIT_MAX_S, Math.max(0, Number(q.get('wait')) || 0));
      if (wait && epoch === c.epoch && from >= c.next) await waitChange(c, res, wait * 1000);
      return view(c, { from, epoch });
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/older$`), async (req, m, q) => {
      const c = chatOr404(m[1]);
      return { events: c.before(Math.max(0, Number(q.get('before')) || 0)), base: c.base };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/send$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      const text = v.message(b.text);
      if (!text) throw bad(`the message must be 1 to ${v.MESSAGE_MAX} bytes`);
      // Also while this chat's process waits idle: a terminal may have resumed the conversation meanwhile.
      if (c.state === 'idle') {
        const term = await terminalOf(c.id);
        if (term) {
          c.stop();
          throw inTerminal(term);
        }
      }
      await c.send(text);
      save();
      return { ok: true };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/answer$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (typeof b.request !== 'string' || !b.request || b.request.length > 200) throw bad('bad request id');
      if (typeof b.allow !== 'boolean') throw bad('say allow: true or false');
      let answers = null;
      if (b.answers !== undefined && b.answers !== null) {
        if (typeof b.answers !== 'object' || Array.isArray(b.answers) || Object.keys(b.answers).length > 20) throw bad('bad answers');
        answers = {};
        for (const [k, x] of Object.entries(b.answers)) {
          if (k.length > 1000 || typeof x !== 'string' || x.length > 4000) throw bad('bad answers');
          answers[k] = x;
        }
      }
      const message = typeof b.message === 'string' ? b.message.slice(0, 1000) : '';
      c.answer(b.request, { allow: b.allow, always: b.always === true, answers, message });
      return { ok: true };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/stop$`), async (req, m) => {
      await ctx.readJson(req);
      return { stopped: chatOr404(m[1]).interrupt() };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/next$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      c.setNext({ model: pick(b.model, models(), 'model'), effort: pick(b.effort, EFFORTS, 'effort') });
      save();
      return { model: c.model, effort: c.effort };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/provider$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (typeof b.profile !== 'string' || !profileOk(b.profile)) throw bad('there is no such provider');
      c.setProfile(b.profile);
      save();
      return { profile: profileView(c.profile) };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/take$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      const term = await terminalOf(c.id);
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
      for (let i = 0; i < 40 && (await terminalOf(c.id)); i++) await new Promise((r) => setTimeout(r, 200));
      if (await terminalOf(c.id)) throw new HttpError(409, 'the terminal did not stop; stop Claude there and try again');
      c.refresh();
      ctx.poke?.();
      return { ok: true };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/terminal$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      if (!fs.existsSync(c.file())) throw new HttpError(409, 'send a first message: a conversation that has not started cannot be resumed in a terminal');
      if (c.state !== 'idle') throw new HttpError(409, 'Claude is working. Wait until the reply ends, or press Stop first.');
      const profile = c.profile === AUTO.name ? (autoOn() ? { name: AUTO.name, env: {} } : null) : readProfile(c.profile);
      if (!profile) throw bad('the provider of this chat is gone; choose another one first');
      await c.stopAndWait();
      const flags = [
        ...(c.permissionMode ? ['--permission-mode', c.permissionMode] : []),
        ...(c.effort ? ['--effort', c.effort] : []),
        ...(c.model ? ['--model', c.model] : []),
      ];
      const name = await ctx.deck.start({ dir: c.cwd, profile, mode: 'resume', sessionId: c.id, flags });
      chats.delete(c.id);
      save();
      ctx.poke?.();
      return { name };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/upload$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const s = cfg().server;
      const dirName = uploadsDirName(s.uploadsDir || DEFAULT_UPLOADS_DIR);
      if (!dirName) throw new HttpError(500, 'server.uploadsDir must be a relative folder name');
      const cwd = insideRoots(c.cwd, roots());
      if (!cwd) throw bad('this chat runs outside the allowed folders');
      let fileName = 'upload';
      try {
        fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'upload'));
      } catch {
        /* keep the default */
      }
      const maxBytes = Math.max(1, Number(s.uploadMaxMB) || DEFAULT_UPLOAD_MAX_MB) * 1024 * 1024;
      return saveUpload(req, { cwd, dirName, fileName, maxBytes });
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/close$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      await c.stopAndWait();
      chats.delete(c.id);
      save();
      ctx.poke?.();
      return { ok: true };
    }],
  ];

  return {
    name: 'chat',
    routes,
    /** The open chats as session cards (server.mjs adds them to the sessions: Home, notifications). */
    cards() {
      load();
      return [...chats.values()].map(card);
    },
    /** True when a chat's process runs conversation `id` right now. */
    running(id) {
      const c = chats.get(id);
      return !!(c && c.child);
    },
    async close() {
      await Promise.all([...chats.values()].map((c) => c.stopAndWait(3000)));
    },
  };
}
