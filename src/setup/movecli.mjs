// `hoprig move-to-user [--user NAME] [--no-admin] [--yes] [--dry-run] [--json]`: move an installation that works as
// root to an ordinary user (made first, through the installer, when Hoprig made none here) (src/setup/moveplan.mjs looks; the move itself copies, checks and switches). A dry
// run only looks and says what would happen: it changes nothing anywhere.
import { movePlan, planLines } from './moveplan.mjs';
import { runBack, runMove } from './moverun.mjs';
import { jobWriter } from './movejob.mjs';
import { HELD_LINE, takeLock } from './movelock.mjs';
import { stateDir } from '../paths.mjs';
import { NETWORK_LINE } from './movenet.mjs';
import { usedCopy } from './movemark.mjs';

/** The question asked once before anything changes. */
export const QUESTION = (p) => `Move Hoprig to ${p.user.name} now? Root's dashboard stops for about half a minute; root's copy is kept.`;

export const MOVE_USAGE = `usage:
  hoprig move-to-user [--user NAME [--new]] [--no-admin] [--dry-run] [--yes] [--json]
      move Hoprig from root to an ordinary user (hoprig, made first when Hoprig made none here; --no-admin gives
      it no administrator rights): it lists what runs and what would be copied, asks first, copies, checks the
      copy and switches. Root's copy is kept. --dry-run only shows it. --new (with --user): only a user that is
      not there yet, or one Hoprig made (the main computer passes it when its look said the move makes the user).
  hoprig move-to-user --back [--user NAME]
      the step back: the user's dashboard stopped, root's started again.
`;

/** The arguments → { user, dryRun, yes, json } or { error }. */
export function parseMoveArgs(args) {
  const o = { user: undefined, dryRun: false, yes: false, json: false, back: false, noAdmin: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a === '--back') o.back = true;
    else if (a === '--no-admin') o.noAdmin = true;
    else if (a === '--new') o.fresh = true;
    else if (a === '--job' && i + 1 < args.length) o.job = args[(i += 1)];
    else if (a === '--user' && i + 1 < args.length) o.user = args[(i += 1)];
    else if (a.startsWith('--user=')) o.user = a.slice('--user='.length);
    else return { error: `unknown option: ${a}` };
  }
  return o;
}

/** The plan as the page and --json get it: no function, nothing secret (paths, counts and command lines). */
export const planView = (p) => ({
  ok: p.ok,
  stops: p.stops,
  user: p.user ? { name: p.user.name, home: p.user.home } : null,
  make: !!p.make,
  again: p.again ? { at: p.again.at || null, switchedAt: p.again.switchedAt || null, used: usedCopy(p.again) } : null,
  oldHome: p.oldHome || null,
  parts: (p.parts || []).map(({ id, what, from, to, entries, bytes, repos }) => ({ id, what, from, to, entries, bytes, repos })),
  total: p.total || null,
  free: p.free ?? null,
  need: p.need ?? null,
  running: p.running,
  admin: (p.admin || []).map(({ id, why, argv }) => ({ id, why, argv })),
  network: p.user && p.network?.length ? { hosts: p.network.map((n) => n.host), line: NETWORK_LINE(p.user.name, p.network, p.proxy || null) } : null,
});

/** How far the copy and its check are, as one line. */
export function progressLine(p) {
  if (p.phase === 'check') return `  checking: ${p.repos} of ${p.totalRepos} repositories`;
  // Never more than the total: root's side may have grown since the look counted it.
  const of = (a, b) => (b ? `${Math.min(a, b)} of ${b}` : `${a}`);
  return `  copying: ${of(p.entries, p.totalEntries)} entries, ${of(Math.round(p.bytes / 1e6), p.totalBytes ? Math.round(p.totalBytes / 1e6) : null)} MB`;
}

/**
 * → exit code. `io`, `cfg`, `steps` (the move's steps, moverun.mjs), `low` (their lowest calls) and `ui` ({ confirm }) are handed in by tests; `out`
 * and `err` take each line.
 */
export async function main(args, { io, cfg, steps, low, ui, onSwitched, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`) } = {}) {
  if (args.includes('--help')) {
    out(MOVE_USAGE.trimEnd());
    return 0;
  }
  const o = parseMoveArgs(args);
  if (o.error) {
    err(o.error);
    err(MOVE_USAGE.trimEnd());
    return 2;
  }
  // --job FILE (the page's job, moveroutes.mjs): every line also goes to that file, with the result at the end.
  if (o.job) {
    const w = jobWriter(o.job, low?.chown ? { chown: low.chown } : {});
    const [o1, e1] = [out, err];
    out = (l) => (w.line(l), o1(l));
    err = (l) => (w.line(l), e1(l));
    const code = await main(args.filter((x, i) => x !== '--job' && args[i - 1] !== '--job'), { io, cfg, steps, low, ui, out, err, onSwitched: (st, user) => w.mirror(st, user) });
    w.end({ ok: code === 0, code });
    return code;
  }
  // One move at a time (movelock.mjs): taken before the look, so a second move never looks at a copy being made. A look
  // alone (--dry-run, --json) changes nothing and takes no lock; nor does a run that is not root (nothing to move, and
  // the look says so).
  const uid = io && 'uid' in io ? io.uid : typeof process.getuid === 'function' ? process.getuid() : null;
  const lockDir = io?.dirs?.state || stateDir();
  const lock = o.dryRun || o.json || uid !== 0 ? null : takeLock(lockDir);
  if (lock && !lock.ok) {
    err(HELD_LINE(lock.pid, lockDir));
    return 1;
  }
  try {
    return await moveOnce(o, { io, cfg, steps, low, ui, onSwitched, out, err });
  } finally {
    lock?.release();
  }
}

async function moveOnce(o, { io, cfg, steps, low, ui, onSwitched, out, err }) {
  const config = cfg || (await import('../config.mjs')).loadConfig();
  const plan = await movePlan({ userName: o.user, fresh: !!o.fresh, cfg: config, io });
  if (o.back) {
    if (!plan.user) {
      for (const l of plan.stops) err(l);
      return 1;
    }
    // A user the look would make is not there: no move switched to it, and it has no id to stop a service of.
    if (plan.make) {
      err(`There is no user ${plan.user.name} on this server yet, so there is nothing to go back from: root's dashboard is the one in use.`);
      return 1;
    }
    return (await runBack(plan, { say: out, steps, low })).ok ? 0 : 1;
  }
  // --json (the hub reads it over SSH, src/machines/movehub.mjs): one line, exit 0 when the look ran; `ok` says the rest.
  if (o.json) {
    out(JSON.stringify({ hoprig: 'move-plan', ...planView(plan) }));
    return 0;
  }
  for (const l of planLines(plan)) out(l);
  if (!plan.ok) return 1;
  if (o.dryRun) {
    if (!o.json) out('A dry run: nothing was copied or changed.');
    return 0;
  }
  // --yes is his yes; in a terminal the question's default is no (the move stops root's dashboard).
  const asker = ui || (await import('./ui.mjs')).makeUi({ yes: o.yes });
  if (o.yes) out(`${QUESTION(plan)} yes (--yes)`);
  else if (!(await asker.confirm(QUESTION(plan), false))) {
    out('Nothing was changed. To move: hoprig move-to-user --yes (or answer yes in a terminal).');
    return 1;
  }
  const r = await runMove(plan, { say: out, noAdmin: o.noAdmin, progress: (p) => out(progressLine(p)), steps, low, onSwitched }); // onSwitched gets the user runMove switched to, never the look's
  return r.ok ? 0 : 1;
}
