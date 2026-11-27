// The door of "Use other providers" (src/models/others.mjs): POST /api/parts, reached only with the token of one Lead
// session (Authorization: Bearer hpt_…, made at that session's start, kept in a file of the state folder, mode 600).
// It is the ONE product function behind the lead's tool hand_part: "start a session for this part on that provider".
// Every call is checked again here from the dashboard's own record of the session (its ticks, Tia's settings for a
// chat of hers, the provider's limit, billing by use, the computer's limit), never from what the model says. A part
// is an App session on that provider in the same folder, without Lead, so the owner can watch it; its answer goes back
// to the lead as fenced data. Nothing here runs by itself: only a call of the lead starts anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAutoSwitch } from '../autoswitch.mjs';
import { binFile, stateDir } from '../paths.mjs';
import { listProfiles, publicProfile, readProfile } from '../profiles.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { readSettings } from '../automation/settings.mjs';
import { resolveTia } from '../assistant/tia.mjs';
import { fenceData } from '../assistant/fence.mjs';
import { ledger as keptLedger } from '../operator/money.mjs';
import { partShare } from '../assistant/spend.mjs';
import { ALL, BYPASS, bypassAllowed } from '../bypassgate.mjs';
import { partGate, ticksOf } from './others.mjs';
import { KINDS, effortFor } from './tiers.mjs';
import { modelsFor } from './catalog.mjs';
import { leadPlan } from './lead.mjs';

const TOKEN_RE = /^hpt_[a-f0-9]{48}$/;
const BODY_MAX = 64 * 1024;
const PARTS_MAX = 50; // per lead session
// How long the lead's "result" call waits for the owner's answer to a part's card before it closes the card for good.
export const ASK_WAIT_MS = 60_000;
export const LEAD_DID_IT = 'No one answered in time, so the lead did this part itself. Nothing was started.';
export const LEAD_WENT_ON = 'The lead went on without it. Nothing was started.';
export const YES_KEPT = 'Your yes is kept: the part starts when the lead asks for it. If the lead goes on without it, nothing starts.';
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const bearer = (req) => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
};
const dirOf = () => path.join(stateDir(), 'part-servers');
const FILE_RE = /^[0-9A-Za-z-]{1,100}\.(token|json)$/;
const kindLabel = (k) => ((KINDS.kinds.find((x) => x.id === k) || {}).label || 'a part of the work').toLowerCase();
/** A chat's token and config file, gone (the chat ended or went to the trash). */
function removeFiles(id) {
  for (const ext of ['token', 'json']) fs.rmSync(path.join(dirOf(), `${id}.${ext}`), { force: true });
}
/** Where this dashboard listens (dashboard.json, written as it starts), as Tia's MCP server finds it. */
function ownAddress() {
  const d = runningDashboard();
  if (!d || d.pid !== process.pid) return null;
  const host = ['0.0.0.0', '::', ''].includes(d.host) ? '127.0.0.1' : d.host.includes(':') ? `[${d.host}]` : d.host;
  return `http://${host}:${d.port}`;
}

/**
 * o: { chat (the chat feature: open, peek, notice, event, recordOf), config(), readJson(req), url() (this dashboard's
 * address), aloneRunning() (Work's runs that end by themselves, running now on this dashboard), now }. → a feature
 * { name, handle, routes, start, configFor(chat) → the --mcp-config file or null, setAddress(url), running() }.
 */
