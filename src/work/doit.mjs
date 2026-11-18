// "Do it": a task done by a coding session, started from the task, and what the session did brought back onto it.
//
// Start opens an App session (the chat feature's open, the same call a schedule makes) in a folder of a project of
// the workspace (folders.mjs), whose first message is the task's brief and one fixed sentence that asks for a short
// report. A RUN records it (runs.mjs: a file of its own in the Work folder, one writer: this dashboard). The task's
// status follows the run:
//   doing   while the session works
//   review  its turn ended well: the session's last answer, the commits made in the folder's repositories since the
//           start and the files changed and not committed are on the run
//   open    it ended in an error, at a usage limit (no other provider went on with it), or the owner stopped it; the
//           reason is on the run (waiting again, when the task was waiting for the owner when it started)
// The run file and the status are written under Work's file lock; a status write that is refused (the file needs a
// tidy, ids that two tasks share) never loses the result: the run is written anyway, with why the status stayed. At
// the end the status is written before the run's final record, so a run is never finished while its task waits.
//
// A dashboard restart while a session works: the run stays "running" and is settled when the dashboard is back,
// from the session's own record of how its turn ended (the chat feature's turnEnd); a run whose session is gone for
// good is "stopped", with that reason. Two presses of Start make one run, and a task with a running run of this
// dashboard offers its session, not a second start (another computer's running run is only said: this one cannot
// settle it, and it must not block the task here). Nothing here pushes, merges or publishes: the session's own rules decide what it
// changes in its folder.
import { MODELS } from '../config.mjs';
import { listProfiles, publicProfile } from '../profiles.mjs';
import { chatTool, chatToolList, choicesOf, serves } from '../chat/tools.mjs';
import { capture } from '../setup/system.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { dirtyOf, folderChoices, folderOf, headsOf, leftIn, projectsByName, reposOf } from './folders.mjs';
import { withLock } from './lock.mjs';
import { BRIEF_MAX, CLOSED, briefOf, checkBrief, findItem, setBrief, setStatus, statusOf, todayIn } from './model.mjs';
import { resolvePlace } from './place.mjs';
import { chatFacts, cleanFolder, cleanText, dropStart, keepStart, listRuns, newRunId, pathsOf, readRun, readStart, viewRun, writeRun, writerId } from './runs.mjs';
import { changeHeld, readDoc } from './store.mjs';

// What every brief ends with: the run's answer is the session's last message, so it is asked to be a report.
const AFTER = '\n\nAfter the last run: '; // what stands before each text the owner sent back, in the brief
export const REPORT_ASK = 'When you are done, end with a short report: what you did, what you checked, and what is left.';
const TICK_MS = 30_000; // how often running runs are looked at besides their chat's own events
const REASONS = {
  failed: (e) => `The session ended in an error${e ? `: ${e}` : ''}`,
  limit: 'The provider reached its usage limit and no other provider went on with it',
  stopped: 'You stopped the session',
  closed: 'The session was closed before its turn ended',
  gone: 'The session is gone: the dashboard stopped while it worked, and its turn has no end on record',
  never: 'The session did not start',
};

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** How a chat's turn ended (its lastEnd, or a kept turn-end event) as a run's state and reason. */
function endOf(lastEnd, error) {
  if (lastEnd === 'ok') return { state: 'done', reason: null };
  if (lastEnd === 'limit') return { state: 'limit', reason: REASONS.limit };
  if (lastEnd === 'stopped') return { state: 'stopped', reason: REASONS.stopped };
  return { state: 'failed', reason: REASONS.failed(error ? String(error).replace(/\s+/g, ' ').slice(0, 300) : '') };
}
const endOfRecord = (e) => endOf(e.ok ? 'ok' : e.stopped ? 'stopped' : e.limited ? 'limit' : 'error', e.error);

/**
 * o: { config(), places() ({ workspace, projects } stand-ins), chat (the chat feature: open, peek, follow, turnEnd),
 * defaultProvider(dir, last, tool), run (git, tests), now(), log }.
 */
