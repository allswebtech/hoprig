// "Go live by itself when the check passes" (docs/GO-LIVE.md, "By itself"): a switch per project, off by default, turned
// on only by typing the project's name, with hours (09:00 to 18:00 unless he changes them). With it on, a check that
// passes, whoever started it, is followed by the go-live without the tap: inside the hours, never twice for one tree,
// never for a tree that also failed, never while the live block pushes or publishes, and never cutting a running turn
// (restart.mjs). Nothing here starts a put-together or a check: it only follows a check that ended.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { insideHours, setSwitches, switchesOf } from './allow.mjs';
import { verdict } from './check.mjs';
import { activity } from './live.mjs';
import { publishes } from './project.mjs';

const fail = (status, message, code = 'auto') => Object.assign(new Error(message), { status, details: { code } });
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Change the switch of project `name` at real path `real`. `live`: its cleaned live block (null when it has none). */
export function setAuto(real, name, { on, typed, from, to, autoBack } = {}, live = null) {
  const patch = {};
  if (on !== undefined) {
    if (typeof on !== 'boolean') throw fail(400, 'on is true or false');
    if (on) {
      if (typed !== name) throw fail(400, `type the project's name, ${name}, to let it go live by itself`, 'typed');
      if (!live) throw fail(409, 'this project has no go-live commands yet');
      if (publishes(live)) throw fail(409, 'its go-live commands push or publish (git push, gh, npm publish): that stays your own press, so it cannot go live by itself', 'publishes');
    }
    patch.auto = on;
  }
  for (const [k, v] of [['from', from], ['to', to]]) {
    if (v === undefined) continue;
    if (typeof v !== 'string' || !HM.test(v)) throw fail(400, `${k} is a time such as 09:00`);
    patch[k] = v;
  }
  if (autoBack !== undefined) {
    if (typeof autoBack !== 'boolean') throw fail(400, 'autoBack is true or false');
    patch.autoBack = autoBack;
  }
  return setSwitches(real, patch);
}

const doneFile = (tree) => path.join(stateDir(), 'ship', 'auto', `${tree}.json`);

/**
 * After a check of `rec` (check.mjs record) ended for the project at `real`: go live by itself when the switch and the
 * rules allow it. `go()`: starts the go-live (the caller's, with the restart wait of a go-live by itself). `refuse`: a
 * reason this caller may not start it at all. → what
 * happened: null (the switch is off, or the check did not pass), { skipped: why }, or go()'s answer.
 */
export async function afterCheck(real, name, rec, live, { go, now = new Date(), refuse = null } = {}) {
  const s = switchesOf(real);
  if (!s.auto) return null;
  const v = verdict(rec);
  if (v.state === 'mixed') return skip(name, 'this tree passed its check and also failed it');
  if (v.state !== 'ready') return null;
  if (!live || publishes(live)) return skip(name, 'its go-live commands push or publish');
  // `refuse`: why this caller cannot start it (the command line for a project whose update restarts the dashboard).
  // Said before the mark below, so the dashboard can still go live by itself with this tree later.
  if (refuse) return skip(name, refuse);
  if (!insideHours(s, now)) return skip(name, `it is outside the hours ${s.from} to ${s.to}`);
  // Never twice for one tree: a mark made exclusively before the go-live starts.
  fs.mkdirSync(path.dirname(doneFile(rec.tree)), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(doneFile(rec.tree), `${JSON.stringify({ at: now.toISOString(), real })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') return { skipped: 'this tree already went live by itself once' };
    throw e;
  }
  return go();
}

function skip(name, why) {
  activity().add({ automation: 'go-live', did: `${name}: did not go live by itself: ${why}`, outcome: 'skipped' });
  return { skipped: why };
}
