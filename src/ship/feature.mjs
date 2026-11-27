// Go live, as a server feature (docs/GO-LIVE.md): { name, routes, start, close }.
//
//   GET  /api/ship                          the projects of the workspace (names only: nothing of a project is read)
//   GET  /api/ship/p/<name>                 one project: the branches to pick, its put-togethers with their checks, its
//                                           check and live commands in full (with the hash of what is shown and whether
//                                           they are confirmed here), the switch, the step under way, the last outcome,
//                                           what a restart would cut
//   POST /api/ship/p/<name>/together { name, branches }   put the picked branches together (together.mjs)
//   POST /api/ship/p/<name>/goon { id }                   after a conflict: merge the next branch
//   POST /api/ship/p/<name>/handoff { id }                give the conflict to a session in that worktree
//   POST /api/ship/p/<name>/allow { kind, seen, id? }     the owner's yes for the commands he was shown (seen: their hash)
//   POST /api/ship/p/<name>/check { id }                  run the check of a put-together
//   POST /api/ship/p/<name>/live { id, seen, anyway? }    go live (anyway: the turns and terminals named before the tap)
//   POST /api/ship/p/<name>/back {}                       take the last go-live back
//   POST /api/ship/p/<name>/auto { on?, typed?, from?, to?, autoBack? }
//   POST /api/ship/p/<name>/drop { id }                   drop a put-together (its branch and worktree stay)
//   GET  /api/ship/limiter                  the limiter's words as they are set (Work → Go live), and whether confirmed
//   POST /api/ship/limiter { run, seen }    set (run: a list of words) or clear (run: null) it; seen: the words as he
//                                           was shown them, so his yes is for exactly those
//
// The owner's own page only: a bearer token of any kind (the assistant's, another computer's) and a request through
// the assistant's door are refused. A project is named by its name, looked up in the workspace's projects; no path from
// the browser is used and no full path is returned.
//
// By itself: at the dashboard's start and at each tick, only the open steps of this computer are finished
// (live.mjs openSteps: a step his press started). With no open step and no switch on nothing here reads a project or
// starts a program. A check that passes is followed by a go-live by itself only where his switch is on (auto.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { bearerOf } from '../machines/tokens.mjs';
import { tilde } from '../paths.mjs';
import { listProjects, projectsIn } from '../workspace/layout.mjs';
import { resolvePlace } from '../work/place.mjs';
import { listRuns } from '../work/runs.mjs';
import { allow, blockHash, isAllowed, limiterOf, setLimiter, switchesOf } from './allow.mjs';
import { afterCheck, setAuto } from './auto.mjs';
import { readChecks, runCheck, treeIdOf, verdict } from './check.mjs';
import { gitFolder } from './lock.mjs';
import { finishCut, goLive, openSteps, planLive, readJournal, readLast, repoOf, takeBack } from './live.mjs';
import { backShown, blocksDir, readCheck, readLive, showWords } from './project.mjs';
import { cutWords, restartsDashboard, waitForTurns, whatRestartCuts } from './restart.mjs';
import { candidates, closeTogether, conflictBrief, goOn, noteSession, putTogether, readTogether, togethersOf } from './together.mjs';

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (b, allowed) => {
  if (!isObj(b)) throw fail(400, 'the body must be a JSON object');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
};
const ID_RE = /^[0-9a-f]{20}$/;

