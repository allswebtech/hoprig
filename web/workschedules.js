// Work → Schedules (#/work/schedules): the schedules of this computer and the repeating tasks in ONE list, each with
// what it does, on which computer, and when it runs next (on that computer's clock); "Add schedule" opens the form that
// reads like a sentence (automation.js scheduleForm). The two switches of the schedules and the note about times are
// one closed Advanced fold at the end; the queue of messages is on each session's sheet only. A repeating task is changed on
// its own sheet (Tasks); here it says its rule, its run time and where that runs.
import { icon } from './icons.js';
import { api, fill, h } from './lib.js';
import { errorBox, fold } from './shell.js';
import { nextRunText, pausedBanner, scheduleForm, schedulesPart } from './automation.js';
import { dayName, whenText } from './workitems.js';

const cap = (t) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);

/**
 * One repeating task (or a task with a run time) as a row of the list: when next in words, as the Tasks rows say it
 * ("Due tomorrow", "2 days overdue"), the computer it runs on (and when that one is not connected now), the days it
 * missed by name. `open(id)`: the task's own sheet. `computers`: /api/work/computers.
 */
export function repeatRow(x, timeZone, { open = null, computers = [], thisYear = null } = {}) {
  const c = x.computer ? computers.find((k) => k.id === x.computer) : null;
  const label = x.computerLabel || (c && c.label) || 'a computer not linked now';
  const where = x.computer ? (x.here ? 'on this computer' : `on ${label}`) : null;
  const due = x.date ? whenText({ date: x.date, days: x.days, status: 'open', approx: false }, thisYear) : null;
  const next = x.here && x.next ? `Next run ${nextRunText(x.next, Date.now(), timeZone)}`
    : x.at ? `${x.daily ? 'Every day' : due} at ${x.at} on ${label}'s clock`
      : due || 'No date';
  const away = x.computer && !x.here && c && c.reachable === false ? `${label} is not connected now: at its time this does not run anywhere` : null;
  const missed = x.missed && x.missed.length ? `Missed ${and(x.missed.slice(-4).map((d) => dayName(d, thisYear)))}${x.missed.length > 4 ? ` (${x.missed.length} days in all)` : ''}` : null;
  return h('button.row.au-sched.wk-repeat', { type: 'button', title: 'Change it on the task', 'aria-label': `Change "${x.title}"`, onclick: () => open && open(x.id) },
    h('span.row-icon', icon(x.what.includes('run by AI') ? 'sparkle' : 'refresh')),
    h('div.au-sched-main',
      h('span.row-title', x.title),
      h('span.au-sentence-line', `${cap(x.what)}.`),
      h('span.row-sub', [next, x.at ? null : where].filter(Boolean).join(' · ')),
      x.problem ? h('span.wk-waits', icon('alert', { size: 14 }), h('span', `${cap(x.problem)}.`)) : null,
      away ? h('span.wk-waits', icon('alert', { size: 14 }), h('span', `${away}.`)) : null,
      missed ? h('span.row-sub', missed) : null),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}

/** Draw the part into `slot`. → { add(), refresh() }. */
export function paintSchedules(slot, { open = null } = {}) {
  const reload = () => draw();
  const add = (preset = null) => scheduleForm(null, preset).then((ok) => ok && reload());
  async function draw() {
    let st;
    let rows;
    let comps;
    try {
      [st, rows, comps] = await Promise.all([api('/api/automation'), api('/api/work/schedules'), api('/api/work/computers').catch(() => ({ computers: [] }))]);
    } catch (e) {
      fill(slot, errorBox(`Could not load the schedules: ${e.message}`, reload));
      return;
    }
    const thisYear = Number(String(rows.today || '').slice(0, 4)) || null;
    const repeats = rows.rows.filter((x) => x.kind === 'repeat').map((x) => repeatRow(x, rows.timeZone, { open, computers: comps.computers || [], thisYear }));
    // schedulesPart draws the switches first, then the list's own heading, rows and note: the list comes first here, the
    // switches and the note go to Advanced, and no heading repeats the tab's name.
    const has = (n, c) => n && typeof n.className === 'string' && n.className.split(/\s+/).includes(c);
    const parts = [schedulesPart(st, { reload, addSchedule: add, rows: repeats, computers: comps.computers || [] })].flat();
    const advanced = parts.filter((n) => has(n, 'au-sched-settings') || has(n, 'au-foot'));
    fill(slot,
      pausedBanner(st, reload),
      parts.filter((n) => !advanced.includes(n) && !has(n, 'group-head')),
      advanced.length ? fold('work-schedules-advanced', 'Advanced', advanced) : null);
  }
  draw();
  return { add, refresh: reload };
}
