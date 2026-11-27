// "Plan with AI" on the Work page (src/work/planai.mjs runs it): the sheet where the owner writes a goal in his own
// words and picks the project (and more), the provider, model and effort; the rows of the proposals that wait for him
// (Today and Plans); and the PROPOSAL screen (#/work/proposal/<id>): everything on one screen, the session's words
// shown as the session's, where he changes a title, a date or who does it, takes out a task or a milestone, and
// presses Accept (only then is anything written) or Dismiss. An answer that could not be read is shown with the reason
// and as text.
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, openSheet, toast, wayLink } from './lib.js';
import { modelPicker } from './modelpicker.js';
import { leadSwitch } from './leadswitch.js';
import { errorBox, fold, groupHead, skeletonRows } from './shell.js';
import { sessionLink, timeText } from './workdo.js';
import { whoText } from './workitems.js';

const enc = encodeURIComponent;
const ROW_WORDS = { ready: 'A plan to look at', working: 'A session is planning', unreadable: 'The proposal could not be read', failed: 'Planning ended without a proposal' };
const ROW_ICONS = { ready: 'sparkle', working: 'clock', unreadable: 'alert', failed: 'alert' };

/** The coding tool, provider, model and effort: closed (advanced), and open only while a provider is still to be chosen. */
const planMore = (needsProvider, body) => {
  const d = fold('plan-more', 'More options', body);
  if (needsProvider) d.open = true;
  return d;
};

/**
 * The proposals that wait for the owner, as rows: each opens its proposal screen. A ready one is named by his own goal;
 * the title the session gave it is said to be the session's.
 */
export function proposalRows(list) {
  return list.map((p) => h(`a.row.wk-proposal-row.wk-prop-${p.state}`, { href: `#/work/proposal/${enc(p.id)}` },
    h('span.row-icon', icon(ROW_ICONS[p.state] || 'sparkle')),
    h('span.row-main',
      h('span.row-title', p.state === 'ready' ? p.goal : ROW_WORDS[p.state]),
      h('span.row-sub', p.state === 'ready' ? `${ROW_WORDS.ready} · the session proposed "${p.title}" · ${p.tasks} task${p.tasks === 1 ? '' : 's'}` : `"${p.goal}"${p.state === 'working' ? ` · started ${timeText(p.startedAt)}` : ''}`)),
    h('span.row-end', icon('chevronRight', { size: 18 }))));
}

/**
 * The proposals as Today and Plans show them: "Plans to look at" counts only what he can look at (ready, and one that
 * could not be read); a session still planning is a quiet line; one that ended without a proposal is under its own
 * words. → [element] (none when there are none).
 */
export function proposalSections(list = []) {
  const look = list.filter((p) => p.state === 'ready' || p.state === 'unreadable');
  const working = list.filter((p) => p.state === 'working');
  const failed = list.filter((p) => p.state === 'failed');
  return [
    look.length ? h('section.wk-section', groupHead('Plans to look at', look.length), h('div.rows', proposalRows(look))) : null,
    working.length ? h('div.wk-planning', working.map((p) => h('a.wk-planning-line', { href: `#/work/proposal/${enc(p.id)}` }, icon('clock', { size: 14 }), h('span', `A session is planning "${p.goal}"`), h('span.wk-planning-when', `started ${timeText(p.startedAt)}`)))) : null,
    failed.length ? h('section.wk-section', groupHead('Planning ended without a proposal', failed.length), h('div.rows', proposalRows(failed))) : null,
  ].filter(Boolean);
}

/**
 * The goal as one sentence that may be long: a field of two lines that grows with it. Enter adds no line: in a form it
 * sends the form, as a one-line field does.
 */
export function goalField(attrs) {
  const grow = (el) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  const el = h('textarea.field.wk-goal-line', { rows: 2, ...attrs, onkeydown: (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.target.form?.requestSubmit();
  }, oninput: (e) => {
    e.target.value = e.target.value.replace(/[\r\n]+/g, ' ');
    grow(e.target);
    if (attrs.oninput) attrs.oninput(e);
  } });
  requestAnimationFrame(() => el.isConnected && grow(el));
  return el;
}

// After Accept the plan screen puts the focus on the plan's title (workplans.js asks with takeFocusFor). For a few
// seconds: the Work page looks again after Accept and may draw the plan screen twice.
let focusPlan = null;
export const takeFocusFor = (id) => !!focusPlan && focusPlan.id === id && Date.now() < focusPlan.until;

