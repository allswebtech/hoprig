// hoprig tasks schedules: the schedules of this computer (Settings' automations) and the repeating items and run times
// of Work, in one list, each with what it does, where it runs and when it runs next on this computer's clock. And the
// words of --repeat, --run-at and --computer for add and edit.
import { readSettings } from '../automation/settings.mjs';
import { describeAction, nextSlot } from '../automation/schedules.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { writerId } from './runs.mjs';
import { readDoc } from './store.mjs';
import { placedItems, statusOf, todayIn, viewItem, CLOSED } from './model.mjs';
import { checkRepeat, checkRunAt, repeatText, ruleOf } from './repeat.mjs';

const usage = (message) => Object.assign(new Error(message), { status: 400, usage: true });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** --repeat daily | weekly:1,4 | monthly:31 | none → a rule, or null (none). */
export function repeatOf(text) {
  if (text === 'none') return null;
  const m = /^(daily|weekly|monthly)(?::([0-9,]+))?$/.exec(String(text));
  if (!m) throw usage('--repeat is daily, weekly:<days 0-6, Sunday is 0> (weekly:1,4), monthly:<day 1-31> or none');
  try {
    if (m[1] === 'daily' && !m[2]) return checkRepeat({ kind: 'daily' });
    if (m[1] === 'weekly' && m[2]) return checkRepeat({ kind: 'weekly', days: m[2].split(',').filter(Boolean).map(Number) });
    if (m[1] === 'monthly' && m[2] && !m[2].includes(',')) return checkRepeat({ kind: 'monthly', day: Number(m[2]) });
  } catch (e) {
    throw usage(`--repeat: ${e.message}`);
  }
  throw usage('--repeat is daily, weekly:1,4, monthly:31 or none');
}

/**
 * --run-at HH:MM | none, with --computer here | <id> → a run time, or null. `dryRun`: this computer's id is only read,
 * never made (a computer that has none yet shows the run time without one: nothing is written).
 */
export function runAtOf(time, computer, { dryRun = false } = {}) {
  if (time === 'none') return null;
  try {
    return checkRunAt({ time, computer: computer === undefined ? null : computer === 'here' ? writerId({ make: !dryRun }) : computer });
  } catch (e) {
    throw usage(`--run-at: ${e.message}`);
  }
}

const when = (ms, tz) => (ms ? new Date(ms).toLocaleString('en-GB', { timeZone: tz || undefined, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not again');

/** The rows: { kind: 'schedule' | 'repeat', id, what, where, next (ms or null), on } */
export function scheduleRows(cfg, place, now = Date.now()) {
  const me = writerId({ make: false }); // a list writes nothing; without an id yet no item names this computer
  const s = readSettings((cfg || {}).automation);
  const rows = s.schedules.list.map((x) => ({
    kind: 'schedule', id: x.id, title: x.label || describeAction(x.action), what: describeAction(x.action),
    computer: x.computer || me, here: !x.computer || x.computer === me, enabled: x.enabled && s.schedules.enabled,
    next: x.enabled && s.schedules.enabled ? nextSlot(x.when, now) : null, when: x.when,
  }));
  let doc = { items: [] };
  const today = todayIn((place && place.settings && place.settings.timeZone) || '', new Date(now));
  try {
    doc = readDoc(place.file).doc;
  } catch {
    /* no Work list: only the schedules */
  }
  for (const [raw] of placedItems(doc)) {
    const rule = ruleOf(raw);
    const at = isObj(raw.work) && isObj(raw.work.at) ? raw.work.at : null;
    if ((!rule && !at) || CLOSED.has(statusOf(raw))) continue;
    const v = viewItem(raw, { today });
    const date = v.date || null;
    const here = !!(at && me && at.computer === me);
    const project = typeof raw.project === 'string' && raw.project ? raw.project : null;
    let next = null;
    if (at && here && project && s.schedules.enabled) next = nextSlot(date ? { kind: 'once', date, time: at.time } : { kind: 'daily', time: at.time }, now);
    // A run time without a computer or a project runs nowhere (alone.mjs refuses it at the slot): said, never a time.
    const problem = at && !at.computer ? 'choose the computer it runs on: it runs nowhere until then' : at && !project ? 'choose the project it runs in: it runs nowhere until then' : null;
    rows.push({
      kind: 'repeat', id: v.id, title: v.title, what: [rule ? repeatText(rule) : null, at ? `run by AI at ${at.time}` : null].filter(Boolean).join(', '),
      computer: at ? at.computer : null, here, date, days: v.days, next, missed: isObj(raw.repeat) && Array.isArray(raw.repeat.missed) ? raw.repeat.missed : [],
      // Another computer runs it at that time on its own clock: on its date, or every day while it is open.
      ...(at && at.computer && !here && project ? { at: at.time, daily: !date } : {}),
      ...(problem ? { problem } : {}),
    });
  }
  return { me, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, today, enabled: s.schedules.enabled, rows };
}

/** The label a linked computer has on this dashboard (schedfeature.mjs keeps them), or null. */
function knownLabel(id) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(stateDir(), 'work-alone', 'computers.json'), 'utf8'));
    const e = Object.values(isObj(d) ? d : {}).find((v) => isObj(v) && v.id === id);
    return e && typeof e.label === 'string' ? e.label.slice(0, 60) : null;
  } catch {
    return null;
  }
}

export function schedulesCommand(cfg, place, { show }) {
  const r = scheduleRows(cfg, place);
  const other = (id) => `computer ${knownLabel(id) ? `"${knownLabel(id)}" ` : ''}${id}`;
  const line = (x) => {
    const where = x.kind === 'schedule' ? (x.here ? 'this computer' : other(x.computer)) : x.computer ? (x.here ? 'this computer' : other(x.computer)) : x.what.includes('run by AI') ? 'no computer chosen' : 'a date only';
    const next = x.kind === 'repeat' && (!x.computer || x.problem) ? (x.date ? `due ${x.date}` : 'no date')
      : x.here ? `next ${when(x.next, r.timeZone)}`
        : x.at ? `${x.daily ? 'every day' : `on ${x.date}`} at ${x.at} on that computer's clock` : 'on that computer\'s clock';
    return `  ${x.kind === 'schedule' ? 'schedule' : 'repeat  '}  ${x.title}: ${x.what} · ${where} · ${next}${x.problem ? ` · ${x.problem}` : ''}  [${x.id}]`;
  };
  const text = [`Schedules and repeating items (this computer's clock, ${r.timeZone})${r.enabled ? '' : ' · schedules are off: none of these runs'}`, ...(r.rows.length ? r.rows.map(line) : ['  none yet'])].join('\n');
  show(r, text);
  return 0;
}
