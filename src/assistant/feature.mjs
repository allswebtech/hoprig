// Tia in the dashboard: one feature (server.mjs features list). It hosts the core (core.mjs) on the real
// operations (ops.mjs), runs her engine per conversation (engine.mjs), drives her jobs from the watcher, and
// answers these routes:
//
//   Tia's token only (bearer, "tia_…")
//     POST /api/assistant/call                 { tool, args } → { text, isError }   (403 { code: "tia-off" } when off)
//   the owner's login (cookie) only — bearer tokens never reach them (machines gate + not trusted here)
//     GET  /api/assistant                      overview: on/off, ready or what to do, conversations, cards, jobs
//     POST /api/assistant/chat                 { conversation?, text, choice? } → { conversation }   (the turn runs after;
//                                              choice: the choice card whose own box the text was written in)
//     GET  /api/assistant/chat/<id>?from=N     { events, next, busy }   events since N (the page polls / streams)
//     GET  /api/assistant/stream?conversation=<id>&from=N   the same as Server-Sent Events
//     GET  /api/assistant/cards                POST /api/assistant/cards/<id>/confirm { values? } | /reject
//     POST /api/assistant/views  { ids }       the dynamic cards in view, as they are now (cardkinds.mjs)
//     POST /api/assistant/views/<id>/undo      Undo on a result card
//     GET  /api/assistant/jobs                 POST /api/assistant/jobs/<id>/stop
//     GET  /api/assistant/audit?n=100
//     GET  /api/assistant/settings             POST /api/assistant/settings  { …patch }  (tia.mjs cleanTiaPatch)
//     POST /api/assistant/client-token         a token for the owner's own MCP client (shown once)
//     POST /api/assistant/client-token/revoke
//   the owner's login, or another dashboard's machine token (the hub's run_command on this computer)
//     POST /api/assistant/run                  { command, cwd?, timeoutMs? } → { code, output, timedOut }
//
// Her own token is written to <stateDir>/assistant-token (mode 600) and rotated at every start of the dashboard;
// her MCP server reads it from that file on every call, so it never appears in a command line or config.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { AuditLog } from './audit.mjs';
import { CONVERSATION_HEADER, tokenFile } from './client.mjs';
import { VIEW_LINE, createAssistantCore } from './core.mjs';
import { DYNAMIC } from './cardkinds.mjs';
import { Engine } from './engine.mjs';
import { createOps, runShell as realRunShell } from './ops.mjs';
import { tiaPrompt } from './accepted.mjs';
import { loadMachines } from '../machines/store.mjs';
import { ASSISTANT_NAME, DEFAULTS as TIA_DEFAULTS, HELP, LEVELS, cleanTiaPatch, resolveTia, savedTiaChoice, servesTool, tiaChoices } from './tia.mjs';
import { keepSample } from '../work/tellwire.mjs';
import { readUsage, recordUsage, summarizeUsage, turnUsage, usageFile } from './usage.mjs';
import { progressAnswer } from './answercheck.mjs';
import { noteCorrection } from '../operator/corrections.mjs';
import { BUSY, SpendLedger, measureChats, paidName } from './spend.mjs';

/** A time in this computer's clock, with the day when it is not today: "11:27", "09:00 on Tue, 24 Nov". */
function atWords(until, now) {
  const d = new Date(until);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return `${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${sameDay ? '' : ` on ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`}`;
}
/** The time words a line wrote for `until` and the moment itself, so the page can write it as it writes its other times. */
export const atOf = (until, now = Date.now()) => (Number.isFinite(until) ? { atText: atWords(until, now), until } : {});
const labelOf = (accounts, n) => ((accounts.profiles || []).find((p) => p.name === n) || {}).label || n;
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * The line for "every subscription she thinks on is at its limit" (Automatic): all of them by their labels (they are
 * few), and the one usable again first with its time in this computer's clock, or that it is not known.
 */
export function subsLimitedLine({ names, first = null, until }, accounts = {}, now = Date.now()) {
  const back = Number.isFinite(until) ? `${labelOf(accounts, first || names[0])} can be used again at ${atWords(until, now)}.` : 'Hoprig does not know yet when one can be used again.';
  return `${andList(names.map((n) => labelOf(accounts, n)))} ${names.length > 1 ? 'have' : 'has'} reached ${names.length > 1 ? 'their' : 'its'} limit, so ${ASSISTANT_NAME} cannot answer now. ${back} ${ASSISTANT_NAME} does not move to a paid provider by herself.`;
}

/**
 * His own choice of "Tia runs on" is a subscription at its limit: she stays on it, and says so with the time; `free`:
 * another subscription of his that can answer now (the notice offers it with "Use …"), named in the line.
 */
export function chosenLimitedLine({ name, until }, accounts = {}, now = Date.now(), { free = null } = {}) {
  const back = Number.isFinite(until) ? `It can be used again at ${atWords(until, now)}.` : 'Hoprig does not know yet when it can be used again.';
  const other = free ? ` ${labelOf(accounts, free)} can answer now.` : '';
  return `${labelOf(accounts, name)}, which ${ASSISTANT_NAME} runs on, has reached its limit, so she cannot answer now. ${back}${other} ${ASSISTANT_NAME} does not move to a paid provider by herself.`;
}