/** Words that mix letters of the Latin alphabet with Cyrillic or Greek ones: a look-alike of a word ("pаyment"). */
export function mixedWords(text) {
  return [...new Set(String(text || '').split(/[^\p{L}\p{M}]+/u).filter((w) => /\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w)))];
}

// ---------- the sheet ----------

/** "Plan with AI": the goal, the project and more, what it runs on; Plan starts the session and opens its proposal. */
/** The plan sheet's last line while Plan cannot start: every missing thing named, in plain words. */
export function planMissing(project, provider) {
  const miss = [project ? null : 'the project the goal is about', provider ? null : 'a provider'].filter(Boolean);
  return miss.length ? `Choose ${miss.join(' and ')}.` : '';
}

let planWays = () => [];
/** The other ways to a plan, offered in the sheet (workplans.js sets them: write it yourself, give it to Tia). */
export const setPlanWays = (fn) => (planWays = fn);

export function planWithAiSheet(data, again = null) {
  return openSheet({ title: 'Plan with AI', subtitle: 'A session researches your goal and proposes a plan', tall: true }, (close) => {
    const body = h('div.wk-do', skeletonRows(3));
    // "Plan again" (a proposal that failed or could not be read): its goal, project and settings filled in.
    const v = again ? { project: again.project, also: [...(again.also || [])], provider: again.provider || null, model: again.model || null, effort: again.effort || null, tool: again.tool || null }
      : { project: null, also: [], provider: null, model: null, effort: null, tool: null };
    let c = null;
    let first = true;
    let refocus = null; // the select that was changed: the form is drawn anew, the focus goes back to it
    const goal = h('textarea.field.wk-goal', { rows: 4, maxlength: 4000, autofocus: true, placeholder: 'What you want reached, in your own words: "make the shop site load fast on a phone before the sale"' });
    if (again) goal.value = again.goal || '';
    const err = h('p.form-error', { role: 'alert' });
    const fix = h('div.wk-do-fix');
    const select = (label, value, options, onchange) => h('label.fieldrow', h('span.field-label', label),
      h('select.field', { dataset: { key: label }, onchange: (e) => {
        refocus = label;
        onchange(e.target.value);
      } }, options.map(([val, text]) => h('option', { value: val, selected: val === (value ?? '') }, text))));
    async function load(want = {}) {
      const q = new URLSearchParams();
      if (want.project) q.set('project', want.project);
      if (want.tool) q.set('tool', want.tool);
      try {
        c = await api(`/api/work/propose?${q}`);
      } catch (e) {
        return fill(body, errorBox(e));
      }
      paint();
    }
    function paint() {
      const project = v.project || c.project;
      const others = c.projects.filter((x) => x !== project);
      const also = h('div.wk-checks', { role: 'group', 'aria-label': 'Also about' }, others.map((n) => h('label.wk-check-line',
        h('input', { type: 'checkbox', value: n, checked: v.also.includes(n), onchange: (e) => (v.also = e.target.checked ? [...v.also, n] : v.also.filter((x) => x !== n)) }), h('span', n))));
      const go = h('button.btn.primary', { type: 'submit', disabled: !project || !(v.provider || c.provider) }, icon('sparkle', { size: 16 }), 'Plan');
      const submit = async (e) => {
        e.preventDefault();
        err.textContent = '';
        fill(fix);
        go.disabled = true;
        go.classList.add('busy');
        try {
          const r = await api('/api/work/propose', { goal: goal.value, project, also: v.also.filter((x) => x !== project), tool: v.tool || c.tool, ...(v.provider || c.provider ? { provider: v.provider || c.provider } : {}), ...(v.model ? { model: v.model } : {}), ...(v.effort ? { effort: v.effort } : {}), ...(typeof v.lead === 'boolean' ? { lead: v.lead } : {}), ...(Array.isArray(v.others) ? { others: v.others } : {}) });
          const p = r.proposal;
          if (p.state === 'failed') {
            err.textContent = p.reason || 'The session did not start.';
            go.disabled = false;
            return;
          }
          toast('A session is planning: its proposal shows here when it is done', p.session ? { action: { label: 'Watch', run: () => (location.hash = sessionLink(p.session)) } } : {});
          close(p);
          location.hash = `#/work/proposal/${enc(p.id)}`;
        } catch (x) {
          go.disabled = false;
          err.textContent = x.message;
          // Characters nobody can see in the goal: one tap takes them out (the server checks it again on Plan).
          if (x.code === 'brief-hidden' && x.data && typeof x.data.clean === 'string') fill(fix, btn('secondary', { label: 'Take them out', onclick: () => {
            goal.value = x.data.clean;
            err.textContent = '';
            fill(fix);
          } }));
        } finally {
          go.classList.remove('busy');
        }
      };
      fill(body, h('form.wk-form', { onsubmit: submit },
        h('label.fieldrow', h('span.field-label', 'Your goal'), goal),
        err,
        fix,
        select('The project it is about', project || '', [...(project ? [] : [['', 'Choose a project']]), ...c.projects.map((x) => [x, x])], (x) => {
          v.project = x || null;
          v.also = v.also.filter((n) => n !== x);
          v.provider = null;
          load({ project: x, tool: v.tool });
        }),
        others.length ? h('div.fieldrow', h('span.field-label', 'Also about'), also) : null,
        planMore(!(v.provider || c.provider), h('div.wk-trio',
          c.tools.length > 1 ? select('Coding tool', v.tool || c.tool, c.tools.map((x) => [x.id, x.name]), (x) => {
            v.tool = x;
            v.provider = null;
            v.model = null;
            v.effort = null;
            load({ project, tool: x });
          }) : null,
          select('Provider', v.provider || c.provider || '', [...(c.provider ? [] : [['', 'Choose one']]), ...c.providers.map((x) => [x.name, x.label])], (x) => {
            v.provider = x || null;
            v.model = null; // another provider has its own models
            paint();
          }),
          // The provider's own models (src/models/catalog.mjs), asked when the sheet is drawn.
          modelPicker({ provider: v.provider || c.provider, tool: v.tool || c.tool, value: v.model || c.model || '', key: 'Model',
            emptyLabel: c.model ? `Default (${c.model})` : 'Default', onchange: (x) => (v.model = x || null) }),
          select('Effort', v.effort || c.effort || '', [['', c.effort ? `Default (${c.effort})` : 'Default'], ...c.efforts.filter((x) => x !== c.effort).map((x) => [x, x])], (x) => (v.effort = x || null)))),
        leadSwitch({ value: typeof v.lead === 'boolean' ? v.lead : c.lead === true, provider: v.provider || c.provider || null, tool: v.tool || c.tool, onchange: (on) => (v.lead = on), others: v.others || c.others || [], onothers: (l) => (v.others = l) }),
        project && (v.provider || c.provider) ? h('p.wk-do-line', icon('info', { size: 16 }),
          h('span', `A session starts in ${project}, in the App so you can watch. It reads the project (and the web where it can) and writes a research note and a draft plan with milestones and dated tasks. Nothing is created before you accept it.`)) : null,
        // The other two ways to a plan are rows here, so the page has one button for all three (not for a plan done again).
        again ? null : h('div.wk-plan-ways', planWays(data).map((w) => btn('small ghost', { icon: w.icon, label: w.label, onclick: () => {
          close(null);
          w.run();
        } }))),
        // Why Plan is grey stands beside it, in the footer that stays in view, not below the first screen.
        h('div.sheet-actions', project && (v.provider || c.provider) ? null : h('span.wk-left.wk-plan-missing', planMissing(project, v.provider || c.provider)),
          h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go)));
      // The goal is what he writes first (the sheet opened before it was drawn); after a choice, the select he changed.
      const back = refocus && body.querySelector(`select[data-key="${refocus}"]`);
      if (back) back.focus();
      else if (first) goal.focus();
      first = false;
      refocus = null;
    }
    load(again ? { project: again.project, tool: again.tool } : { project: data && data.projects && data.projects.length === 1 ? data.projects[0] : undefined });
    return body;
  });
}

