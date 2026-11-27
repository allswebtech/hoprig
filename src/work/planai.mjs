// "Plan with AI": the owner writes a goal in his own words, picks the project it is about (and may name more), the
// provider, model and effort (the defaults as "Do it" has them), and presses Plan. A coding session starts in that
// project, in the App so he can watch, with a first message that asks it to research and to answer with a research
// note and a draft plan in one strict shape (proposal.mjs firstMessage; its method is the bundled skill plan-work).
//
// The session never writes into the Work repository (it runs in the mode that asks before any change: PLAN_MODE), and
// its result is DATA: its last answer, captured when its turn
// ends, as a "Do it" run captures one (the chat feature's lastText). Not a file in the session's folder: that folder
// may hold the Work repository itself (the AI brain, a project that keeps Work's list), and a file there would be a
// write into it, read back by Work from a place the session controls. The answer is masked (a key, this computer's
// paths) and parsed strictly (proposal.mjs parseAnswer); a proposal waits in the state folder (proposals.mjs) until the
// owner accepts it (planstore.mjs acceptProposal: only then plan, note and tasks are written, as one unit) or dismisses
// it. A restart of the dashboard while a session plans: the proposal stays "working" and is settled when the
// dashboard is back, from the chat as it is then.
import { listProfiles, publicProfile } from '../profiles.mjs';
import { leadPlan } from '../models/lead.mjs';
import { cleanOthers, ticksOf } from '../models/others.mjs';
import { chatTool, chatToolList, choicesOf, modelOk, modelRefusal, serves } from '../chat/tools.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { folderOf, projectsByName } from './folders.mjs';
import { checkBrief, todayIn, withoutHidden } from './model.mjs';
import { resolvePlace } from './place.mjs';
import { acceptProposal } from './planstore.mjs';
import { ANSWER_MAX, applyEdits, firstMessage, parseAnswer } from './proposal.mjs';
import { dropProposal, listProposals, placeKey, readProposal, rowOf, viewProposal, writeProposal } from './proposals.mjs';
import { chatFacts, cleanText, newRunId, pathsOf } from './runs.mjs';

const TICK_MS = 30_000;
const leadLineFor = (provider, tool) => {
  if (!provider) return null;
  const p = leadPlan(provider, { tool });
  return p.can ? p.line : p.why;
};
// The permission mode of a planning session: "manual" (Claude Code's "default", OpenCode's asking mode), both tools'.
const PLAN_MODE = 'manual';
const ALSO_MAX = 9;
const REASONS = {
  failed: (e) => `The session stopped with an error before it answered: open the session to see what happened, or plan again${e ? ` (the coding tool said: ${e})` : ''}`,
  limit: 'The provider reached its usage limit and no other provider went on with it',
  stopped: 'You stopped the session',
  closed: 'The session was closed before its turn ended',
  gone: 'The session is gone: the dashboard stopped while it planned, and its turn has no end on record',
  never: 'The session did not start',
  empty: 'The session ended without an answer',
};
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });

