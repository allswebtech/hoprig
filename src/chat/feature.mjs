// Coding without the terminal: the chat view of a Claude Code conversation (chat.mjs), as one feature of the
// dashboard (server.mjs features list). The open chats are kept in <stateDir>/chats.json, so they are still listed
// after a restart (their process starts again with the next message).
//
//   GET  /api/chats                           the open chats, as cards
//   GET  /api/chats/tools                     the coding tools a chat can run here: [{ id, name }] (on and installed)
//   POST /api/chats                           { dir, tool?, profile?, model?, effort?, permissionMode?, ultracode?, lead?, sessionId?, text? }
//                                             → { id }   what is left out: as the last chat in that folder ran
//                                             (folders.mjs), else the folder's default provider for that coding tool
//                                             and Settings. tool: the coding tool (absent: Claude Code); the chat
//                                             stays in it (tools.mjs)
//   GET  /api/chats/<id>?from=N&epoch=E&wait=S   the chat: events from N (wait up to S seconds for news)
//   GET  /api/chats/<id>/older?before=N       earlier events
//   POST /api/chats/<id>/send                 { text, attachments?: [{ path }] } → { id, queued }   (while a turn
//                                             runs the message is queued; attachments: what /upload returned)
//   POST /api/chats/<id>/fork                 a new chat that goes on from a copy of this conversation → { id }
//   POST /api/chats/<id>/answer               { request, allow, always?, answers?, mode?, message? }   a tool use's OK
//                                             (mode: a plan approved, the permission mode to go on in)
//   POST /api/chats/<id>/stop                 end the turn (background tasks go on; see live.mjs for one task)
//                                             → { stopped, back: [{ text, files }] }  (the queued messages, taken back)
//   POST /api/chats/<id>/provider             { profile }   continue on another provider
//   POST /api/chats/<id>/upload               raw bytes, X-File-Name → { path }   (the uploads folder, as for sessions)
//   POST /api/chats/<id>/close               Archive: it leaves the list; its conversation goes to archived.mjs's list
//   GET  /api/chats/archived                  the archived sessions, to continue one (archived.mjs)
// and the routes of live.mjs (the event stream, mode, settings, queue, task stop, rewind, files, commands, usage) and
// of handoff.mjs (from a terminal session to a chat and back: one conversation never runs in two places at once).
// The other way round, startTerminal() is how the session start (server.mjs) opens a terminal on a conversation: never
// a second process on it.
import { heldError, heldUntil } from '../operator/decide-store.mjs';
import { ledger as keptLedger } from '../operator/money.mjs';
import { paidName, partShare } from '../assistant/spend.mjs';
import { readSettings } from '../automation/settings.mjs';
import { billedLogin } from '../routerstate.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handsOffOffered, hoprigVersion } from '../handsoff.mjs';
import { chatSwitch } from './handsoff.mjs';
import { getAutoSwitch } from '../autoswitch.mjs';
import { rememberFolderProvider } from '../defaultprovider.mjs';
import { stateDir, tilde } from '../paths.mjs';
import { archivedSessions } from './archived.mjs';
import { cleanOthers, ticksOf } from '../models/others.mjs';
import { deleteRoutes } from './deletes.mjs';
import { listProfiles, publicProfile, readProfile } from '../profiles.mjs';
import { removeSettingsLeftovers } from '../runs.mjs';
import { isSessionId } from '../sessions.mjs';
import { insideRoots, resolveRoots } from '../server/folders.mjs';
import { DEFAULT_UPLOADS_DIR, DEFAULT_UPLOAD_MAX_MB, saveUpload, uploadsDirName } from '../server/uploads.mjs';
import { fromHerDoor } from '../server/herdoor.mjs';
import * as v from '../server/validate.mjs';
import { Chat } from './chat.mjs';
import { engineOf } from './engines/index.mjs';
import { askNote, previewText } from './events.mjs';
import { readTurns } from './turns.mjs';
import { gitBranch, readAttachments } from './files.mjs';
import { folderMemory } from './folders.mjs';
import { handoffRoutes, terminals } from './handoff.mjs';
import { liveRoutes, stateOf } from './live.mjs';
import { limitMark } from './providerlimit.mjs';
import { readTitles } from '../titles.mjs';
import { BYPASS, bypassAllowed, gateModes, ROOT_BYPASS_LINE, runsAsRoot } from '../bypassgate.mjs';
import { assertHerToolBound } from '../codetools/start.mjs';
import { chatTool, chatToolList, choicesOf, conversationIdOk, modeFor, modelOk, modelRefusal, providerOk, serves, toolOffWords } from './tools.mjs';

const OPEN_MAX = 50;
const WAIT_MAX_S = 25; // below the relay's 30 s idle limit, so a chat of another computer can wait too
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const AUTO = { name: 'auto', label: 'Auto', kind: 'auto' };

/** The coding tool the last chat in a folder ran (folders.mjs), else Claude Code. */
const lastTool = (last) => (last && typeof last.engine === 'string' ? last.engine : 'claude');

/** The name a chat has among the sessions (Home, notifications). ":" is never in a terminal's name. */
export const cardName = (id) => `chat:${id}`;

/** The question chat `c` waits on, for the Operator's decisions: its exact card, the request, Hands-off's switch for
 * the chat, and `only` (no other ask waits beside it); null when it waits on none. */
export function chatQuestion(c) {
  const ask = [...c.pending.values()].find((e) => e.type === 'question');
  return ask ? { request: ask.request, card: ask.card || null, handsOff: chatSwitch(c), only: c.pending.size === 1 } : null;
}