/**
 * The notice when her turn on a paid provider is not taken (spend.mjs take): its `code` and the sentence, which names
 * the provider by its label (Auto mode: the paid ones its order can use). The code follows the reason, not the daily
 * limit for paid use: a busy spending record is "busy" (no button: that limit may have room), no limit set is
 * "paid-no-cap", and only a limit without room is "cap-reached".
 */
export function paidNotice(why, { cap, runsOn = null }, accounts = {}) {
  if (why === BUSY) return { code: 'busy', text: `${ASSISTANT_NAME} did not answer: another dashboard is writing the record of paid use just now. Send your message again in a moment.` };
  const order = accounts.autoSwitch && Array.isArray(accounts.autoSwitch.order) ? accounts.autoSwitch.order : [];
  const paidInAuto = order.map((n) => (accounts.profiles || []).find((p) => p.name === n)).filter((p) => p && p.name !== 'auto' && (p.kind === 'api' || p.paid === true));
  const on = runsOn === 'auto'
    ? `Auto mode, which can use ${andList(paidInAuto.map((p) => p.label || p.name)) || 'a paid provider'}`
    : runsOn ? labelOf(accounts, runsOn) : 'a paid provider';
  if (!(Number.isFinite(cap) && cap > 0)) return { code: 'paid-no-cap', text: `${ASSISTANT_NAME} did not answer: to answer she would use ${on}, which costs money, and you have not set a daily limit for paid use yet.` };
  return { code: 'cap-reached', text: `${ASSISTANT_NAME} did not answer: to answer she would use ${on}, which costs money, and ${why}.` };
}

/**
 * Which page the owner is looking at, as the page itself says it (the chat box sends it with every message): one
 * line before the message, so "set this one up" on a computer's page means that computer. Only the shapes the page
 * makes pass; anything else is left out, never quoted.
 */
export function contextLine(x) {
  if (!x || typeof x !== 'object') return '';
  // A page id is a route of the page: "providers", "computer/setup", "settings/tia" — words and one slash at most.
  const page = typeof x.page === 'string' && /^[a-z][a-z0-9-]{0,30}(\/[a-z0-9-]{1,30})?$/.test(x.page) ? x.page : null;
  if (!page) return '';
  const sub = typeof x.sub === 'string' && /^[A-Za-z0-9._~ /-]{1,80}$/.test(x.sub) ? x.sub : null;
  const computer = typeof x.computer === 'string' && /^[A-Za-z0-9 ._@()-]{1,40}$/.test(x.computer) ? x.computer : null;
  return `[The owner is looking at the dashboard page "${page}"${sub ? ` (${sub})` : ''}${computer ? ` of the computer "${computer}"` : ''}.]\n`;
}

const BODY_MAX = 64 * 1024;
const CONV_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIEW_ID_RE = /^v_[0-9a-f]{12}$/;
const EVENTS_MAX = 2000;
const CONVS_MAX = 30;
const TOKEN_PREFIX = 'tia_';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * A conversation's events as they are served (a reload, another device): each card in them as the server has it NOW
 * (core.mjs views), not as it was when the event was pushed; after an Undo the history shows the card taken back.
 */