export function shipFeature(ctx, opts = {}) {
  const cfg = () => (ctx.config ? ctx.config() : {});
  const projectsDir = () => (opts.projectsDir ? opts.projectsDir() : projectsIn(cfg()));
  const ownerOnly = (req) => {
    if (bearerOf(req) !== null || (ctx.caller && ctx.caller(req) !== 'page')) throw fail(403, 'Go live is the owner\'s own page only');
  };
  const steps = new Map(); // project real path → the promise of the step this dashboard runs

  /** The project `name` of the workspace: { name, real, top } (top: its repository), or 404. */
  function project(name) {
    let n;
    try {
      n = decodeURIComponent(name);
    } catch {
      throw fail(400, 'that is not a project name');
    }
    const p = listProjects(projectsDir()).find((x) => x.name === n);
    if (!p) throw fail(404, 'there is no such project in the workspace');
    const real = fs.realpathSync(p.dir);
    const top = repoOf(real);
    if (!top) throw fail(409, 'this project has no git repository to put tasks together in');
    return { name: p.name, real, top };
  }
  const together = (pr, id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(400, 'that is not a put-together');
    const t = readTogether(id);
    if (!t || t.top !== pr.top) throw fail(404, 'there is no such put-together of this project');
    return t;
  };
  /** Work's titles of the task branches its runs worked on. */
  const titles = () => {
    try {
      const out = {};
      for (const r of listRuns(resolvePlace(cfg()))) if (r.branch && r.title && !out[r.branch]) out[r.branch] = r.title;
      return out;
    } catch {
      return {};
    }
  };
  /** What a restart of the dashboard would cut, from this dashboard's own sessions. */
  const cutSources = () => ({
    kind: ctx.backend && ctx.backend.kind,
    chats: async () => (opts.chat && opts.chat.cards ? opts.chat.cards() : []),
    assistant: async () => {
      const a = opts.assistant && opts.assistant();
      return a && a.conversations ? [...a.conversations.values()].map((c) => ({ id: c.id, title: c.title, busy: c.busy })) : [];
    },
    terminals: async () => (ctx.backend && ctx.backend.list ? ctx.backend.list() : []),
  });

  const shownCheck = (check) => (check ? { commands: check.map((c) => `${showWords(c.run)}  (up to ${c.minutes} min)`), hash: blockHash(check) } : null);
  const shownLive = (live) => {
    if (!live) return null;
    const line = (c) => (c.url ? `${c.url} answers ${c.status} within ${c.seconds} s` : `${showWords(c.run)}  (up to ${c.minutes} min)`);
    return { update: live.update.map(line), verify: live.verify.map(line), back: live.back.map(line), keep: [...live.keep], github: live.github === true, restarts: live.restarts, turnSeconds: live.turnSeconds, waitSeconds: live.waitSeconds, hash: blockHash(live) };
  };
  const stepView = (j) => (j ? { id: j.id, name: j.name, together: j.together || null, tree: (j.values && j.values.tree) || null, part: j.part, outcome: j.outcome, why: j.why || null, by: j.by, at: j.at, endedAt: j.endedAt || null, liveSince: j.liveSince || null, changed: j.changed || [], more: j.more || 0, keptSame: j.keptSame ?? null, autoBackFailed: j.autoBackFailed || null, updateFailed: !!j.updateFailed, before: j.values && typeof j.values.before === 'string' ? j.values.before.slice(0, 12) : null, pictures: j.pictures || {}, parts: (j.parts || []).map((p) => ({ part: p.part, ok: p.ok, results: p.results })), runningElsewhere: !!j.runningElsewhere, unreadable: !!j.unreadable, waiting: !!j.waiting, turnSeconds: (j.live && j.live.turnSeconds) || null } : null);

  /** The last step, with the "back" it would run as it will run: its own confirmed words, its own values. */
  const lastView = (last) => (last ? { ...stepView(last), back: backShown(last) } : null);

  async function togetherView(pr, t) {
    let check = { state: 'none', passed: 0, failed: 0, last: null };
    let tree = null;
    if (t.finished && t.dir && fs.existsSync(t.dir)) {
      try {
        tree = (await treeIdOf(t.dir)).tree;
        check = verdict(readChecks(tree));
      } catch {
        /* the worktree is gone */
      }
    }
    return {
      id: t.id, name: t.name, branch: t.branch, base: t.base, branches: t.branches, titles: t.titles, done: t.done.map((d) => d.branch), finished: t.finished, problem: t.problem, at: t.at, tree,
      conflict: t.conflict ? { branch: t.conflict.branch, files: t.conflict.files, meets: t.conflict.meets, more: t.conflict.more, session: t.conflict.session } : null,
      check: { state: check.state, passed: check.passed, failed: check.failed, notCounted: check.notCounted || null, last: check.last ? { at: check.last.at, ok: check.last.ok, commands: check.last.commands } : null },
    };
  }

  async function view(pr) {
    const tg = togethersOf(pr.top).filter((t) => !t.closed);
    const open = tg.find((t) => t.finished) || tg[0] || null;
    const where = blocksDir(pr.real, open && open.dir && fs.existsSync(open.dir) ? open.dir : null);
    const c = readCheck(where);
    const l = readLive(where);
    let journal = null;
    try {
      journal = readJournal(await gitFolder(pr.top));
    } catch {
      /* no git folder */
    }
    const restarts = !!l.live && restartsDashboard(pr.real, l.live);
    const cut = restarts ? await whatRestartCuts(cutSources()) : null;
    const lim = limiterOf();
    // Read after every await above: a step that ended meanwhile is its own last record, never also "under way".
    const last = readLast(pr.real);
    // What the tap would run, with {commit} and {before} filled in (only for a put-together that may go live).
    let tap = null;
    if (open && open.finished) {
      try {
        const p = await planLive(pr.real, open);
        const limit = (list, shown) => shown.map((l, i) => (list[i].url ? l : `${l}  (up to ${list[i].minutes} min)`));
        tap = {
          id: open.id, update: limit(p.live.update, p.shown.update), verify: p.shown.verify, back: limit(p.live.back, p.shown.back), keep: p.shown.keep, github: p.shown.github,
          commit: p.values.commit.slice(0, 12), before: p.values.before.slice(0, 12),
        };
      } catch {
        /* not ready to go live: the page says why */
      }
    }
    return {
      tap,
      project: pr.name, folder: tilde(pr.real),
      ...(await candidates(pr.top, { titles: titles() })),
      togethers: await Promise.all(tg.map((t) => togetherView(pr, t))),
      check: { shown: shownCheck(c.check), problem: c.errors[0] || null, confirmed: isAllowed(pr.real, 'check', c.check) },
      live: { shown: shownLive(l.live), problem: l.errors[0] || null, confirmed: isAllowed(pr.real, 'live', l.live), restarts },
      limiter: lim.run ? { shown: showWords(lim.run), confirmed: lim.allowed } : null,
      switches: switchesOf(pr.real),
      step: stepView(journal && !journal.unreadable && !(last && last.id === journal.id) ? journal : journal && journal.unreadable ? { unreadable: true } : null),
      last: lastView(last),
      cut: cut ? { ...cut, words: cutWords(cut) } : null,
    };
  }

  /** Start the go-live of `t`; by itself never cuts a running turn (waits, then stops with its reason). */
  async function startLive(pr, t, { by = 'owner', named = null } = {}) {
    if (steps.has(pr.real)) throw fail(409, 'a go-live of this project is under way');
    const plan = await planLive(pr.real, t, { by });
    const restarts = restartsDashboard(pr.real, plan.live);
    const beforeUpdate = restarts ? () => waitForTurns(cutSources(), { seconds: plan.live.turnSeconds, named, byItself: by === 'auto' }) : async () => {};
    const step = await goLive(pr.real, t, { by, beforeUpdate });
    const done = step.done.catch(() => null).finally(() => steps.delete(pr.real));
    steps.set(pr.real, done);
    return { id: step.id };
  }

  /** A check of `t`, then (where his switch is on) the go-live by itself. */
  async function check(pr, t, by = 'owner') {
    const rec = await runCheck(pr.real, t.dir, { by, together: t.id, ...(opts.busy ? { busy: opts.busy } : {}) });
    const l = readLive(blocksDir(pr.real, t.dir));
    const auto = await afterCheck(pr.real, pr.name, rec, l.live, { go: () => startLive(pr, t, { by: 'auto' }).catch((e) => ({ skipped: e.message })) }).catch((e) => ({ skipped: e.message }));
    return { check: verdict(rec), auto };
  }

  /** The next look: finish every open step of this computer whose process is gone. */
  let looking = null;
  const finishOpen = () => (looking ||= (async () => {
    try {
      for (const real of openSteps()) if (!steps.has(real)) await finishCut(real).catch(() => null);
    } finally {
      looking = null;
    }
  })());

  const routes = [
    ['GET', /^\/api\/ship$/, async (req) => {
      ownerOnly(req);
      return { projects: listProjects(projectsDir()).filter((p) => p.git || p.parent).map((p) => p.name) };
    }],
    ['GET', /^\/api\/ship\/p\/([^/]+)$/, async (req, m) => {
      ownerOnly(req);
      const pr = project(m[1]);
      await finishCut(pr.real).catch(() => null); // the page is a look too: it finishes a step that was cut off
      return view(pr);
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/together$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['name', 'branches']);
      const pr = project(m[1]);
      return togetherView(pr, await putTogether(pr.top, { name: b.name, branches: b.branches, titles: titles() }));
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/goon$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['id']);
      const pr = project(m[1]);
      return togetherView(pr, await goOn(together(pr, b.id).id));
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/handoff$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['id']);
      const pr = project(m[1]);
      const t = together(pr, b.id);
      if (!t.conflict) throw fail(409, 'there is no conflict to hand on');
      if (t.conflict.session) throw fail(409, 'this conflict is already with a session', 'handed');
      if (!opts.chat || !opts.chat.open) throw fail(409, 'sessions cannot be started from this dashboard');
      const opened = await opts.chat.open({ dir: t.dir, title: `Put together ${t.name}: ${t.conflict.branch}`.slice(0, 120), text: conflictBrief(t), defaults: true });
      noteSession(t.id, opened.id);
      return { session: opened.id, sent: !!opened.sent };
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/allow$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['kind', 'seen', 'id']);
      const pr = project(m[1]);
      if (b.kind === 'limiter') {
        const lim = limiterOf();
        if (!lim.run || typeof b.seen !== 'string' || b.seen !== showWords(lim.run)) throw fail(409, 'the limiter changed since it was shown: look at it again', 'changed');
        setLimiter(lim.run);
        return { ok: true };
      }
      if (b.kind !== 'check' && b.kind !== 'live') throw fail(400, 'kind is check or live');
      const t = b.id === undefined || b.id === null ? null : together(pr, b.id);
      const where = blocksDir(pr.real, t && t.dir && fs.existsSync(t.dir) ? t.dir : null);
      const block = b.kind === 'check' ? readCheck(where).check : readLive(where).live;
      if (!block) throw fail(409, `this project has no ${b.kind} commands that can be used`);
      // His yes holds for exactly what he was shown: the hash of the commands now must be the one the page showed.
      if (typeof b.seen !== 'string' || b.seen !== blockHash(block)) throw fail(409, 'the commands changed since they were shown: look at them again', 'changed');
      allow(pr.real, b.kind, block);
      return { ok: true };
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/check$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['id']);
      const pr = project(m[1]);
      const t = together(pr, b.id);
      if (!t.finished) throw fail(409, 'put all the tasks together first');
      return check(pr, t);
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/live$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['id', 'seen', 'anyway']);
      const pr = project(m[1]);
      const t = together(pr, b.id);
      const plan = await planLive(pr.real, t);
      if (typeof b.seen !== 'string' || b.seen !== blockHash(plan.live)) throw fail(409, 'the go-live commands changed since they were shown: look at them again', 'changed');
      let named = null;
      if (b.anyway !== undefined && b.anyway !== null) {
        if (!isObj(b.anyway) || !Array.isArray(b.anyway.turns) || !Array.isArray(b.anyway.terminals) || [...b.anyway.turns, ...b.anyway.terminals].some((x) => typeof x !== 'string' || x.length > 100)) throw fail(400, 'anyway is { turns: [ids], terminals: [names] }');
        named = { turns: b.anyway.turns, terminals: b.anyway.terminals };
      }
      return startLive(pr, t, { named });
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/back$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, []);
      const pr = project(m[1]);
      if (steps.has(pr.real)) throw fail(409, 'a go-live of this project is under way: take it back when it has ended');
      return stepView(await takeBack(pr.real));
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/drop$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['id']);
      const pr = project(m[1]);
      const t = together(pr, b.id);
      if (steps.has(pr.real)) throw fail(409, 'a go-live of this project is under way: drop it when it has ended');
      closeTogether(t.id);
      return { ok: true };
    }],
    ['POST', /^\/api\/ship\/p\/([^/]+)\/auto$/, async (req, m) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['on', 'typed', 'from', 'to', 'autoBack']);
      const pr = project(m[1]);
      const tg = togethersOf(pr.top).find((t) => t.finished && t.dir && fs.existsSync(t.dir));
      return setAuto(pr.real, pr.name, b, readLive(blocksDir(pr.real, tg ? tg.dir : null)).live);
    }],
    ['GET', /^\/api\/ship\/limiter$/, async (req) => {
      ownerOnly(req);
      const lim = limiterOf();
      return { run: lim.run, shown: lim.run ? showWords(lim.run) : null, confirmed: !!lim.run && lim.allowed };
    }],
    ['POST', /^\/api\/ship\/limiter$/, async (req) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      keys(b, ['run', 'seen']);
      if (b.run === null) {
        setLimiter(null);
        return { run: null, shown: null, confirmed: false };
      }
      // His own words, and his yes for exactly what the sheet showed him (setLimiter checks their shape).
      if (!Array.isArray(b.run) || b.run.some((w) => typeof w !== 'string')) throw fail(400, 'the limiter is a list of words, such as ["nice", "-n", "15"]');
      if (typeof b.seen !== 'string' || b.seen !== showWords(b.run)) throw fail(409, 'the words changed since they were shown: look at them again', 'changed');
      setLimiter(b.run);
      return { run: [...b.run], shown: showWords(b.run), confirmed: true };
    }],
  ];

  let stopTick = null;
  return {
    name: 'ship',
    routes,
    start() {
      finishOpen();
      if (ctx.onTick) stopTick = ctx.onTick(() => (openSteps().length ? finishOpen() : null));
    },
    async close() {
      if (stopTick) stopTick();
    },
    // For tests and the command line: the same steps the routes take.
    finishOpen,
    view: (name) => view(project(name)),
    running: () => [...steps.values()],
  };
}

/** The real path of a project folder for the command line and tests (the same lookup the routes make). */
export function projectByName(name, dir) {
  const p = listProjects(dir).find((x) => x.name === name);
  if (!p) return null;
  const real = fs.realpathSync(p.dir);
  const top = repoOf(real);
  return top ? { name: p.name, real, top, dir: path.relative(dir, real) } : null;
}
