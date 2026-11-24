// Learning skills from the owner's work, as a server feature: { name, routes, sentBack, look, start, close }.
//
// Off by default. While it is off nothing is looked at, no model is called and nothing is written, on any path (a
// send back, the button, a restart). When it is on, only two things start a look, both the owner's own doing in Work:
//   - a result he SENT BACK with his words (the strongest sign: a correction) → sentBack(item, words) from Work;
//   - a result he accepted, of a task he marks "Learn from this" (the button on its run) → POST …/look.
// One look is one headless model turn (learnlook.mjs); a draft it makes waits in quarantine for his Install or
// Discard (learned.mjs). Caps: the looks per week he chose, and at most three drafts a week.
//
//   GET  /api/skills/learn                      the settings, the providers and models to choose, this week's counts
//   POST /api/skills/learn/settings { on?, provider?, model?, perWeek? }
//   GET  /api/skills/learned                    the drafts (and installed ones, for Undo), newest first
//   POST /api/skills/learned/look { run, dryRun? }   "Learn from this" on an accepted task's run (dryRun: the prompt only)
//   POST /api/skills/learned/<id>/install | discard | undo
//
// Behind the owner's login like every /api route. Tia's token and the server's own requests on her behalf are
// refused: a skill is installed only by the owner's press on the page (or on another dashboard of his).
import { listProfiles, publicProfile } from '../profiles.mjs';
import { MODELS } from '../config.mjs';
import { readDoc } from '../work/store.mjs';
import { findItem, statusOf } from '../work/model.mjs';
import { resolvePlace } from '../work/place.mjs';
import { RUN_ID_RE, cleanText, listRuns, pathsOf, readRun } from '../work/runs.mjs';
import { brainDir, projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { changeDraft, discard, install, listDrafts, makeDraft, ownSkills, readDraft, settledView, undo } from './learned.mjs';
import { noteCorrection } from '../operator/corrections.mjs';
import { freshWayRound } from '../field/wayround.mjs';
import { claudeTurn, lookInput, lookPrompt, parseLook, peopleIn, tryTests } from './learnlook.mjs';
import { DRAFTS_PER_WEEK, bookLook, declinedLike, inWeek, lookedAt, noteCost, readDeclined, readLearnSettings, readLedger, settleLook, writeLearnSettings } from './learnset.mjs';

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });

/** A draft for the page: what it needs, nothing of the server's own folders. */
const forPage = (d) => ({
  id: d.id, createdAt: d.createdAt, state: d.state, kind: d.kind, name: d.name, description: d.description, why: d.why,
  source: d.source, skillMd: d.skillMd, diff: d.diff, findings: d.findings, counts: d.counts, risky: d.risky, riskyWhy: d.riskyWhy,
  tests: d.tests, cost: d.cost, installed: d.installed, undone: d.undone,
});

