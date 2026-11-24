// `hoprig ship …`: Go live on the command line (docs/GO-LIVE.md), the same steps as the page, in this process.
//
//   hoprig ship status <project> [--json]       the branches, put-togethers, checks, commands, the step and the last outcome
//   hoprig ship together <project> <name> <branch>...   put them together (the same name again: go on after a conflict)
//   hoprig ship check <project> <name>           run the check of a put-together
//   hoprig ship allow <project> check|live|limiter [<name>]   show the commands in full, ask on this terminal
//   hoprig ship live <project> <name>            show what will run, ask on this terminal, go live and wait for the end
//   hoprig ship back <project>                   take the last go-live back (asks)
//   hoprig ship auto <project> on|off [--from HH:MM] [--to HH:MM] [--back on|off]   on: type the project's name
//   hoprig ship drop <project> <name>            drop a put-together that cannot finish (asks; branch and folder stay)
//
// A yes is only ever a question answered on a terminal: there is no --yes, and without a terminal, or in a shell a coding
// tool or Hoprig started, it is refused. A
// project whose update restarts the dashboard goes live from the page only: only the dashboard sees which running turns
// and terminal sessions a restart would cut (rule 6b).
import fs from 'node:fs';
import { CODING_TOOL_VARS } from '../addons/gatewaycli.mjs';
import { loadConfig } from '../config.mjs';
import { tilde } from '../paths.mjs';
import { listProjects, projectsIn } from '../workspace/layout.mjs';
import { allow, isAllowed, limiterOf, setLimiter, switchesOf } from './allow.mjs';
import { afterCheck, setAuto } from './auto.mjs';
import { readChecks, runCheck, treeIdOf, verdict } from './check.mjs';
import { gitFolder } from './lock.mjs';
import { finishCut, goLive, planLive, readJournal, readLast, repoOf, takeBack } from './live.mjs';
import { backShown, blocksDir, readCheck, readLive, showWords } from './project.mjs';
import { restartsDashboard } from './restart.mjs';
import { candidates, closeTogether, putTogether, readTogether, togetherId, togethersOf } from './together.mjs';

export const USAGE = `usage: hoprig ship status <project> [--json]
       hoprig ship together <project> <name> <branch>...   (the same name again goes on after a conflict)
       hoprig ship check <project> <name>
       hoprig ship allow <project> check|live|limiter [<name>]
       hoprig ship live <project> <name>
       hoprig ship back <project>
       hoprig ship auto <project> on|off [--from HH:MM] [--to HH:MM] [--back on|off]
       hoprig ship drop <project> <name>`;

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const usage = () => Object.assign(fail(400, USAGE), { usage: true });

/**
 * A question on the terminal (only when both ends are one): the answer's text, or null without a terminal. A terminal
 * is no proof that a person answers: a coding tool's shell can make one (script, a pty). In a shell that a coding tool
 * or Hoprig started (its marks in the environment) every question is refused instead, and says why.
 */
