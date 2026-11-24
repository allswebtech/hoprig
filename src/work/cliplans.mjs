// hoprig tasks plans | plan <id>: the plans of Work from a terminal (the Plans part of the Work page), read only.
import { CLOSED } from './model.mjs';
import { listPlans, readNote, readPlan } from './plans.mjs';
import { planRow, planView, withWaits } from './planview.mjs';

const progress = (p) => `${p.progress.done} of ${p.progress.all} done`;

/** `plans`: every plan with its progress and next date. */
export function plansCommand(place, store, { show }) {
  const { plans, unreadable } = listPlans(place);
  const items = withWaits(store.list().items);
  const today = store.today();
  const rows = plans.map((p) => planRow(p, items, today));
  // The ids padded to the longest one: every title starts in one column.
  const idWidth = Math.max(0, ...rows.map((p) => p.id.length));
  const lines = rows.length
    ? rows.map((p) => `${p.status.padEnd(8)} ${progress(p).padEnd(14)} ${(p.next ? `next ${p.next}` : '').padEnd(16)} ${p.id.padEnd(idWidth)}  ${p.title}`)
    : [`tasks: no plans yet (${place.label}/plans)`];
  for (const u of unreadable) lines.push(`  ${u.name} is not read as a plan: ${u.why}`);
  show({ today, plans: rows, unreadable }, lines.join('\n'));
  return 0;
}

/** `plan <id>`: one plan: its goal, milestones with their tasks, what waits, the note. */
export function planCommand(place, store, id, { show }) {
  const plan = readPlan(place, id);
  if (!plan) throw Object.assign(new Error(`there is no plan "${String(id).slice(0, 80)}" (hoprig tasks plans lists them)`), { status: 404 });
  const today = store.today();
  const v = planView(plan, withWaits(store.list().items), today);
  const note = readNote(place, plan);
  const task = (t) => {
    const mark = t.status === 'done' ? '✓' : t.status === 'dropped' ? '×' : CLOSED.has(t.status) ? ' ' : '·';
    const waits = t.waits.length ? `  (waits for ${t.waits.map((w) => w.id).join(', ')})` : '';
    return `    ${mark} ${(t.date || 'no date').padEnd(10)} ${t.by.padEnd(9)} ${t.id}  ${t.title}${waits}`;
  };
  const lines = [`${v.title}  [${v.id}, ${v.status}, ${progress(v)}${v.next ? `, next ${v.next}` : ''}]`, `Goal: ${v.goal}`];
  if (v.projects.length) lines.push(`Projects: ${v.projects.join(', ')}`);
  lines.push(`Made ${v.made.how === 'proposal' ? 'from a proposal' : 'by hand'} on ${v.made.at.slice(0, 10)}`, '');
  for (const m of v.milestones) lines.push(`  ${m.title}  (${m.date || 'no date'}, ${m.done} of ${m.all} done)`, ...m.tasks.map(task));
  if (v.loose.length) lines.push('  In no milestone', ...v.loose.map(task));
  if (note) lines.push('', 'Research note', ...note.split('\n').map((l) => `  ${l}`));
  show({ today, plan: v, note }, lines.join('\n'));
  return 0;
}
