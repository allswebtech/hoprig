// Coding without the terminal: the chat view of a Claude Code conversation (chat.mjs), as one feature of the
// dashboard (server.mjs features list). The open chats are kept in <stateDir>/chats.json, so they are still listed
// after a restart (their process starts again with the next message).
//
//   GET  /api/chats                           the open chats, as cards
//   POST /api/chats                           { dir, profile?, model?, effort?, permissionMode?, ultracode?, sessionId?, text? }
//                                             → { id }   what is left out: as the last chat in that folder ran
//                                             (folders.mjs), else the provider recommended now and Settings
//   GET  /api/chats/<id>?from=N&epoch=E&wait=S   the chat: events from N (wait up to S seconds for news)
//   GET  /api/chats/<id>/older?before=N       earlier events
//   POST /api/chats/<id>/send                 { text, attachments?: [{ path }] } → { id, queued }   (while a turn
//                                             runs the message is queued; attachments: what /upload returned)
//   POST /api/chats/<id>/answer               { request, allow, always?, answers?, mode?, message? }   a tool use's OK
//                                             (mode: a plan approved, the permission mode to go on in)
//   POST /api/chats/<id>/stop                 end the turn (background tasks go on; see live.mjs for one task)
//                                             → { stopped, back: [{ text, files }] }  (the queued messages, taken back)
//   POST /api/chats/<id>/provider             { profile }   continue on another provider
//   POST /api/chats/<id>/upload               raw bytes, X-File-Name → { path }   (the uploads folder, as for sessions)
//   POST /api/chats/<id>/close
// and the routes of live.mjs (the event stream, mode, settings, queue, task stop, rewind, files, commands, usage) and
// of handoff.mjs (from a terminal session to a chat and back: one conversation never runs in two places at once).
// The other way round, startTerminal() is how the session start (server.mjs) opens a terminal on a conversation: never
// a second process on it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAutoSwitch, limitedProfiles } from '../autoswitch.mjs';
import { EFFORTS, MODELS, PERMISSION_MODES } from '../config.mjs';
import { stateDir, tilde } from '../paths.mjs';
import { assertServes, listProfiles, publicProfile, readProfile, servesTools } from '../profiles.mjs';
import { isSessionId, sessionsIn } from '../sessions.mjs';
import { insideRoots, resolveRoots } from '../server/folders.mjs';
import { DEFAULT_UPLOADS_DIR, DEFAULT_UPLOAD_MAX_MB, saveUpload, uploadsDirName } from '../server/uploads.mjs';
import * as v from '../server/validate.mjs';
import { Chat } from './chat.mjs';
import { askNote, previewText } from './events.mjs';
import { gitBranch, readAttachments } from './files.mjs';
import { folderMemory } from './folders.mjs';
import { handoffRoutes, terminals } from './handoff.mjs';
import { liveRoutes, stateOf } from './live.mjs';
import { limitMark } from './providerlimit.mjs';

const OPEN_MAX = 50;
const WAIT_MAX_S = 25; // below the relay's 30 s idle limit, so a chat of another computer can wait too
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const AUTO = { name: 'auto', label: 'Auto', kind: 'auto' };

/** The name a chat has among the sessions (Home, notifications). ":" is never in a terminal's name. */
export const cardName = (id) => `chat:${id}`;