/** `opts`: { turn (a stand-in for the model turn), now(), places() ({ workspace, projects }), log }. */
export function learnFeature(sctx, opts = {}) {
  const cfg = () => (sctx.config ? sctx.config() : {});
  const places = () => (opts.places ? opts.places() : {});
  const turn = opts.turn || claudeTurn;
  const now = opts.now || Date.now;
  const log = opts.log || ((s) => console.error(`learn: ${String(s).slice(0, 500)}`));
  const brain = () => brainDir(places().workspace || workspaceDir(cfg()));
  const paths = () => pathsOf({ projectsDir: places().projects || projectsIn(cfg()), workspace: places().workspace || workspaceDir(cfg()) });
  const place = () => resolvePlace(cfg(), places());
  const busy = new Set(); // run ids being looked at now
  const providerNames = () => [...listProfiles().map((p) => p.name), 'auto'];
  // Dollars are said only for a provider billed by use (a key or a gateway), as the chat says them (web/chat/words.js
  // billed): a subscription pays nothing per look, and Auto mode's provider is not known beforehand.
  const billedBy = (name) => {
    const p = listProfiles().find((x) => x.name === name);
    return !!p && (p.kind === 'api' || p.kind === 'openai');
  };
  const lastWord = (x) => String(x.result).replace(/^draft [0-9a-f]+$/, 'draft');

  // Tia's token, and the server's own requests (Tia's door), never reach these routes' actions.
  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'learned skills are the owner\'s only');
    if (sctx.caller && sctx.caller(req) === 'self') throw fail(403, 'learned skills are installed by the owner\'s own press only');
  };

  /**
   * One look at `run`. trigger: "sent-back" (with `words`) or "asked". → { skipped } | { dryRun, system, prompt } |
   * { result: 'nothing' | 'refused' | 'failed' | 'declined' | 'draft', … }. While learning is off: { skipped: 'off' },
   * and nothing else is read, called or written.
   */
  async function look({ run, trigger, words = null, dryRun = false }) {
    const s = readLearnSettings();
    if (!s.on) return { skipped: 'off' };
    if (trigger !== 'sent-back' && trigger !== 'asked') throw fail(400, 'a look starts from a send back or from "Learn from this" only');
    if (trigger === 'sent-back' && (typeof words !== 'string' || !words.trim())) throw fail(400, 'a send back has the owner\'s words');
    const ledger = readLedger();
    if (inWeek(ledger.looks, now()) >= s.perWeek) return { skipped: 'cap', why: `the ${s.perWeek} looks of this week are used` };
    if (inWeek(ledger.drafts, now()) >= DRAFTS_PER_WEEK) return { skipped: 'drafts', why: `${DRAFTS_PER_WEEK} drafts were made this week` };
    if (busy.has(run.id)) return { skipped: 'busy', why: 'this run is being looked at now' };
    if (!dryRun && lookedAt(run.id, trigger)) return { skipped: 'looked', why: 'this run was looked at already' };
    const prepare = async () => {
      const skills = await ownSkills({ brain: brain() });
      const declined = readDeclined().map((x) => x.name);
      const p0 = paths();
      const input = lookInput({ run, words: trigger === 'sent-back' ? words : null }, p0);
      return { skills, declined, p0, input, ...lookPrompt(input, { skills, declined }) };
    };
    if (dryRun) {
      const { system, prompt } = await prepare();
      return { dryRun: true, provider: s.provider, model: s.model, system, prompt };
    }
    // Booked before anything is awaited, and the caps checked again under the ledger's lock: looks started at the same
    // time (a row of send backs, two dashboards) cannot all pass the caps before one of them is counted.
    busy.add(run.id);
    let usd = 0;
    let tokens = 0;
    let at = null;
    try {
      const booked = await bookLook({ run: run.id, trigger, perWeek: s.perWeek, now: now() });
      if (booked.skipped) return booked;
      at = booked.at;
      const { skills, declined, p0, input, system, prompt } = await prepare();
      const billed = billedBy(s.provider);
      const r = await turn({ provider: s.provider, model: s.model, system, prompt });
      usd += r.usd || 0;
      tokens += r.tokens || 0;
      if (!r.ok) {
        await settleLook(run.id, at, 'failed');
        return { result: 'failed', why: cleanText(r.error || 'the model turn failed', 300, p0) };
      }
      let parsed;
      try {
        const waiting = listDrafts().filter((x) => ['trying', 'ready', 'installing'].includes(x.state)).map((x) => x.name);
        parsed = parseLook(r.text, { skills: skills.map((x) => x.name), declined, waiting, people: peopleIn([run.title, input.brief, input.words, input.answer]) });
      } catch (e) {
        await settleLook(run.id, at, `refused: ${e.rule || 'shape'}`);
        return { result: 'refused', rule: e.rule || 'shape', why: e.message };
      }
      if (parsed.kind === 'nothing') {
        await settleLook(run.id, at, 'nothing');
        return { result: 'nothing' };
      }
      if (declinedLike(parsed)) {
        await settleLook(run.id, at, 'declined');
        return { result: 'declined' };
      }
      const source = { run: run.id, item: run.item, title: cleanText(run.title || run.item, 200, p0), trigger, words: input.words };
      const d = makeDraft(parsed, { source, cost: { usd, tokens, billed }, brain: brain(), now: now() });
      await settleLook(run.id, at, `draft ${d.id}`, { draft: d.id, now: now() });
      const t = await tryTests(parsed.tests, d.skillMd, { turn, provider: s.provider, paths: p0 });
      usd += t.usd;
      tokens += t.tokens;
      await changeDraft(d.id, (x) => ({ ...x, state: x.state === 'trying' ? 'ready' : x.state, tests: t.tests, cost: { usd, tokens, billed } })).catch(() => {});
      Promise.resolve(sctx.notify ? sctx.notify({ title: 'A skill draft to look at', message: `"${d.name}": read it in Skills → Learned. Nothing is installed until you press Install.`, status: 'automation', session: '', url: '' }) : null).catch(() => {});
      return { result: 'draft', id: d.id };
    } catch (e) {
      // Booked, then stopped by an error: it ran no further, and it says so (a "looking" left would count as running).
      if (at !== null) await settleLook(run.id, at, 'failed').catch(() => {});
      throw e;
    } finally {
      if (usd || tokens) noteCost(usd, tokens, now(), billedBy(s.provider));
      busy.delete(run.id);
    }
  }

  /** Work's Send back: look at the run that was in review, with his words. Never throws; does nothing while off. */
  function sentBack(item, words) {
    if (!readLearnSettings().on) return;
    Promise.resolve().then(() => {
      const run = listRuns(place(), { item }).find((r) => r.state === 'done');
      return run ? look({ run, trigger: 'sent-back', words }) : null;
    }).then((r) => r && r.result && log(`looked at a sent-back run: ${r.result}${r.rule ? ` (${r.rule})` : ''}`), (e) => log(`a look failed: ${e && e.message}`));
  }

  const routes = [
    ['GET', /^\/api\/skills\/learn$/, async (req) => {
      ownerOnly(req);
      const l = readLedger();
      const providers = listProfiles().map((p) => ({ name: p.name, label: publicProfile(p).label || p.name }));
      // The last look's time and result apart from its cost: a look that did not reach the model cost nothing.
      const lastLook = l.looks.length ? { at: l.looks.at(-1).at, result: lastWord(l.looks.at(-1)) } : null;
      return { settings: readLearnSettings(), providers: [...providers, { name: 'auto', label: 'Auto mode' }], models: MODELS, looksThisWeek: inWeek(l.looks, now()), draftsThisWeek: inWeek(l.drafts, now()), draftsPerWeek: DRAFTS_PER_WEEK, lastLook, looking: busy.size > 0 };
    }],
    ['POST', /^\/api\/skills\/learn\/settings$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'the body must be a JSON object');
      return writeLearnSettings(b, { providers: providerNames() });
    }],
    ['GET', /^\/api\/skills\/learned$/, async (req) => {
      ownerOnly(req);
      const s = readLearnSettings();
      return { on: s.on, looking: busy.size > 0, drafts: listDrafts().map((d) => forPage(settledView(d, now()))), recent: readLedger().looks.slice(-5).reverse().map((x) => ({ at: x.at, trigger: x.trigger, result: lastWord(x) })) };
    }],
    ['POST', /^\/api\/skills\/learned\/look$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      if (!b || typeof b.run !== 'string' || !RUN_ID_RE.test(b.run)) throw fail(400, 'that is not a run');
      if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw fail(400, 'dryRun is true or false');
      if (!readLearnSettings().on) throw fail(409, 'learning skills is off: turn it on in Settings → Learn skills', 'learn-off');
      const p = place();
      const run = readRun(p, b.run);
      if (!run) throw fail(404, 'that run is not there');
      if (run.state !== 'done') throw fail(409, 'only a run that ended well can be learned from', 'not-done');
      let item;
      try {
        item = findItem(readDoc(p.file).doc, run.item);
      } catch {
        throw fail(409, 'its task is not in the list any more', 'no-task');
      }
      if (statusOf(item) !== 'done') throw fail(409, 'accept the task first: "Learn from this" is for a result you accepted', 'not-accepted');
      if (b.dryRun) return look({ run, trigger: 'asked', dryRun: true });
      const first = await Promise.race([look({ run, trigger: 'asked' }).catch((e) => ({ result: 'failed', why: e.message })), new Promise((r) => setTimeout(() => r(null), 300))]);
      return first && first.skipped ? first : { started: true };
    }],
    ['POST', /^\/api\/skills\/learned\/([0-9a-f]{24})\/(install|discard|undo)$/, async (req, m) => {
      ownerOnly(req);
      await sctx.readJson(req);
      if (m[2] === 'discard') return discard(m[1], { brain: brain() });
      // A way round (src/field/wayround.mjs) made on an older text of its skill is made again on the text there now.
      if (m[2] === 'install') return install(freshWayRound(m[1], { brain: brain() }), { brain: brain() });
      const r = await undo(m[1], { brain: brain() });
      try {
        noteCorrection(cfg(), { kind: 'undo', about: { skill: readDraft(m[1]).name } });
      } catch {
        /* its draft is gone: nothing to count it for */
      }
      return r;
    }],
  ];

  return {
    name: 'learn',
    routes,
    look,
    sentBack,
    start() {
      // A draft whose test requests were being tried when the dashboard stopped: ready, with that said. No model call.
      // While learning is off nothing is written: the page and Install read such a draft as ready all the same.
      if (!readLearnSettings().on) return;
      for (const d of listDrafts()) {
        if (settledView(d, now()) === d) continue;
        changeDraft(d.id, (x) => (settledView(x, now()) === x ? undefined : settledView(x, now()))).catch(() => {});
      }
    },
    close() {},
  };
}