export function workRuns(o) {
  const cfg = () => (o.config ? o.config() : {});
  const places = () => (o.places ? o.places() : {});
  const run = o.run || capture;
  const now = o.now || (() => new Date());
  const log = o.log || ((s) => console.error(`work: ${s}`));
  const place = () => resolvePlace(cfg(), places());
  const projectsDir = () => places().projects || projectsIn(cfg());
  const workspace = () => places().workspace || workspaceDir(cfg());
  const me = () => writerId();
  const starting = new Map(); // item key → the start under way (two presses: one run)
  const followed = new Map(); // run id → stop following its chat
  const settling = new Set(); // run ids being settled now
  let timer = null;

  const projectDir = (name) => {
    const dir = projectsByName(projectsDir()).get(name);
    if (!dir) throw fail(400, `"${String(name).slice(0, 100)}" is not a project of the workspace`);
    return dir;
  };
  const words = (s, max) => cleanText(s, max, pathsOf({ projectsDir: projectsDir(), workspace: workspace() }));
  const where = (r) => (r.folder === '.' ? r.project : `${r.project}/${r.folder}`);

  /** The item `ref` names, read fresh, with its place in the list. */
  function itemOf(ref) {
    const p = place();
    const { doc } = readDoc(p.file);
    const raw = findItem(doc, ref);
    const at = doc.items.indexOf(raw);
    return { p, doc, raw, at };
  }

  /** A provider's label as the page shows it ("Main"), by its name; the name when it has none or is gone. */
  const labels = () => {
    const m = new Map(listProfiles().map((p) => [p.name, publicProfile(p).label || p.name]));
    m.set('auto', 'Auto mode');
    return (name) => m.get(name) || name;
  };
  const shown = (r, label) => ({ ...viewRun(r, me()), providerLabel: label(r.provider) });

  /** The providers a session of `tool` may run on: [{ name, label, kind }] (Auto mode while it is on, for Claude Code). */
  function providersFor(tool) {
    const out = listProfiles().filter((p) => serves(p.name, tool)).map((p) => {
      const v = publicProfile(p);
      return { name: v.name, label: v.label || v.name, kind: v.kind };
    });
    if (serves('auto', tool)) out.unshift({ name: 'auto', label: 'Auto mode', kind: 'auto' });
    return out;
  }
  const models = () => {
    const saved = (cfg().sessionDefaults || {}).model;
    return saved && !MODELS.includes(saved) ? [...MODELS, saved] : [...MODELS];
  };

  /**
   * What "Do it" would start for item `ref`, for the sheet: the brief, the projects and their folders, the coding
   * tools, the providers, models and efforts, and the defaults. `want`: { project, folder, tool } to work the defaults
   * out for (the sheet asks again when one changes).
   */
  async function plan(ref, want = {}) {
    const { raw, at } = itemOf(ref);
    const item = { id: raw.id, at, title: String(raw.title || raw.id), status: statusOf(raw), project: typeof raw.project === 'string' ? raw.project : null };
    const all = projectsByName(projectsDir());
    const project = want.project !== undefined ? want.project : item.project && all.has(item.project) ? item.project : null;
    if (project !== null && !all.has(project)) throw fail(400, `"${String(project).slice(0, 100)}" is not a project of the workspace`);
    const folders = project ? folderChoices(all.get(project)).map(({ value, label }) => ({ value, label })) : [];
    const folder = want.folder !== undefined ? want.folder : '.';
    if (project && !folders.some((f) => f.value === folder)) throw fail(400, 'choose the project\'s own folder or one of its code repositories');
    const tool = chatTool(want.tool, cfg());
    const providers = providersFor(tool);
    let provider = null;
    if (project) provider = await o.defaultProvider(folderOf(all.get(project), folder), null, tool);
    const ch = choicesOf(tool, provider, models);
    const d = cfg().sessionDefaults || {};
    // Only this dashboard's own running run is one session already at work here; a running run of another computer
    // (brought in by a save, or one whose writer is gone) is said, and does not stop a start here.
    const all0 = listRuns(place(), { item: item.id }).filter((r) => r.state === 'running');
    const running = all0.find((r) => r.writer === me()) || null;
    const elsewhere = all0.find((r) => r.writer !== me()) || null;
    const brief = briefOf(raw);
    let briefProblem = null; // what is wrong with the task's own brief (a character that cannot be seen, too long)
    let briefClean = null; // the brief without the characters that cannot be seen, when those are what is wrong
    try {
      checkBrief(brief);
    } catch (e) {
      briefProblem = e.message;
      if (e.details && e.details.code === 'brief-hidden') briefClean = e.details.clean;
    }
    return {
      item, brief, briefProblem, briefClean, briefKept: isObj(raw.work) && typeof raw.work.brief === 'string', report: REPORT_ASK,
      projects: [...all.keys()], project, folders, folder, tools: chatToolList(cfg()).map(({ id, name }) => ({ id, name })), tool,
      providers, provider, models: ch.models, efforts: ch.efforts,
      model: tool === 'claude' && d.model && ch.models.includes(d.model) ? d.model : null, effort: d.effort && ch.efforts.includes(d.effort) ? d.effort : null,
      running: running ? shown(running, labels()) : null, elsewhere: elsewhere ? shown(elsewhere, labels()) : null,
    };
  }

  /**
   * Start a run of item `ref`. c: { brief?, seen?, project?, folder?, tool?, provider?, model?, effort? } (left out:
   * the task's own and the defaults; seen: the task's brief as it was shown, refused when it differs now). → { run,
   * existing? } (existing: the item has a running run: its session is offered), or { dryRun, would } with `dryRun`.
   */
  function start(ref, c = {}, { dryRun = false } = {}) {
    const key = `${place().file}#${typeof ref === 'string' ? ref : ref && ref.id}`;
    if (starting.has(key)) return starting.get(key);
    const p = begin(ref, c, { dryRun }).finally(() => starting.delete(key));
    starting.set(key, p);
    return p;
  }

  async function begin(ref, c, { dryRun }) {
    const { p, raw } = itemOf(ref);
    const id = raw.id;
    const status = statusOf(raw);
    const running = listRuns(p, { item: id }).find((r) => r.state === 'running' && r.writer === me());
    if (running) return { run: viewRun(running, me()), existing: true };
    if (CLOSED.has(status)) throw fail(409, `"${id}" is ${status}: open it again first`, 'closed');
    // A task in review waits for Accept or Send back: a new run would leave that answer unanswered.
    if (status === 'review') throw fail(409, `"${id}" waits for your review: Accept it or Send it back first`, 'review');
    const name = c.project !== undefined && c.project !== null ? c.project : raw.project;
    if (typeof name !== 'string' || !name) throw fail(400, 'this task has no project: choose the project a session works in', 'no-project');
    const pdir = projectDir(name);
    const folder = c.folder === undefined || c.folder === null ? '.' : cleanFolder(c.folder);
    if (!folder) throw fail(400, 'choose the project\'s own folder or one of its code repositories');
    const dir = folderOf(pdir, folder);
    const tool = chatTool(c.tool, cfg());
    const provider = c.provider === undefined || c.provider === null || c.provider === '' ? await o.defaultProvider(dir, null, tool) : c.provider;
    if (!provider) throw fail(400, 'there is no provider for this coding tool yet: add one under Providers first');
    if (typeof provider !== 'string' || !serves(provider, tool)) throw fail(400, 'that provider does not serve this coding tool');
    // The brief the session gets is the one the owner saw (`seen`: the sheet's, or the command's) or the one he wrote,
    // checked either way: a task that changed since it was shown (a merge, a save) is not started on text he never saw.
    const same = (a, b) => a.replace(/\r\n?/g, '\n').trim() === b.replace(/\r\n?/g, '\n').trim();
    if ((c.brief === undefined || c.brief === null) && c.seen !== undefined && !same(c.seen, briefOf(raw))) throw fail(409, 'the task changed since its brief was shown: look at it again', 'brief-changed');
    const brief = checkBrief(c.brief === undefined || c.brief === null ? briefOf(raw) : c.brief);
    const ch = choicesOf(tool, provider, models);
    if (c.model !== undefined && c.model !== null && !ch.models.includes(c.model)) throw fail(400, `the model must be one of: ${ch.models.join(', ')}`);
    if (c.effort !== undefined && c.effort !== null && !ch.efforts.includes(c.effort)) throw fail(400, `the effort must be one of: ${ch.efforts.join(', ')}`);
    const would = { item: id, project: name, folder, tool, provider, model: c.model ?? null, effort: c.effort ?? null, brief };
    if (dryRun) return { dryRun: true, would };

    const repos = reposOf(pdir, folder);
    const r = {
      v: 1, id: newRunId(now()), item: id, title: words(raw.title || id, 200).replace(/\s+/g, ' '), writer: me(), by: 'owner',
      startedAt: now().toISOString(), endedAt: null, project: name, folder, tool, provider, model: c.model ?? null, effort: c.effort ?? null,
      session: null, conversation: null, message: null, brief: words(brief, 4000), state: 'running', reason: null, answer: '',
      commits: [], changed: [], more: 0, was: status === 'waiting' ? 'waiting' : 'open', statusError: null,
    };
    // What the session starts from stays on this computer (runs.mjs keepStart): only this dashboard settles the run.
    keepStart(r.id, { start: await headsOf(repos, run), ...(await dirtyOf(repos, { run, skip: [p.folder] })) });
    // The record first, then the task: a status that cannot be written never loses the run.
    await withLock(p.file, async () => {
      writeRun(p, r);
      r.statusError = await taskStatus(p, ref, 'doing', { brief: c.brief === undefined || c.brief === null ? null : brief, from: null });
      if (r.statusError) writeRun(p, r);
    });
    let opened;
    try {
      // The chat is named after the task (its first message, the brief with the report sentence, would name it).
      opened = await o.chat.open({ dir, tool, profile: provider, title: r.title, ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), text: `${brief}\n\n${REPORT_ASK}`, defaults: true });
    } catch (e) {
      return { run: await settle(r, { state: 'failed', reason: `${REASONS.never}: ${words(e.message, 300)}`, answer: '' }) };
    }
    if (!opened.sent) return { run: await settle(r, { state: 'failed', reason: `${REASONS.never}: ${words(opened.why || 'the message did not go', 300)}`, answer: '' }) };
    const snap = o.chat.peek(opened.id);
    const facts = chatFacts({ id: opened.id, messageId: opened.messageId, ...(snap ? { conversationId: snap.conversationId, model: snap.model, effort: snap.effort } : {}) });
    Object.assign(r, { session: facts.session, conversation: facts.conversation, message: facts.message, ...(snap ? { model: facts.model ?? r.model, effort: facts.effort ?? r.effort } : {}) });
    await withLock(p.file, async () => {
      const now0 = readRun(p, r.id);
      if (now0 && now0.state === 'running') writeRun(p, r);
    });
    follow(r);
    return { run: viewRun(readRun(p, r.id) || r, me()) };
  }

  /**
   * Set the task's status for a run, under the file's lock (the caller holds it). Only from `from` (null: any open
   * status); brief: kept on the task. → null, or why it could not be written (the run keeps that sentence).
   */
  async function taskStatus(p, ref, to, { brief = null, from = null } = {}) {
    try {
      await changeHeld(p.file, (doc) => {
        const item = findItem(doc, ref);
        if (brief !== null) setBrief(item, brief);
        const st = statusOf(item);
        if ((from === null ? !CLOSED.has(st) : st === from) && st !== to) setStatus(doc, typeof ref === 'string' ? ref : { id: ref.id, at: doc.items.indexOf(item) }, to, ctx(p));
      });
      return null;
    } catch (e) {
      if (!e.status) log(`a run could not set its task's status: ${e.message}`);
      return words(`The task's status could not be changed: ${e.message}`, 400);
    }
  }
  const ctx = (p) => ({ today: todayIn(p.settings.timeZone, now()), ownerId: p.settings.ownerId, projects: [...projectsByName(projectsDir()).keys()] });

  /** Follow run `r`'s chat until its turn ends (its status events, and a look now). */
  function follow(r) {
    if (followed.has(r.id) || !r.session) return;
    const look = (snap) => {
      if (snap === null) return settleFrom(r, null);
      if (snap.busy || snap.pending) return null;
      return settleFrom(r, snap);
    };
    followed.set(r.id, o.chat.follow(r.session, look));
    look(o.chat.peek(r.session));
  }

  /** A run whose chat is idle (or gone: null): settled by how its turn ended. */
  function settleFrom(r, snap) {
    if (snap && snap.lastEnd) {
      const end = endOf(snap.lastEnd, snap.lastError);
      return settle(r, { ...end, answer: snap.lastText || '' });
    }
    // No end in the chat itself (a chat restored after a restart): the kept end of its turn, else gone for good.
    const kept = r.conversation && r.message ? o.chat.turnEnd(r.conversation, r.message) : null;
    if (kept) return settle(r, { ...endOfRecord(kept), answer: snap ? snap.lastText || '' : '' });
    return settle(r, { state: 'stopped', reason: !r.session ? REASONS.never : snap === null && followed.has(r.id) ? REASONS.closed : REASONS.gone, answer: snap ? snap.lastText || '' : '' });
  }

  /** End run `r`: what the session left, the final record, then the task's status (review, or open again). */
  async function settle(r, { state, reason, answer }) {
    if (settling.has(r.id)) return null;
    settling.add(r.id);
    const stop = followed.get(r.id);
    followed.delete(r.id);
    stop?.();
    try {
      const p = place();
      let left = { commits: [], changed: [], more: 0 };
      const from = readStart(r.id);
      try {
        // Without what it started from (a lost state folder) nothing can be told apart: nothing is listed.
        if (from) left = await leftIn(reposOf(projectDir(r.project), r.folder), from.start, { run, skip: [p.folder], before: from.before, beforeCut: from.beforeCut, since: Date.parse(r.startedAt) });
      } catch (e) {
        log(`a run could not read its folder's git state: ${e.message}`);
      }
      let out = null;
      let over = false; // settled already (here, a moment ago)
      await withLock(p.file, async () => {
        const cur = readRun(p, r.id);
        over = !!cur && cur.state !== 'running';
        if (!cur || cur.state !== 'running' || cur.writer !== me()) return;
        const fin = { ...cur, ...pick(r), state, reason: reason ? words(reason, 400) : null, answer: words(answer, 4000), endedAt: now().toISOString(), commits: left.commits.map((c) => ({ ...c, subject: words(c.subject, 200) })), changed: left.changed, more: left.more };
        // The task's status first, then the final record. A stop in between leaves the run running, and the next look
        // (settleRunning) settles it again, with the status set already; the other way round, a finished run would
        // leave its task doing, and nothing looks at a finished run again.
        fin.statusError = await taskStatus(p, fin.item, state === 'done' ? 'review' : fin.was, { from: 'doing' });
        out = writeFinal(p, fin, cur);
      });
      if (out || over) dropStart(r.id);
      return out ? viewRun(out, me()) : null;
    } catch (e) {
      log(`a run could not be settled: ${e.message}`);
      return null;
    } finally {
      settling.delete(r.id);
    }
  }
  /**
   * Write a run's final record. When its check still refuses what the folder or the session gave (a last resort: a
   * file of a name a run does not hold is counted, never listed, folders.mjs), the record is written without its lists,
   * saying why, and if even that is refused, as it
   * was at the start with only its end: a run never stays running because of what it found. A file that cannot be
   * written (a stop, a full disk) still throws: the run stays running and is settled on the next look.
   */
  function writeFinal(p, fin, cur) {
    try {
      return writeRun(p, fin);
    } catch (e) {
      if (!e.refused) throw e;
      log(`a run's final record was refused (${e.message}): it is written without its lists`);
      const why = `What it left could not be kept on the run (${e.message.replace(/^a run record /, '')})`;
      const lean = { commits: [], changed: [], more: fin.more + fin.changed.length, reason: words(fin.reason ? `${fin.reason}. ${why}` : why, 400) };
      try {
        return writeRun(p, { ...fin, ...lean });
      } catch (e2) {
        if (!e2.refused) throw e2;
        return writeRun(p, { ...cur, ...lean, state: fin.state, endedAt: fin.endedAt, statusError: fin.statusError });
      }
    }
  }
  // What the runner knows of a run beyond its file (the session, set right after the chat opened).
  const pick = (r) => ({ session: r.session, conversation: r.conversation, message: r.message, model: r.model, effort: r.effort });

  /** Every running run of this dashboard: followed, or settled when its session's turn has ended (a restart). */
  function settleRunning() {
    let p;
    try {
      p = place();
    } catch {
      return;
    }
    for (const r of listRuns(p)) {
      if (r.state !== 'running' || r.writer !== me() || followed.has(r.id) || settling.has(r.id) || starting.size) continue;
      if (!r.session) {
        settleFrom(r, null);
        continue;
      }
      const snap = o.chat.peek(r.session);
      if (snap && (snap.busy || snap.pending)) follow(r);
      else settleFrom(r, snap);
    }
  }

  /** "Accept": the task the session did is done. */
  async function accept(ref) {
    const p = place();
    return withLock(p.file, async () => {
      const r = await changeHeld(p.file, (doc) => {
        const item = findItem(doc, ref);
        if (statusOf(item) !== 'review') throw fail(409, `"${item.id}" is not ready for review`, 'not-review');
        return setStatus(doc, ref, 'done', ctx(p)).item;
      });
      return { item: r.result.id };
    });
  }

  /** "Send back": the task is open again, and what the owner wrote is added to the brief of its next run. */
  async function sendBack(ref, text) {
    if (typeof text !== 'string' || !text.trim()) throw fail(400, 'say what is to be done differently');
    const p = place();
    return withLock(p.file, async () => {
      const r = await changeHeld(p.file, (doc) => {
        const item = findItem(doc, ref);
        if (statusOf(item) !== 'review') throw fail(409, `"${item.id}" is not ready for review`, 'not-review');
        setBrief(item, briefAfter(briefOf(item), checkBrief(text)));
        return setStatus(doc, ref, 'open', ctx(p)).item;
      });
      return { item: r.result.id, brief: briefOf(r.result) };
    });
  }

  /**
   * The brief with what the owner wrote after a run added: the brief he started from, then each text he sent back,
   * the oldest left out first when they no longer fit in a brief together (the newest always stays, or it is refused).
   */
  function briefAfter(brief, text) {
    const at = brief.indexOf(AFTER);
    const own = at >= 0 ? brief.slice(0, at) : brief;
    const sent = [...(at >= 0 ? brief.slice(at + AFTER.length).split(AFTER) : []), text];
    const join = () => own + sent.map((x) => AFTER + x).join('');
    while (sent.length > 1 && join().length > BRIEF_MAX) sent.shift();
    if (join().length > BRIEF_MAX) throw fail(400, `the brief and what you wrote are more than ${BRIEF_MAX} characters together: write at most ${Math.max(0, BRIEF_MAX - own.length - AFTER.length)} characters`);
    return join();
  }

  /**
   * The runs, newest first, as the page and the command get them. f: { item, project, day (YYYY-MM-DD in Work's time
   * zone) }.
   */
  function list(f = {}) {
    const p = place();
    const tz = p.settings.timeZone;
    const label = labels();
    return listRuns(p, f.item ? { item: f.item } : {})
      .filter((r) => (!f.project || r.project === f.project) && (!f.day || todayIn(tz, new Date(r.startedAt)) === f.day))
      .map((r) => ({ ...shown(r, label), day: todayIn(tz, new Date(r.startedAt)), where: where(r) }));
  }

  /** The newest run of each item: { [item id]: { id, state, session, startedAt, endedAt, reason, here, answer } }. */
  function latest() {
    let p;
    try {
      p = place();
    } catch {
      return {};
    }
    const out = {};
    for (const r of listRuns(p)) {
      if (out[r.item]) continue;
      out[r.item] = { id: r.id, state: r.state, session: r.session, startedAt: r.startedAt, endedAt: r.endedAt, reason: r.reason, here: r.writer === me(), answer: r.answer.length > 300 ? `${r.answer.slice(0, 299)}…` : r.answer, statusError: r.statusError };
    }
    return out;
  }

  return {
    plan, start, accept, sendBack, list, latest, settleRunning,
    /** Settle what a restart left, and look at running runs now and then. */
    begin() {
      setTimeout(() => settleRunning(), 0).unref?.();
      timer = setInterval(() => settleRunning(), TICK_MS);
      timer.unref?.();
    },
    close() {
      clearInterval(timer);
      for (const stop of followed.values()) stop();
      followed.clear();
    },
  };
}