/** o: { command, resolveEnv, spawnImpl, idleMs, stopGraceMs, owedMs } (tests), file (where the open chats are kept) */
export function chatFeature(ctx, o = {}) {
  const { HttpError } = ctx;
  const bad = (msg) => new HttpError(400, msg);
  const cfg = () => ctx.config();
  const roots = () => resolveRoots(cfg().server.roots);
  const file = () => o.file || path.join(stateDir(), 'chats.json');
  // The settings each folder's chat ran with last: one tap on a project opens a chat with them.
  const memory = folderMemory(() => o.foldersFile || path.join(path.dirname(file()), 'chat-folders.json'));
  const remember = (c) => memory.remember(c.record());
  const chats = new Map();
  const shut = new Map(); // the chats closed since the start (the last 100): id → { cwd, conversationId, title }
  let loaded = false;

  // ---------- the list of open chats ----------
  function make(rec) {
    const c = new Chat({ ...rec, turnsDir: path.join(path.dirname(file()), 'chat-turns'), command: o.command, resolveEnv: o.resolveEnv, spawnImpl: o.spawnImpl, idleMs: o.idleMs, stopGraceMs: o.stopGraceMs, owedMs: o.owedMs });
    c.setMaxListeners(200); // one per page that waits for news
    c.on('status', () => ctx.poke?.()); // Home and the notifications see a new state at once
    c.on('turn', save);
    c.on('turn', (ev) => limitMark(c, ev, { auto: AUTO.name, poke: () => ctx.poke?.() }));
    c.on('record', save); // "allow in this chat" was given: it is kept with the chat
    c.on('closed', () => {
      // Its page, opened later, still names it and can continue its conversation (chatOr404).
      shut.delete(c.id);
      shut.set(c.id, { cwd: c.cwd, conversationId: c.conversationId, title: c.title || null });
      if (shut.size > 100) shut.delete(shut.keys().next().value);
    });
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
    if (!c) {
      const e = new HttpError(404, 'this chat is not open (it was closed or opened in a terminal)');
      if (shut.has(id)) e.details = { closed: shut.get(id) }; // the page offers to continue it in a new chat
      throw e;
    }
    return c;
  }

  // ---------- providers, models ----------
  const autoOn = () => getAutoSwitch().enabled === true;
  // The chat runs Claude Code: a provider that does not serve it (an OpenAI key, a Codex sign-in) is not one to offer.
  const profileOk = (name) => {
    if (name === AUTO.name) return autoOn();
    const p = readProfile(name);
    if (p && !servesTools(p).includes('claude')) assertServes(p, 'claude'); // says why, as a 400
    return !!p;
  };
  // The same, without the sentence: may a chat fall back on this provider (the folder's last one)?
  const servesChat = (name) => (name === AUTO.name ? autoOn() : servesTools(readProfile(name)).includes('claude'));
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

  // One place at a time (handoff.mjs): the open chat whose process runs a conversation (or gets ready to) is one.
  const chatOf = (id) => ([...chats.values()].find((c) => c.conversationId === id && (c.session || c.starting || c.busy())) || {}).id || null;
  const { terminalOf, inTerminal, claim, serial, forget } = terminals(ctx, { chatOf });
  /**
   * A message that starts a turn in chat `c` (`fn` sends it): never while a terminal runs the conversation, also while
   * this chat's process waits idle (a terminal may have resumed the conversation meanwhile).
   */
  async function sendOne(c, fn) {
    const r = await claim(c.conversationId, fn, { self: c.id });
    if (r.terminal) {
      if (!c.busy()) c.stop();
      throw inTerminal(r.terminal);
    }
    if (r.chat) throw new HttpError(409, 'another chat runs this conversation right now');
    return r.started;
  }

  // ---------- views ----------
  function card(c) {
    const status = c.status();
    const ask = status === 'attention' ? [...c.pending.values()][0] : null;
    return {
      name: cardName(c.id), kind: 'chat', chatId: c.id, display: c.title || 'New chat', title: c.title,
      cwd: c.cwd, short: tilde(c.cwd), profile: profileView(c.profile), status, statusAt: c.statusAt, activity: c.statusAt,
      byTia: c.byTia, // Tia started this chat: her rules let her answer its OKs (src/assistant/core.mjs facts)
      created: c.openedAt, attached: false, panes: 0, sessionId: c.conversationId, canSwitch: false,
      lastMessage: previewText(c.lastText), // plain words: a card shows no Markdown marks
      running: !!c.session, // its process runs on the provider now (idle care keeps that provider's gateway up)
      note: ask ? askNote(ask, c.cwd) : '',
      // The OK it waits for, so a card can answer it (Allow, Allow in this chat, Do not allow); a question or a plan
      // is answered in the chat itself. `subject` is what it is really about (the whole command or path; `cut` when it
      // was too long to carry whole), `owner` says the chat keeps it for the owner (his settings, a hook or a safety
      // check ask him) and `known` that it is a call Tia's rules can judge at all (claude-parse.mjs askSubject): her
      // rules read all four.
      ask: ask ? {
        request: ask.request, type: ask.type, tool: ask.tool, subject: ask.subject || '', cut: !!ask.subjectCut, owner: !!ask.owner, known: ask.known === true,
        canAlways: !!ask.grant, always: ask.grant ? (ask.grant.edits ? 'edits' : 'rule') : null, alwaysText: ask.grant && !ask.grant.edits ? ask.grant.text : '',
      } : null,
      // The turn is over but subagents, shells or a workflow still run (Home: "Working in the background").
      background: status === 'working' && !c.turn,
      limit: c.limit ? { text: c.limit.text } : null,
      ...(c.limit ? { limitAt: c.limit.at || null } : {}), // since when: the page compares it with the provider's accountAt
    };
  }
  /** What the page shows beside the chat's state. */
  const about = (c) => ({ cwd: c.cwd, short: tilde(c.cwd), conversationId: c.conversationId, branch: gitBranch(c.cwd), profile: profileView(c.profile), choices: { models: models(), efforts: EFFORTS, modes: PERMISSION_MODES } });
  /** The terminal that runs the chat's conversation, as the page names it ({ name }), or null. */
  const terminalView = async (c) => (c.session && c.busy() ? null : await terminalOf(c.conversationId).then((t) => (t ? { name: t.name } : null)));
  async function view(c, { from, epoch }) {
    const { reset, events } = c.window(from, epoch);
    return {
      id: c.id, epoch: c.epoch, reset, events, next: c.next, first: events.length ? events[0].i : c.next, older: (events.length ? events[0].i : c.next) > c.base,
      ...stateOf(c), ...about(c), terminal: await terminalView(c),
    };
  }
  /** Where the files of a chat's messages are uploaded (inside its folder). */
  function uploadsOf(c) {
    const dirName = uploadsDirName(cfg().server.uploadsDir || DEFAULT_UPLOADS_DIR);
    if (!dirName) throw new HttpError(500, 'server.uploadsDir must be a relative folder name');
    const cwd = insideRoots(c.cwd, roots());
    if (!cwd) throw bad('this chat runs outside the allowed folders');
    return { cwd, dirName, dir: path.join(cwd, dirName) };
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
      const look = setInterval(() => !c.session && c.refresh(), 1500);
      c.on('change', check);
      c.on('status', check);
      res.on?.('close', done);
    });
  }

  /**
   * Open a chat (POST /api/chats; the schedules too). b: { dir, profile?, model?, effort?, permissionMode?, ultracode?,
   * sessionId?, text?, defaults?, byTia? }. What is left out: as the last chat in that folder ran, else the provider
   * recommended now and Settings. defaults: true (Tia, a schedule) takes Settings → New-session defaults and not the
   * folder's last chat, as a terminal session they start does: a mode the owner chose for himself (bypass) is not
   * carried into a chat nobody watches. A conversation an open chat already runs gives that chat, as it is.
   * byTia: true (Tia's start_chat) marks the chat this call creates as hers, and no other: not an open chat it gives
   * back, nor a later chat on the same conversation (the mark goes with this chat when it closes for any reason). A
   * message sent into it by anyone but her (the page, a schedule) takes the mark off for good: from then on the chat
   * carries the owner's own instructions. An answer, a Stop or a settings change does not (he only steers her work).
   * → { id, sent, existing?, permissionMode? } (sent: false when the first message was not sent because a terminal or
   * an open chat runs the conversation; existing: true with that open chat's mode)
   */
  async function openChat(b) {
    load();
    const dir = insideRoots(v.absPath(b.dir), roots());
    if (!dir) throw bad('choose a folder inside the allowed roots');
    const owners = b.defaults !== true;
    const last = (owners && memory.last(dir)) || {};
    let profile = b.profile;
    if (profile === undefined || profile === null || profile === '') {
      // As the last chat here ran, while that provider is still there; else the one recommended now.
      // A provider at its limit is not picked by itself (the owner may still choose it).
      profile = last.profile && servesChat(last.profile) && !limitedProfiles()[last.profile] ? last.profile : (await ctx.state()).recommended;
      if (!profile) throw bad('there is no provider yet: add one under Providers first');
    }
    if (typeof profile !== 'string' || !profileOk(profile)) throw bad('there is no such provider');
    if (b.ultracode !== undefined && b.ultracode !== null && typeof b.ultracode !== 'boolean') throw bad('ultracode is true or false');
    if (b.byTia !== undefined && typeof b.byTia !== 'boolean') throw bad('byTia is true or false');
    const d = cfg().sessionDefaults || {};
    // Left out: as the last chat in this folder; never chosen there: Settings → New-session defaults.
    const kept = (k, chosen, fallback) => (chosen !== undefined ? chosen : k in last ? last[k] : fallback);
    const model = kept('model', pick(b.model, models(), 'model'), d.model || null);
    const effort = kept('effort', pick(b.effort, EFFORTS, 'effort'), d.effort || null);
    const permissionMode = kept('permissionMode', pick(b.permissionMode, PERMISSION_MODES, 'permission mode'), d.permissionMode || null);
    const ultracode = kept('ultracode', b.ultracode ?? undefined, false) === true;
    let id = crypto.randomUUID();
    let conversationId = null;
    if (b.sessionId !== undefined && b.sessionId !== null) {
      conversationId = v.sessionId(b.sessionId);
      if (!conversationId || !sessionsIn(dir).some((s) => s.id === conversationId)) throw bad('that conversation is not in this folder');
      const open = openChatOf(conversationId);
      if (open) {
        // That chat is someone's already (the owner's, as a rule): it keeps its own settings, and `existing` says so,
        // so a caller does not take it for a chat it started (Tia's rules let her answer OKs only in her own chats).
        const mode = chats.get(open).permissionMode || null;
        if (b.text === undefined || b.text === null) return { id: open, existing: true, permissionMode: mode };
        return { id: open, existing: true, permissionMode: mode, sent: false, why: 'this conversation is already open in a chat; write to that chat' };
      }
      id = freeId(conversationId);
    }
    let text = null;
    if (b.text !== undefined && b.text !== null) {
      text = v.message(b.text);
      if (!text) throw bad(`the message must be 1 to ${v.MESSAGE_MAX} bytes`);
    }
    if (chats.size >= OPEN_MAX) {
      const old = [...chats.values()].filter((c) => !c.session).sort((a, b2) => a.statusAt - b2.statusAt)[0];
      if (!old) throw new HttpError(409, `${OPEN_MAX} chats are open; close one first`);
      chats.delete(old.id);
      old.close();
    }
    const c = make({
      id, ...(conversationId && conversationId !== id ? { conversationId } : {}), cwd: dir, profile,
      // a model the computer stopped offering is not forced on a new chat
      model: model && models().includes(model) ? model : null, effort: EFFORTS.includes(effort) ? effort : null,
      permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : null, ultracode, byTia: b.byTia === true,
    });
    save();
    if (owners) remember(c); // the folder's last chat is the owner's own choice, not Tia's or a schedule's
    if (!text) return { id };
    try {
      await sendOne(c, () => c.send(text));
    } catch (e) {
      if (e.code === 'in-terminal') return { id, sent: false, why: 'a terminal session runs this conversation' };
      throw e;
    }
    return { id, sent: true };
  }

  /** A message to an open chat from the dashboard itself (a schedule): queued by the chat while Claude works. */
  async function sendTo(id, text) {
    const c = chatOr404(id);
    const t = v.message(text);
    if (!t) throw bad(`the message must be 1 to ${v.MESSAGE_MAX} bytes`);
    const r = c.busy() ? await c.send(t) : await sendOne(c, () => c.send(t));
    c.byTia = false; // the owner's schedule writes in it: a chat with his instructions, not Tia's any more
    save();
    return { id: r.id, queued: r.queued };
  }

  // ---------- routes ----------
  const routes = [
    ['GET', /^\/api\/chats$/, async () => {
      load();
      return { chats: [...chats.values()].map(card) };
    }],
    ['POST', /^\/api\/chats$/, async (req) => openChat(await ctx.readJson(req))],
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
      let text = v.message(b.text);
      if (!text) throw bad(`the message must be 1 to ${v.MESSAGE_MAX} bytes`);
      if (b.byTia !== undefined && typeof b.byTia !== 'boolean') throw bad('byTia is true or false');
      let files = { images: [], mentions: [], attachments: [] };
      if (b.attachments !== undefined && b.attachments !== null) {
        const u = uploadsOf(c);
        files = readAttachments(b.attachments, { cwd: u.cwd, uploadsDir: u.dir });
        if (files.mentions.length) text = `${text}\n\n${files.mentions.join(' ')}`;
      }
      // A turn that runs queues it; else it starts one, never while a terminal runs the conversation (one at a time).
      const send = () => c.send(text, { images: files.images, attachments: files.attachments });
      const r = c.busy() ? await send() : await sendOne(c, send);
      if (b.byTia !== true) c.byTia = false; // a message of the owner's (not Tia's own send_to_chat): his chat from now on
      save();
      return { ok: true, id: r.id, queued: r.queued };
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
      const mode = b.mode === undefined || b.mode === null ? null : pick(b.mode, PERMISSION_MODES, 'permission mode');
      c.answer(b.request, { allow: b.allow, always: b.always === true, answers, mode, message });
      if (mode) {
        save();
        remember(c);
      }
      return { ok: true };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/stop$`), async (req, m) => {
      await ctx.readJson(req);
      const c = chatOr404(m[1]);
      // What is queued is taken back first (it goes back into the box): after Stop nothing starts by itself.
      const back = c.turn ? await c.takeBack() : [];
      return { stopped: c.interrupt(), back };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/provider$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (typeof b.profile !== 'string' || !profileOk(b.profile)) throw bad('there is no such provider');
      c.setProfile(b.profile, profileView(b.profile).label); // the owner's name for it in the timeline, not its id
      c.emit('state'); // a page that streams shows the new provider
      save();
      remember(c);
      return { profile: profileView(c.profile) };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/upload$`), async (req, m) => {
      const c = chatOr404(m[1]);
      const s = cfg().server;
      const { cwd, dirName } = uploadsOf(c);
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
      chats.delete(c.id);
      save();
      await c.close();
      ctx.poke?.();
      return { ok: true };
    }],
  ];

  // The open chat that runs conversation `id` now, or null. By the conversation, never by the chat's own id: a chat
  // opened on X keeps X as its id after a clear or a rewind gave it conversation Y, and X is then free to continue.
  const openChatOf = (id) => ([...chats.values()].find((c) => c.conversationId === id) || {}).id || null;
  // A chat's own id for conversation `id`: the same where it is free (its link reads as the conversation), else new.
  const freeId = (id) => (chats.has(id) ? crypto.randomUUID() : id);
  routes.push(...handoffRoutes(ctx, { chats, make, save, load, chatOr404, memory, models, openChatOf, freeId, terminalOf, claim, serial, forget, auto: { name: AUTO.name, on: autoOn } }));
  const live = liveRoutes(ctx, { chatOr404, save, remember, bad, models, folderOf: (c) => uploadsOf(c).cwd, uploadsDir: (c) => uploadsOf(c).dir, openChatOf, about, terminalOf: terminalView });
  routes.push(...live.routes);

  return {
    name: 'chat',
    routes,
    handle: live.handle, // the event stream (server-sent events)
    open: openChat, // a chat for the dashboard itself (the schedules)
    send: sendTo,
    /** The open chats as session cards (server.mjs adds them to the sessions: Home, notifications). */
    cards() {
      load();
      return [...chats.values()].map(card);
    },
    /** True when a chat runs conversation `id` right now: its process, or one getting ready for a message. */
    running(id) {
      load();
      return !!chatOf(id);
    },
    /**
     * Start a terminal on conversation `id` (server.mjs: New session, Tia) with `start()` → { name }, unless something
     * runs it already: → { name } of the new one, or { existing: { terminal: { name } } | { chat } } (handoff.mjs claim).
     */
    async startTerminal(id, start, tool = 'claude') {
      load();
      const r = await claim(id, start, { tool });
      return r.started ? r.started : { existing: r.terminal ? { terminal: { name: r.terminal.name } } : { chat: r.chat } };
    },
    async close() {
      await Promise.all([...chats.values()].map((c) => c.close(3000)));
    },
  };
}
