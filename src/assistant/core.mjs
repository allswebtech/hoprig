// Tia's core, run INSIDE the dashboard (phase 2 mounts it on /api/assistant/*). Every tool call from any client
// (Tia's own MCP server, the owner's Claude Code or Claude Desktop through `hoprig mcp`) comes here and is
// handled the same way:
//
//   0. Tia is on                           Settings → Tia off → every call refused
//   1. the tool exists                     unknown → error listing the tools
//   2. strict input validation             unknown keys, wrong types → error naming the field
//   3. no secrets in the input             a key/token/password-shaped value → refused (L3 is never by chat)
//   4. ids were shown                      a session/process/conversation/computer/job id this conversation was
//                                          not shown → error naming the tool to call first
//   5. the account                         a start or move uses an account the owner allowed for Tia, picked by
//                                          tia.mjs chooseAccount() when none is named; anything else is refused
//   6. the level                           policy.mjs, from the owner's level (Ask me / Do the work / Hands off)
//                                          and facts looked up here; L2 only STAGES a confirm card, which runs in
//                                          confirm() — reachable only with the owner's login, never Tia's token
//   7. the turn's rules                    a turn woken by a job may act only on that job's sessions, and each
//                                          answer counts against the job's step cap
//
// The core has no I/O of its own: `ops` is the dashboard (OPS in tools.mjs); the card store, job store, skills
// and audit log are injected so tests can drive every rule.
import { toolOf } from '../automation/cards.mjs';
import { AuditLog } from './audit.mjs';
import { CardError, CardStore } from './cards.mjs';
import { fence, fenceData, neutralize } from './fence.mjs';
import { JobStore } from './jobs.mjs';
import { decideLevel } from './policy.mjs';
import { SchemaError, validate } from './schema.mjs';
import { looksSecret, stringsIn } from './secrets.mjs';
import { FIRST_CALL, LOCAL, ShownIds } from './shown.mjs';
import { Skills } from './skills.mjs';
import { ASSISTANT_NAME, DEFAULTS as TIA_DEFAULTS, chooseAccount, freePct, resolveTia, servesTool } from './tia.mjs';
import { ToolError, TOOL_NAMES, byName, statusOf } from './tools.mjs';
import { wakeMessage } from './jobs.mjs';

const SESSION_TOOLS = new Set(['send_to_session', 'send_to_chat', 'switch_account', 'stop_session']);
// What a job-woken turn may always do: read, tell the owner, finish the job, stage cards (the owner decides).
const WAKE_OK = new Set(['notify_owner', 'finish_job', 'open_screen', 'watch_session']);

/** Turn an id ref from the schema into the ledger key: sessions and pids are per computer. */
// Everything but a computer, a Claude conversation and a job belongs to one computer: its id is kept with it.
const GLOBAL_KINDS = new Set(['computer', 'conversation', 'job', 'address']);

/**
 * Repository addresses the owner wrote himself (https, ssh, git@host:path, owner/name): his own words, so they may be
 * used as an address argument (a restore). Text from a tool result never adds one this way.
 */
export function addressesIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:https?:\/\/|ssh:\/\/|git@)[^\s<>"'`]+|\b[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\b/g)) out.add(m[0].replace(/[.,;:!?)\]]+$/, ''));
  return [...out].slice(0, 50);
}
const refKey = (r, args) => (GLOBAL_KINDS.has(r.kind) ? r.value : `${args.computer || LOCAL}|${r.value}`);
/** A call's usual level: an action tool's depends on its action (toolkit.mjs actionTool). */
const baseLevel = (tool, args) => (tool.levelOf ? tool.levelOf(args) : tool.level);

export function render(result, tool) {
  const parts = [result.summary];
  if (result.data !== undefined) parts.push(fenceData({ tool }, result.data));
  if (result.terminal) parts.push(fence('terminal_output', { session: result.terminal.session }, result.terminal.text));
  if (result.output) parts.push(fence('command_output', { tool }, result.output.text));
  // A brain file and a skill review are someone's text: data, fenced like a screen.
  if (result.file) parts.push(fence('file', { name: result.file.name }, result.file.text, 16_000));
  if (result.review) parts.push(fence('review', { skill: result.review.name }, result.review.text, 16_000));
  if (result.skill) {
    // Skills come from the owner's folder or the shipped pack, never from a session: they are instructions. A
    // forged fence tag inside is still neutralised.
    parts.push(`<skill name="${result.skill.name}">\n${neutralize(result.skill.text, 16_000)}\n</skill>`);
  }
  return parts.join('\n');
}