// ---------- the proposal screen ----------

/** The proposal screen into `content`. → { refresh(), working(), stop() }. */
export function viewProposal(content, id, { data, reload }) {
  let alive = true;
  let rec = null;
  const back = () => h('a.wk-back', { href: '#/work/plans' }, icon('back', { size: 16 }), 'Plans');
  const load = () => api(`/api/work/proposals/${enc(id)}`).then((r) => {
    if (!alive) return;
    const same = rec && JSON.stringify(rec) === JSON.stringify(r.proposal);
    rec = r.proposal;
    if (!same) draw();
  }, (e) => alive && fill(content, back(), errorBox(e.code === 'gone' ? 'This proposal is not here any more: it was accepted or dismissed.' : e.message)));
  const dismiss = async () => {
    if (!(await confirmSheet({ title: 'Dismiss this proposal?', text: 'It is thrown away; nothing of it was written. The session\'s chat stays as it is.', ok: 'Dismiss', danger: true }))) return;
    try {
      await api(`/api/work/proposals/${enc(id)}/dismiss`, {});
      toast('Proposal dismissed');
      reload();
      location.hash = '#/work/plans';
    } catch (e) {
      toast(e, { kind: 'error' });
    }
  };
  const goalLine = () => h('p.wk-prop-goal', h('span', 'Your goal: '), h('q', rec.goal), ` · ${rec.project}${rec.also.length ? `, ${rec.also.join(', ')}` : ''}`);
  const watch = () => (rec.session ? h('a.btn.small.secondary', { href: sessionLink(rec.session) }, icon('external', { size: 15 }), 'Open the session') : null);
  function draw() {
    if (rec.state === 'working') {
      return fill(content, back(), h('section.card.wk-plan-card',
        h('div.wk-prop-working', icon('clock', { size: 20 }), h('div', h('h2.wk-plan-title', 'A session is planning'), goalLine(), h('p.hint', 'It reads the project and writes a research note and a draft plan. Its proposal shows here when its turn ends; you can watch it meanwhile.'))),
        h('div.wk-plan-actions', watch(), btn('small ghost', { icon: 'x', label: 'Dismiss', onclick: dismiss }))));
    }
    if (rec.state === 'failed' || rec.state === 'unreadable') {
      const hidden = rec.state === 'unreadable' && rec.problem && ['hidden', 'brief-hidden'].includes(rec.problem.code);
      return fill(content, back(), h('section.card.wk-plan-card',
        h('h2.wk-plan-title', rec.state === 'failed' ? 'Planning ended without a proposal' : 'The proposal could not be read'),
        goalLine(),
        h('div.banner.warn', icon('alert', { size: 18 }), h('span', rec.state === 'failed' ? `${rec.reason || 'The session ended.'}` : `${cap(rec.problem.message)}.`)),
        rec.answer ? [h('p.wk-prop-label', icon('sparkle', { size: 14 }), 'The session\'s answer, as text'), h('pre.wk-run-answer.wk-prop-answer', rec.answer)] : null,
        h('div.wk-plan-actions', watch(),
          hidden ? btn('small primary', { label: 'Take them out', onclick: async () => {
            try {
              rec = (await api(`/api/work/proposals/${enc(id)}/clean`, {})).proposal;
              draw();
            } catch (e) {
              toast(e, { kind: 'error' });
            }
          } }) : null,
          btn('small secondary', { icon: 'sparkle', label: 'Plan again', onclick: () => planWithAiSheet(data, rec) }),
          btn('small ghost', { icon: 'x', label: 'Dismiss', onclick: dismiss }))));
    }
    return drawReady();
  }

  function drawReady() {
    const p = rec.proposal;
    // What the owner changed, by the place each part had in the proposal as it was read; nothing else is sent.
    const e = { milestones: {}, tasks: {}, drop: { milestones: new Set(), tasks: new Set() } };
    // The take-outs in the order he made them: "Put back" undoes the last one, one at a time.
    const outs = [];
    const takeOut = (part, i) => {
      e.drop[part].add(i);
      outs.push([part, i]);
      paintAll();
      putBack?.focus();
    };
    const set = (part, i, key, value, was) => {
      const o = (e[part][i] = e[part][i] || {});
      if (value === was) delete o[key];
      else o[key] = value;
      if (!Object.keys(o).length) delete e[part][i];
    };
    const title = h('input.field.wk-prop-title', { value: p.title, maxlength: 200, 'aria-label': 'The plan\'s title', oninput: (x) => (e.title = x.target.value) });
    const goal = goalField({ value: p.goal, maxlength: 300, 'aria-label': 'The goal', oninput: (x) => (e.goal = x.target.value) });
    const err = h('p.form-error', { role: 'alert' });
    const msSlot = h('div.wk-prop-list');
    const taskSlot = h('div.wk-prop-list');
    const left = h('p.hint.wk-prop-left');
    const live = (part) => p[part].map((x, i) => i).filter((i) => !e.drop[part].has(i));
    const msTitle = (i) => (e.milestones[i] && e.milestones[i].title !== undefined ? e.milestones[i].title : p.milestones[i].title);
    const taskTitle = (i) => (e.tasks[i] && e.tasks[i].title !== undefined ? e.tasks[i].title : p.tasks[i].title);
    const whoOptions = (by) => [...new Set(['me', 'ai', by])].map((w) => [w, w === 'me' ? 'You' : w === 'ai' ? 'The AI' : whoText(w)]);
    const paintMs = () => fill(msSlot, live('milestones').length ? live('milestones').map((i) => {
      const m = p.milestones[i];
      return h('div.wk-prop-row',
        h('span.wk-prop-num', icon('stack', { size: 14 })),
        h('input.field', { value: msTitle(i), maxlength: 200, 'aria-label': `Milestone ${i + 1}`, oninput: (x) => {
          set('milestones', i, 'title', x.target.value, m.title);
          paintTasks();
        } }),
        h('input.field.wk-date', { type: 'date', value: (e.milestones[i] && e.milestones[i].date !== undefined ? e.milestones[i].date : m.date) || '', 'aria-label': `Date of milestone ${i + 1}`, oninput: (x) => set('milestones', i, 'date', x.target.value || null, m.date) }),
        btn('icon small ghost', { icon: 'x', title: `Take out the milestone "${m.title}" (its tasks stay, in no milestone)`, onclick: () => takeOut('milestones', i) }));
    }) : h('p.hint', 'No milestones.'));
    const paintTasks = () => fill(taskSlot, live('tasks').map((i) => {
      const t = p.tasks[i];
      const waits = t.after.filter((a) => !e.drop.tasks.has(a)).map((a) => `"${taskTitle(a)}"`);
      const freed = t.after.filter((a) => e.drop.tasks.has(a)).map((a) => `"${taskTitle(a)}"`);
      const ms = t.milestone !== null && !e.drop.milestones.has(t.milestone) ? msTitle(t.milestone) : null;
      const by = e.tasks[i] && e.tasks[i].by !== undefined ? e.tasks[i].by : t.by;
      return h('div.wk-prop-task',
        h('div.wk-prop-row',
          h('span.wk-prop-num', String(i + 1)),
          h('input.field', { value: taskTitle(i), maxlength: 200, 'aria-label': `Task ${i + 1}`, oninput: (x) => {
            set('tasks', i, 'title', x.target.value, t.title);
          } }),
          h('input.field.wk-date', { type: 'date', value: (e.tasks[i] && e.tasks[i].date !== undefined ? e.tasks[i].date : t.date) || '', 'aria-label': `Date of task ${i + 1}`, oninput: (x) => set('tasks', i, 'date', x.target.value || null, t.date) }),
          h('select.field.wk-prop-who', { 'aria-label': `Who does task ${i + 1}`, onchange: (x) => set('tasks', i, 'by', x.target.value, t.by) }, whoOptions(by).map(([w, label]) => h('option', { value: w, selected: w === by }, label))),
          btn('icon small ghost', { icon: 'x', title: `Take out the task "${t.title}"`, onclick: () => takeOut('tasks', i) })),
        h('div.wk-prop-sub',
          ms ? h('span.wk-tag', icon('stack', { size: 13 }), ms) : h('span.wk-tag', 'No milestone'),
          t.project ? h('span.wk-tag', icon('folder', { size: 13 }), t.project) : null,
          waits.length ? h('span.wk-tag', icon('clock', { size: 13 }), `waits for ${waits.join(', ')}`) : null,
          freed.length ? h('span.wk-tag.wk-tag-freed', icon('clock', { size: 13 }), `no longer waits for ${freed.join(', ')}: taken out`) : null,
          t.check ? h('span.wk-tag', icon('check', { size: 13 }), t.check) : null),
        t.brief ? h('details.wk-prop-brief', h('summary', 'Brief for a session, written by the session'), h('p', t.brief)) : null);
    }));
    // After a take-out the focus goes to "Put them back" (the button pressed is gone), so a keyboard can undo at once.
    let putBack = null;
    const paintLeft = () => {
      const n = e.drop.tasks.size;
      const m = e.drop.milestones.size;
      const last = outs[outs.length - 1];
      putBack = last ? btn('small ghost', { icon: 'undo', label: `Put back "${clip(last[0] === 'tasks' ? taskTitle(last[1]) : msTitle(last[1]))}"`, onclick: () => {
        const [part, i] = outs.pop();
        e.drop[part].delete(i);
        paintAll();
        // The focus on the row that came back: its title.
        (content.querySelector(`input[aria-label="${part === 'tasks' ? 'Task' : 'Milestone'} ${i + 1}"]`) || title).focus();
      } }) : null;
      fill(left, putBack ? [`Taken out: ${[n ? `${n} task${n === 1 ? '' : 's'}` : null, m ? `${m} milestone${m === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')}. `, putBack] : null);
    };
    // The counts of the two heads say what is left, not what the session proposed.
    const msHead = h('div');
    const taskHead = h('div');
    const counts = h('span.wk-prop-counts');
    const paintAll = () => {
      fill(msHead, groupHead('Milestones', live('milestones').length));
      fill(taskHead, groupHead('Tasks', live('tasks').length));
      const nt = live('tasks').length;
      const nm = live('milestones').length;
      counts.textContent = `${nt} task${nt === 1 ? '' : 's'}${nm ? `, ${nm} milestone${nm === 1 ? '' : 's'}` : ''}`;
      paintMs();
      paintTasks();
      paintLeft();
    };
    paintAll();
    const accept = btn('primary', { icon: 'check', label: 'Accept', onclick: async () => {
      err.textContent = '';
      if (!live('tasks').length) {
        err.textContent = 'Every task is taken out: put one back, or dismiss the proposal.';
        return;
      }
      accept.disabled = true;
      accept.classList.add('busy');
      const body = { seen: rec.hash, ...(e.title !== undefined && e.title !== p.title ? { title: e.title } : {}), ...(e.goal !== undefined && e.goal !== p.goal ? { goal: e.goal } : {}),
        ...(Object.keys(e.milestones).length ? { milestones: e.milestones } : {}), ...(Object.keys(e.tasks).length ? { tasks: e.tasks } : {}),
        ...(e.drop.tasks.size || e.drop.milestones.size ? { drop: { tasks: [...e.drop.tasks], milestones: [...e.drop.milestones] } } : {}) };
      try {
        const r = await api(`/api/work/proposals/${enc(id)}/accept`, body);
        toast(`Accepted: the plan and ${r.tasks.length} task${r.tasks.length === 1 ? '' : 's'} are in your list; Save sends them`);
        focusPlan = { id: r.plan, until: Date.now() + 5000 };
        reload();
        location.hash = `#/work/plans/${enc(r.plan)}`;
      } catch (x) {
        // An Accept interrupted earlier waits on Work's own page (its record and Drop): the way opens it.
        const way = wayLink(x);
        fill(err, x.message, way ? [' ', way] : null);
        accept.disabled = false;
      } finally {
        accept.classList.remove('busy');
      }
    } });
    // Words that mix the letters of two alphabets (a look-alike of a word): said before he accepts them.
    const mixed = mixedWords([p.title, p.goal, ...p.milestones.map((m) => m.title), ...p.tasks.map((t) => t.title)].join(' '));
    fill(content, back(),
      h('section.card.wk-plan-card.wk-prop',
        mixed.length ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `Some words mix letters of two alphabets and only look like the words they seem to be: ${mixed.slice(0, 5).map((w) => `"${w}"`).join(', ')}. Change them before you accept, or dismiss the proposal.`)) : null,
        h('div.banner.info.wk-prop-banner', icon('sparkle', { size: 18 }), h('span', h('strong', 'Written by the session that planned it'), `${rec.model ? ` (${rec.model})` : ''}. Nothing is created before you accept it. Change a title, a date or who does it, take out what you do not want, then Accept.${rec.cleaned ? ' Characters nobody could see were taken out of it on your word.' : ''}`)),
        goalLine(),
        h('label.fieldrow', h('span.field-label', 'Plan'), title),
        h('label.fieldrow', h('span.field-label', 'Goal'), goal)),
      p.note ? h('section.wk-section', groupHead('Research note, by the session'), h('div.card.wk-note-card', noteOf(p.note))) : null,
      h('section.wk-section', msHead, msSlot),
      h('section.wk-section', taskHead, taskSlot),
      left,
      err,
      // At the foot of the window while the proposal scrolls: Accept is never 40 tasks away.
      h('div.wk-prop-actions', counts, watch(), btn('ghost', { icon: 'x', label: 'Dismiss', onclick: dismiss }), accept));
  }
  fill(content, skeletonRows(4));
  load();
  return { refresh: load, working: () => !!rec && rec.state === 'working', stop: () => (alive = false) };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const clip = (s) => (String(s).length > 40 ? `${String(s).slice(0, 39)}…` : String(s));
// The note is shown as the plan screen shows one (workplans.js noteView); imported late, the two files use each other.
let noteOf = (text) => h('pre.wk-run-answer', text);
export const setNoteView = (fn) => (noteOf = fn);