/** o: { config(), places(), chat (open, peek, follow, turnEnd), defaultProvider(dir, last, tool), now(), log }. */
export function planRunner(o) {
  const cfg = () => (o.config ? o.config() : {});
  const places = () => (o.places ? o.places() : {});
  const now = o.now || (() => new Date());
  const log = o.log || ((s) => console.error(`work plans: ${s}`));
  const place = () => resolvePlace(cfg(), places());
  const projectsDir = () => places().projects || projectsIn(cfg());
  const workspace = () => places().workspace || workspaceDir(cfg());
  const all = () => projectsByName(projectsDir());
  const words = (s, max) => cleanText(s, max, pathsOf({ projectsDir: projectsDir(), workspace: workspace() }));
  const ctx = () => {
    const p = place();
    return { today: todayIn(p.settings.timeZone, now()), ownerId: p.settings.ownerId, projects: [...all().keys()], now };
  };
  const followed = new Map(); // proposal id → stop following its chat
  const settling = new Set();
  let timer = null;

  // The saved values a check keeps accepting (the default of Settings → New sessions); the provider's own list
  // comes from src/models/catalog.mjs (chat/tools.mjs choicesOf).
  const models = () => {
    const saved = (cfg().sessionDefaults || {}).model;
    return saved ? [saved] : [];
  };
  function providersFor(tool) {
    const out = listProfiles().filter((p) => serves(p.name, tool)).map((p) => {
      const v = publicProfile(p);
      return { name: v.name, label: v.label || v.name, kind: v.kind };
    });
    if (serves('auto', tool)) out.unshift({ name: 'auto', label: 'Auto mode', kind: 'auto' });
    return out;
  }

  /**
   * What Plan would start, for the sheet: the projects, the coding tools, providers, models and efforts, and the
   * defaults (as "Do it" has them). want: { project, tool }.
   */
  async function choices(want = {}) {
    const names = all();
    const project = want.project && names.has(want.project) ? want.project : null;
    if (want.project && !project) throw fail(400, `"${String(want.project).slice(0, 100)}" is not a project of the workspace`);
    const tool = chatTool(want.tool, cfg());
    // The provider default also without a project (no folder: the order of his providers), so the sheet never opens
    // on "Choose one".
    const provider = await o.defaultProvider(project ? names.get(project) : null, null, tool);
    const ch = choicesOf(tool, provider, models);
    const d = cfg().sessionDefaults || {};
    return {
      projects: [...names.keys()], project, tools: chatToolList(cfg()).map(({ id, name }) => ({ id, name })), tool, providers: providersFor(tool), provider,
      models: ch.models, efforts: ch.efforts, model: tool === 'claude' && d.model && ch.models.includes(d.model) ? d.model : null, effort: d.effort && ch.efforts.includes(d.effort) ? d.effort : null,
      // "Lead model": Settings → New sessions; leadLine says which models it uses on this provider, or why not.
      lead: tool === 'claude' && d.lead === true, leadLine: leadLineFor(provider, tool), others: ticksOf(d.others).filter((n) => n !== provider),
    };
  }

  /**
   * Start a planning session. c: { goal, project, also?, tool?, provider?, model?, effort? }. → { proposal } (its
   * record as the page shows it), or { dryRun, would }.
   */
  async function start(c, { dryRun = false, hers = false } = {}) {
    const goal = checkBrief(c.goal ?? '');
    const names = all();
    if (typeof c.project !== 'string' || !names.has(c.project)) throw fail(400, 'choose the project the goal is about', 'no-project');
    const also = [...new Set(c.also || [])];
    if (also.length > ALSO_MAX) throw fail(400, `name up to ${ALSO_MAX} more projects`);
    for (const n of also) if (typeof n !== 'string' || !names.has(n) || n === c.project) throw fail(400, `"${String(n).slice(0, 100)}" is not another project of the workspace`);
    const dir = folderOf(names.get(c.project), '.');
    const tool = chatTool(c.tool, cfg());
    const provider = c.provider ? c.provider : await o.defaultProvider(dir, null, tool);
    if (!provider) throw fail(400, 'there is no provider for this coding tool yet: add one under Providers first', 'no-provider');
    if (typeof provider !== 'string' || !serves(provider, tool)) throw fail(400, 'that provider does not serve this coding tool');
    const ch = choicesOf(tool, provider, models);
    if (c.model && !modelOk(tool, c.model, ch)) throw fail(400, modelRefusal(c.model, ch));
    if (c.effort && !ch.efforts.includes(c.effort)) throw fail(400, `the effort must be one of: ${ch.efforts.join(', ')}`);
    if (c.lead !== undefined && c.lead !== null && typeof c.lead !== 'boolean') throw fail(400, 'lead is true or false');
    // A choice wins over Settings → New sessions; only Claude Code can lead.
    const lead = tool === 'claude' && (typeof c.lead === 'boolean' ? c.lead : (cfg().sessionDefaults || {}).lead === true);
    let others = [];
    try {
      others = lead ? cleanOthers(c.others !== undefined && c.others !== null ? c.others : ticksOf((cfg().sessionDefaults || {}).others).filter((n) => n !== provider && serves(n, 'claude')), provider) : [];
    } catch (e) {
      throw fail(400, e.message);
    }
    const p = place();
    const text = firstMessage({ goal, project: c.project, also, today: todayIn(p.settings.timeZone, now()) });
    const would = { project: c.project, also, tool, provider, model: c.model || null, effort: c.effort || null, ...(lead ? { lead } : {}), ...(others.length ? { others } : {}), goal };
    if (dryRun) return { dryRun: true, would, text };
    const rec = {
      v: 1, id: newRunId(now()), place: placeKey(p), goal, project: c.project, also, tool, provider, model: c.model || null, effort: c.effort || null, ...(lead ? { lead } : {}), ...(others.length ? { others } : {}),
      session: null, conversation: null, message: null, startedAt: now().toISOString(), endedAt: null, state: 'working', reason: null, answer: '', proposal: null, problem: null, cleaned: false,
    };
    writeProposal(rec);
    let opened;
    try {
      const title = `Plan: ${goal.replace(/\s+/g, ' ').slice(0, 70)}`;
      // The session reads the web and the project's files, which may hold instructions of someone else's: it runs in
      // the mode that asks the owner (watching in the App) before anything that changes something, never in his
      // New-session default (which may ask nothing). Not Claude Code's "plan" mode: its plan card would hold the turn.
      opened = await o.chat.open({ dir, tool, profile: provider, title, ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), lead, ...(others.length ? { others } : {}), permissionMode: PLAN_MODE, text, defaults: true, ...(hers ? { hers: true } : {}) });
    } catch (e) {
      return { proposal: viewProposal(finish(rec, { state: 'failed', reason: `${REASONS.never}: ${words(e.message, 300)}` })) };
    }
    if (!opened.sent) return { proposal: viewProposal(finish(rec, { state: 'failed', reason: `${REASONS.never}: ${words(opened.why || 'the message did not go', 300)}` })) };
    const snap = o.chat.peek(opened.id);
    const facts = chatFacts({ id: opened.id, messageId: opened.messageId, ...(snap ? { conversationId: snap.conversationId, model: snap.model, effort: snap.effort } : {}) });
    Object.assign(rec, { session: facts.session, conversation: facts.conversation, message: facts.message, model: facts.model ?? rec.model, effort: facts.effort ?? rec.effort });
    const cur = readProposal(rec.id);
    if (cur && cur.state === 'working') writeProposal(rec);
    follow(rec);
    return { proposal: viewProposal(readProposal(rec.id) || rec) };
  }

  /** The record's end: failed with a reason, or the answer parsed (ready, or unreadable with the reason). */
  function finish(rec, { state, reason = null, answer = '' }) {
    const out = { ...rec, endedAt: now().toISOString(), reason: reason ? words(reason, 400) : null };
    if (state !== 'done') return writeProposal({ ...out, state: 'failed', answer: words(answer, ANSWER_MAX) });
    if (!String(answer).trim()) return writeProposal({ ...out, state: 'failed', reason: REASONS.empty, answer: '' });
    // The answer as it may be shown and kept: a key masked, this computer's paths and name taken out. The proposal is
    // read from that same text, so no plan written from it holds what a run would not.
    const shown = words(answer, ANSWER_MAX + 1);
    return writeProposal(parsed({ ...out, answer: shown.slice(0, ANSWER_MAX) }, shown));
  }
  /** The record with its answer parsed: ready with the proposal, or unreadable with the reason. */
  function parsed(rec, text) {
    try {
      const proposal = parseAnswer(text, { projects: [...all().keys()], project: rec.project, also: rec.also });
      return { ...rec, state: 'ready', proposal, problem: null };
    } catch (e) {
      if (e.status !== 400) throw e;
      return { ...rec, state: 'unreadable', proposal: null, problem: { message: e.message, code: e.details.code } };
    }
  }

  function follow(rec) {
    if (followed.has(rec.id) || !rec.session) return;
    const look = (snap) => {
      if (snap === null) return settleFrom(rec, null);
      if (snap.busy || snap.pending) return null;
      return settleFrom(rec, snap);
    };
    followed.set(rec.id, o.chat.follow(rec.session, look));
    look(o.chat.peek(rec.session));
  }

  /** A planning session whose chat is idle (or gone: null): settled by how its turn ended. */
  function settleFrom(rec, snap) {
    if (settling.has(rec.id)) return null;
    settling.add(rec.id);
    try {
      const stop = followed.get(rec.id);
      followed.delete(rec.id);
      stop?.();
      const cur = readProposal(rec.id);
      if (!cur || cur.state !== 'working') return null; // dismissed meanwhile, or settled
      const merged = { ...cur, session: rec.session ?? cur.session, conversation: rec.conversation ?? cur.conversation, message: rec.message ?? cur.message };
      const answer = snap ? snap.lastText || '' : '';
      const end = snap && snap.lastEnd ? snap : (merged.conversation && merged.message ? o.chat.turnEnd(merged.conversation, merged.message) : null);
      if (!end) return finish(merged, { state: 'failed', reason: !merged.session ? REASONS.never : snap === null ? REASONS.gone : REASONS.closed, answer });
      const how = end.lastEnd || (end.ok ? 'ok' : end.stopped ? 'stopped' : end.limited ? 'limit' : 'error');
      if (how === 'ok') return finish(merged, { state: 'done', answer });
      return finish(merged, { state: 'failed', reason: how === 'limit' ? REASONS.limit : how === 'stopped' ? REASONS.stopped : REASONS.failed(String(end.lastError || end.error || '').replace(/\s+/g, ' ').slice(0, 300)), answer });
    } catch (e) {
      log(`a planning session could not be settled: ${e.message}`);
      return null;
    } finally {
      settling.delete(rec.id);
    }
  }

  /** Every proposal of this place still "working": followed, or settled when its session's turn has ended (a restart). */
  function settleWorking() {
    let p;
    try {
      p = place();
    } catch {
      return;
    }
    for (const r of listProposals(p)) {
      if (r.state !== 'working' || followed.has(r.id) || settling.has(r.id)) continue;
      if (!r.session) {
        // Started a moment ago, or never: a record without a session older than a minute did not start.
        if (Date.now() - Date.parse(r.startedAt) > 60_000) settleFrom(r, null);
        continue;
      }
      const snap = o.chat.peek(r.session);
      if (snap && (snap.busy || snap.pending)) follow(r);
      else settleFrom(r, snap);
    }
  }

  /** A proposal of this place by id, or 404. */
  function mine(id) {
    const r = readProposal(id);
    if (!r || r.place !== placeKey(place())) throw fail(404, 'there is no such proposal (it was accepted or dismissed)', 'gone');
    return r;
  }

  return {
    choices,
    start,
    list: () => {
      try {
        return listProposals(place()).map(rowOf);
      } catch {
        return [];
      }
    },
    get: (id) => viewProposal(mine(id)),
    /** "Take them out": an answer refused for characters that cannot be seen, read again without them. */
    clean(id) {
      const r = mine(id);
      if (r.state !== 'unreadable' || !r.problem || !['hidden', 'brief-hidden'].includes(r.problem.code)) throw fail(409, 'this proposal has no characters that cannot be seen to take out', 'not-hidden');
      const next = parsed({ ...r, answer: withoutHidden(r.answer), cleaned: true }, withoutHidden(r.answer));
      return viewProposal(writeProposal(next));
    },
    /** Accept: the proposal with the owner's changes (applyEdits) is written as a plan, its note and its tasks. */
    async accept(id, edits) {
      const r = mine(id);
      if (r.state !== 'ready') throw fail(409, 'only a proposal that was read can be accepted', 'not-ready');
      const c = ctx();
      return acceptProposal(place(), applyEdits(r.proposal, edits, c), c, { pid: r.id });
    },
    /** Dismiss: the proposal is thrown away (a session still planning goes on in its chat; its answer is not read). */
    dismiss(id) {
      const r = mine(id);
      const stop = followed.get(r.id);
      followed.delete(r.id);
      stop?.();
      return { dismissed: dropProposal(r.id) };
    },
    settleWorking,
    begin() {
      setTimeout(() => settleWorking(), 0).unref?.();
      timer = setInterval(() => settleWorking(), TICK_MS);
      timer.unref?.();
    },
    close() {
      clearInterval(timer);
      for (const stop of followed.values()) stop();
      followed.clear();
    },
  };
}
