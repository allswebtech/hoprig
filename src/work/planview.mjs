// A plan as the page and the command show it, worked out from the plan file and the task list (views of
// model.mjs viewItem, with their place in the list). Pure: no files here.
//
//   planView    the goal, the milestones with their tasks in order, the tasks in no milestone, the progress (done of
//               all that are not dropped), the next date, and the timeline
//   timelineOf  tasks and milestones by date, week by week (a week begins on Monday), what has no date apart
//   waitsOf     what a task waits for that is not done (nor dropped): such a task says so and is not offered "Do it"
import { CLOSED, addDays, daysBetween } from './model.mjs';

/** The states of a task that end the wait of a task after it: done, or dropped (it will never be done). */
export const WAIT_OVER = ['done', 'dropped'];
const WEEKS_MAX = 104; // a timeline shows two years of weeks at most; later dates go in its last week's "later"

/** The Monday of the week `ymd` is in. */
export function weekOf(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(ymd, -((d + 6) % 7));
}

/**
 * What task `it` waits for that is not done: [{ id, title, status, missing }] (missing: no task of that id in the list).
 * A task it waits for that was dropped will never be done, so it holds nothing back (WAIT_OVER). `byId`: the list's
 * items by id (the first of two that share an id).
 */
export function waitsOf(it, byId) {
  const out = [];
  for (const id of it.after || []) {
    const o = byId.get(id);
    if (o && WAIT_OVER.includes(o.status)) continue;
    out.push({ id, title: o ? o.title : id, status: o ? o.status : null, missing: !o });
  }
  return out;
}

/** The items of the list by id (the first one where two share an id). */
export function itemsById(items) {
  const m = new Map();
  for (const it of items) if (it.id && !m.has(it.id)) m.set(it.id, it);
  return m;
}

/** Every item with what it waits for (`waits`): the Tasks part and Today show it too. */
export const withWaits = (items) => {
  const byId = itemsById(items);
  return items.map((it) => (it.after && it.after.length ? { ...it, waits: waitsOf(it, byId) } : it));
};

const byDate = (a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(a.date || '').localeCompare(String(b.date || ''));

/**
 * Tasks and milestones by date, week by week: { weeks: [{ start, end, entries, gap, now }], undated: [entry], later:
 * number, thisWeek }. An entry: { kind: "task" | "milestone", id, title, date, … } (a task also its status, who does
 * it, its place in the list, what it waits for, and `late`: open with a date before today; a milestone how many of its
 * tasks are done). `gap`: weeks with nothing between the one before and this one. Weeks with something in them are
 * listed, and this week always when there is any date (empty, it says where today is); `undated`: the tasks and the
 * milestones without a date.
 */
export function timelineOf(milestones, tasks, today) {
  const task = (t) => ({ kind: 'task', id: t.id, at: t.at, title: t.title, date: t.date || null, status: t.status, by: t.by, waits: t.waits || [], late: !!(today && t.date && t.date < today && !CLOSED.has(t.status)) });
  const milestone = (m) => ({ kind: 'milestone', id: m.id, title: m.title, date: m.date || null, done: m.done, all: m.all });
  const entries = [...tasks.filter((t) => t.date).map(task), ...milestones.filter((m) => m.date).map(milestone)]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'task' ? -1 : 1));
  const thisWeek = today ? weekOf(today) : null;
  const weeks = [];
  let later = 0;
  const first = entries.length ? weekOf(entries[0].date) : null;
  const week = (start) => ({ start, end: addDays(start, 6), entries: [], gap: 0, now: start === thisWeek });
  for (const e of entries) {
    const start = weekOf(e.date);
    if (daysBetween(first, start) / 7 >= WEEKS_MAX) {
      later += 1;
      continue;
    }
    let w = weeks[weeks.length - 1];
    if (!w || w.start !== start) {
      w = week(start);
      weeks.push(w);
    }
    w.entries.push(e);
  }
  // This week, also with nothing due in it: where today is, between what is past and what comes.
  if (thisWeek && weeks.length && !weeks.some((w) => w.start === thisWeek) && daysBetween(first, thisWeek) / 7 < WEEKS_MAX) {
    const i = weeks.findIndex((w) => w.start > thisWeek);
    weeks.splice(i < 0 ? weeks.length : i, 0, week(thisWeek));
  }
  weeks.forEach((w, i) => {
    w.gap = i ? daysBetween(weeks[i - 1].start, w.start) / 7 - 1 : 0;
  });
  return { weeks, undated: [...tasks.filter((t) => !t.date).map(task), ...milestones.filter((m) => !m.date).map(milestone)], later, thisWeek };
}

/**
 * One plan with its tasks: { ...plan, milestones: [{ …, tasks, done, all, days }], loose: [task], tasks: count,
 * progress: { done, all }, next, overdue, timeline }. `items`: every item of the list (views with `at`).
 */
export function planView(plan, items, today) {
  const byId = itemsById(items);
  const mine = items.filter((it) => it.plan === plan.id).map((it) => ({ ...it, waits: waitsOf(it, byId) }));
  const known = new Set(plan.milestones.map((m) => m.id));
  const ordered = (list) => [...list].sort(byDate); // a stable sort: the list's own order where the dates are the same
  const milestones = plan.milestones.map((m) => {
    const tasks = ordered(mine.filter((it) => it.milestone === m.id));
    const live = tasks.filter((t) => t.status !== 'dropped');
    return { ...m, tasks, done: live.filter((t) => t.status === 'done').length, all: live.length, days: m.date && today ? daysBetween(today, m.date) : null };
  });
  const loose = ordered(mine.filter((it) => !it.milestone || !known.has(it.milestone)));
  const live = mine.filter((t) => t.status !== 'dropped');
  const open = mine.filter((t) => !CLOSED.has(t.status));
  const dates = [...open.map((t) => t.date), ...milestones.filter((m) => m.all === 0 || m.done < m.all).map((m) => m.date)].filter(Boolean).sort();
  return {
    ...plan,
    milestones,
    loose,
    tasks: mine.length,
    progress: { done: live.filter((t) => t.status === 'done').length, all: live.length },
    next: today ? dates.find((d) => d >= today) || null : dates[0] || null,
    overdue: today ? open.filter((t) => t.date && t.date < today).length : 0,
    timeline: timelineOf(milestones, mine, today),
  };
}

/** A plan in the list of plans: its title, goal, status, progress and next date (no tasks, no timeline). */
export function planRow(plan, items, today) {
  const v = planView(plan, items, today);
  return { id: v.id, title: v.title, goal: v.goal, status: v.status, projects: v.projects, made: v.made, progress: v.progress, next: v.next, overdue: v.overdue, milestones: v.milestones.length, tasks: v.tasks };
}