export function terminalAsk({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) return null;
  const tool = CODING_TOOL_VARS.find((k) => env[k]);
  if (tool) return async () => {
    throw fail(409, `this is yours alone: run it in your own terminal, not in a session or a terminal of the dashboard (${tool} is set here)`, 'coding-tool');
  };
  return async (question) => {
    const rl = (await import('node:readline/promises')).createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
}

// What runs now, said plainly: after a failed verify the new version is running.
export const OUTCOME = {
  live: 'live', 'not-verified': 'running now, but it does not answer as it should', changed: 'running now, and kept files changed',
  'update-cut': 'the update was cut off: the project may be part-way updated', 'taken-back': 'taken back', 'back-failed': 'taking back failed',
  'back-cut': 'taking back was cut off', 'did-not-start': 'did not start', 'not-confirmed': 'stopped: its commands were no longer the confirmed ones',
};
// What a yes covers: the words of the commands, not the files they run (a task branch can change those).
export const COVERS = {
  check: 'Your yes covers these words. The check runs the code of the branches that were put together, also scripts a task branch changed.',
  live: 'Your yes covers these words. They run the scripts that are in the project\'s folder at that moment: the update runs the scripts of the put-together, and so does "back" unless it checks out {before} first.',
};
const CHECK = { none: 'not checked', running: 'checking', ready: 'ready', failed: 'failed', mixed: 'passed and failed' };
const times = (n) => `${n} time${n === 1 ? '' : 's'}`;
/** The verdict of a tree in words, with its counts. */
export const checkWords = (v) => (v.state === 'mixed' ? `passed ${times(v.passed)} and failed ${times(v.failed)}: not counted as passed` : `${CHECK[v.state]} (${v.passed} passed, ${v.failed} failed)`);

export async function main(args, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), ask = terminalAsk(), projectsDir = null, env = process.env, busy = null } = {}) {
  const json = args.includes('--json');
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const words = args.filter((a, i) => !a.startsWith('--') && !['--from', '--to', '--back'].includes(args[i - 1]));
  const [cmd, name, ...rest] = words;
  try {
    if (cmd === 'help') return out(USAGE), 0;
    if (!cmd || !name) throw usage();
    const dir = projectsDir || projectsIn(loadConfig());
    const p = listProjects(dir).find((x) => x.name === name);
    if (!p) throw fail(404, `there is no project "${name}" in the workspace (${tilde(dir)})`);
    const real = fs.realpathSync(p.dir);
    const top = repoOf(real);
    if (!top) throw fail(409, `${name} has no git repository to put tasks together in`);
    const named = (n) => {
      if (!n) throw usage();
      const t = readTogether(togetherId(top, n));
      if (!t) throw fail(404, `there is no put-together "${n}" of ${name}: make it with hoprig ship together ${name} ${n} <branch>...`);
      return t;
    };
    const yes = async (question) => {
      if (!ask) throw fail(409, 'this needs your yes on a terminal: run it in a terminal (there is no --yes)', 'no-terminal');
      return /^y(es)?$/i.test(await ask(question));
    };
    const where = (t) => blocksDir(real, t && t.dir && fs.existsSync(t.dir) ? t.dir : null);

    if (cmd === 'status') {
      const cut = await finishCut(real, { env }).catch(() => null);
      const tg = togethersOf(top).filter((t) => !t.closed);
      const c = await candidates(top);
      const list = [];
      for (const t of tg) {
        let check = 'none';
        if (t.finished && t.dir && fs.existsSync(t.dir)) check = verdict(readChecks((await treeIdOf(t.dir)).tree)).state;
        list.push({ name: t.name, branch: t.branch, branches: t.branches, done: t.done.length, finished: t.finished, conflict: t.conflict ? { branch: t.conflict.branch, files: t.conflict.files } : null, check });
      }
      const b = where(tg.find((t) => t.finished));
      const ch = readCheck(b).check;
      const lv = readLive(b).live;
      const j = readJournal(await gitFolder(top));
      const last = readLast(real);
      const s = {
        project: name, base: c.base, branches: c.branches.map((x) => ({ name: x.name, title: x.title, commits: x.commits })), togethers: list,
        check: ch ? { commands: ch.map((x) => showWords(x.run)), confirmed: isAllowed(real, 'check', ch) } : null,
        live: lv ? { update: lv.update.map((x) => showWords(x.run)), back: lv.back.map((x) => showWords(x.run)), confirmed: isAllowed(real, 'live', lv), restarts: restartsDashboard(real, lv) } : null,
        auto: switchesOf(real), step: j && !j.unreadable ? { part: j.part, name: j.name } : j ? { unreadable: true } : null,
        last: last ? { name: last.name, outcome: last.outcome, why: last.why || null, at: last.endedAt || last.at, liveSince: last.liveSince || null } : null,
        finished: cut && cut.outcome ? cut.outcome : null,
      };
      if (json) return out(JSON.stringify(s)), 0;
      out(`${name}: default branch ${c.base}`);
      if (s.finished) out(`A go-live that was cut off is finished now: ${OUTCOME[s.finished] || s.finished}.`);
      out(c.branches.length ? `Finished task branches: ${c.branches.map((x) => `${x.name}${x.title ? ` ("${x.title}")` : ''}`).join(', ')}` : 'No task branches that are not in the default branch.');
      for (const t of list) out(`Put together "${t.name}" (${t.branch}): ${t.finished ? `all ${t.branches.length} merged, check ${CHECK[t.check]}` : t.conflict ? `stopped at a conflict of ${t.conflict.branch} in ${t.conflict.files.join(', ')}` : `${t.done} of ${t.branches.length} merged`}`);
      out(s.check ? `Check: ${s.check.commands.join('; ')} (${s.check.confirmed ? 'confirmed' : 'not confirmed yet'})` : 'Check: none in project.json');
      out(s.live ? `Go live: ${s.live.update.join('; ')} (${s.live.confirmed ? 'confirmed' : 'not confirmed yet'})` : 'Go live: none in project.json');
      out(`By itself: ${s.auto.auto ? `on, ${s.auto.from} to ${s.auto.to}` : 'off'}`);
      if (s.step) out(s.step.unreadable ? 'A go-live journal cannot be read: look at it before anything goes live again.' : `A go-live of "${s.step.name}" is under way (${s.step.part}).`);
      if (s.last) out(`Last go-live "${s.last.name}": ${OUTCOME[s.last.outcome] || s.last.outcome}${s.last.why ? `: ${s.last.why}` : ''}`);
      return 0;
    }
    if (cmd === 'together') {
      const [n, ...branches] = rest;
      if (!n) throw usage();
      const kept = readTogether(togetherId(top, n));
      const r = await putTogether(top, { name: n, branches: branches.length ? branches : kept ? kept.branches : [] });
      if (json) return out(JSON.stringify({ ok: true, finished: r.finished, conflict: r.conflict, done: r.done.map((d) => d.branch) })), 0;
      if (r.finished) out(`All ${r.branches.length} branches are put together on ${r.branch}. Next: hoprig ship check ${name} ${n}`);
      else if (r.conflict) out(`${r.conflict.branch} meets ${r.conflict.meets.map((m) => m.branch).join(', ') || r.base} in ${r.conflict.files.join(', ')}. Resolve it in ${tilde(r.dir)} (commit the merge), then run the same command again.`);
      else out(`Stopped: ${r.problem}`);
      return r.finished ? 0 : 1;
    }
    if (cmd === 'check') {
      const t = named(rest[0]);
      if (!t.finished) throw fail(409, 'put all the tasks together first');
      // `busy`: how the check learns whether this computer is too loaded now (check.mjs overloaded); a caller may hand
      // its own in, as the page's route does.
      const rec = await runCheck(real, t.dir, { env, together: t.id, ...(busy ? { busy } : {}) });
      const v = verdict(rec);
      const lastRun = rec.runs.at(-1);
      for (const c of lastRun.commands) out(`${c.ok ? 'passed' : 'FAILED'}  ${c.shown}  (${c.ended})`);
      if (lastRun.notCounted) out(`This run is not counted: ${lastRun.notCounted}.`);
      else if (!lastRun.ok) out(lastRun.commands.at(-1).last);
      out(`The check of this tree: ${checkWords(v)}.`);
      const live = readLive(where(t)).live;
      // Only the dashboard sees the turns a restart would cut and waits for them (rule 6b): never from here.
      const refuse = live && restartsDashboard(real, live) ? 'its update restarts the dashboard: it goes live by itself only from the dashboard' : null;
      const auto = await afterCheck(real, name, rec, live, { refuse, go: async () => (await goLive(real, t, { env, by: 'auto' })).done });
      if (auto && auto.skipped) out(`Not by itself: ${auto.skipped}.`);
      else if (auto) out(auto.outcome === 'live' ? 'It went live by itself: live.' : `It went ahead by itself: ${OUTCOME[auto.outcome] || auto.outcome}.`);
      return lastRun.ok ? 0 : 1;
    }
    if (cmd === 'allow') {
      const kind = rest[0];
      if (kind === 'limiter') {
        const lim = limiterOf();
        if (!lim.run) throw fail(409, 'no limiter is set in Settings');
        out(`Every check command would run through: ${showWords(lim.run)}`);
        if (!(await yes('Confirm this limiter on this computer? (y/N) '))) return out('Nothing changed.'), 1;
        setLimiter(lim.run);
        return out('Confirmed.'), 0;
      }
      if (kind !== 'check' && kind !== 'live') throw usage();
      const t = rest[1] ? named(rest[1]) : togethersOf(top).find((x) => x.finished) || null;
      const block = kind === 'check' ? readCheck(where(t)).check : readLive(where(t)).live;
      if (!block) throw fail(409, `${name} has no ${kind} commands that can be used`);
      out(`These commands come from the project's own file. They run on this computer as you, without a shell:`);
      if (kind === 'check') for (const c of block) out(`  check:   ${showWords(c.run)}  (up to ${c.minutes} min)`);
      else {
        for (const k of ['update', 'verify', 'back']) for (const c of block[k]) out(`  ${`${k}:`.padEnd(8)} ${c.url ? `${c.url} answers ${c.status} within ${c.seconds} s` : `${showWords(c.run)}  (up to ${c.minutes} min)`}`);
        if (block.keep.length) out(`  kept the same: ${block.keep.join(', ')}`);
        out(block.github ? '  GitHub token: these commands get it ("github": true)' : '  GitHub token: not given to these commands');
      }
      out(COVERS[kind]);
      if (!(await yes(`Confirm exactly these ${kind} commands for ${name} on this computer? (y/N) `))) return out('Nothing changed.'), 1;
      allow(real, kind, block);
      return out('Confirmed. A change to any of them asks again.'), 0;
    }
    if (cmd === 'live') {
      const t = named(rest[0]);
      const plan = await planLive(real, t);
      if (restartsDashboard(real, plan.live)) throw fail(409, `${name}'s update restarts the dashboard: go live from the page, which can see what a restart would cut`, 'page-only');
      if (!plan.confirmed) throw fail(409, `confirm the go-live commands first: hoprig ship allow ${name} live ${t.name}`, 'not-confirmed');
      out('This will run, in the project\'s folder:');
      for (const k of ['update', 'verify']) for (const l of plan.shown[k]) out(`  ${`${k}:`.padEnd(8)} ${l}`);
      out(`If it is not verified, "hoprig ship back ${name}" runs: ${plan.shown.back.join('; ')}`);
      if (!(await yes(`Go live with "${t.name}" now? (y/N) `))) return out('Nothing ran.'), 1;
      const j = await (await goLive(real, t, { env })).done;
      out(j.outcome === 'live' ? `Live since ${new Date(j.liveSince).toTimeString().slice(0, 5)}.` : `${OUTCOME[j.outcome] || j.outcome}: ${j.why || ''}`);
      return j.outcome === 'live' || j.outcome === 'taken-back' ? 0 : 1;
    }
    if (cmd === 'back') {
      const last = readLast(real);
      if (!last) throw fail(409, `there is no go-live of ${name} to take back`);
      if (restartsDashboard(real, last.live)) throw fail(409, `${name}'s back restarts the dashboard: take it back from the page`, 'page-only');
      out(`This will run: ${backShown(last).join('; ')}`);
      if (!(await yes(`Take "${last.name}" back now? (y/N) `))) return out('Nothing ran.'), 1;
      const j = await takeBack(real, { env });
      out(j.outcome === 'taken-back' ? `Taken back${j.keptSame === false ? `, but kept files differ from before: ${j.changed.map((c) => c.path).join(', ')}` : j.keptSame === true ? '' : ' (the files you keep were not compared: no picture of them from before was kept)'}.` : `Taking back failed: ${j.why}`);
      return j.outcome === 'taken-back' ? 0 : 1;
    }
    if (cmd === 'drop') {
      const t = named(rest[0]);
      if (t.closed) throw fail(409, `"${t.name}" is dropped already`);
      out(`This drops the put-together "${t.name}". Its branch ${t.branch} and its folder ${tilde(t.dir)} stay; a new put-together needs another name.`);
      if (!(await yes(`Drop "${t.name}"? (y/N) `))) return out('Nothing changed.'), 1;
      closeTogether(t.id);
      return out(`Dropped. Pick the tasks again with hoprig ship together ${name} <name> <branch>...`), 0;
    }
    if (cmd === 'auto') {
      const on = rest[0] === 'on' ? true : rest[0] === 'off' ? false : undefined;
      const patch = { from: opt('--from'), to: opt('--to'), autoBack: opt('--back') === undefined ? undefined : opt('--back') === 'on' };
      if (on === true) {
        if (!ask) throw fail(409, 'turning it on needs the project\'s name typed on a terminal', 'no-terminal');
        patch.on = true;
        patch.typed = await ask(`It will go live by itself after a passed check, inside the hours. Type the project's name (${name}) to turn it on: `);
      } else if (on === false) patch.on = false;
      const tg = togethersOf(top).find((x) => x.finished);
      const s = setAuto(real, name, patch, readLive(where(tg)).live);
      return out(`By itself: ${s.auto ? `on, ${s.from} to ${s.to}${s.autoBack ? ', taken back by itself when not verified' : ''}` : 'off'}`), 0;
    }
    throw usage();
  } catch (e) {
    const exit = e.status === 400 ? 2 : 1;
    if (json) out(JSON.stringify({ ok: false, code: e.usage ? 'usage' : (e.details && e.details.code) || 'refused', message: e.message }));
    else err(e.message);
    return exit;
  }
}