/** o: { command, resolveEnv, spawnImpl, engineOpts, idleMs, stopGraceMs, owedMs } (tests), file (where the open chats are kept) */
export function chatFeature(ctx, o = {}) {
  // Hoprig runs as root here: Claude Code refuses bypass permissions mode, and the flag that allows it, for root.
  const asRoot = ctx.root !== undefined ? ctx.root === true : runsAsRoot();
  const { HttpError } = ctx;
  const bad = (msg) => new HttpError(400, msg);
  const cfg = () => ctx.config();
  const roots = () => resolveRoots(cfg().server.roots);
  const file = () => o.file || path.join(stateDir(), 'chats.json');
  // "This is Tia's" (byTia) counts only from her own door: the server's in-process call, or another computer's
  // dashboard relaying hers (its token and the mark its relay sets for its own requests, never for a browser's). A
  // page that says it is ignored: a chat it opens or writes in is the owner's.
  const fromTia = (req) => fromHerDoor(ctx, req);
  // The settings each folder's chat ran with last: one tap on a project opens a chat with them.
  const memory = folderMemory(() => o.foldersFile || path.join(path.dirname(file()), 'chat-folders.json'));
  // Another coding tool's provider is also kept as that tool's own in the folder (src/defaultprovider.mjs): the next
  // chat of the tool there starts on it even after a chat of another tool (Claude Code's is the launcher's to keep).
  // Only the owner's own choice is kept: not a change Tia makes (her door), nor anything of a chat that is hers (she
  // moves it to another provider after a limit; the owner's next chat in the folder must not start there).
  const remember = (c, req) => {
    if (c.byTia || (req && fromTia(req))) return;
    memory.remember(c.record());
    if (c.engine.id !== 'claude') rememberFolderProvider(c.cwd, c.profile, c.engine.id);
  };
  const chats = new Map();
  let partsConfig = null; // "Use other providers": the lead's one tool at its start (src/models/partdoor.mjs)
  let handedOf = null; // and the parts a lead handed to other providers (for who did what)
  const shut = new Map(); // the chats closed since the start (the last 100): id → { cwd, conversationId, title, tool, terminal? }
  const archived = archivedSessions({ file: () => path.join(path.dirname(file()), 'chat-archived.json'), openChatOf: (id) => openChatOf(id) });
  let loaded = false;
  let stopPurge = () => {};

  // Tia's one ledger of paid use (src/assistant/spend.mjs, the file in this state folder); `o.spend`: tests only.
  const spendLedger = () => o.spend || keptLedger();
  /**
   * A part's chat on provider `name` is billed by use, by the part door's rule for a part of Tia's (others.mjs
   * partGate): an API provider, one paid per use, a sign-in on a Console account; Auto when its order holds such a one.
   */
  const billedByUse = (name) => {
    if (name === AUTO.name) return paidName(AUTO.name, { profiles: listProfiles().map((p) => ({ ...publicProfile(p), paid: p.paid === true || billedLogin(p) })), autoSwitch: getAutoSwitch() });
    const p = readProfile(name);
    return !!p && (p.kind === 'api' || p.paid === true || billedLogin(p));
  };
  /**
   * Chat `c`'s process ended (or starts again): what it cost since its first hold of the day is measured now from its
   * own figure (costTotal, as measureChats does at Tia's ticks, which may not have come since its last turn), and then
   * its budget holds are settled, so it counts what it cost, never less. `cut`: it ended inside a turn that reported
   * no cost: the rest of its budget counts (spend.settleParts). `unseen`: a hold its process end never settled (the
   * dashboard stopped while it ran): the rest counts too, with that reason of its own. → the ledger
   */
  function settleChat(c, { cut = false, unseen = false } = {}) {
    const key = `this|chat:${c.id}`;
    const l = spendLedger();
    const base = l.bound().get(key);
    if (base !== undefined && Number.isFinite(c.costTotal) && c.costTotal >= base) l.measure(key, c.costTotal - base, false);
    l.settleParts(key, { cut, unseen });
    return l;
  }
  /**
   * The budget of a part's chat (Chat paidBudget; Claude Code's --max-budget-usd), asked at each start of its process.
   * Its first start: what its opener gave (the part door took that hold and bound it to this chat). Every later one
   * (after its idle stop, a restart for a setting, a restart of the dashboard): an earlier hold its process end did not
   * settle (a dashboard killed while it ran) is settled as cut (what it cost counts, and the rest of its budget, which
   * bounds a turn whose cost was never reported), and a new share of what is left is held for it as the door does (spend.partShare, the limit
   * and the parts allowed at once as they are now), so the budgets of the parts that run at one moment never sum past
   * what was left. On a provider not billed by use any more (moved to a subscription): no budget (null). Refused (no
   * limit set any more, or a share under a cent): the start does not happen at all (run.mjs asks this before the coding
   * tool is started, which checks its budget only between steps, so even a cent could pay for one whole request). It
   * throws the ledger's sentence (what holds the limit, and what he can do); the send ends it as a start that could not
   * happen (chat.mjs send: "could not start"), and nothing is held for it.
   */
  function partBudget(first, chat) {
    let given = Number.isFinite(first) && first > 0 ? first : null;
    return () => {
      if (given) {
        const v = given;
        given = null;
        return v;
      }
      const c = chat();
      const key = `this|chat:${c.id}`;
      // A hold still open here was not settled when its process ended: that end was never seen (the dashboard stopped
      // while it ran), so the cost of a turn it may have run is not known: the rest of its budget counts, said as such.
      const l = settleChat(c, { unseen: true });
      if (!billedByUse(c.profile)) return null;
      const conf = cfg();
      const cap = (conf.assistant || {}).dailyCapUsd;
      const atOnce = readSettings(conf.automation).schedules.atOnce;
      const hold = `part-${crypto.randomBytes(6).toString('hex')}`;
      const why = l.take(cap, { id: hold, amount: (t) => partShare(cap, t, atOnce) });
      if (!why) {
        l.bind(hold, key, Number.isFinite(c.costTotal) && c.costTotal > 0 ? c.costTotal : 0);
        return l.heldFor(hold);
      }
      throw Object.assign(new Error(why), { status: 409, code: 'start' });
    };
  }

  // ---------- the list of open chats ----------
  function make(rec) {
    // maxBudgetUsd (openChat's `run`, never the route's body): reaches the coding tool's start with its other options.
    const paid = rec.paidBudget === true || !!rec.maxBudgetUsd;
    const engineOpts = paid ? { ...(o.engineOpts || {}), maxBudgetUsd: partBudget(rec.maxBudgetUsd, () => c) } : o.engineOpts;
    // Its process ended (hear.mjs exited, run.mjs stop): its budget hold is settled, so what it cost counts, no more.
    const ended = paid ? { processEnded: ({ cut = false } = {}) => settleChat(c, { cut }) } : {};
    const c = new Chat({ ...rec, ...ended, handsOffConfig: () => cfg(), allowBypass: () => bypassAllowed(cfg(), asRoot), titles: () => cfg().sessionTitles !== false, turnsDir: path.join(path.dirname(file()), 'chat-turns'), command: o.command, resolveEnv: o.resolveEnv, spawnImpl: o.spawnImpl, engineOpts, idleMs: o.idleMs, stopGraceMs: o.stopGraceMs, owedMs: o.owedMs , partsConfig: (x) => (partsConfig ? partsConfig(x) : null) });
    c.setMaxListeners(200); // one per page that waits for news
    c.on('status', () => ctx.poke?.()); // Home and the notifications see a new state at once
    c.on('turn', save);
    c.on('turn', (ev) => limitMark(c, ev, { auto: AUTO.name, poke: () => ctx.poke?.() }));
    c.on('record', save); // "allow in this chat" was given: it is kept with the chat
    c.on('closed', () => {
      // Its page, opened later, still names it and can continue its conversation (chatOr404): only one that has a
      // conversation to continue (a chat closed before its first message has none on disk).
      shut.delete(c.id);
      // A tool whose conversations are its server's (OpenCode: no file here) has one once it named it (ownIds).
      const file = c.file();
      const has = file ? fs.existsSync(file) : conversationIdOk(c.engine.id, c.conversationId);
      shut.set(c.id, { cwd: c.cwd, conversationId: has ? c.conversationId : null, title: c.title || null, tool: c.engine.id });
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
    let marks = false;
    for (const r of Array.isArray(list) ? list : []) {
      if (r && isSessionId(r.id) && typeof r.cwd === 'string' && path.isAbsolute(r.cwd) && typeof r.profile === 'string') {
        // restored: Tia's mark is checked against what the record knew of the conversation (chat.mjs restoredMark).
        const c = make({ ...r, restored: true });
        if (r.byTia === true && !c.byTia && !c.restoredMark) marks = true;
      }
    }
    if (marks) save(); // a mark that went (the conversation went on while the dashboard was down) goes on disk too
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
      const e = new HttpError(404, 'this chat is not open (it was archived or opened in a terminal)');
      if (shut.has(id)) e.details = { closed: shut.get(id) }; // the page offers to continue it in a new chat
      throw e;
    }
    return c;
  }

  // ---------- providers, models ----------
  const autoOn = () => getAutoSwitch().enabled === true;
  // A chat runs on a provider that serves its coding tool (tools.mjs): one that does not says why, as a 400.
  const profileOk = (name, tool) => providerOk(name, tool);
  function profileView(name) {
    if (name === AUTO.name) return AUTO;
    const p = listProfiles().find((x) => x.name === name);
    // ownFolder (publicProfile): the page's Sign in again signs in only the default folder, so it is not offered then.
    return p ? publicProfile(p) : { name, label: name, kind: 'unknown' };
  }
  // The saved values a check keeps accepting (the default of Settings → New-session defaults); the provider's own list
  // comes from src/models/catalog.mjs (chat/tools.mjs choicesOf).
  const models = () => {
    const saved = (cfg().sessionDefaults || {}).model;
    return saved ? [saved] : [];
  };
  const pick = (val, list, what) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    if (!list.includes(val)) throw bad(`the ${what} must be one of: ${list.join(', ')}`);
    return val;
  };
  /** The chips' choices of chat `c` (its coding tool's, on its provider); a list that comes later is sent then. */
  // Bypass permissions only where the owner allowed it (bypassgate.mjs): not in a chat's modes, its menu or Shift+Tab.
  const gated = (ch) => ({ ...ch, modes: gateModes(ch.modes, cfg(), asRoot) });
  // The chat's own saved model counts as saved too: shown (marked when its provider's list left it), never replaced.
  const choices = (c) => gated(choicesOf(c.engine.id, c.profile, () => [...models(), ...(c.model ? [c.model] : [])], () => c.emit('state')));
  const pickModel = (val, tool, ch) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    if (!modelOk(tool, val, ch)) throw bad(modelRefusal(val, ch));
    return val;
  };

  // One place at a time (handoff.mjs): the open chat whose process runs a conversation (or gets ready to) is one.
  const chatOf = (id, tool = 'claude') => ([...chats.values()].find((c) => c.conversationId === id && c.engine.id === tool && (c.session || c.starting || c.busy())) || {}).id || null;
  const { terminalOf, inTerminal, claim, serial, forget } = terminals(ctx, { chatOf });
  /**
   * A message that starts a turn in chat `c` (`fn` sends it): never while a terminal runs the conversation, also while
   * this chat's process waits idle (a terminal may have resumed the conversation meanwhile).
   */
  async function sendOne(c, fn) {
    const r = await claim(c.conversationId, fn, { tool: c.engine.id, self: c.id });
    if (r.terminal) {
      if (!c.busy()) c.stop();
      throw inTerminal(r.terminal);
    }
    if (r.chat) throw Object.assign(new HttpError(409, 'another chat runs this conversation right now'), { code: 'in-chat' });
    return r.started;
  }
  /**
   * Every message into an open chat (the page, Tia's send_to_chat, a schedule): a turn that runs queues it; else it
   * starts one through the claim, by the chat's coding tool, never while a terminal runs the conversation. Only Tia's
   * own message (`hers`: from her door, src/server/server.mjs ctx.caller) keeps her mark on a chat she started; anyone
   * else's makes it the owner's chat for good.
   */
  async function deliver(c, text, opts = {}, hers = false) {
    const send = () => c.send(text, opts);
    const r = c.busy() ? await send() : await sendOne(c, send);
    if (!hers && c.dropMark()) save();
    return r;
  }
  /**
   * A chat of a coding tool that was turned off since: it runs nothing any more. It can still be read (from the tool's
   * server where that runs already) and closed, and its page says why it runs nothing (about().toolOff).
   */
  const toolOff = (c) => toolOffWords(c.engine.id, cfg());
  const toolStillOn = (c) => {
    const why = toolOff(c);
    // With the code of the place its sentence names (web/errorways.js), so the page draws the button to Coding tools.
    if (why) throw Object.assign(new HttpError(409, why), { details: { code: 'tool-off' } });
  };

  // ---------- views ----------
  function card(c) {
    const status = c.status();
    const ask = status === 'attention' ? [...c.pending.values()][0] : null;
    return {
      name: cardName(c.id), kind: 'chat', chatId: c.id, display: c.currentTitle() || 'New session', title: c.title,
      cwd: c.cwd, short: tilde(c.cwd), profile: profileView(c.profile), status, statusAt: c.statusAt, activity: c.statusAt,
      byTia: c.byTia, // Tia started this chat: her rules let her answer its OKs (src/assistant/core.mjs facts)
      created: c.openedAt, attached: false, panes: 0, sessionId: c.conversationId, canSwitch: false,
      lastMessage: previewText(c.lastText), // plain words: a card shows no Markdown marks
      running: !!c.session, // its process runs on the provider now (idle care keeps that provider's gateway up)
      costTotal: Number.isFinite(c.costTotal) ? c.costTotal : null, // what its coding tool reported it has cost so far (Tia's daily cap reads it)
      note: ask ? askNote(ask, c.cwd, c.engine.id === 'claude' ? 'Claude' : c.engine.label) : '',
      tool: c.engine.id, // the coding tool (Home shows its chip when it is not Claude Code)
      ...(c.extras && c.extras.length ? { extras: [...c.extras] } : c.withs.length ? { extras: [...c.withs] } : {}), // its extra folders, by map name
      // The OK it waits for, so a card can answer it (Allow, Allow in this chat, Do not allow); a question or a plan
      // is answered in the chat itself. `subject` is what it is really about (the whole command or path; `cut` when it
      // was too long to carry whole), `owner` says the chat keeps it for the owner (his settings, a hook or a safety
      // check ask him) and `known` that it is a call Tia's rules can judge at all (claude-parse.mjs askSubject), with
      // `judged`, its strings by their keys, for her allow-list: her rules read them all.
      ask: ask ? {
        request: ask.request, type: ask.type, tool: ask.tool, subject: ask.subject || '', cut: !!ask.subjectCut, owner: !!ask.owner, known: ask.known === true,
        judged: ask.known === true && ask.judged ? ask.judged : null,
        canAlways: !!ask.grant, always: ask.grant ? (ask.grant.edits ? 'edits' : 'rule') : null, alwaysText: ask.grant && !ask.grant.edits ? ask.grant.text : '',
        canProject: !!(ask.grant && ask.grant.project),
      } : null,
      // The turn is over but subagents, shells or a workflow still run (Home: "Working in the background").
      background: status === 'working' && !c.turn,
      limit: c.limit ? { text: c.limit.text } : null,
      ...(c.limit ? { limitAt: c.limit.at || null } : {}), // since when: the page compares it with the provider's accountAt
    };
  }
  /** What the page shows beside the chat's state. */
  const about = (c) => ({ cwd: c.cwd, short: tilde(c.cwd), conversationId: c.conversationId, branch: gitBranch(c.cwd), profile: profileView(c.profile), choices: choices(c), toolOff: toolOff(c) });
  /** The terminal that runs the chat's conversation, as the page names it ({ name }), or null. */
  const terminalView = async (c) => (c.session && c.busy() ? null : await terminalOf(c.conversationId, c.engine.id).then((t) => (t ? { name: t.name } : null)));
  async function view(c, { from, epoch }) {
    const { reset, events } = c.window(from, epoch);
    return {
      id: c.id, epoch: c.epoch, reset, events, next: c.next, first: events.length ? events[0].i : c.next, older: (events.length ? events[0].i : c.next) > c.base || !!c.partial,
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
   * sessionId?, text?, defaults?, byTia? }. What is left out: as the last chat in that folder ran, else the folder's
   * default provider (ctx.defaultProvider) and Settings. defaults: true (Tia, a schedule) takes Settings → New-session
   * defaults and not the folder's last chat, as a terminal session they start does: a mode the owner chose for himself
   * (bypass) is not carried into a chat nobody watches. A conversation an open chat already runs gives that chat, as it is.
   * byTia: true (Tia's start_chat, from her door only) marks the chat this call creates as hers, and no other: not an
   * open chat it gives back, not a chat on an existing conversation (sessionId: never hers), nor a later chat on the
   * same conversation (the mark goes with this chat when it closes for
   * any reason). A message sent into it by anyone but her (the page, a schedule) takes the mark off for good (deliver):
   * from then on the chat carries the owner's own instructions, and so does a conversation that went on in a terminal.
   * An answer, a Stop or a settings change does not (he only steers her work).
   * → { id, sent, existing?, permissionMode? } (sent: false when the first message was not sent because a terminal or
   * an open chat runs the conversation; existing: true with that open chat's mode)
   */
  /**
   * What a start in `dir` takes before its own choices: the coding tool (chosen, else as the last chat here while that
   * tool is still offered: on and installed, else Claude Code), the last chat here of that tool (none for a start the
   * owner does not make himself), the provider (chosen, else the folder's default) and whether it was chosen.
   */
  async function startBase(dir, b, owners) {
    const lastOne = lastTool(owners && memory.last(dir));
    const tool = chatTool(b.tool === undefined || b.tool === null || b.tool === '' ? (lastOne !== 'claude' && chatToolList(cfg()).some((t) => t.id === lastOne) ? lastOne : 'claude') : b.tool, cfg());
    const before = (owners && memory.last(dir)) || {};
    // What the last chat here chose counts only for a chat of the same coding tool.
    const last = (before.engine || 'claude') === tool ? before : {};
    let profile = b.profile;
    const chose = !(profile === undefined || profile === null || profile === '');
    if (!chose) {
      // The folder's default for this coding tool (src/defaultprovider.mjs), with the last chat of that tool here as
      // the folder's own provider while it serves the tool; without one, the provider that tool last started on here.
      // Either goes through the same tests as every other: not at its limit, not a pay-per-use key while another can
      // work (the owner may still choose one).
      profile = await ctx.defaultProvider(dir, last.profile && serves(last.profile, tool) ? last.profile : null, tool);
      if (!profile) throw Object.assign(bad(tool === 'claude' ? 'there is no provider yet: add one under Providers first' : 'there is no provider for this coding tool yet: add one under Providers first'), { details: { code: 'no-provider' } });
    }
    if (typeof profile !== 'string' || !profileOk(profile, tool)) throw bad('there is no such provider');
    return { tool, last, profile, chose };
  }

  /**
   * "Lead model": a choice wins, then the folder's last chat, then Settings (`d`); only Claude Code can lead. A start the
   * owner does not make himself (defaults: true: Tia, a schedule, Do it, a new project's start) leads only when its
   * caller says so: Settings' Lead and ticks are for the chats he starts, and nobody watches these as they start.
   * "Use other providers": ticked here, else Settings' (only names that are other providers that serve Claude Code).
   * Ticks given with no provider chosen lose the provider the server picked: the caller could not know it, and the
   * session's own provider is not another one.
   */
  function leadOf({ tool, last, profile, chose, owners }, b, d) {
    const kept = (k, chosen, fallback) => (chosen !== undefined ? chosen : k in last ? last[k] : fallback);
    const lead = tool === 'claude' && (owners ? kept('lead', b.lead ?? undefined, d.lead === true) : b.lead) === true;
    if (!lead) return { lead, others: [] };
    const given = b.others !== undefined && b.others !== null;
    try {
      const ticks = given ? (!chose && Array.isArray(b.others) ? b.others.filter((n) => n !== profile) : b.others) : owners ? ticksOf(d.others).filter((n) => n !== profile && serves(n, 'claude')) : [];
      return { lead, others: cleanOthers(ticks, profile) };
    } catch (e) {
      throw bad(e.message);
    }
  }

  // run: what only a caller inside the dashboard gives, never the route's body. maxBudgetUsd: the coding tool's own
  // budget for its turns (a part of Tia's Lead session inside her daily limit for paid use, partdoor.mjs).
  async function openChat(b, run = {}) {
    const held = heldUntil(); // "start nothing new" (src/operator/decide-store.mjs)
    if (held) throw heldError(held);
    load();
    const dir = insideRoots(v.absPath(b.dir), roots());
    if (!dir) throw bad('choose a folder inside the allowed roots');
    const owners = b.defaults !== true;
    const { tool, last, profile, chose } = await startBase(dir, b, owners);
    // A chat she started on Codex or OpenCode gets no hook (its OKs are answered by the chat, not held by her level),
    // so Hoprig lets her start one only at Full; below that she starts it with Claude Code. Her door marks it hers
    // (b.hers), as does a start of hers (Work's Do it, a schedule she added); a chat that says byTia is marked hers
    // too (below), so the guard asks the same value the mark is made from.
    const hers = b.hers === true || b.byTia === true;
    assertHerToolBound(tool, { hers, cfg: cfg() });
    if (b.ultracode !== undefined && b.ultracode !== null && typeof b.ultracode !== 'boolean') throw bad('ultracode is true or false');
    if (b.byTia !== undefined && typeof b.byTia !== 'boolean') throw bad('byTia is true or false');
    if (b.lead !== undefined && b.lead !== null && typeof b.lead !== 'boolean') throw bad('lead is true or false');
    // "Also open": checked here (server.mjs checkWith), and again at every start. A context without the check takes none.
    const withs = ctx.checkWith ? await ctx.checkWith(b.with, dir) : [];
    if (!ctx.checkWith && b.with !== undefined && b.with !== null) throw bad('"with" is not taken here');
    // A name of its own (Work's Do it names a chat after its task): one line, no control characters.
    if (b.title !== undefined && b.title !== null && typeof b.title !== 'string') throw bad('the title is text');
    const title = typeof b.title === 'string' ? v.chatTitle(b.title) : '';
    const d = cfg().sessionDefaults || {};
    const ch = gated(choicesOf(tool, profile, models));
    // Left out: as the last chat in this folder; never chosen there: Settings → New-session defaults (Claude Code's
    // words: another tool takes what it has of them).
    const kept = (k, chosen, fallback) => (chosen !== undefined ? chosen : k in last ? last[k] : fallback);
    const model = kept('model', pickModel(b.model, tool, ch), tool === 'claude' ? d.model || null : null);
    const effort = kept('effort', pick(b.effort, ch.efforts, 'effort'), d.effort || null);
    // As root, a chat nobody chooses for at this moment (a schedule, Work, Tia) that would run in bypass does not
    // open: the answer says why. A person who opens one gets the mode that asks (the page says why).
    if (asRoot && b.permissionMode === BYPASS) throw Object.assign(new HttpError(409, ROOT_BYPASS_LINE), { details: { code: 'root-bypass' } });
    if (asRoot && tool === 'claude' && (!owners || b.byTia === true) && b.permissionMode === undefined && d.permissionMode === BYPASS) throw Object.assign(new HttpError(409, ROOT_BYPASS_LINE), { details: { code: 'root-bypass' } });
    const permissionMode = kept('permissionMode', pick(b.permissionMode, ch.modes, 'permission mode'), d.permissionMode || null);
    const ultracode = kept('ultracode', b.ultracode ?? undefined, false) === true;
    const { lead, others } = leadOf({ tool, last, profile, chose, owners }, b, d);
    let id = crypto.randomUUID();
    let conversationId = null;
    if (b.sessionId !== undefined && b.sessionId !== null) {
      conversationId = conversationIdOk(tool, b.sessionId) ? b.sessionId : null;
      // Every conversation of the folder in the tool's store (not only the newest few the history list shows).
      if (!conversationId || !(await engineOf(tool).sessions(dir, o.engineOpts)).some((s) => s.id === conversationId)) throw bad('that conversation is not in this folder');
      const open = openChatOf(conversationId);
      if (open) {
        // That chat is someone's already (the owner's, as a rule): it keeps its own settings, and `existing` says so,
        // so a caller does not take it for a chat it started (Tia's rules let her answer OKs only in her own chats).
        const mode = chats.get(open).permissionMode || null;
        if (b.text === undefined || b.text === null) return { id: open, existing: true, permissionMode: mode };
        return { id: open, existing: true, permissionMode: mode, sent: false, why: 'this conversation is already open in a chat; write to that chat' };
      }
      id = tool === 'claude' ? freeId(conversationId) : crypto.randomUUID(); // a chat's own id is a UUID
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
      old.emit('gone'); // its page shows it as not open (live.mjs)
    }
    const budget = run && Number.isFinite(run.maxBudgetUsd) && run.maxBudgetUsd > 0 ? run.maxBudgetUsd : null;
    const c = make({
      ...(budget ? { maxBudgetUsd: budget, paidBudget: true } : {}),
      id, ...(conversationId && conversationId !== id ? { conversationId } : {}), engine: tool, cwd: dir, profile,
      // a model the computer stopped offering is not forced on a new chat
      model: model && modelOk(tool, model, ch) ? model : null, effort: ch.efforts.includes(effort) ? effort : null,
      // A chat on an existing conversation is never hers, whoever asks: its history holds the owner's own instructions
      // (or her own earlier ones, which the safe side treats the same), so its OKs stay his.
      permissionMode: ch.modes.includes(permissionMode) ? modeFor(tool, permissionMode) : null, ultracode, ...(lead ? { lead } : {}), ...(others.length ? { others } : {}), byTia: b.byTia === true && !conversationId,
      // `hers`: opened through her door (the route above) or for a start of hers (Work's Do it, Plan with AI from her
      // door): marked and signed in as hers, whoever answers its OKs.
      ...(hers ? { hers: true } : {}),
      ...(title ? { title, named: true } : {}), ...(withs.length ? { withs } : {}),
    });
    save();
    if (owners) remember(c); // the folder's last chat is the owner's own choice, not Tia's or a schedule's
    if (!text) return { id };
    let first;
    try {
      first = await sendOne(c, () => c.send(text));
    } catch (e) {
      // The chat is open all the same (it reads along): a caller is told the message did not go, not that nothing opened.
      if (e.code === 'in-terminal') return { id, sent: false, why: 'a terminal session runs this conversation' };
      if (e.code === 'in-chat') return { id, sent: false, why: 'another chat runs this conversation right now' };
      throw e;
    }
    return { id, sent: true, ...(first && typeof first.id === 'string' ? { messageId: first.id } : {}) };
  }

  /** A message to an open chat from the dashboard itself (a schedule): queued by the chat while Claude works. */
  async function sendTo(id, text) {
    const c = chatOr404(id);
    toolStillOn(c);
    const t = v.message(text);
    if (!t) throw bad(`the message must be 1 to ${v.MESSAGE_MAX} bytes`);
    const r = await deliver(c, t); // the owner's schedule writes in it: a chat with his instructions, not Tia's any more
    save();
    return { id: r.id, queued: r.queued };
  }

  // ---------- routes ----------
  const routes = [
    ['GET', /^\/api\/chats$/, async () => {
      load();
      return { chats: [...chats.values()].map(card) };
    }],
    ['POST', /^\/api\/chats$/, async (req) => {
      const b = await ctx.readJson(req);
      if (b && b.byTia === true && !fromTia(req)) b.byTia = false;
      // Every chat her door opens is hers for her safety (the mark, her git sign-in), also one on an existing
      // conversation whose OKs stay the owner's; never from the body.
      if (b && typeof b === 'object') b.hers = fromTia(req);
      return openChat(b);
    }],
    // What a start of the owner's in a folder would take for "Lead model" and its ticks when he leaves them as they are
    // (the new-session sheet draws its switch from it): the folder's last chat, else Settings, for the provider given
    // or the folder's default.
    ['GET', /^\/api\/chats\/lead$/, async (req, m, q) => {
      load();
      const dir = insideRoots(v.absPath(q.get('dir')), roots());
      if (!dir) throw bad('choose a folder inside the allowed roots');
      const b = { tool: 'claude', profile: q.get('profile') || undefined };
      const base = await startBase(dir, b, true);
      return { profile: base.profile, ...leadOf({ ...base, owners: true }, b, cfg().sessionDefaults || {}) };
    }],
    ['GET', /^\/api\/chats\/archived$/, async () => ({ list: archived.list() })],
    ['GET', /^\/api\/chats\/tools$/, async () => ({ tools: chatToolList(cfg()).map((t) => (t.modes ? { ...t, modes: gateModes(t.modes, cfg(), asRoot) } : t)) })],
    ['GET', new RegExp(`^/api/chats/${ID}$`), async (req, m, q, res) => {
      const c = chatOr404(m[1]);
      if (c.loading) await c.loading; // its first read, in pieces at the start: the page draws what it read
      if (c.engine.id === 'claude') await readTitles([c.file()]); // its name for the title bar, in pieces
      c.refresh();
      const from = Math.max(0, Number(q.get('from')) || 0);
      const epoch = Number(q.get('epoch')) || 0;
      const wait = Math.min(WAIT_MAX_S, Math.max(0, Number(q.get('wait')) || 0));
      if (wait && epoch === c.epoch && from >= c.next) await waitChange(c, res, wait * 1000);
      return view(c, { from, epoch });
    }],
    ['GET', new RegExp(`^/api/chats/${ID}/older$`), async (req, m, q) => {
      const c = chatOr404(m[1]);
      const before = Math.max(0, Number(q.get('before')) || 0);
      // Read from its last part at the start: the earlier part is read now (in pieces), once.
      if (c.partial && before <= c.base) await c.earlier();
      return { events: c.before(before), base: c.base, more: !!c.partial };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/send$`), async (req, m) => {
      const c = chatOr404(m[1]);
      toolStillOn(c);
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
      const r = await deliver(c, text, { images: files.images, attachments: files.attachments }, b.byTia === true && fromTia(req));
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
      const mode = b.mode === undefined || b.mode === null ? null : pick(b.mode, choices(c).modes, 'permission mode');
      if (b.always !== undefined && b.always !== null && typeof b.always !== 'boolean' && b.always !== 'project') throw bad('always is true, false or "project"');
      if (b.key !== undefined && (typeof b.key !== 'string' || b.key.length > 64)) throw bad('bad key');
      c.answer(b.request, { allow: b.allow, always: b.always === 'project' ? 'project' : b.always === true, answers, mode, message, key: b.key ?? null });
      if (mode) {
        save();
        remember(c, req);
      }
      return { ok: true };
    }],
    // Hands-off for this session of the App (chat/handsoff.mjs): its own switch; off stops it at once, on again ends a
    // loop's stop. Set only here, by the owner's page.
    ['POST', new RegExp(`^/api/chats/${ID}/handsoff$`), async (req, m) => {
      // Not offered: nothing of Hands-off is stored (a switch kept now would read as on once it is offered).
      if (!handsOffOffered(cfg())) throw new HttpError(409, 'Hands-off is not offered on this computer');
      const c = chatOr404(m[1]);
      const b = await ctx.readJson(req);
      if (typeof b.on !== 'boolean') throw bad('say on: true or false');
      c.handsOff = { on: b.on, version: hoprigVersion(), at: Date.now() };
      c.handsOffStop = null;
      c.handsOffRow = 0;
      save();
      c.emit('state');
      return { on: b.on };
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
      if (typeof b.profile !== 'string' || !profileOk(b.profile, c.engine.id)) throw bad('there is no such provider');
      c.setProfile(b.profile, profileView(b.profile).label); // the owner's name for it in the timeline, not its id
      c.emit('state'); // a page that streams shows the new provider
      save();
      remember(c, req);
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
    // Fork (the session menu): a new chat on a copy of this conversation as it is now (a rewound one: as the rewind
    // left it), with the same settings; the copy is made by the coding tool at the new chat's first message.
    ['POST', new RegExp(`^/api/chats/${ID}/fork$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      if (!c.engine.capabilities.fork || typeof c.engine.endPoint !== 'function') throw new HttpError(409, `${c.engine.label} cannot fork a conversation`);
      const fork = c.forkSource();
      if (!fork) throw new HttpError(409, 'there is nothing to fork yet: send a message first');
      if (chats.size >= OPEN_MAX) throw new HttpError(409, `${OPEN_MAX} chats are open; close one first`);
      const title = c.title ? `Fork of ${c.title}`.slice(0, 80) : '';
      const n = make({
        id: crypto.randomUUID(), engine: c.engine.id, cwd: c.cwd, profile: c.profile, model: c.model, effort: c.effort,
        permissionMode: c.permissionMode, ultracode: c.ultracode, ...(c.lead ? { lead: true } : {}), ...(c.others.length ? { others: [...c.others] } : {}), fork,
        ...(title ? { title, named: true } : {}),
      });
      save();
      ctx.poke?.();
      return { id: n.id };
    }],
    ['POST', new RegExp(`^/api/chats/${ID}/close$`), async (req, m) => {
      const c = chatOr404(m[1]);
      await ctx.readJson(req);
      chats.delete(c.id);
      save();
      const ended = c.close();
      c.emit('gone'); // closed for good: its page shows it as not open, without asking again (live.mjs)
      await ended;
      const kept = shut.get(c.id); // what 'closed' found of its conversation
      archived.add({ id: c.id, cwd: c.cwd, conversationId: kept ? kept.conversationId : null, title: c.currentTitle(), tool: c.engine.id, profile: c.profile });
      ctx.poke?.();
      return { ok: true };
    }],
  ];

  // The open chat that runs conversation `id` now, or null. By the conversation, never by the chat's own id: a chat
  // opened on X keeps X as its id after a clear or a rewind gave it conversation Y, and X is then free to continue.
  const openChatOf = (id) => ([...chats.values()].find((c) => c.conversationId === id) || {}).id || null;
  // A chat's own id for conversation `id`: the same where it is free (its link reads as the conversation), else new.
  const freeId = (id) => (chats.has(id) ? crypto.randomUUID() : id);
  routes.push(...handoffRoutes(ctx, { chats, make, save, load, chatOr404, memory, models, openChatOf, freeId, terminalOf, claim, serial, forget, auto: { name: AUTO.name, on: autoOn }, handedFile: () => path.join(path.dirname(file()), 'chat-handed.json'), handedTo: (id, name) => shut.has(id) && typeof name === 'string' && (shut.get(id).terminal = name) }));
  const live = liveRoutes(ctx, { chatOr404, toolStillOn, save, remember, bad, choices, pickModel, folderOf: (c) => uploadsOf(c).cwd, uploadsDir: (c) => uploadsOf(c).dir, openChatOf, about, terminalOf: terminalView, shutOf: (id) => shut.get(id) || null, openNow: (c) => chats.get(c.id) === c,
    // Who did what: the parts this chat handed to other providers, each with its own session's folder and conversation.
    handed: (c) => (handedOf ? handedOf(c.id) : []).map((p) => {
      const x = chats.get(p.id);
      const s = x ? { cwd: x.cwd, conversationId: x.conversationId } : shut.get(p.id);
      return { ...p, cwd: s ? s.cwd : null, conversationId: s ? s.conversationId : null, open: !!x };
    }) });
  routes.push(...live.routes);
  // Delete and the trash (deletes.mjs): an App session leaves the list as Archive closes it, then its files move.
  const closeChat = async (c) => {
    chats.delete(c.id);
    save();
    const ended = c.close();
    // Its page learns it was deleted (in the trash), and offers no Continue of a conversation that is not there.
    const kept = shut.get(c.id);
    if (kept) Object.assign(kept, { conversationId: null, deleted: true });
    c.emit('gone');
    await ended;
  };
  const deletes = deleteRoutes(ctx, {
    chats, load, save, make, chatOr404, openChatOf, freeId, terminalOf, serial, roots, closeChat, now: o.now, step: o.trashStep, purgeEvery: o.purgeEvery, writingMs: o.writingMs,
    deleted: (conversationId) => archived.drop(conversationId),
  });
  routes.push(...deletes.routes);

  return {
    name: 'chat',
    routes,
    /**
     * The dashboard listens (server.mjs): a chat's settings file left by a dashboard stopped by a signal goes (runs.mjs),
     * and the open chats are made now, not only when a page looks: one whose coding tool waits for an OK (asked while
     * the dashboard was down) takes it up (reading.mjs checkWaiting), also with no page open. Not when the feature is
     * built: a test that builds it without a state folder of its own must not touch the real chats file.
     */
    start() {
      removeSettingsLeftovers();
      // The parts' budget holds of an earlier run of the dashboard are NOT settled here: a chat's process is its child
      // on pipes, not ended by the system when the dashboard ends otherwise than by its own stop (a crash, a kill), and
      // it may still run a turn then. Such a hold counts for the day (the safe side) until that chat starts again
      // (partBudget settles it then) or its next process ends.
      load();
      stopPurge = deletes.start(); // the trash: what a stopped dashboard left half done, then what is 30 days old
    },
    handle: live.handle, // the event stream (server-sent events)
    /**
     * "Allow bypass permissions mode" was turned off (bypassgate.mjs): every open chat in bypass goes to Manual, and its
     * process, started with the flag that allows bypass, stops now (after its turn, if one runs); the next message
     * starts it without. → how many chats were in bypass
     */
    async bypassOff() {
      load();
      let n = 0;
      for (const c of chats.values()) {
        if (c.permissionMode !== 'bypassPermissions') continue;
        n++;
        await c.setSettings({ mode: 'manual' });
        if (c.session) {
          if (c.busy()) c.restart = true;
          else c.stop();
        }
      }
      if (n) save();
      return n;
    },
    /** The switch changed: every open page gets its chat's state again, with the modes it now offers (about → choices). */
    bypassChanged() {
      load();
      for (const c of chats.values()) c.emit('state');
    },
    open: (b, run) => openChat(b, run), // a chat for the dashboard itself (the schedules)
    /** "Use other providers" (src/models/partdoor.mjs): the --mcp-config of a Lead chat's one tool, made at its start. */
    setPartsConfig(fn, handed = null) {
      partsConfig = fn;
      handedOf = handed;
    },
    /** The dashboard's own record of open chat `id` (with Tia's mark), or null: what the part door checks against. */
    recordOf(id) {
      load();
      const c = chats.get(id);
      return c && !c.closed ? { ...c.record(), lead: c.lead, others: [...c.others], byTia: c.byTia === true } : null;
    },
    /** One line in chat `id`'s timeline (a part handed, skipped or waiting for the owner). */
    notice(id, level, text) {
      const c = chats.get(id);
      if (c) c.push({ kind: 'notice', level, text });
    },
    /** One event of the part door in chat `id`'s timeline (a part's card for the owner, and how it was answered). */
    event(id, ev) {
      const c = chats.get(id);
      if (c && (ev.kind === 'part-ask' || ev.kind === 'part-ask-kept' || ev.kind === 'part-ask-closed')) {
        c.push(ev);
        c.changed();
      }
    },
    send: sendTo,
    /** Before cards(): the names of the open App sessions are read in pieces, so cards() reads nothing at once. */
    async readNames() {
      load();
      await readTitles([...chats.values()].filter((c) => c.engine.id === 'claude').map((c) => c.file()));
    },
    /** The App session that has conversation `id` open, or null (the folder's list marks it: never offered to delete). */
    openOf(id) {
      load();
      return openChatOf(id);
    },
    /** The open chats as session cards (server.mjs adds them to the sessions: Home, notifications). */
    cards() {
      load();
      return [...chats.values()].map(card);
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
      stopPurge();
      await Promise.all([...chats.values()].map((c) => c.close(3000)));
    },
    // For Work's runs (src/work/doit.mjs), which follow a chat they started until its turn ends:
    /** Where open chat `id` stands now ({ busy, pending, turn, lastEnd, lastError, lastText, … }), null when it is not open. */
    /**
     * For the Operator's decisions (src/operator/decide-asks.mjs): the question chat `id` waits on (its exact card, the
     * request, Hands-off's switch for the chat, `only`: no other ask waits beside it), or null.
     */
    question(id) {
      load();
      const c = chats.get(id);
      return c ? chatQuestion(c) : null;
    },
    /** Its answer, through answerAsk (the owner's own way; the card's key checked again there). */
    answerQuestion(id, request, a) {
      load();
      const c = chats.get(id);
      if (!c) throw new HttpError(409, 'this chat is not open');
      c.answer(request, a);
    },
    peek(id) {
      load();
      const c = chats.get(id);
      if (!c) return null;
      c.refresh();
      return snapshot(c);
    },
    /** fn(snapshot) at each change of chat `id`'s status, and once it closes; → stop following. */
    follow(id, fn) {
      load();
      const c = chats.get(id);
      if (!c) return () => {};
      const on = () => fn(chats.get(id) === c && !c.closed ? snapshot(c) : null);
      c.on('status', on);
      c.on('closed', on);
      return () => {
        c.off('status', on);
        c.off('closed', on);
      };
    },
    /** How the turn that began with message `messageId` of conversation `conv` ended, as kept beside the chats (turns.mjs), or null. */
    turnEnd(conv, messageId) {
      return readTurns(path.join(path.dirname(file()), 'chat-turns'), conv).get(messageId) || null;
    },
    /**
     * How message `messageId` of chat `id` ended, for Tia's spending ledger (spend.mjs measureChats): what the chat saw
     * (Chat messageEnd), else, after a restart, its turn's kept end (turns.mjs; total: the chat's costTotal now, which
     * that turn's end came before). null: waiting, running, or not known (its hold stays). Reads only.
     */
    messageEnd(id, messageId) {
      load();
      const c = chats.get(id);
      if (!c || typeof messageId !== 'string' || !messageId) return null;
      const seen = c.messageEnd(messageId);
      if (seen) return seen;
      if (c.turn && (c.turn.messageId === messageId || (c.turn.took || []).includes(messageId))) return null;
      if (c.queue.find(messageId)) return null;
      const kept = readTurns(path.join(path.dirname(file()), 'chat-turns'), c.conversationId).get(messageId);
      if (!kept) return null;
      return { ended: true, cost: Number.isFinite(kept.turnCostUsd) ? kept.turnCostUsd : null, total: c.costTotal };
    },
  };
}

/** What Work's runs read of a chat: its state, how its last turn ended, its last answer, what it runs on. */
function snapshot(c) {
  return {
    id: c.id, conversationId: c.conversationId, busy: c.busy(), pending: c.pending.size, turn: c.turn ? c.turn.messageId || null : null,
    lastEnd: c.lastEnd, lastError: c.lastError, lastText: c.lastText, limit: c.limit ? c.limit.text : null,
    tool: c.engine.id, profile: c.profile, model: c.model, effort: c.effort,
  };
}