export function partDoor(o) {
  const now = o.now || Date.now;
  // Tia's one ledger of paid use (src/assistant/spend.mjs), the file in this state folder; `o.spend`: tests only.
  const ledger = () => o.spend || keptLedger();
  const askWaitMs = o.askWaitMs ?? ASK_WAIT_MS;
  const waiting = new Map(); // part id → [resolve()] of the lead's result calls that wait for the owner's answer
  const taking = new Map(); // part id → the start of a part the owner said yes to, while it runs (one start at most)
  const wake = (id) => {
    for (const f of waiting.get(id) || []) f();
    waiting.delete(id);
  };
  let address = null;
  const tokens = new Map(); // token → chat id
  const parts = new Map(); // part id → { chat (the lead's), id (the part's chat), provider, at, asked?, said? }
  const startedAt = now(); // parts handed before this dashboard started are not known here (said once in such a chat)
  const followed = new Set(); // chats whose end removes their token and config file
  // Parts that run now: opened or opening. Waiting for the owner's OK is not running.
  const runningParts = () => [...parts.values()].filter((p) => p.opening || (p.id && (o.chat.peek(p.id) || {}).busy)).length;

  /** Facts the gate needs, looked up here. */
  const facts = (rec) => {
    const cfg = o.config();
    const auto = getAutoSwitch();
    const tia = rec.byTia ? resolveTia(cfg.assistant, { profiles: listProfiles().map(publicProfile), autoSwitch: auto }) : null;
    // The computer's one measure of slots ("runs by themselves at once", as Work's runs): every session that runs by
    // itself here counts, Work's runs and these parts. A part being opened counts: its slot is taken before the await,
    // so two calls at once cannot both pass.
    const running = runningParts() + (o.aloneRunning ? Number(o.aloneRunning()) || 0 : 0);
    // Billed by use is allowed only by the owner's own choice: Auto mode on and "also use pay-per-use API keys" set. The
    // value getAutoSwitch infers from the order list (never chosen) is not a choice, and Auto mode off allows nothing.
    const raw = cfg.autoSwitch && typeof cfg.autoSwitch === 'object' ? cfg.autoSwitch : {};
    return { tia, running, atOnce: readSettings(cfg.automation).schedules.atOnce, paidOk: auto.enabled === true && raw.payPerUse === true, now: now() };
  };

  /**
   * The mode a part opens in: never more than the lead's. The lead's own mode where the owner may start a session in
   * it on this computer now (bypass only while "Allow bypass permissions mode" is on), else Manual. A lead with no mode
   * of its own gives Manual too, never Settings' default (that may be more than the lead has).
   */
  const partMode = (rec) => {
    // A part never runs in Allow everything (it is the owner's own choice on his page): in Bypass at most.
    const m = rec.permissionMode === ALL ? BYPASS : rec.permissionMode || 'manual';
    return m === BYPASS && !bypassAllowed(o.config()) ? 'manual' : m;
  };

  async function start(rec, b) {
    const provider = b.provider;
    if (typeof b.brief !== 'string' || !b.brief.trim() || b.brief.length > 8000) return { isError: true, text: 'Error: give the part\'s brief: plain words, up to 8000 characters.' };
    if (b.kind !== undefined && !KINDS.kinds.some((k) => k.id === b.kind)) return { isError: true, text: `Error: kind is one of ${KINDS.kinds.map((k) => k.id).join(', ')}.` };
    if ([...parts.values()].filter((p) => p.chat === rec.id).length >= PARTS_MAX) return { isError: true, text: `Error: this session handed ${PARTS_MAX} parts already. Do the rest yourself.` };
    const f = facts(rec); // read once: the gate and the part's share of the limit see the same numbers
    let g = partGate(rec, provider, f);
    const label = (readProfile(provider) || {}).label || provider;
    // A part of Tia's at Hands off on a provider billed by use: by itself only inside her daily limit for paid use. The
    // check and the hold in one step (spend.take), with no await before the part's slot is taken; no room: a card.
    // The hold is the part's budget: its share of what is left and not held (spend.partShare: divided among the parts
    // that may still run at once), so the budgets of the parts that run at one moment never sum past what was left.
    let hold = null;
    let short = null; // the ledger's sentence when the limit has too little left for this part
    if (g.ok && g.hold) {
      hold = `part-${crypto.randomBytes(6).toString('hex')}`;
      const why = ledger().take(g.hold, { id: hold, amount: (t) => partShare(g.hold, t, f.atOnce) });
      if (why) {
        hold = null;
        short = why;
        g = { card: `the provider "${provider}" is billed by use, and ${why}: the owner's OK comes first` };
      }
    }
    if (g.card) {
      // Billed by use and not allowed for work that goes on by itself: ONE card in the lead's chat, and the part
      // starts only at his yes (answer below). Nothing starts meanwhile.
      const id = `p_${crypto.randomBytes(5).toString('hex')}`;
      parts.set(id, { chat: rec.id, id: null, provider, at: now(), asked: true, brief: b.brief, kind: b.kind || null });
      o.chat.event(rec.id, { kind: 'part-ask', part: id, provider, label, partKind: kindLabel(b.kind), brief: b.brief.replace(/\s+/g, ' ').slice(0, 300) });
      return { text: `Waiting for the owner's OK: ${label} is billed by use${short ? `, and ${short}` : ''}. Part ${id} starts there only when he says yes. Do not do this part meanwhile: call action "result" with part "${id}"; it waits up to a minute for his answer. If he says no or does not answer, you do the part yourself (his card is closed then, so it is never done twice).` };
    }
    if (g.refuse) {
      if (/at its limit/.test(g.refuse)) o.chat.notice(rec.id, 'info', `A part for ${label} was skipped: that provider is at its limit.`);
      return { isError: true, text: `Not started: ${g.refuse}.` };
    }
    const id = `p_${crypto.randomBytes(5).toString('hex')}`;
    let r;
    try {
      // Its budget: the size of its own hold (spend.heldFor), so the part's own turns stop inside its share rather than
      // only being counted after they ran.
      r = await openPart(rec, id, { provider, brief: b.brief, kind: b.kind || null, ...(hold ? { budgetUsd: ledger().heldFor(hold) } : {}) });
    } catch (e) {
      if (hold) ledger().spent(0, 'part', hold); // nothing started: its hold is given back
      throw e;
    }
    if (hold) {
      // Nothing started: its hold is given back (spent by id at $0). Started: the part's own chat is measured from now
      // (spend.mjs measureChats, at Tia's ticks), and its reported cost takes the place of the hold.
      if (r.isError) ledger().spent(0, 'part', hold);
      else ledger().bind(hold, `this|chat:${parts.get(id).id}`, 0, true);
    }
    return r.isError ? r : { text: `Started part ${id} on ${provider}. Ask for its result with action "result" and part "${id}".` };
  }

  /**
   * The model and effort a part of `kind` runs at on `provider`: its kind's tier of that provider's own list (the
   * picker's shared ask, kept ten minutes; asked here only when a part starts), never the lead's choice. A part without
   * a kind is "writing and reviewing code" (coder). No list to be had: the provider's own default.
   */
  async function kindModel(provider, kind) {
    const k = KINDS.kinds.find((x) => x.id === (kind || 'coder'));
    await (o.models || modelsFor)(provider).catch(() => null);
    const plan = leadPlan(provider);
    const model = plan.tiers ? plan.tiers[k.tier] || null : null;
    return model ? { model, ...(effortFor(k, plan.tiers) ? { effort: effortFor(k, plan.tiers) } : {}) } : {};
  }

  /** Open part `id` as a session of its own on `provider`. → { ok } | { isError, text } */
  async function openPart(rec, id, { provider, brief, kind, budgetUsd = null }) {
    const label = (readProfile(provider) || {}).label || provider;
    // The slot is taken now (see facts) and given back if the session does not start.
    parts.set(id, { chat: rec.id, id: null, provider, at: now(), opening: true, kind });
    let opened;
    try {
      const runAt = await kindModel(provider, kind);
      // A session of its own, in the lead's folder (its project's extra folders and the lead's "Also open" with it),
      // under the same hook as every chat, in the lead's mode as allowed now (partMode); never a lead itself.
      opened = await o.chat.open({ dir: rec.cwd, tool: 'claude', profile: provider, text: brief, lead: false, defaults: true, ...runAt, permissionMode: partMode(rec), ...(Array.isArray(rec.withs) && rec.withs.length ? { with: [...rec.withs] } : {}), title: `Part: ${brief.replace(/\s+/g, ' ').slice(0, 60)}` }, budgetUsd ? { maxBudgetUsd: budgetUsd } : {});
    } catch (e) {
      parts.delete(id);
      throw e;
    }
    if (!opened.sent) {
      parts.delete(id);
      return { isError: true, text: `Not started: ${opened.why || 'the session did not take the brief'}.` };
    }
    parts.set(id, { chat: rec.id, id: opened.id, provider, at: now(), kind });
    o.chat.notice(rec.id, 'info', `A part went to ${label}: open it from Home to watch it.`);
    return { ok: true };
  }

  /** The owner's answer to a part's card: yes opens it (the other checks again, now); no leaves it to the lead. */
  async function answer(partId, allow) {
    const p = parts.get(partId);
    if (!p || !p.asked) throw Object.assign(new Error('there is no such question'), { status: 404 });
    // Closed for good when the lead was told to do it itself: a press now starts nothing, and says so.
    if (p.said === 'lead') throw Object.assign(new Error(LEAD_DID_IT), { status: 409 });
    if (p.said === 'gone') throw Object.assign(new Error(LEAD_WENT_ON), { status: 409 });
    if (p.said || p.yes) throw Object.assign(new Error('that question was already answered'), { status: 409 });
    const rec = o.chat.recordOf(p.chat);
    if (!rec) throw Object.assign(new Error('the session that asked is not open any more'), { status: 409 });
    if (!allow) {
      p.said = 'no';
      o.chat.event(p.chat, { kind: 'part-ask-closed', part: partId, outcome: 'no' });
      wake(partId);
      return { ok: true, started: false };
    }
    // A yes never starts a part by itself: it is kept (set before any wait, so a second press is refused), and the part
    // starts only when the lead's "result" call is there to take it. One waits now: the part starts now, for it.
    p.yes = true;
    if (!waiting.has(partId)) {
      o.chat.event(p.chat, { kind: 'part-ask-kept', part: partId });
      return { ok: true, started: false, kept: true };
    }
    await takeYes(partId);
    wake(partId);
    const q = parts.get(partId);
    return { ok: true, started: !!(q && q.id), ...(q && q.why ? { why: q.why } : {}) };
  }

  /**
   * Start part `id` the owner said yes to, for the lead's "result" call that takes it. His yes covers the billing only:
   * the ticks, Tia's providers, the limit and the computer's slots are checked again now. At most once: two calls at
   * the same moment get the same start.
   */
  function takeYes(id) {
    if (taking.has(id)) return taking.get(id);
    const p = parts.get(id);
    if (!p || !p.yes || p.said || p.id) return Promise.resolve();
    const run = (async () => {
      const refuse = (why) => {
        parts.set(id, { ...p, said: 'refused', why });
        o.chat.event(p.chat, { kind: 'part-ask-closed', part: id, outcome: 'refused', why });
      };
      const rec = o.chat.recordOf(p.chat);
      if (!rec) return refuse('the session that asked is not open any more');
      const g = partGate(rec, p.provider, { ...facts(rec), ownerYes: true });
      if (g.refuse) return refuse(g.refuse);
      const r = await openPart(rec, id, { provider: p.provider, brief: p.brief, kind: p.kind });
      if (r.isError) return refuse(r.text);
      // A part of Tia's started by his yes is a paid act from his tap: counted in today's sum at once (spend.tapped,
      // never checked against the limit, no budget: his yes is his decision), and its chat is bound, so what it was
      // measured to cost stands in today's sum in place of the $0.50, as for her other acts that went into a chat.
      if (rec.byTia) {
        const tap = `part-${crypto.randomBytes(6).toString('hex')}`;
        ledger().tapped(tap);
        ledger().bind(tap, `this|chat:${parts.get(id).id}`, 0, true);
      }
      Object.assign(parts.get(id), { asked: true, yes: true, said: 'yes' });
      o.chat.event(p.chat, { kind: 'part-ask-closed', part: id, outcome: 'yes' });
    })().finally(() => taking.delete(id));
    taking.set(id, run);
    return run;
  }

  /** The lead's turn ended (or its chat): a card still open, a kept yes among them, is closed for good, nothing started. */
  function closeAsked(chatId) {
    for (const [k, p] of parts) {
      if (p.chat !== chatId || !p.asked || p.said || p.id || taking.has(k)) continue;
      p.said = 'gone';
      wake(k);
      o.chat.event(chatId, { kind: 'part-ask-closed', part: k, outcome: 'gone' });
    }
  }

  /** Chat `id` ended (closed, deleted, replaced): its token, its files and its unanswered questions go. */
  function forget(id) {
    for (const [t, c] of tokens) if (c === id) tokens.delete(t);
    for (const [k, p] of parts) {
      if (p.chat === id && p.asked && !p.said) {
        parts.delete(k);
        wake(k);
      }
    }
    followed.delete(id);
    try {
      removeFiles(id);
    } catch {
      /* gone already */
    }
  }

  /**
   * The lead asks for a part that waits for the owner's card: it waits up to askWaitMs for his answer. No answer by
   * then: the card is closed for good in the same step (nothing can start it any more), and the lead does the part.
   */
  async function waitForOwner(id) {
    const p = parts.get(id);
    if (!p || !p.asked || p.said || p.id) return;
    if (!p.yes) {
      await new Promise((resolve) => {
        const done = () => (clearTimeout(timer), resolve());
        const timer = setTimeout(() => {
          const list = (waiting.get(id) || []).filter((f) => f !== done);
          if (list.length) waiting.set(id, list);
          else waiting.delete(id);
          resolve();
        }, askWaitMs);
        timer.unref?.();
        waiting.set(id, [...(waiting.get(id) || []), done]);
      });
    }
    if (taking.has(id)) await taking.get(id);
    const q = parts.get(id);
    if (!q || !q.asked || q.said || q.id) return;
    // His yes, kept or given while this call waited: the lead is here to take it, so the part starts now.
    if (q.yes) return void (await takeYes(id));
    q.said = 'lead';
    wake(id);
    o.chat.event(q.chat, { kind: 'part-ask-closed', part: id, outcome: 'lead' });
  }

  async function result(rec, b) {
    if (typeof b.part === 'string' && parts.get(b.part) && parts.get(b.part).chat === rec.id) await waitForOwner(b.part);
    const p = typeof b.part === 'string' ? parts.get(b.part) : null;
    if (!p || p.chat !== rec.id || p.opening) return { isError: true, text: 'Error: this session handed no such part (a part handed before the dashboard restarted is not followed any more: the owner finds it on Home).' };
    if (p.asked && !p.id) {
      const said = p.said === 'lead' ? 'the owner did not answer in time, so his card is closed: do the part yourself and say so.'
        : p.said === 'gone' ? 'your turn ended before it started, so the card is closed and nothing was started: do the part yourself if it is still needed.'
          : p.said === 'refused' ? `it could not start (${String(p.why || 'refused').slice(0, 200)}): do the part yourself and say so.`
        : p.said === 'no' ? 'the owner said no: do the part yourself and say so.'
          : 'it could not start: do the part yourself and say so.';
      return { text: `Part ${b.part} on ${p.provider}: ${said}` };
    }
    const s = o.chat.peek(p.id);
    const state = !s ? 'closed' : s.busy || s.pending ? 'working' : s.lastEnd || 'working';
    return { text: `Part ${b.part} on ${p.provider}: ${state}.${state === 'working' ? ' Ask again later.' : ''}\n${fenceData({ tool: 'hand_part' }, { part: b.part, provider: p.provider, state, answer: state === 'working' ? '' : String((s && s.lastText) || '').slice(0, 20_000) })}` };
  }

  return {
    name: 'parts',
    /** At the dashboard's start: the files of an earlier run of it are useless (its tokens were in memory): removed. */
    start() {
      let names = [];
      try {
        names = fs.readdirSync(dirOf());
      } catch {
        return;
      }
      for (const n of names) if (FILE_RE.test(n)) fs.rmSync(path.join(dirOf(), n), { force: true });
    },
    /** The parts chat `id` handed to other providers that opened: [{ id (the part's chat), provider, kind }]. */
    handedOf: (id) => [...parts.values()].filter((p) => p.chat === id && p.id).map((p) => ({ id: p.id, provider: p.provider, kind: p.kind || null })),
    /** Parts that run now (Work's runs count them as taken slots too). */
    running: () => runningParts(),
    routes: [
      ['POST', /^\/api\/parts\/(p_[0-9a-f]{10})\/answer$/, async (req, m) => {
        const b = o.readJson ? await o.readJson(req) : {};
        if (typeof b.allow !== 'boolean') throw Object.assign(new Error('say allow: true or false'), { status: 400 });
        return answer(m[1], b.allow);
      }],
    ],
    setAddress(url) {
      address = url;
    },
    /** The --mcp-config file for a Lead chat with ticks (a fresh token at every start), or null. */
    configFor(c) {
      if (!c.lead || !ticksOf(c.others).length) return null;
      const url = address || (o.url ? o.url() : ownAddress());
      if (!url) return null;
      for (const [t, id] of tokens) if (id === c.id) tokens.delete(t);
      // Its end removes what this made for it (a chat is an event emitter; a stand-in may not be one).
      if (!followed.has(c.id) && typeof c.once === 'function') {
        followed.add(c.id);
        c.once('closed', () => forget(c.id));
        // The lead's turn that asked for a part ended: its open cards close for good (a yes after that starts nothing).
        c.on('turn', () => closeAsked(c.id));
        // Opened before this dashboard started: what it handed then is not known here. Said once, in plain words.
        if (Number.isFinite(c.openedAt) && c.openedAt < startedAt && typeof c.push === 'function') c.push({ kind: 'notice', level: 'info', text: 'The dashboard restarted: parts this session handed before are no longer followed here. Their sessions are still on Home.' });
      }
      const token = `hpt_${crypto.randomBytes(24).toString('hex')}`;
      tokens.set(token, c.id);
      fs.mkdirSync(dirOf(), { recursive: true, mode: 0o700 });
      const tokenFile = path.join(dirOf(), `${c.id}.token`);
      fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
      const file = path.join(dirOf(), `${c.id}.json`);
      const cfg = { mcpServers: { 'hoprig-parts': { type: 'stdio', command: process.execPath, args: [binFile(), 'mcp', '--parts'], env: { HOPRIG_DASHBOARD_URL: url, HOPRIG_PART_TOKEN_FILE: tokenFile } } } };
      fs.writeFileSync(file, `${JSON.stringify(cfg)}\n`, { mode: 0o600 });
      return file;
    },
    /** The mode a part of chat record `rec` would open in now (for the line under the switch and the tests). */
    modeFor: (rec) => partMode(rec),
    async handle(req, res) {
      const t = bearer(req);
      if (!t || !t.startsWith('hpt_')) return false;
      const id = TOKEN_RE.test(t) ? tokens.get(t) : null;
      const p = String(req.url || '').split('?')[0];
      if (!id) return send(res, 401, { error: 'unknown part token' }), true;
      if (p !== '/api/parts' || req.method !== 'POST') return send(res, 403, { error: 'a part token only reaches POST /api/parts' }), true;
      let b;
      try {
        b = await new Promise((resolve, reject) => {
          let size = 0;
          const chunks = [];
          req.on('data', (x) => {
            size += x.length;
            if (size <= BODY_MAX) return void chunks.push(x);
            reject(new Error('too large'));
            req.destroy(); // nothing more is read of it
          });
          // A body that is not JSON is the caller's error, never a throw outside this promise (it would end the dashboard).
          req.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch (e) {
              reject(e);
            }
          });
          req.on('error', reject);
        });
      } catch {
        return send(res, 400, { error: 'send JSON' }), true;
      }
      const rec = o.chat.recordOf(id);
      if (!rec) return send(res, 200, { isError: true, text: 'Error: this session is not open any more.' }), true;
      try {
        const r = b.action === 'start' ? await start(rec, b) : b.action === 'result' ? await result(rec, b) : { isError: true, text: 'Error: action is "start" or "result".' };
        send(res, 200, r);
      } catch (e) {
        send(res, 200, { isError: true, text: `Error: ${String(e.message).slice(0, 200)}. Do the part yourself.` });
      }
      return true;
    },
  };
}