/** A Map that forgets its oldest entry past `max`. */
class BoundedMap extends Map {
  constructor(max) {
    super();
    this.max = max;
  }
  set(k, v) {
    if (!this.has(k) && this.size >= this.max) this.delete(this.keys().next().value);
    return super.set(k, v);
  }
}

const errorText = (message, next) => `Error: ${message}.${next ? ` Next: ${next}.` : ''}`;

export function createAssistantCore({
  ops,
  now = Date.now,
  cards = new CardStore({ now }),
  audit = new AuditLog({ now }),
  skills = new Skills(),
  shown = new ShownIds(),
  jobs = null,
} = {}) {
  let lastTia = { ...TIA_DEFAULTS };
  jobs ||= new JobStore({ now });
  jobs.settings = () => lastTia; // new jobs take the owner's current caps
  const turns = new Map(); // conversation → { origin: "owner" | "job", job, mode }
  const outcomes = []; // card results waiting to be told to Tia: { conversation, text, card }
  // What a tool showed that a later action of hers relies on (a skill review's name and findings), by computer|id.
  const memo = new BoundedMap(200);

  /** Tia's settings, resolved against the accounts of that computer. */
  async function tiaFor(computer = LOCAL) {
    const raw = (await ops.assistantSettings()) || {};
    const accounts = await ops.accounts({ computer });
    lastTia = resolveTia(raw, accounts);
    return lastTia;
  }

  const ctxFor = (conversation, extra = {}) => ({
    now, conversation, skills, jobs, memo, tia: tiaFor, choose: chooseAccount, freePct, ...extra,
  });

  /** The facts policy.mjs needs, looked up by the dashboard (never taken from the model). */
  async function facts(tool, args) {
    const f = { session: null, mine: false, account: null };
    if (args.session && baseLevel(tool, args) !== 'L0') {
      const list = await ops.listSessions({ computer: args.computer || LOCAL });
      const c = list.find((x) => x.name === args.session && (x.computer || LOCAL) === (args.computer || LOCAL));
      if (c) f.session = { status: statusOf(c), note: c.note || '', account: c.profile ? c.profile.name : null, cwd: c.cwd || null, screen: '', tool: toolOf(c) };
      // A chat (src/chat) has no screen: its card carries the OK it waits for, with what it is really about (the
      // whole command or path, not the model's label of it), whether the chat keeps it for the owner, and its request
      // id (send_to_chat answers that one and no other).
      if (f.session && c.kind === 'chat' && c.ask) {
        f.session.screen = String(c.ask.subject || '');
        f.session.cut = c.ask.cut === true; // only a part of it came: never judged by that part
        f.session.owner = c.ask.owner === true;
        f.session.known = c.ask.known === true; // a call her rules can judge; else (or not said) the OK is the owner's
        f.session.tool = typeof c.ask.tool === 'string' ? c.ask.tool : null; // with its strings, for her allow-list
        f.session.input = c.ask.judged && typeof c.ask.judged === 'object' ? c.ask.judged : null;
        f.session.request = c.ask.request || null;
      }
      // What a permission prompt asks is on the screen, not in the notification: read it, so policy.mjs can judge
      // the request itself (deterministically, not by the model).
      if (f.session && f.session.status === 'needs_ok' && c.kind !== 'chat') {
        try {
          f.session.screen = String(await ops.capture({ computer: args.computer || LOCAL, session: args.session, lines: 15 })).split('\n').slice(-15).join('\n');
        } catch {
          /* gone meanwhile */
        }
      }
      // Hers: a chat by its own mark (a chat id comes back when the owner opens that conversation later, so a mark
      // by name would hand her his chat); a terminal session by the jobs' marks of this very terminal (its name and
      // when it was made: the name of a session that ended is used again).
      f.mine = c && c.kind === 'chat' ? c.byTia === true : !!c && jobs.startedByTia(args.computer || LOCAL, args.session, c.created);
    }
    return f;
  }

  /** start_session / switch_account: fill in the account (Tia's choice when none is named) and its facts. */
  async function pickAccount(tool, args, f, tia) {
    const accounts = await ops.accounts({ computer: args.computer || LOCAL });
    const need = (f.session && f.session.tool) || 'claude'; // the coding tool the provider must serve
    let why = null;
    if (!args.account) {
      const current = f.session && f.session.account;
      const pool = current ? { ...accounts, profiles: (accounts.profiles || []).map((p) => (p.name === current ? { ...p, limited: p.limited || { until: null } } : p)) } : accounts;
      const tiaPool = current ? { ...tia, allowed: tia.allowed.filter((n) => n !== current) } : tia;
      const pick = chooseAccount(tiaPool, pool, need);
      if (pick.error) throw new ToolError(pick.error, 'tell the owner; he can allow more providers in Settings → Tia (open_screen "settings/tia") or wait for a reset');
      args.account = pick.account;
      why = `picked by ${ASSISTANT_NAME}: ${pick.why}`;
    }
    const p = args.account === 'auto' ? { name: 'auto', kind: 'auto' } : (accounts.profiles || []).find((x) => x.name === args.account);
    if (!p) throw new ToolError(`there is no provider "${args.account}"`, 'call get_accounts for the names, or leave account out');
    // A new session or chat of hers runs Claude Code; a session that moves stays in its coding tool.
    if (!servesTool(p, need)) throw new ToolError(`the provider "${p.name}" does not serve ${need === 'claude' ? 'Claude Code' : need}`, `pick a provider whose tools in get_accounts include ${need}, or leave account out`);
    f.account = { name: p.name, kind: p.kind, allowed: tia.allowed.includes(p.name), why };
    return why;
  }

  function wakeRule(conversation, tool, args, level) {
    const turn = turns.get(conversation);
    if (!turn || turn.origin !== 'job') return null;
    if (level === 'L0' || WAKE_OK.has(tool.name)) return null;
    const job = jobs.get(turn.job);
    const inJob = job && args.session && job.sessions.some((e) => e.session === args.session && e.computer === (args.computer || LOCAL));
    if (!SESSION_TOOLS.has(tool.name)) return level === 'L2' ? null : [`during a job wake-up ${ASSISTANT_NAME} may only act on that job's sessions`, 'notify_owner with what you suggest'];
    if (!inJob) return [`during this wake-up you may only act on the sessions of job ${turn.job}`, 'notify_owner about anything else'];
    if (turn.mode !== 'answer') return [`job ${turn.job} used all its answers`, 'notify_owner with the question and your suggested answer'];
    if (level !== 'L2' && !jobs.step(turn.job)) return [`job ${turn.job} used all its ${job.maxSteps} answers`, 'notify_owner and let the owner decide'];
    return null;
  }

  /**
   * Handle one tool call. opts: { conversation, actor }. Returns { text, isError, card?, ui? } — never throws for
   * anything the caller did; a failure in a handler becomes a plain error result too.
   */
  async function call(name, rawArgs, { conversation = 'direct', actor = 'assistant' } = {}) {
    const tool = byName.get(name);
    if (!tool) return { isError: true, text: errorText(`there is no tool "${String(name).slice(0, 40)}"`, `use one of: ${TOOL_NAMES.join(', ')}`) };
    let args;
    let refs;
    try {
      ({ value: args, refs } = validate(tool.input, rawArgs));
      if (tool.check) tool.check(args, ctxFor(conversation));
    } catch (e) {
      if (e instanceof SchemaError) return { isError: true, text: errorText(`invalid input for ${name}: ${e.message}`, 'fix that field and call again (see the tool schema)') };
      if (e instanceof ToolError) return { isError: true, text: errorText(e.message, e.next) };
      throw e;
    }
    const log = (outcome, extra = {}) => (extra.level || baseLevel(tool, args)) !== 'L0' && audit.append({ actor, conversation, tool: name, level: extra.level || baseLevel(tool, args), input: args, outcome, ...extra });

    if (stringsIn(args).some(looksSecret)) {
      log('refused', { error: 'secret-shaped input' });
      return { isError: true, text: errorText('that input looks like a key, token or password; secrets never go through the assistant', 'the owner enters secrets himself: open_screen "providers" (sign-ins and keys) or "settings/security" (the password)') };
    }
    const miss = shown.missing(conversation, refs.map((r) => ({ ...r, value: refKey(r, args) })));
    if (miss) {
      const raw = refs.find((r) => refKey(r, args) === miss.value)?.value ?? miss.value;
      return { isError: true, text: errorText(`${miss.kind} "${String(raw).slice(0, 60)}" was not shown to you in this conversation (ids only come from tool results, never from screen text)`, `call ${FIRST_CALL[miss.kind]} first`) };
    }

    try {
      const tia = await tiaFor(args.computer || LOCAL);
      if (!tia.enabled) return { isError: true, text: errorText(`${ASSISTANT_NAME} is turned off`, 'the owner can turn her on in Settings → Tia') };
      const f = await facts(tool, args);
      // What only the dashboard knows for this call (a project's unpublished commits …), for policy.mjs.
      if (tool.facts) f.extra = await tool.facts(ops, args, ctxFor(conversation));
      const accountWhy = tool.pickAccount ? await pickAccount(tool, args, f, tia) : null;
      const ctx = ctxFor(conversation, { accountWhy, accountKind: f.account ? f.account.kind : null });
      const d = decideLevel(tool, args, f, tia);
      if (d.refuse) {
        log('refused', { error: d.refuse });
        return { isError: true, text: errorText(d.refuse, d.next) };
      }
      const rule = wakeRule(conversation, tool, args, d.level);
      if (rule) {
        log('refused', { error: rule[0] });
        return { isError: true, text: errorText(rule[0], rule[1]) };
      }
      if (d.level !== 'L2') {
        ctx.judged = f.session; // what the level was decided on (an answer goes to that OK, no other)
        const result = await tool.run(ops, args, ctx);
        if (result.shown) shown.add(conversation, result.shown);
        log('done', { level: d.level });
        return { isError: false, text: render(result, name), ...(result.ui ? { ui: result.ui } : {}) };
      }
      const before = await tool.before(ops, args, ctx);
      const lines = [...(d.why ? [`Why a card: ${d.why}`] : []), ...(accountWhy ? [`Provider ${args.account}: ${accountWhy}`] : []), ...tool.cardLines(args, before)].map((l) => String(l).slice(0, 4000));
      const card = cards.stage({ tool: name, input: args, lines, before, conversation });
      log('staged', { card: card.id, level: 'L2' });
      return {
        isError: false,
        card,
        text: `Waiting for the owner's OK (card ${card.id}, expires in ${Math.round((card.expiresAt - card.createdAt) / 60_000)} min). Nothing has been done yet. Tell the owner in one line what you proposed and why; you will be told the outcome.\n${fenceData({ tool: name }, { card: card.id, shows: lines })}`,
      };
    } catch (e) {
      if (e instanceof ToolError) {
        log('failed', { error: e.message });
        return { isError: true, text: errorText(e.message, e.next) };
      }
      log('failed', { error: e.message });
      return { isError: true, text: errorText(`${name} failed: ${neutralize(e.message || 'unknown error', 300)}`, e.status === 404 ? 'call list_sessions or get_computer_status to see what exists now' : 'check the state with a read tool, then try once more or tell the owner') };
    }
  }

  /**
   * The owner tapped Confirm. Re-validates the stored input, re-reads the before-state, and runs the action only
   * when the card is pending, unexpired, unused and the state hashes the same. Only the owner's own login may
   * reach this (phase 2: cookie session, never a bearer token).
   */
  async function confirm(id) {
    const card = cards.get(id);
    if (!card) return { ok: false, error: 'there is no such card' };
    const tool = byName.get(card.tool);
    const conversation = card.conversation;
    const log = (outcome, extra = {}) => audit.append({ actor: 'owner', conversation, tool: card.tool, level: 'L2', input: card.input, outcome, card: id, ...extra });
    let args;
    let before;
    let ctx;
    try {
      args = validate(tool.input, card.input).value;
      ctx = ctxFor(conversation);
      if (tool.check) tool.check(args, ctx);
      if (tool.pickAccount) {
        // The account must still exist and still be allowed; its kind is part of the before-state.
        const tia = await tiaFor(args.computer || LOCAL);
        const f = await facts(tool, args);
        await pickAccount(tool, args, f, tia);
        if (!f.account.allowed) throw new Error(`provider ${args.account} is no longer allowed for ${ASSISTANT_NAME}`);
        ctx = ctxFor(conversation, { accountKind: f.account.kind });
      }
      before = await tool.before(ops, args, ctx);
      ctx.before = before; // what the card showed and the owner confirmed (an answer goes to that OK, no other)
    } catch (e) {
      if (cards.get(id)?.status === 'pending') cards.markStale(id);
      log('stale', { error: e.message });
      tell(conversation, id, `The owner confirmed card ${id} (${card.tool}), but it could not run: ${neutralize(e.message, 300)}. Nothing was done.`);
      return { ok: false, error: e.message, code: 'stale' };
    }
    try {
      cards.take(id, before);
    } catch (e) {
      if (!(e instanceof CardError)) throw e;
      log(e.code === 'stale' ? 'stale' : e.code, { error: e.message });
      if (e.code === 'stale') tell(conversation, id, `Card ${id} (${card.tool}) did not run: the state changed after it was made. Nothing was done; look again before proposing it anew.`);
      return { ok: false, error: e.message, code: e.code };
    }
    log('confirmed');
    try {
      const result = await tool.run(ops, args, ctx);
      if (result.shown) shown.add(conversation, result.shown);
      cards.finish(id, { ok: true, summary: result.summary });
      log('done');
      tell(conversation, id, `The owner confirmed card ${id} (${card.tool}). ${render(result, card.tool)}`);
      return { ok: true, summary: result.summary };
    } catch (e) {
      cards.finish(id, { ok: false, error: e.message });
      log('failed', { error: e.message });
      tell(conversation, id, `The owner confirmed card ${id} (${card.tool}), but it failed: ${neutralize(e.message, 300)}.`);
      return { ok: false, error: e.message };
    }
  }

  function reject(id) {
    try {
      const c = cards.reject(id);
      audit.append({ actor: 'owner', conversation: c.conversation, tool: c.tool, level: 'L2', input: c.input, outcome: 'declined', card: id });
      tell(c.conversation, id, `The owner declined card ${id} (${c.tool}). Do not propose it again unless he asks.`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** The owner stops a job from the Tia tab. */
  function stopJob(id) {
    const j = jobs.get(id);
    if (!j) return { ok: false, error: 'there is no such job' };
    jobs.finish(id, 'stopped', 'stopped by the owner');
    audit.append({ actor: 'owner', conversation: j.conversation, tool: 'stop_job', level: 'L1', input: { job: id }, outcome: 'done' });
    tell(j.conversation, null, `The owner stopped job ${id}. Do not continue it.`);
    return { ok: true };
  }

  function tell(conversation, card, text) {
    outcomes.push({ conversation, card, text });
    if (outcomes.length > 500) outcomes.shift();
  }

  /** Card outcomes for one conversation, oldest first, removed as they are taken (the engine tells Tia). */
  function takeOutcomes(conversation) {
    const mine = outcomes.filter((o) => o.conversation === conversation);
    for (const o of mine) outcomes.splice(outcomes.indexOf(o), 1);
    return mine;
  }

  /**
   * One watcher tick: which jobs need Tia. Returns [{ conversation, job, reason, mode, message }]; the engine
   * starts each turn with beginTurn(conversation, { origin: "job", job, mode }) and sends `message` as the user
   * turn. The job's session counts as shown to that conversation. Nothing runs while Tia is off.
   */
  async function jobTick(sessionCards, screenOf = async () => '') {
    const tia = await tiaFor(LOCAL);
    if (!tia.enabled) return [];
    const out = [];
    for (const ev of jobs.tick(sessionCards)) {
      const conv = ev.job.conversation;
      if (ev.entry) shown.add(conv, { session: [`${ev.entry.computer}|${ev.entry.session}`], computer: [ev.entry.computer], job: [ev.job.id] });
      let screen = '';
      if (ev.entry && ev.reason !== 'ended') {
        try {
          screen = await screenOf(ev.entry);
        } catch {
          /* gone meanwhile */
        }
      }
      out.push({ conversation: conv, job: ev.job.id, reason: ev.reason, mode: ev.mode, message: wakeMessage(ev, ev.mode, screen) });
    }
    return out;
  }

  return {
    call,
    confirm,
    reject,
    stopJob,
    takeOutcomes,
    jobTick,
    tiaSettings: tiaFor,
    /** The engine marks who started a turn: the owner's message, or a job wake-up. */
    beginTurn(conversation, turn) {
      // An owner's turn: the addresses he wrote count as shown (see addressesIn).
      if (turn.origin !== 'job' && turn.text) shown.add(conversation, { address: addressesIn(turn.text) });
      turns.set(conversation, turn.origin === 'job' ? { origin: 'job', job: turn.job, mode: turn.mode } : { origin: 'owner' });
    },
    endTurn(conversation) {
      turns.delete(conversation);
    },
    cards,
    jobs,
    audit,
    skills,
    shown,
  };
}