export function currentViews(events, views) {
  return events.map((e) => {
    const v = e.view && typeof e.view.id === 'string' ? views.get(e.view.id) : null;
    return v && v.card !== e.view ? { ...e, view: v.card } : e;
  });
}
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function bearerOf(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return reject(Object.assign(new Error('send JSON'), { status: 415 }));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(b && typeof b === 'object' && !Array.isArray(b) ? b : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * o: { runShell, jobWaitMs, now, engine: { resolveEnv, command, spawnImpl, mcpCommand },
 *      core: { audit, jobs, skills, cards } (tests), url (the dashboard address for her MCP server) }
 */
export function assistantFeature(ctx, o = {}) {
  // Every action goes through the page's own routes (ctx.dispatch): see ops.mjs.
  const ops = createOps({ ctx, runShell: o.runShell || realRunShell, ...(o.jobWaitMs !== undefined ? { jobWaitMs: o.jobWaitMs } : {}) });
  // What she spends on providers billed by use, kept in the state folder so a restart keeps the day's sum (spend.mjs).
  const spend = (o.core && o.core.spend) || new SpendLedger({ ...(o.now ? { now: o.now } : {}) });
  const startedAt = Date.now(); // when this dashboard started: a card made earlier cannot be known here
  const core = createAssistantCore({ ops, ...(o.now ? { now: o.now } : {}), ...(o.core || {}), spend });
  const audit = core.audit || new AuditLog();
  const HttpError = ctx.HttpError;
  const hubComputers = () => {
    try {
      return loadMachines().map((m) => ({ name: m.name, label: m.label || m.name }));
    } catch {
      return [];
    }
  };
  const raw = () => {
    const a = ctx.config().assistant;
    return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  };
  // Off until the owner turns her on (she costs money): the same default Settings → Tia shows (resolveTia).
  const enabled = () => ({ ...TIA_DEFAULTS, ...raw() }).enabled !== false;
  let serverToken = null;
  let address = o.url || null; // set in start(): where this dashboard listens
  /**
   * Where this very server listens, from the server itself (ctx.listening), else from dashboard.json when this process
   * wrote it; null when neither says. Never a default port: another dashboard (the one a person really uses) may hold
   * it, and her MCP server would then act there with this dashboard's token refused or, worse, another one's state.
   */
  const ownAddress = () => {
    const l = ctx.listening ? ctx.listening() : null;
    const d = l ? null : runningDashboard();
    const mine = l ? { host: l.address, port: l.port } : d && d.pid === process.pid ? d : null;
    if (!mine || !mine.port) return null;
    const host = ['0.0.0.0', '::', ''].includes(mine.host) ? '127.0.0.1' : String(mine.host).includes(':') ? `[${mine.host}]` : mine.host;
    return `http://${host}:${mine.port}`;
  };

  // ---- tokens ----
  function rotateToken() {
    serverToken = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, serverToken + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  /** "engine" for her own token, "client" for the owner's MCP client token, null for anything else. */
  function tokenKind(t) {
    if (!t || !t.startsWith(TOKEN_PREFIX)) return null;
    if (serverToken && sameHash(sha256(t), sha256(serverToken))) return 'engine';
    const c = raw().clientToken;
    if (c && typeof c.hash === 'string' && sameHash(sha256(t), c.hash)) return 'client';
    return null;
  }

  // ---- conversations: one engine each, and the events the page shows ----
  const convs = new Map(); // id → { id, title, events: [], busy, engine, createdAt, queue }
  function conv(id = null) {
    if (id && convs.has(id)) return convs.get(id);
    const c = { id: id || `t${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, title: '', events: [], busy: false, engine: null, createdAt: Date.now(), queue: Promise.resolve(), listeners: new Set() };
    convs.set(c.id, c);
    if (convs.size > CONVS_MAX) {
      const old = [...convs.values()].filter((x) => !x.busy).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (old) {
        old.engine?.cleanup();
        convs.delete(old.id);
      }
    }
    return c;
  }
  function push(c, ev) {
    const e = { i: c.events.length, at: Date.now(), ...ev };
    c.events.push(e);
    if (c.events.length > EVENTS_MAX) c.events.splice(0, c.events.length - EVENTS_MAX);
    for (const fn of c.listeners) fn(e);
    return e;
  }
  const since = (c, from) => currentViews(c.events.filter((e) => e.i >= from), core.views);

  async function accountsNow() {
    try {
      return await ops.accounts({ computer: 'this' });
    } catch {
      return { profiles: [], autoSwitch: { enabled: false } };
    }
  }

  /** Can Tia run at all? { ok, problem, runsOn } — the tab shows `problem` in one line instead of failing. */
  async function readiness() {
    if (!enabled()) return { ok: false, problem: `${ASSISTANT_NAME} is turned off. Turn her on in Settings → ${ASSISTANT_NAME}.` };
    const accounts = await accountsNow();
    const tia = resolveTia(raw(), accounts);
    // Her tools reach this dashboard only at its own address: without it nothing is started (never a default port).
    // Not known at start (the server was not listening yet): asked again now.
    if (!(address || (address = ownAddress()))) return { ok: false, problem: `${ASSISTANT_NAME} cannot reach her tools: this dashboard did not say where it listens. Restart the dashboard; if it keeps happening, check that its state folder can be written.` };
    // Automatic, and every subscription is at its limit: one plain line with when the first is back; she never goes on
    // to a provider billed by use by herself.
    if (!tia.runsOn && tia.subsLimited) return { ok: false, code: 'subs-limited', until: tia.subsLimited.until, other: tia.subsLimited.other === true, ...atOf(tia.subsLimited.until), problem: subsLimitedLine(tia.subsLimited, accounts) };
    // The subscription the notice offers in its place (its "Use …" button), when one can answer now.
    const offer = tia.subscription && tia.subscription !== tia.runsOn ? { name: tia.subscription, label: labelOf(accounts, tia.subscription) } : null;
    // He chose a subscription himself (also by "Use …" on a notice) and it is at its limit: she stays on his choice and
    // says so, with the time it is usable again; nothing moves to a provider billed by use. A code of its own: unlike
    // "every subscription is at its limit", another subscription may answer now, and then the notice offers it.
    if (tia.chosenLimited) return { ok: false, code: 'chosen-limited', until: tia.chosenLimited.until, ...atOf(tia.chosenLimited.until), offer, problem: chosenLimitedLine(tia.chosenLimited, accounts, Date.now(), { free: offer && offer.name }) };
    // Automatic with no subscription, and no provider she may use can run her: the ticks are his to change.
    if (!tia.runsOn && tia.noneAllowed) return { ok: false, code: 'none-allowed', problem: `None of the providers ${ASSISTANT_NAME} may use can run her. Tick one under Settings → ${ASSISTANT_NAME} → "Providers she may use", or choose one under "${ASSISTANT_NAME} runs on".` };
    if (!tia.runsOn) return { ok: false, problem: `No provider can run ${ASSISTANT_NAME}. Add a provider, or choose one under Settings → ${ASSISTANT_NAME} → "${ASSISTANT_NAME} runs on".` };
    // Her own thinking on a provider billed by use spends too: only inside his daily limit for paid use, held before the turn starts.
    const runsOnPaid = paidName(tia.runsOn, accounts);
    // accounts: for her turn's notice (paidNotice) only; the overview leaves it out.
    return { ok: true, problem: null, runsOn: tia.runsOn, model: tia.model, level: tia.level, paid: runsOnPaid, cap: tia.dailyCapUsd, offer, accounts };
  }

  /** One turn of conversation `c`: the owner's message or a job wake-up. Queued: turns of one conversation never overlap. */
  function turn(c, text, { origin = 'owner', job = null, mode = null } = {}) {
    const run = async () => {
      // A wake-up queued behind a turn in which she already finished (or the owner stopped) the job: nothing to do.
      if (origin === 'job' && job && !['working', 'waiting'].includes(core.jobs.get(job)?.state)) return;
      const ready = await readiness();
      if (!ready.ok) {
        // His chosen subscription at its limit: the page draws "Use <the one that can answer now>" from the code.
        // Every subscription at its limit: the page draws the sentence once, as this notice, and the way to "Tia runs on"
        // when he allowed another provider (`other`).
        const coded = ready.code === 'chosen-limited' ? { code: ready.code, origin, ...(ready.offer ? { use: ready.offer } : {}) }
          : ready.code === 'subs-limited' ? { code: ready.code, origin, ...(ready.other ? { other: true } : {}) } : {};
        // The time in the line, also as a moment: the page writes it in its own form (pageTime).
        push(c, { kind: 'notice', text: ready.problem, ...coded, ...(ready.atText ? { atText: ready.atText, until: ready.until } : {}) });
        return;
      }
      // Her own paid turn: its hold has an id of its own, settled by this turn's cost and no other.
      const hold = ready.paid ? `turn-${crypto.randomBytes(6).toString('hex')}` : null;
      if (ready.paid) {
        const why = spend.take(ready.cap, { id: hold });
        if (why) {
          // No way in words: the page draws the buttons from `code` (use the subscription offered, or set the limit).
          // `origin`: the page's "Use …" sends his message again only for a notice his own message brought.
          const { code, text: said } = paidNotice(why, ready, ready.accounts);
          push(c, { kind: 'notice', code, text: said, origin, ...(ready.offer && code !== 'busy' ? { use: ready.offer } : {}) });
          return;
        }
      }
      c.busy = true;
      // Card outcomes since her last turn come first, so she knows what the owner decided.
      const outcomes = core.takeOutcomes(c.id).map((x) => x.text);
      const message = outcomes.length ? `[What happened since your last turn]\n${outcomes.join('\n')}\n\n${text}` : text;
      if (!c.engine || c.engine.o.profile !== ready.runsOn || c.engine.o.model !== (ready.model || null)) {
        c.engine?.cleanup();
        c.engine = new Engine({
          profile: ready.runsOn, model: ready.model || null, conversation: c.id, systemPrompt: tiaPrompt(core.skills.index()), accepted: true,
          url: address, tokenFile: tokenFile(), maxBudgetUsd: o.maxBudgetUsd || null, ...(c.engine ? { sessionId: c.engine.sessionId } : {}), ...(o.engine || {}),
        });
        c.engine.on('event', (ev) => {
          // A small model sometimes writes a bare "(empty)" next to a tool call: nothing to show.
          if (ev.kind === 'text') {
            if (ev.text.trim() !== '(empty)') {
              const e = push(c, { kind: 'text', text: ev.text });
              if (c.turn) c.turn.texts.push({ i: e.i, text: ev.text });
            }
          }
          else if (ev.kind === 'tool_call') push(c, { kind: 'tool_call', id: ev.id, tool: ev.name, input: ev.input });
          else if (ev.kind === 'tool_result') {
            if (c.turn) c.turn.results.push(ev.text);
            const staged = /^Waiting for the owner's OK \(card (c_[0-9a-f]{12})/.exec(ev.text);
            // The card a result shows (core.mjs viewOf): found by its id in the text, and only if it was made for THIS
            // conversation; the card itself comes from the server's store, never from the text.
            const seen = ev.isError ? null : VIEW_LINE.exec(String(ev.text));
            const v = seen ? core.views.get(seen[1]) : null;
            const view = v && v.conversation === c.id ? v.card : null;
            push(c, { kind: 'tool_result', id: ev.id, isError: ev.isError, summary: ev.text.split('\n')[0].slice(0, 300), ...(staged ? { card: staged[1] } : {}), ...(view ? { view } : {}) });
          }
        });
      }
      // A paid turn may spend at most what is left of today's daily limit for paid use (the coding tool stops it there); else her usual budget.
      c.engine.o.maxBudgetUsd = ready.paid ? Math.max(0.01, Math.min(spend.left(ready.cap, hold), o.maxBudgetUsd || Infinity)) : o.maxBudgetUsd || null;
      core.beginTurn(c.id, origin === 'job' ? { origin: 'job', job, mode } : { origin: 'owner', text });
      c.turn = { texts: [], results: [], progress: null };
      try {
        const r = await c.engine.send(message);
        const d = r.done;
        if (c.turn.progress) progressAnswerOf(c, c.turn);
        // The turn's cost goes into the spending record first and on its own: it is money. When the record cannot be
        // written (its lock stayed taken to the end of the wait), the turn stays counted at its hold, and the log says so.
        try {
          if (ready.paid && Number.isFinite(d.costUsd)) spend.spent(d.costUsd, 'her own turn', hold);
        } catch (e) {
          console.error(`${ASSISTANT_NAME}: the cost of a turn could not be written into the spending record (${e && e.message ? e.message : e}); the turn stays counted at its hold`);
        }
        try {
          recordUsage(turnUsage(d, { conversation: c.id }));
        } catch {
          /* the usage list is a nice-to-have */
        }
        push(c, { kind: 'done', ok: d.ok, error: d.ok ? null : d.text.slice(0, 300), costUsd: d.costUsd });
      } finally {
        core.endTurn(c.id);
        c.turn = null;
        c.busy = false;
      }
    };
    c.queue = c.queue.then(run, run).catch((e) => push(c, { kind: 'notice', text: `${ASSISTANT_NAME} stopped: ${e.message}` }));
    return c.queue;
  }

  /**
   * Rule 7 at run time (answercheck.mjs): she read progress in this turn, so its lines are the answer, shown by code
   * under her reply. A figure in her words that no tool gave her hides her words of the turn, noted once in Activity.
   */
  function progressAnswerOf(c, t) {
    const a = progressAnswer({ texts: t.texts, results: t.results, lines: t.progress });
    push(c, { kind: 'progress', lines: a.lines, replaced: a.replaced, hides: a.hides });
    if (a.replaced) audit.append({ actor: 'assistant', conversation: c.id, tool: 'manage_work', level: 'L0', input: { action: 'progress' }, outcome: 'replaced', error: `figures no tool gave: ${a.foreign.slice(0, 10).join(', ')}` });
  }

  // ---- jobs: the watcher drives them; a wake-up is one turn of the job's conversation ----
  async function onTick(cards) {
    if (!enabled()) return;
    // What the chats her paid acts went into today have cost, from their own figures (nothing is written when there
    // were none): it takes the place of those acts' fixed holds in today's sum (spend.mjs).
    // An act bound with a message id is settled by how that message ended, which the chat feature tells (when given).
    try {
      measureChats(spend, cards, o.chat && typeof o.chat.messageEnd === 'function' ? (id, m) => o.chat.messageEnd(id, m) : null);
    } catch {
      /* the holds stay counted: the safe side */
    }
    const active = core.jobs.list({ active: true });
    if (!active.length) return;
    const remote = active.some((j) => j.sessions.some((e) => e.computer !== 'this'));
    const list = remote ? await ops.listSessions({ computer: null }) : cards.map((x) => ({ ...x, computer: 'this' }));
    // A chat has no screen: what it asks and its last reply stand in for it.
    const chatText = (e) => {
      const c = list.find((x) => x.name === e.session && (x.computer || 'this') === e.computer && x.kind === 'chat');
      return c ? [c.note, c.lastMessage].filter(Boolean).join('\n') : null;
    };
    const wakes = await core.jobTick(list, async (e) => chatText(e) ?? ops.capture({ computer: e.computer, session: e.session, lines: 60 }));
    // The watcher looks only every 30 s while no Claude session runs: a session that is still starting must be
    // looked at again soon, or a job would miss its first "working".
    if (core.jobs.list({ active: true }).some((j) => j.sessions.some((e) => !e.armed && !e.ended))) setTimeout(() => ctx.poke?.(), 1000).unref?.();
    for (const w of wakes) {
      const c = conv(w.conversation);
      push(c, { kind: 'wake', job: w.job, reason: w.reason });
      turn(c, w.message, { origin: 'job', job: w.job, mode: w.mode });
    }
  }

  // ---- settings view ----
  async function settingsView() {
    const accounts = await accountsNow();
    const tia = resolveTia(raw(), accounts);
    const usage = summarizeUsage(readUsage());
    const c = raw().clientToken;
    return {
      name: ASSISTANT_NAME,
      // The saved choice holds only names Save accepts back (savedTiaChoice), or the page could not be saved.
      settings: { ...tia, ...savedTiaChoice(raw(), accounts) },
      // What "Automatic" picks now, also while he chose a provider himself: the page names it in that choice.
      automatic: (({ runsOn, subsLimited }) => ({ runsOn, subsLimited }))(resolveTia({ ...raw(), runsOn: null }, accounts)),
      levels: LEVELS,
      help: HELP,
      // Only the providers she can use (tiaChoices); `thinks`: she can run on it (it serves Claude Code).
      accounts: [...(accounts.profiles || []).filter((p) => p.virtual), ...tiaChoices(accounts)]
        .map((p) => ({ name: p.name, label: p.label, kind: p.kind, limited: !!p.limited, virtual: !!p.virtual, thinks: servesTool(p, 'claude') })),
      autoOn: !!(accounts.autoSwitch && accounts.autoSwitch.enabled),
      // The computers of the hub he may let her start work on (Settings → Tia; assistant.computers).
      computers: hubComputers(),
      // Beside the level that runs without asking: the daily limit for paid use he set and what was spent against it today (spend.mjs).
      spend: { cap: tia.dailyCapUsd, today: spend.detail() },
      usage: { today: usage.today, week: usage.week, conversations: Object.entries(usage.byConversation).slice(-20).map(([id, u]) => ({ id, ...u })) },
      client: c ? { created: c.created || null } : null,
    };
  }

  const ownerOnly = (req) => {
    if (bearerOf(req) !== null) throw new HttpError(403, `${ASSISTANT_NAME}'s screens need the owner's login`);
  };

  const routes = [
    ['GET', /^\/api\/assistant$/, async (req) => {
      ownerOnly(req);
      const { accounts: _accounts, ...ready } = await readiness();
      return {
        name: ASSISTANT_NAME, enabled: enabled(), ready,
        conversations: [...convs.values()].sort((a, b) => b.createdAt - a.createdAt).map((c) => ({ id: c.id, title: c.title, busy: c.busy, events: c.events.length, at: c.createdAt })),
        cards: core.cards.pending(), jobs: core.jobs.list().slice(0, 30),
      };
    }],
    ['POST', /^\/api\/assistant\/chat$/, async (req) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      const again = b.again === undefined || b.again === null ? null : b.again;
      if (again !== null && !(Number.isInteger(again) && again >= 0)) throw new HttpError(400, 'bad again');
      if (!(again !== null && (b.text === undefined || b.text === null)) && (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 8000)) throw new HttpError(400, 'write a message of 1 to 8000 characters');
      if (b.conversation !== undefined && b.conversation !== null && (typeof b.conversation !== 'string' || !CONV_RE.test(b.conversation))) throw new HttpError(400, 'bad conversation');
      if (b.choice !== undefined && b.choice !== null && (typeof b.choice !== 'string' || !VIEW_ID_RE.test(b.choice))) throw new HttpError(400, 'bad choice');
      // His message sent again from notice `again` ("Use …", or the button after he set the daily limit): once per
      // notice. The check and the message are one step with no wait between them, so two pages pressing at the same
      // moment send it once; the text is the message that brought the notice unless the page sends it.
      let text = b.text;
      if (again !== null) {
        const c0 = typeof b.conversation === 'string' ? convs.get(b.conversation) : null;
        const n = c0 && c0.events.find((e) => e.i === again && e.kind === 'notice' && e.origin === 'owner');
        if (!n) throw new HttpError(404, 'that notice is not in this conversation any more');
        if (c0.events.some((e) => e.i > n.i && e.kind === 'owner')) throw Object.assign(new HttpError(409, 'this message was sent again already (from another page, or you wrote since)'), { details: { code: 'sent-already' } });
        if (typeof text !== 'string') text = (c0.events.filter((e) => e.i < n.i && e.kind === 'owner').at(-1) || {}).text;
        if (typeof text !== 'string' || !text.trim()) throw new HttpError(404, 'the message of that notice is not kept any more');
      }
      const c = conv(b.conversation || null);
      if (!c.title) c.title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
      // An answer from a choice card's own box names that card, so the card says "You answered" after a reload and on
      // another device too. Kept only for a choice card of this conversation; anything else is a plain message.
      const asked = b.choice ? core.views.get(b.choice) : null;
      const choice = asked && asked.conversation === c.id && asked.card.kind === 'choice' ? b.choice : null;
      push(c, { kind: 'owner', text, ...(choice ? { choice } : {}) });
      try {
        keepSample(ctx.config(), text); // his language, for "Tia writes my digest" (only while that is on)
      } catch {
        /* the digest goes in plain words */
      }
      // The computer the owner is looking at counts as shown to Tia: the page said it, not a screen or a file.
      const cc = b.context && typeof b.context.computer === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(b.context.computer) ? b.context.computer : null;
      if (cc) core.shown.add(c.id, { computer: [cc] });
      turn(c, `${contextLine(b.context)}${text}`);
      return { conversation: c.id };
    }],
    ['GET', /^\/api\/assistant\/chat\/([A-Za-z0-9_-]{1,64})$/, async (req, m, q) => {
      ownerOnly(req);
      const c = convs.get(m[1]);
      if (!c) throw new HttpError(404, 'no such conversation (they are kept until the dashboard restarts)');
      const from = Math.max(0, Number(q.get('from')) || 0);
      return { events: since(c, from), next: c.events.length ? c.events[c.events.length - 1].i + 1 : 0, busy: c.busy };
    }],
    ['GET', /^\/api\/assistant\/cards$/, async (req) => {
      ownerOnly(req);
      return { cards: core.cards.pending() };
    }],
    ['POST', /^\/api\/assistant\/cards\/(c_[0-9a-f]{12})\/(confirm|reject)$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      // Cards live in this running dashboard only: one the page shows from before a restart (`made`: when the page says
      // it was made, earlier than this dashboard's start) is unknown here and runs nothing; he is told so plainly. The
      // page's word decides only the sentence, never whether anything runs.
      if (!core.cards.get(m[1]) && Number.isFinite(b.made) && b.made < startedAt) {
        throw Object.assign(new HttpError(409, `This card was made before the dashboard restarted, so it cannot run any more: ask ${ASSISTANT_NAME} again if you still want it.`), { details: { code: 'before-restart' } });
      }
      // A form card's values the owner changed: an object of short values, checked again by the core.
      const values = b.values === undefined ? null : b.values;
      if (values !== null && (typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 4
        || Object.values(values).some((v) => !(typeof v === 'string' && v.length <= 500) && !(typeof v === 'number' && Number.isFinite(v))))) throw new HttpError(400, 'values: up to four fields of the card, each a short text or a number');
      if (values && m[2] !== 'confirm') throw new HttpError(400, 'values go with confirm');
      const before = m[2] === 'reject' ? core.cards.get(m[1]) : null;
      const r = m[2] === 'confirm' ? await core.confirm(m[1], values) : core.reject(m[1]);
      if (r.code === 'refused') throw new HttpError(400, r.error);
      // He declined her card: one correction of that kind of decision (her tool's name).
      if (before && r.ok) noteCorrection(ctx.config(), { kind: 'declined', about: { decision: String(before.tool || '').replace(/[^a-z0-9_]/gi, '_').slice(0, 60) || 'card' } });
      const card = core.cards.get(m[1]);
      if (card) {
        const c = convs.get(card.conversation);
        if (c) push(c, { kind: 'card', card: card.id, status: card.status, ok: !!r.ok, error: r.ok ? null : r.error || null, ...(r.view ? { view: r.view } : {}) });
      }
      if (!r.ok && m[2] === 'confirm') throw Object.assign(new HttpError(409, r.error || 'the card did not run'), { details: { code: r.code || null, ...(Number.isFinite(r.expiresAt) ? { expiresAt: r.expiresAt } : {}) } });
      return { ok: true, card, ...(r.open ? { open: r.open } : {}) };
    }],
    // The dynamic cards on the owner's screen, as they are now: one request per tick of the page's own poller, for every
    // card in view at once (web/tiacards.js). Only cards of a conversation of this dashboard; unknown ids come back null.
    ['POST', /^\/api\/assistant\/views$/, async (req) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      if (!Array.isArray(b.ids) || b.ids.length > 40 || b.ids.some((x) => typeof x !== 'string' || !/^v_[0-9a-f]{12}$/.test(x))) throw new HttpError(400, 'ids: up to 40 card ids');
      const ids = [...new Set(b.ids)].filter((id) => {
        const v = core.views.get(id);
        return v && convs.has(v.conversation) && DYNAMIC.includes(v.card.kind);
      });
      const cards = await core.refreshViews(ids);
      return { cards: Object.fromEntries(b.ids.map((id) => [id, cards[id] || null])), at: Date.now() };
    }],
    // Undo on a result card: only the act the card is about, only while it is still her newest one, once.
    ['POST', /^\/api\/assistant\/views\/(v_[0-9a-f]{12})\/undo$/, async (req, m) => {
      ownerOnly(req);
      await ctx.readJson(req);
      const v = core.views.get(m[1]);
      if (!v || !convs.has(v.conversation)) throw new HttpError(404, 'there is no such card');
      const r = await core.undoView(m[1]);
      if (!r.ok) throw Object.assign(new HttpError(409, r.error), { details: { code: r.code, card: r.card || null } });
      return { ok: true, card: r.card };
    }],
    ['GET', /^\/api\/assistant\/jobs$/, async (req) => {
      ownerOnly(req);
      return { jobs: core.jobs.list().slice(0, 50) };
    }],
    ['POST', /^\/api\/assistant\/jobs\/(j_[0-9a-f]{10})\/stop$/, async (req, m) => {
      ownerOnly(req);
      await ctx.readJson(req);
      const r = core.stopJob(m[1]);
      if (!r.ok) throw new HttpError(404, r.error);
      return { ok: true, job: core.jobs.get(m[1]) };
    }],
    ['GET', /^\/api\/assistant\/audit$/, async (req, m, q) => {
      ownerOnly(req);
      return { entries: audit.recent(Math.max(1, Math.min(500, Number(q.get('n')) || 100))).reverse() };
    }],
    ['GET', /^\/api\/assistant\/settings$/, async (req) => {
      ownerOnly(req);
      return settingsView();
    }],
    ['POST', /^\/api\/assistant\/settings$/, async (req) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      const accounts = await accountsNow();
      let patch;
      try {
        const choices = tiaChoices(accounts);
        patch = cleanTiaPatch(b, choices.map((p) => p.name), choices.filter((p) => servesTool(p, 'claude')).map((p) => p.name), hubComputers().map((m) => m.name));
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      // Her ticks ("Use other providers") only among the providers she may use, as the save leaves them: a tick on one
      // she may not use is refused, and a tick left on one the owner unticks from her list goes (it never comes back by
      // itself when he allows that provider again).
      const allowedAfter = resolveTia({ ...raw(), ...patch }, accounts).allowed;
      if (patch.others) {
        const out = patch.others.find((n) => !allowedAfter.includes(n));
        if (out) throw new HttpError(400, `"${out}" is not a provider she may use: tick it under "Providers she may use" first`);
      } else if (Array.isArray(raw().others)) patch.others = raw().others.filter((n) => allowedAfter.includes(n));
      // Activity lists what the owner changed, not every value the page sends again with Save.
      const was = { ...TIA_DEFAULTS, ...raw() };
      const same = (k, v) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v ?? null) === JSON.stringify(Array.isArray(was[k]) ? [...was[k]].sort() : was[k] ?? null);
      const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !same(k, v)));
      ctx.saveConfig({ assistant: { ...raw(), ...patch } });
      if (Object.keys(changed).length) audit.append({ actor: 'owner', conversation: '-', tool: 'tia_settings', level: 'L1', input: changed, outcome: 'done' });
      if (patch.enabled === false) for (const c of convs.values()) c.engine?.stop();
      return settingsView();
    }],
    ['POST', /^\/api\/assistant\/client-token$/, async (req) => {
      ownerOnly(req);
      await ctx.readJson(req);
      // Her tools answer a client only while she is on (the call route says tia-off): a token made now would not work.
      if (!enabled()) throw Object.assign(new HttpError(409, `Turn ${ASSISTANT_NAME} on first (Settings → ${ASSISTANT_NAME}): your Claude Code can use ${ASSISTANT_NAME}'s tools only while she is on`), { details: { code: 'tia-off' } });
      const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
      ctx.saveConfig({ assistant: { ...raw(), clientToken: { hash: sha256(token), created: Date.now() } } });
      audit.append({ actor: 'owner', conversation: '-', tool: 'client_token', level: 'L1', input: {}, outcome: 'done' });
      // The one command to add the server to the owner's own Claude Code (user scope, so every folder has it).
      const port = address ? new URL(address).port : '';
      const envs = [`HOPRIG_ASSISTANT_TOKEN=${token}`, ...(address ? [`HOPRIG_DASHBOARD_URL=http://127.0.0.1:${port}`] : [])];
      return { token, command: `claude mcp add --scope user ${envs.map((e) => `-e ${e}`).join(' ')} hoprig -- hoprig mcp` };
    }],
    ['POST', /^\/api\/assistant\/client-token\/revoke$/, async (req) => {
      ownerOnly(req);
      await ctx.readJson(req);
      const { clientToken, ...rest } = raw();
      ctx.saveConfig({ assistant: rest });
      return { revoked: !!clientToken };
    }],
    // run_command on this computer for another dashboard (the hub) or the owner. The machines gate lets machine
    // tokens through to this one path only; Tia's own token never gets here (it is not a machine token).
    ['POST', /^\/api\/assistant\/run$/, async (req) => {
      const b = await ctx.readJson(req);
      try {
        return await ops.runHere({ command: b.command, cwd: typeof b.cwd === 'string' ? b.cwd : null, timeoutMs: b.timeoutMs });
      } catch (e) {
        throw new HttpError(e.status || 400, e.message);
      }
    }],
  ];

  /** Tia's own token, and the event stream; everything else goes on to the machines gate and the routes. */
  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return false;
    }
    const p = url.pathname;
    const bearer = bearerOf(req);
    const kind = tokenKind(bearer);
    if (kind) {
      // Her token reaches exactly one route.
      if (p !== '/api/assistant/call' || req.method !== 'POST') {
        sendJson(res, 403, { error: `${ASSISTANT_NAME}'s token only reaches /api/assistant/call`, code: 'token-scope' });
        return true;
      }
      if (!enabled()) {
        sendJson(res, 403, { error: `${ASSISTANT_NAME} is turned off`, code: 'tia-off' });
        return true;
      }
      try {
        const b = await readBody(req);
        const h = String(req.headers[CONVERSATION_HEADER.toLowerCase()] || 'direct');
        const conversation = CONV_RE.test(h) ? h : 'direct';
        const r = await core.call(b.tool, b.args, { conversation: kind === 'client' ? `client-${conversation}`.slice(0, 64) : conversation, actor: 'assistant' });
        // Progress she read in a turn of hers: its lines go under her reply (progressAnswerOf).
        const own = kind !== 'client' ? convs.get(conversation) : null;
        if (own && own.turn && r.ui && Array.isArray(r.ui.progress)) own.turn.progress = r.ui.progress;
        sendJson(res, 200, { text: r.text, isError: r.isError });
      } catch (e) {
        sendJson(res, e.status || 500, { error: e.message });
      }
      return true;
    }
    if (p === '/api/assistant/call' && req.method === 'POST' && bearer === null) {
      sendJson(res, 401, { error: `/api/assistant/call needs ${ASSISTANT_NAME}'s token` });
      return true;
    }
    if (p === '/api/assistant/stream' && req.method === 'GET') {
      if (bearer !== null || !ctx.authed(req)) {
        sendJson(res, 401, { error: 'log in first' });
        return true;
      }
      const id = url.searchParams.get('conversation') || '';
      const c = CONV_RE.test(id) ? convs.get(id) : null;
      if (!c) {
        sendJson(res, 404, { error: 'no such conversation' });
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (e) => res.write(`id: ${e.i}\ndata: ${JSON.stringify(e)}\n\n`);
      for (const e of since(c, Math.max(0, Number(url.searchParams.get('from')) || 0))) send(e);
      c.listeners.add(send);
      const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(beat);
        c.listeners.delete(send);
      });
      return true;
    }
    return false;
  }

  let unsubscribe = null;
  return {
    name: 'assistant',
    routes,
    handle,
    core,
    ops,
    conversations: convs,
    tokenKind,
    start() {
      rotateToken();
      if (!address) address = ownAddress();
      unsubscribe = ctx.onTick((cards) => onTick(cards));
    },
    /** The address her MCP server calls (the server sets it once it listens; tests set it). */
    setAddress(url) {
      address = url;
    },
    close() {
      unsubscribe?.();
      for (const c of convs.values()) c.engine?.cleanup();
      try {
        fs.rmSync(tokenFile(), { force: true });
      } catch {
        /* gone */
      }
    },
    usageFile,
    stateDir,
  };
}
