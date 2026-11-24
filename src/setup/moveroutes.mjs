// The move to an ordinary user on this server's own page (Settings → Runs as root):
//   GET  /api/move               → { root, server, plan (the look, movecli.mjs planView) | null, job | null }
//   POST /api/move  { confirm, noAdmin }  start it: only from the signed-in page here (never a computer token or Tia's door),
//                                only as root, after one confirmation that names this server (`confirm` is its name)
//   GET  /api/move/job?from=N    → { running, lines, next, result }
// The move stops root's dashboard, so it runs as a process of its own (`hoprig move-to-user --yes --job FILE`,
// detached; the service stops only its main process, KillMode=process). Its lines are in the job file, which after the
// switch is also in the user's state folder: the user's dashboard on the same port answers GET /api/move with it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { binFile, hostName, stateDir } from '../paths.mjs';
import { planView } from './movecli.mjs';
import { movePlan } from './moveplan.mjs';
import { JOB_FILE, readJob, startJob } from './movejob.mjs';

export const PAGE_ONLY = 'The move is started only from this server\'s own page, signed in here: not by another computer or Tia.';

/** The detached process of the move. `spawnFn` is handed in by tests. */
export function startMoveProcess(file, { spawnFn = spawn, env = process.env, noAdmin = false } = {}) {
  const child = spawnFn(process.execPath, [binFile(), 'move-to-user', '--yes', ...(noAdmin ? ['--no-admin'] : []), '--job', file], { detached: true, stdio: 'ignore', env });
  child.unref?.();
  return child.pid;
}

/** o: { plan (cfg) → movePlan, start(file) → pid, server () → name, jobFile } (tests) */
export function moveFeature(ctx, o = {}) {
  const jobFile = o.jobFile || (() => path.join(stateDir(), JOB_FILE));
  const server = o.server || hostName;
  const plan = o.plan || ((cfg) => movePlan({ cfg }));
  const start = o.start || ((file, more) => startMoveProcess(file, more));
  let claiming = false; // a press whose look still runs (movelock.mjs keeps two processes apart)
  const view = (j, from = 0) => (j ? { running: j.running === true, lines: j.lines.slice(from), next: j.lines.length, result: j.result || null } : null);
  return {
    name: 'move',
    routes: [
      ['GET', /^\/api\/move$/, async () => {
        const job = view(readJob(jobFile()));
        if (ctx.root !== true) return { root: false, server: server(), plan: null, job };
        return { root: true, server: server(), plan: job?.running ? null : planView(await plan(ctx.config())), job };
      }],
      ['POST', /^\/api\/move$/, async (req) => {
        const b = await ctx.readJson(req);
        if (typeof ctx.caller !== 'function' || ctx.caller(req) !== 'page') throw new ctx.HttpError(403, PAGE_ONLY);
        if (ctx.root !== true) throw new ctx.HttpError(409, 'Hoprig does not run as root here: there is nothing to move.');
        if (typeof b.confirm !== 'string' || b.confirm !== server()) throw new ctx.HttpError(400, `confirm the move with this server's name, ${server()}`);
        // Claimed before the look's first await: a second press (two tabs, a double tap) meanwhile is told it runs.
        if (claiming || readJob(jobFile())?.running) throw new ctx.HttpError(409, 'the move is running already');
        claiming = true;
        try {
          const p = await plan(ctx.config());
          if (!p.ok) throw new ctx.HttpError(409, p.stops.join(' '));
          // Written before the process starts: the page's first ask finds the move running, never an old or no file.
          startJob(jobFile());
          // His choice on the sheet: no administrator rights for the user the move makes (--no-admin).
          start(jobFile(), { noAdmin: b.noAdmin === true });
          return { started: true };
        } finally {
          claiming = false;
        }
      }],
      ['GET', /^\/api\/move\/job$/, async (req, m, q) => {
        const j = readJob(jobFile());
        const from = Math.max(0, Math.min(j ? j.lines.length : 0, Number(q && q.get('from')) || 0));
        return view(j, from) || { running: false, lines: [], next: 0, result: null };
      }],
    ],
  };
}
