// The Plans part of the Work page (#/work/plans, #/work/plans/<id>; src/work/plans.mjs keeps them): the list of plans
// with their progress (done of all) and next date, and one plan's screen: its goal, its research note (Markdown shown
// as text: a link as its address, never as HTML), its milestones with their tasks in order, and a timeline of tasks
// and milestones week by week, with what waits for what said plainly. A plan is made by hand here, changed, marked
// done or dropped; a task is put into a plan and taken out. "Plan with AI" and its proposals are workpropose.js.
import { goalSheet } from './mission.js';
import { icon } from './icons.js';
import { add, api, btn, fill, h, openSheet, toast } from './lib.js';
import { mdView } from './mdtext.js';
import { emptyState, errorBox, fold, groupHead, skeletonRows } from './shell.js';
import { dayName, itemRow, setPlanChooser, whoText } from './workitems.js';
import { goalField, planWithAiSheet, proposalSections, setNoteView, takeFocusFor, viewProposal } from './workpropose.js';

const enc = encodeURIComponent;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS = { active: 'Active', done: 'Done', dropped: 'Dropped' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const yearOf = (today) => Number(String(today || '').slice(0, 4)) || null;
/** A day as "3 Dec", with its year when that is not this year (`year`; none given: always without). */
const short = (date, year = null) => {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${year && y !== year ? ` ${y}` : ''}`;
};

/** A research note as text: Markdown's own marks (mdtext.js), and a link as its words with its address after them. */
export function noteView(text) {
  const plain = String(text || '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  return h('div.md.wk-note-md', mdView(plain));
}

/** A small bar of done of all. */
const progressBar = (p) => h('span.wk-progress', { role: 'img', 'aria-label': `${p.done} of ${p.all} done` },
  h('span.wk-progress-fill', { style: { width: `${p.all ? Math.round((p.done / p.all) * 100) : 0}%` } }));

/**
 * The Plans part into `content`. sub: "plans", "plans/<id>" or "proposal/<id>". ctx(): the Work page's ({ projects,
 * today, runs, doIt }, as they are now); data: GET /api/work's answer as it is now; reload(): the Work page looks again.
 * → { refresh(), working(), stop() }.
 */
export function paintPlans(content, { sub, data, ctx, reload }) {
  const m = /^plans\/([^/]+)$/.exec(sub);
  const pm = /^proposal\/([^/]+)$/.exec(sub);
  if (pm) return viewProposal(content, decodeURIComponent(pm[1]), { data, reload });
  if (m) return viewPlan(content, decodeURIComponent(m[1]), { data, ctx, reload });
  return viewList(content, { data, reload });
}

// ---------- the list ----------

function viewList(content, { data, reload }) {
  let alive = true;
  const draw = (r) => {
    if (!alive) return;
    const head = h('div.wk-plans-head',
      h('p.hint.wk-plans-intro', 'A plan is a goal with milestones and the tasks that reach it. Its tasks are ordinary tasks of your list.'),
      h('div.wk-plans-actions',
        btn('secondary', { icon: 'sparkle', label: 'Give Tia a goal', onclick: () => goalSheet(data.projects || []).then((r) => r && reload()) }),
        btn('secondary', { icon: 'plus', label: 'New plan', onclick: () => planSheet(null, data).then((p) => p && (location.hash = `#/work/plans/${enc(p.id)}`)) })));
    const waiting = proposalSections(data.proposals || []);
    const row = (p) => h('a.row.wk-plan-row', { href: `#/work/plans/${enc(p.id)}` },
      h('span.row-icon', icon(p.status === 'done' ? 'check' : p.status === 'dropped' ? 'x' : 'stack')),
      h('span.row-main',
        h('span.row-title', p.title),
        h('span.row-sub.wk-plan-sub',
          progressBar(p.progress),
          h('span', `${p.progress.done} of ${p.progress.all} done`),
          p.next ? h('span', `next ${dayName(p.next, yearOf(r.today))}`) : null,
          p.overdue ? h('span.wk-late', `${p.overdue} overdue`) : null,
          p.projects.length ? h('span.wk-tag', icon('folder', { size: 13 }), p.projects.join(', ')) : null)),
      h('span.row-end', icon('chevronRight', { size: 18 })));
    const active = r.plans.filter((p) => p.status === 'active');
    const done = r.plans.filter((p) => p.status === 'done');
    const dropped = r.plans.filter((p) => p.status === 'dropped');
    const broken = r.unreadable.length ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${plural(r.unreadable.length, 'file')} in the plans folder ${r.unreadable.length === 1 ? 'is' : 'are'} not read as a plan: ${r.unreadable.map((u) => `${u.name} (${u.why})`).join('; ')}.`)) : null;
    const empty = !r.plans.length ? h('div.card.wk-start', emptyState('stack', 'No plans yet. Write a goal and let a session research it and propose milestones and dated tasks, or make a plan yourself.',
      data.planWithAi ? btn('primary', { icon: 'sparkle', label: 'Plan with AI', onclick: () => planWithAiSheet(data) }) : null)) : null;
    fill(content, head, waiting, broken, empty,
      active.length ? h('section.wk-section', groupHead('Active', active.length), h('div.rows', active.map(row))) : null,
      done.length ? fold('work-plans-done', `Done (${done.length})`, h('div.rows', done.map(row))) : null,
      dropped.length ? fold('work-plans-dropped', `Dropped (${dropped.length})`, h('div.rows', dropped.map(row))) : null);
  };
  const load = () => api('/api/work/plans').then(draw, (e) => alive && fill(content, errorBox(`Could not load the plans: ${e.message}`, load)));
  fill(content, skeletonRows(3));
  load();
  return { refresh: load, working: () => false, stop: () => (alive = false) };
}

// ---------- one plan ----------

function viewPlan(content, id, { data, ctx, reload }) {
  let alive = true;
  let shown = null;
  const load = () => api(`/api/work/plans/${enc(id)}`).then((r) => {
    if (!alive) return;
    shown = r;
    draw(r);
  }, (e) => alive && fill(content, h('a.wk-back', { href: '#/work/plans' }, icon('back', { size: 16 }), 'Plans'), errorBox(e, load)));
  const after = () => {
    reload();
    load();
  };
  // After a change of its status the screen is drawn anew: the focus goes to the button that undoes it.
  let refocus = false;
  function draw(r) {
    const p = r.plan;
    const year = yearOf(r.today);
    const setStatus = (status) => api(`/api/work/plans/${enc(p.id)}`, { seen: r.hash, status }).then(() => {
      toast(status === 'active' ? 'The plan is active again' : status === 'done' ? 'Plan marked done' : 'Plan dropped');
      refocus = true;
      load();
    }, (e) => toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 }));
    const statusBtn = p.status === 'active' ? btn('small secondary', { icon: 'check', label: 'Mark done', onclick: () => setStatus('done') }) : btn('small secondary', { icon: 'undo', label: 'Active again', onclick: () => setStatus('active') });
    const heading = h('h2.wk-plan-title', { tabindex: '-1' }, p.title);
    const head = h('section.card.wk-plan-card',
      h('div.wk-plan-top',
        h('div.wk-plan-titles',
          heading,
          h('p.wk-plan-goal', p.goal)),
        h('span.badge.soft', STATUS[p.status] || p.status)),
      h('div.wk-plan-meta',
        progressBar(p.progress),
        h('span', `${p.progress.done} of ${p.progress.all} done`),
        p.next ? h('span', `next ${dayName(p.next, year)}`) : null,
        p.overdue ? h('span.wk-late', `${p.overdue} overdue`) : null,
        p.projects.length ? h('span.wk-tag', icon('folder', { size: 13 }), p.projects.join(', ')) : null,
        h('span', p.made.how === 'proposal' ? `made from a proposal on ${short(p.made.at.slice(0, 10))}` : `made by hand on ${short(p.made.at.slice(0, 10))}`)),
      h('div.wk-plan-actions',
        btn('small secondary', { icon: 'pencil', label: 'Change', onclick: () => planSheet({ ...p, hash: r.hash }, data).then((x) => x && load()) }),
        btn('small secondary', { icon: 'plus', label: 'Put a task in it', onclick: () => putTaskSheet(p, data).then((x) => x && after()) }),
        statusBtn,
        p.status === 'active' ? btn('small ghost', { icon: 'x', label: 'Drop', onclick: () => setStatus('dropped') }) : null));
    const taskRows = (list) => h('div.rows', list.map((it) => itemRow(it, { ...ctx(), planLinks: false }, after)));
    const parts = p.milestones.map((m) => h('section.wk-section',
      h('div.group-head.wk-milestone-head',
        h('span.wk-milestone-name', icon('stack', { size: 15 }), m.title),
        h('span.wk-milestone-when', m.date ? dayName(m.date, year) : 'no date'),
        h('span.wk-ms-count', { title: `${m.done} of ${m.all} done` }, `${m.done}/${m.all}`)),
      m.tasks.length ? taskRows(m.tasks) : h('p.hint.wk-hint', 'No tasks in this milestone yet.')));
    if (p.loose.length) parts.push(h('section.wk-section', groupHead(p.milestones.length ? 'In no milestone' : 'Tasks', p.loose.length), taskRows(p.loose)));
    if (!p.tasks) parts.push(h('p.hint.wk-hint', 'No tasks in this plan yet: put one in with "Put a task in it", or from a task\'s ⋯.'));
    const note = r.note ? h('section.wk-section', groupHead('Research note'), h('div.card.wk-note-card', noteView(r.note))) : null;
    fill(content,
      h('a.wk-back', { href: '#/work/plans' }, icon('back', { size: 16 }), 'Plans'),
      head,
      parts,
      timeline(p.timeline, year),
      note);
    // After a change of its status, the button that undoes it; just accepted, the plan's title (the proposal's Accept
    // is gone), unless the focus is somewhere already.
    const lost = !document.activeElement || document.activeElement === document.body;
    if (refocus) statusBtn.focus();
    else if (lost && takeFocusFor(p.id)) heading.focus();
    refocus = false;
  }
  fill(content, skeletonRows(4));
  load();
  return { refresh: load, working: () => false, stop: () => (alive = false), shown: () => shown };
}

/** Tasks and milestones by date, week by week; what waits for what said in words; quiet weeks counted. */
export function timeline(t, year) {
  if (!t.weeks.length && !t.undated.length) return null;
  // A row: its mark, its day, and the rest (title, who, what it waits for) in one cell that wraps under the title.
  const day = (e) => h(`span.wk-tl-day${e.late ? '.wk-late' : ''}`, e.date ? dayName(e.date, year) : '');
  const entry = (e) => (e.kind === 'milestone'
    ? h('li.wk-tl-milestone', h('span.wk-tl-mark', icon('stack', { size: 14 })), day(e), h('span.wk-tl-rest', h('strong', e.title), h('span.wk-tl-count', `${e.done}/${e.all}`)))
    : h(`li.wk-tl-task.wk-st-${e.status}`,
      h('span.wk-tl-mark', e.status === 'done' ? icon('check', { size: 14 }) : h('span.wk-dot')),
      day(e),
      h('span.wk-tl-rest',
        h('span.wk-tl-title', e.title),
        e.late ? h('span.wk-late.wk-tl-late', 'overdue') : null,
        h('span.wk-who', whoText(e.by)),
        e.waits.length ? h('span.wk-tl-waits', icon('clock', { size: 12 }), `waits for ${e.waits.map((w) => w.title).join(', ')}`) : null)));
  const weeks = t.weeks.map((w) => [
    w.gap > 0 ? h('li.wk-tl-gap', `${plural(w.gap, 'week')} with nothing`) : null,
    h(`li.wk-tl-week${w.now ? '.wk-tl-now' : ''}`,
      h('div.wk-tl-label', h('strong', w.now ? 'This week' : `Week of ${short(w.start, year)}`), h('span', `${short(w.start, year)} – ${short(w.end, year)}`)),
      w.entries.length ? h('ul.wk-tl-entries', w.entries.map(entry)) : h('p.hint.wk-tl-empty', 'Nothing due this week')),
  ]);
  return h('section.wk-section', groupHead('Timeline'),
    h('ol.wk-timeline', { 'aria-label': 'The plan week by week' }, weeks,
      t.later ? h('li.wk-tl-gap', `${plural(t.later, 'more date')} later than two years`) : null,
      t.undated.length ? h('li.wk-tl-week', h('div.wk-tl-label', h('strong', 'No date')), h('ul.wk-tl-entries', t.undated.map(entry))) : null));
}

// ---------- sheets ----------

/** A list of checkboxes (projects). */
function checks(names, chosen, label) {
  return h('div.wk-checks', { role: 'group', 'aria-label': label }, names.map((n) => h('label.wk-check-line',
    h('input', { type: 'checkbox', value: n, checked: chosen.includes(n) }), h('span', n))));
}
const checked = (el) => [...el.querySelectorAll('input:checked')].map((x) => x.value);

/** Milestones as rows of a title and a date, with Add and Take out. → { el, value() }. */
function milestoneEditor(list) {
  const rows = h('div.wk-ms-rows');
  const more = (m = { title: '', date: null }) => {
    const row = h('div.wk-ms-row', { dataset: { id: m.id || '' } },
      h('input.field', { value: m.title, maxlength: 200, placeholder: 'A milestone: what is true when it is reached', 'aria-label': 'Milestone' }),
      h('input.field.wk-date', { type: 'date', value: m.date || '', 'aria-label': 'Its date' }),
      btn('icon small ghost', { icon: 'x', title: 'Take this milestone out', onclick: () => {
        // The focus stays in the sheet: on the row before (its title), else on "Add a milestone".
        const before = row.previousElementSibling;
        row.remove();
        (before ? before.querySelector('input') : addBtn).focus();
      } }));
    add(rows, row);
    return row;
  };
  for (const m of list) more(m);
  const addBtn = btn('small ghost', { icon: 'plus', label: 'Add a milestone', onclick: () => more().querySelector('input').focus() });
  return {
    el: h('div.wk-ms', rows, addBtn),
    value: () => [...rows.children].map((r) => {
      const [t, d] = r.querySelectorAll('input');
      return { ...(r.dataset.id ? { id: r.dataset.id } : {}), title: t.value, date: d.value || null };
    }).filter((m) => m.title.trim() || m.date),
  };
}

/** Make a plan by hand (`p` null) or change one. Resolves the plan, or null. */
function planSheet(p, data) {
  return openSheet({ title: p ? 'Change the plan' : 'New plan', tall: true }, (close) => {
    const err = h('p.form-error', { role: 'alert' });
    const title = h('input.field', { value: p ? p.title : '', maxlength: 200, autofocus: true, placeholder: 'What the plan reaches, in a few words' });
    const goal = goalField({ value: p ? p.goal : '', maxlength: 300, placeholder: 'The goal in one sentence: how you know it is reached' });
    const projects = checks([...new Set([...(data.projects || []), ...(p ? p.projects : [])])], p ? p.projects : [], 'Projects');
    const ms = milestoneEditor(p ? p.milestones : []);
    const submit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      const body = { title: title.value, goal: goal.value, projects: checked(projects), milestones: ms.value() };
      try {
        const r = p ? await api(`/api/work/plans/${enc(p.id)}`, { seen: p.hash, ...body }) : await api('/api/work/plans', body);
        toast(p ? 'Plan changed' : 'Plan made');
        close(r.plan);
      } catch (x) {
        err.textContent = x.message;
      }
    };
    return h('form.wk-form', { onsubmit: submit },
      h('label.fieldrow', h('span.field-label', 'Plan'), title),
      h('label.fieldrow', h('span.field-label', 'Goal'), goal),
      h('div.fieldrow', h('span.field-label', 'Projects it is about'), projects),
      h('div.fieldrow', h('span.field-label', 'Milestones'), ms.el),
      err,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, p ? 'Save changes' : 'Make the plan')));
  });
}

/** Put a task of the list into plan `p` (one not in a plan, or move one), with its milestone. Resolves true when done. */
function putTaskSheet(p, data) {
  // The tasks in no plan first (the first of them chosen), then those of other plans, each under its plan's name:
  // moving one out of its plan is never what Enter does by itself.
  const open = (data.items || []).filter((it) => it.editable && it.plan !== p.id && !['done', 'dropped'].includes(it.status));
  const loose = open.filter((it) => !it.plan);
  const titleOf = (id) => (data.planTitles && data.planTitles[id]) || id;
  const others = [...new Set(open.filter((it) => it.plan).map((it) => it.plan))].map((id) => [id, open.filter((it) => it.plan === id)]);
  const free = [...loose, ...others.flatMap(([, list]) => list)];
  return openSheet({ title: 'Put a task in this plan', subtitle: p.title }, (close) => {
    if (!free.length) return [h('p.sheet-text', 'Every open task is in this plan already, or there are none: add a task first.'), h('div.sheet-actions', btn('primary', { label: 'Close', onclick: () => close(false) }))];
    const err = h('p.form-error', { role: 'alert' });
    const option = (it) => h('option', { value: String(free.indexOf(it)) }, it.title);
    const task = h('select.field', { 'aria-label': 'Task' },
      loose.length ? h('optgroup', { label: 'In no plan' }, loose.map(option)) : null,
      others.map(([id, list]) => h('optgroup', { label: `Moves out of the plan "${titleOf(id)}"` }, list.map(option))));
    const ms = h('select.field', { 'aria-label': 'Milestone' }, h('option', { value: '' }, 'No milestone'), p.milestones.map((m) => h('option', { value: m.id }, m.title)));
    const submit = async (e) => {
      e.preventDefault();
      const it = free[Number(task.value)];
      try {
        await api(`/api/work/items/${enc(it.id)}/plan`, { at: it.at, plan: p.id, milestone: ms.value || null });
        toast(it.plan ? `The task moved here out of the plan "${titleOf(it.plan)}"` : 'The task is in the plan');
        close(true);
      } catch (x) {
        err.textContent = x.message;
      }
    };
    return h('form.wk-form', { onsubmit: submit },
      h('label.fieldrow', h('span.field-label', 'Task'), task),
      h('label.fieldrow', h('span.field-label', 'Milestone'), ms),
      err,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'Put it in')));
  }).then((x) => x === true);
}

/** A task's ⋯ → "Plan": its plan and milestone, or out of it (workitems.js calls this). Resolves true when changed. */
async function chooseFor(it) {
  let plans;
  try {
    plans = (await api('/api/work/plans')).plans.filter((p) => p.status === 'active' || p.id === it.plan);
  } catch (e) {
    toast(e, { kind: 'error' });
    return false;
  }
  const full = {};
  return openSheet({ title: it.plan ? 'Its plan' : 'Put it in a plan', subtitle: it.title }, (close) => {
    if (!plans.length) return [h('p.sheet-text', 'There is no active plan yet. Make one on the Plans part of Work.'), h('div.sheet-actions', btn('primary', { label: 'Close', onclick: () => close(false) }))];
    const err = h('p.form-error', { role: 'alert' });
    const ms = h('select.field', { 'aria-label': 'Milestone' });
    const plan = h('select.field', { 'aria-label': 'Plan', onchange: () => fillMs() }, plans.map((p) => h('option', { value: p.id, selected: p.id === it.plan }, p.title)));
    async function fillMs() {
      const id = plan.value;
      if (!full[id]) full[id] = (await api(`/api/work/plans/${enc(id)}`)).plan;
      fill(ms, h('option', { value: '' }, 'No milestone'), full[id].milestones.map((m) => h('option', { value: m.id, selected: m.id === it.milestone }, m.title)));
    }
    fillMs().catch((e) => (err.textContent = e.message));
    const send = async (body, word) => {
      try {
        await api(`/api/work/items/${enc(it.id)}/plan`, { at: it.at, ...body });
        toast(word);
        close(true);
      } catch (x) {
        err.textContent = x.message;
      }
    };
    return h('form.wk-form', { onsubmit: (e) => {
      e.preventDefault();
      send({ plan: plan.value, milestone: ms.value || null }, 'The task is in the plan');
    } },
    h('label.fieldrow', h('span.field-label', 'Plan'), plan),
    h('label.fieldrow', h('span.field-label', 'Milestone'), ms),
    err,
    h('div.sheet-actions',
      it.plan ? h('button.btn.ghost', { type: 'button', onclick: () => send({ plan: null }, 'The task is out of its plan') }, 'Take it out of the plan') : null,
      h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'Save')));
  }).then((x) => x === true);
}
setPlanChooser(chooseFor);
setNoteView(noteView);
