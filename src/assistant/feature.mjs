// Tia in the dashboard: one feature (server.mjs features list). It hosts the core (core.mjs) on the real
// operations (ops.mjs), runs her engine per conversation (engine.mjs), drives her jobs from the watcher, and
// answers these routes:
//
//   Tia's token only (bearer, "tia_…")
//     POST /api/assistant/call                 { tool, args } → { text, isError }   (403 { code: "tia-off" } when off)
//   the owner's login (cookie) only — bearer tokens never reach them (machines gate + not trusted here)
//     GET  /api/assistant                      overview: on/off, ready or what to do, conversations, cards, jobs
//     POST /api/assistant/chat                 { conversation?, text } → { conversation }   (the turn runs after)
//     GET  /api/assistant/chat/<id>?from=N     { events, next, busy }   events since N (the page polls / streams)
//     GET  /api/assistant/stream?conversation=<id>&from=N   the same as Server-Sent Events
//     GET  /api/assistant/cards                POST /api/assistant/cards/<id>/confirm | /reject
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
import { createAssistantCore } from './core.mjs';
import { Engine } from './engine.mjs';
import { createOps, runShell as realRunShell } from './ops.mjs';
import { systemPrompt } from './prompt.mjs';
import { ASSISTANT_NAME, DEFAULTS as TIA_DEFAULTS, HELP, LEVELS, cleanTiaPatch, resolveTia, savedTiaChoice, servesTool, tiaChoices } from './tia.mjs';
import { readUsage, recordUsage, summarizeUsage, turnUsage, usageFile } from './usage.mjs';

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
const EVENTS_MAX = 2000;
const CONVS_MAX = 30;
const TOKEN_PREFIX = 'tia_';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
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
  const core = createAssistantCore({ ops, ...(o.now ? { now: o.now } : {}), ...(o.core || {}) });
  const audit = core.audit || new AuditLog();
  const HttpError = ctx.HttpError;
  const raw = () => {
    const a = ctx.config().assistant;
    return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  };
  // Off until the owner turns her on (she costs money): the same default Settings → Tia shows (resolveTia).
  const enabled = () => ({ ...TIA_DEFAULTS, ...raw() }).enabled !== false;
  let serverToken = null;
  let address = o.url || null; // set in start(): where this dashboard listens

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
  const since = (c, from) => c.events.filter((e) => e.i >= from);

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
    const tia = resolveTia(raw(), await accountsNow());
    if (!tia.runsOn) return { ok: false, problem: `No provider can run ${ASSISTANT_NAME}. Add a provider, or choose one under Settings → ${ASSISTANT_NAME} → "${ASSISTANT_NAME} runs on".` };
    return { ok: true, problem: null, runsOn: tia.runsOn, model: tia.model, level: tia.level };
  }

  /** One turn of conversation `c`: the owner's message or a job wake-up. Queued: turns of one conversation never overlap. */
  function turn(c, text, { origin = 'owner', job = null, mode = null } = {}) {
    const run = async () => {
      // A wake-up queued behind a turn in which she already finished (or the owner stopped) the job: nothing to do.
      if (origin === 'job' && job && !['working', 'waiting'].includes(core.jobs.get(job)?.state)) return;
      const ready = await readiness();
      if (!ready.ok) {
        push(c, { kind: 'notice', text: ready.problem });
        return;
      }
      c.busy = true;
      // Card outcomes since her last turn come first, so she knows what the owner decided.
      const outcomes = core.takeOutcomes(c.id).map((x) => x.text);
      const message = outcomes.length ? `[What happened since your last turn]\n${outcomes.join('\n')}\n\n${text}` : text;
      if (!c.engine || c.engine.o.profile !== ready.runsOn || c.engine.o.model !== (ready.model || null)) {
        c.engine?.cleanup();
        c.engine = new Engine({
          profile: ready.runsOn, model: ready.model || null, conversation: c.id, systemPrompt: systemPrompt(core.skills.index()),
          url: address, tokenFile: tokenFile(), maxBudgetUsd: o.maxBudgetUsd || null, ...(c.engine ? { sessionId: c.engine.sessionId } : {}), ...(o.engine || {}),
        });
        c.engine.on('event', (ev) => {
          // A small model sometimes writes a bare "(empty)" next to a tool call: nothing to show.
          if (ev.kind === 'text') {
            if (ev.text.trim() !== '(empty)') push(c, { kind: 'text', text: ev.text });
          }
          else if (ev.kind === 'tool_call') push(c, { kind: 'tool_call', id: ev.id, tool: ev.name, input: ev.input });
          else if (ev.kind === 'tool_result') {
            const staged = /^Waiting for the owner's OK \(card (c_[0-9a-f]{12})/.exec(ev.text);
            push(c, { kind: 'tool_result', id: ev.id, isError: ev.isError, summary: ev.text.split('\n')[0].slice(0, 300), ...(staged ? { card: staged[1] } : {}) });
          }
        });
      }
      core.beginTurn(c.id, origin === 'job' ? { origin: 'job', job, mode } : { origin: 'owner', text });
      try {
        const r = await c.engine.send(message);
        const d = r.done;
        try {
          recordUsage(turnUsage(d, { conversation: c.id }));
        } catch {
          /* usage is a nice-to-have */
        }
        push(c, { kind: 'done', ok: d.ok, error: d.ok ? null : d.text.slice(0, 300), costUsd: d.costUsd });
      } finally {
        core.endTurn(c.id);
        c.busy = false;
      }
    };
    c.queue = c.queue.then(run, run).catch((e) => push(c, { kind: 'notice', text: `${ASSISTANT_NAME} stopped: ${e.message}` }));
    return c.queue;
  }

  // ---- jobs: the watcher drives them; a wake-up is one turn of the job's conversation ----
  async function onTick(cards) {
    if (!enabled()) return;
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
      levels: LEVELS,
      help: HELP,
      // Only the providers she can use (tiaChoices); `thinks`: she can run on it (it serves Claude Code).
      accounts: [...(accounts.profiles || []).filter((p) => p.virtual), ...tiaChoices(accounts)]
        .map((p) => ({ name: p.name, label: p.label, kind: p.kind, limited: !!p.limited, virtual: !!p.virtual, thinks: servesTool(p, 'claude') })),
      autoOn: !!(accounts.autoSwitch && accounts.autoSwitch.enabled),
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
      const ready = await readiness();
      return {
        name: ASSISTANT_NAME, enabled: enabled(), ready,
        conversations: [...convs.values()].sort((a, b) => b.createdAt - a.createdAt).map((c) => ({ id: c.id, title: c.title, busy: c.busy, events: c.events.length, at: c.createdAt })),
        cards: core.cards.pending(), jobs: core.jobs.list().slice(0, 30),
      };
    }],
    ['POST', /^\/api\/assistant\/chat$/, async (req) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 8000) throw new HttpError(400, 'write a message of 1 to 8000 characters');
      if (b.conversation !== undefined && b.conversation !== null && (typeof b.conversation !== 'string' || !CONV_RE.test(b.conversation))) throw new HttpError(400, 'bad conversation');
      const c = conv(b.conversation || null);
      if (!c.title) c.title = b.text.trim().replace(/\s+/g, ' ').slice(0, 80);
      push(c, { kind: 'owner', text: b.text });
      // The computer the owner is looking at counts as shown to Tia: the page said it, not a screen or a file.
      const cc = b.context && typeof b.context.computer === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(b.context.computer) ? b.context.computer : null;
      if (cc) core.shown.add(c.id, { computer: [cc] });
      turn(c, `${contextLine(b.context)}${b.text}`);
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
      await ctx.readJson(req);
      const r = m[2] === 'confirm' ? await core.confirm(m[1]) : core.reject(m[1]);
      const card = core.cards.get(m[1]);
      if (card) {
        const c = convs.get(card.conversation);
        if (c) push(c, { kind: 'card', card: card.id, status: card.status, ok: !!r.ok, error: r.ok ? null : r.error || null });
      }
      if (!r.ok && m[2] === 'confirm') throw new HttpError(409, r.error || 'the card did not run');
      return { ok: true, card };
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
        patch = cleanTiaPatch(b, choices.map((p) => p.name), choices.filter((p) => servesTool(p, 'claude')).map((p) => p.name));
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      ctx.saveConfig({ assistant: { ...raw(), ...patch } });
      audit.append({ actor: 'owner', conversation: '-', tool: 'tia_settings', level: 'L1', input: patch, outcome: 'done' });
      if (patch.enabled === false) for (const c of convs.values()) c.engine?.stop();
      return settingsView();
    }],
    ['POST', /^\/api\/assistant\/client-token$/, async (req) => {
      ownerOnly(req);
      await ctx.readJson(req);
      // Her tools answer a client only while she is on (the call route says tia-off): a token made now would not work.
      if (!enabled()) throw Object.assign(new HttpError(409, `Turn ${ASSISTANT_NAME} on first: her tools answer your own Claude Code only while she is on`), { details: { code: 'tia-off' } });
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
      if (!address) {
        // Where this dashboard listens: dashboard.json is written just before features start.
        const d = runningDashboard();
        const mine = d && d.pid === process.pid ? d : null;
        const host = !mine || ['0.0.0.0', '::', ''].includes(mine.host) ? '127.0.0.1' : mine.host.includes(':') ? `[${mine.host}]` : mine.host;
        address = `http://${host}:${mine ? mine.port : ctx.config().server.port || 7433}`;
      }
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
