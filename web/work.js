// Work (#/work, #/work/tasks, #/work/activity): everything the workspace has to do, kept in a file of the workspace
// (src/work). Three parts, each with its own address:
//   Today     (#/work)           "Needs you" (items overdue or due within seven days, items waiting for you, and the
//                                sessions that need an OK or reached a limit, as Home knows them), "To review" (what
//                                a session has done: Accept or Send back), "This week" day by day, "Done lately"
//   Tasks     (#/work/tasks)     every item in groups by status and date, filtered by project and by who does it
//   Plans     (#/work/plans)     plans with their progress, one plan with its milestones and timeline, and "Plan with
//                                AI" with its proposals (workplans.js, workpropose.js)
//   Schedules (#/work/schedules) the schedules and the repeating tasks in one list, the queue below (workschedules.js)
//   Activity  (#/work/activity)  the one history of the workspace, newest first: sessions, runs, commits, saves,
//                                what the automations did and errors, by project, day and who (workhistory.js)
// "Do it" on a task starts a coding session that does it (workdo.js). "Save" commits the Work file (and the run files)
// in its git repository and shows what it will commit first. Where the data lives is Settings → Work (also in this
// file). Rows and sheets are workitems.js.
import { icon } from './icons.js';
import { api, btn, fill, h, needsYou, needsYouFirst, openSheet, prefs, statusPill, toast } from './lib.js';
import { registerPage, registerSettingsPage } from './registry.js';
import { accessPanel } from './workaccess.js';
import { emptyState, errorBox, field, fold, groupHead, panel, radioCards, saveBar, skeletonRows, tabBar } from './shell.js';
import { sessionHref } from './sessionitem.js';
import { store } from './store.js';
import { dayWord, itemRow, itemSheet, weekLabel, whoText } from './workitems.js';
import { keepFocus, runsSheet } from './workdo.js';
import { paintHistory } from './workhistory.js';
import { paintPlans } from './workplans.js';
import { planWithAiSheet, proposalSections } from './workpropose.js';
import { paintSchedules } from './workschedules.js';
import { goalSheet, paintBrief, paintTeam, viewMission } from './mission.js';
import { needsNoneWords, paintProgress } from './workpulse.js';
import { paintShip } from './ship.js';

const TABS = [['today', 'Today', 'sun'], ['tasks', 'Tasks', 'tasks'], ['plans', 'Plans', 'stack'], ['schedules', 'Schedules', 'refresh'], ['activity', 'Activity', 'clock'], ['golive', 'Go live', 'zap'], ['team', 'Team', 'user']];
const CLOSED = ['done', 'dropped'];
let cache = null; // the last answer of GET /api/work: a page opened again shows it at once

function viewWork({ frame, sub }) {
  // Team (#/work/team) and one mission of Tia's (#/work/mission/<id>): mission.js.
  const tab = sub === 'tasks' || sub === 'activity' || sub === 'schedules' || sub === 'golive' || sub === 'team' ? sub : /^mission\/[^/]+$/.test(sub) ? 'team' : sub === 'plans' || /^(plans|proposal)\/[^/]+$/.test(sub) ? 'plans' : sub ? null : 'today';
  if (!tab) {
    location.replace('#/work');
    return () => {};
  }
  let alive = true;
  let data = cache;
  const top = h('div.wk-top');
  const content = h('div.wk-content');
  const foot = h('div.wk-foot');
  const tabs = tabBar('Parts of Work', TABS.map(([id, label, ic]) => ({ id, label, icon: ic, href: id === 'today' ? '#/work' : `#/work/${id}` })), tab);
  // Five parts are wider than a phone: page-work.css drops their icons there, and the open one is scrolled into view.
  tabs.classList.add('wk-tabs');
  setTimeout(() => tabs.querySelector?.('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }), 0);
  // Tasks' filter, per device.
  const filter = { project: prefs.get('work.project', ''), by: prefs.get('work.by', '') };
  const ctx = () => ({ projects: (data && data.projects) || [], today: data && data.today, project: tab === 'tasks' && filter.project !== '-' ? filter.project || '' : '', runs: (data && data.runs) || {}, doIt: !!(data && data.doIt), planTitles: (data && data.planTitles) || {} });
  const add = () => itemSheet(null, ctx()).then((ok) => ok && load());
  // The Plans part reads the page's data as it is now (it stays drawn while the page looks again: a proposal being
  // changed is not drawn anew under the owner's hands).
  const live = new Proxy({}, { get: (_, k) => (data ? data[k] : undefined) });
  // The page's main action. None on a proposal's screen (its own Accept is the one thing to press there), and none
  // while the list could not be read: then Try again is the one thing to press, and an Add task would go nowhere.
  let unread = false;
  const primary = () => (unread || /^proposal\//.test(sub) || tab === 'golive' ? null : tab === 'team' ? { label: 'Give Tia a goal', icon: 'sparkle', onclick: () => goalSheet((data && data.projects) || []).then((r) => r && teamPart && teamPart.refresh()) } : tab === 'schedules' ? { label: 'Add schedule', icon: 'plus', onclick: () => schedulesPart && schedulesPart.add() } : tab === 'plans' ? { label: 'Plan with AI', icon: 'sparkle', onclick: () => planWithAiSheet(live) } : { label: 'Add task', icon: 'plus', onclick: add });
  const drawFrame = () => frame({
    title: 'Work',
    page: 'work',
    intro: 'Your tasks and plans. Today: what is due, and what waits for your yes.',
    primary: primary(),
    primaryInHead: true, // on a phone in the page head: a floating button would sit on a task's text
    body: [tabs, top, content, foot],
  });
  drawFrame();
  // The list could be read again, or not: the frame is drawn again only when that changes its main action.
  const readable = (ok) => {
    if (unread === !ok || !alive) return;
    unread = !ok;
    drawFrame();
  };

  // Today's "Needs you" (paintToday makes it). Declared before the store's first call below, which may draw into it at
  // once: a page opened again has its last answer (cache) and is drawn before the first look.
  let needsSlot = null;
  let pulseWaits = 0; // what Progress lists as waiting for him: Needs you's empty line points to it
  // The sessions that need an OK or reached a limit, on every computer: what Home shows first. Redrawn on each poll.
  const sessionsSlot = h('div.wk-sessions');
  let lastSessions = '';
  const paintSessions = () => {
    const list = store.all.flatMap((m) => m.sessions || []).filter(needsYou).sort(needsYouFirst);
    const key = JSON.stringify(list.map((s) => [s.machine, s.name, s.status, s.limit, s.runLimit]));
    if (key === lastSessions) return;
    lastSessions = key;
    fill(sessionsSlot, list.map((s) => h('a.row.wk-session', { href: sessionHref(s) },
      h('span.row-icon', icon(s.limit || s.runLimit ? 'clock' : 'alert')),
      h('span.row-main', h('span.row-title', s.title || s.name), h('span.row-sub', statusPill(s, { time: true }), store.multi ? ` · ${s.machineLabel}` : '')),
      h('span.row-end', icon('chevronRight', { size: 18 })))));
    if (data && tab === 'today') paintNeeds();
  };
  const unsubscribe = store.subscribe(() => alive && paintSessions());

  function paintNeeds() {
    if (!needsSlot) return;
    const items = data.todayView.needsYou;
    const sessions = sessionsSlot.childElementCount;
    const head = groupHead('Needs you', items.length + sessions);
    if (!items.length && !sessions) {
      const [title, sub] = needsNoneWords(pulseWaits);
      fill(needsSlot, head, h('div.rows', h('div.row.static.wk-calm', h('span.row-icon', icon('check')),
        h('span.row-main', h('span.row-title', title), h('span.row-sub', sub)))));
      return;
    }
    fill(needsSlot, head, h('div.rows', sessionsSlot.childElementCount ? [...sessionsSlot.children].map((n) => n.cloneNode(true)) : null,
      items.map((it) => itemRow(it, ctx(), load, { why: cap(it.why) }))));
  }

  const afterProgress = (p) => {
    pulseWaits = p ? p.counts.waiting : 0;
    if (alive && tab === 'today') paintNeeds();
  };

  function paintToday() {
    const t = data.todayView;
    const year = Number(t.today.slice(0, 4));
    needsSlot = h('section.wk-section');
    const inWeek = t.week.reduce((n, d) => n + d.items.length, 0);
    const chip = (it) => h(`button.wk-day-item.wk-st-${it.status}`, { type: 'button', title: it.title, onclick: () => itemSheet(it, ctx()).then((ok) => ok && load()) },
      it.status === 'done' ? icon('check', { size: 14 }) : h('span.wk-dot'), h('span.wk-day-title', it.title), it.by !== 'me' ? h('span.wk-who', whoText(it.by)) : null);
    const week = h('section.wk-section', groupHead('This week', inWeek), inWeek
      ? h('div.wk-week', t.week.map((d, i) => h(`div.wk-day${d.items.length ? '' : '.wk-day-empty'}${i === 0 ? '.wk-day-now' : ''}`,
        h('div.wk-day-name', ...weekLabel(d.date, i).map((x, k) => h(k ? 'span' : 'strong', x))),
        d.items.length ? h('div.wk-day-items', d.items.map(chip)) : h('span.wk-none', 'Nothing due'))))
      : h('div.rows', h('div.row.static.wk-calm', h('span.row-icon', icon('clock')), h('span.row-main', h('span.row-title', 'Nothing due in the next seven days'), h('span.row-sub', 'Give a task a date and it shows here on its day.')))));
    const doneWord = (date) => {
      const n = daysFrom(t.today, date);
      return n === 0 ? 'Done today' : n === -1 ? 'Done yesterday' : `Done on ${dayWord(date, n, year)}`;
    };
    const done = h('section.wk-section', groupHead('Done lately', t.doneLately.length),
      t.doneLately.length
        ? h('div.rows', t.doneLately.map((it) => itemRow(it, ctx(), load, { why: doneWord(it.doneAt) })))
        : h('p.hint.wk-hint', 'What you mark done in the last seven days shows here.'));
    if (!data.items.length) {
      const pulse0 = h('div.wk-pulse-slot');
      paintProgress(pulse0).then(afterProgress);
      fill(content, pulse0, needsSlot, plansToLook(), h('div.card.wk-start', emptyState('tasks', 'No tasks of your own yet. Add your first one: what is to be done and, if it has one, the day it is due. Whatever is due in the next seven days then shows here.', btn('primary', { icon: 'plus', label: 'Add your first task', onclick: add }))));
      paintNeeds();
      return;
    }
    // What a session has done: Accept or Send back, right here.
    const review = t.toReview && t.toReview.length ? h('section.wk-section', groupHead('To review', t.toReview.length), h('div.rows', t.toReview.map((it) => itemRow(it, ctx(), load, { why: 'A session has done it' })))) : null;
    // Progress first: what runs, how far, when it will be done, what waits for you (workpulse.js).
    const pulse = h('div.wk-pulse-slot');
    fill(content, pulse, needsSlot, briefSlot, plansToLook(), review, week, done);
    paintProgress(pulse).then(afterProgress);
    paintBrief(briefSlot);
    paintNeeds();
  }

  // "Plan with AI": the proposals that wait for the owner (a plan to look at or one that could not be read, a session
  // still planning, one that ended without a proposal).
  const plansToLook = () => proposalSections(data.proposals || []);

  function paintTasks() {
    const items = data.items;
    const projectsHere = [...new Set([...data.projects, ...items.map((i) => i.project).filter(Boolean)])].sort();
    const whos = [...new Set(['me', 'ai', ...items.map((i) => i.by)])];
    const sel = (label, key, options) => h('label.wk-filter', h('span', label), h('select.field', { dataset: { key: `tasks-${key}` }, onchange: (e) => {
      filter[key] = e.target.value;
      prefs.set(`work.${key}`, filter[key]);
      paintTasks();
    } }, options.map(([v, t]) => h('option', { value: v, selected: v === filter[key] }, t))));
    const bar = h('div.wk-filters',
      sel('Project', 'project', [['', 'All projects'], ['-', 'No project'], ...projectsHere.map((p) => [p, p])]),
      sel('Who', 'by', [['', 'Anyone'], ...whos.map((w) => [w, whoText(w)])]));
    const shown = items.filter((i) => (!filter.project || (filter.project === '-' ? !i.project : i.project === filter.project)) && (!filter.by || i.by === filter.by));
    const groups = taskGroups(shown);
    const parts = groups.filter((g) => !g.closed && g.items.length).map((g) => h('section.wk-section', groupHead(g.title, g.items.length), h('div.rows', g.items.map((it) => itemRow(it, ctx(), load)))));
    const closed = groups.filter((g) => g.closed && g.items.length).map((g) => fold(`work-${g.id}`, `${g.title} (${g.items.length})`, h('div.rows', g.items.map((it) => itemRow(it, ctx(), load)))));
    const empty = !items.length
      ? h('div.card.wk-start', emptyState('tasks', 'No tasks of your own yet. Add one: a title is enough, a date and a project help.', btn('primary', { icon: 'plus', label: 'Add a task', onclick: add })))
      : !shown.length ? emptyState('search', 'Nothing matches this filter.', btn('secondary', { label: 'Show everything', onclick: () => {
        filter.project = '';
        filter.by = '';
        prefs.set('work.project', '');
        prefs.set('work.by', '');
        paintTasks();
      } })) : !parts.length ? h('p.hint.wk-hint', 'Nothing open: everything here is done or dropped.') : null;
    fill(content, items.length ? bar : null, empty, parts, closed);
  }

  // The bar over both parts: why the Work folder cannot be used, a file a change would alter (with "Tidy the file
  // once"), or the offer to keep a copy of the list in its repository (saveBand).
  async function paintTop() {
    if (!data || data.problem) return fill(top, data && data.problem ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', data.problem, ' ', h('a', { href: '#/settings/work' }, 'Settings → Work'))) : null);
    const tidy = data.untidy ? h('div.banner.warn.wk-untidy', icon('alert', { size: 18 }),
      h('div.wk-untidy-text',
        h('strong', 'This file has things a change would alter, so Work changes nothing in it yet.'),
        h('ul', data.untidy.slice(0, 5).map((a) => h('li', cap(a.text)))),
        data.untidy.length > 5 ? h('span', `and ${data.untidy.length - 5} more`) : null),
      btn('small secondary', { label: 'Tidy the file once', onclick: () => tidySheet().then((ok) => ok && load()) })) : null;
    // Two computers that added the same title make two tasks with one id: one plain line, and one change that fixes it.
    const nDoubled = data.doubles ? data.doubles.reduce((n, d) => n + d.count - 1, 0) : 0;
    const doubles = nDoubled ? h('div.banner.info.wk-doubles', icon('alert', { size: 18 }),
      h('span', `${plural(nDoubled, 'task')} ${nDoubled === 1 ? 'shares its id' : 'share their ids'} with another (${data.doubles.map((d) => `"${d.id}"`).join(', ')}), as when two computers add the same title.`),
      btn('small secondary', { label: 'Give the doubles new ids', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await api('/api/work/fix-ids', {});
          toast(`${plural(r.fixed.length, 'task')} got a new id; Save shows the change`);
        } catch (x) {
          toast(`${x.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
        }
        load();
      } })) : null;
    // A planning tool's file that does not use the owner's id yet: said once, with the id it uses most filled in.
    // Until he says it, a new task is not written (it would carry a word that tool does not know for "me").
    let owner = null;
    if (data.planner && data.planner.needsId) {
      const input = h('input.field.mono.wk-owner-id', { value: data.planner.suggested || '', 'aria-label': 'Your id in this file', autocapitalize: 'off', spellcheck: 'false' });
      owner = h('div.banner.info.wk-owner', icon('user', { size: 18 }),
        h('span', h('strong', 'This list is a planning tool\'s file.'), ' Your id in this file, so the tasks you add are written in its words:'),
        h('div.wk-owner-form', input, btn('small primary', { label: 'Save', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api('/api/work/settings', { ownerId: input.value.trim() });
            toast('Saved: your id in this file');
            load();
          } catch (x) {
            toast(x, { kind: 'error', ms: 6000 });
            e.currentTarget.disabled = false;
          }
        } })));
    }
    // A save that was interrupted: finished when the server read the list (one sentence), or shown with where its
    // list is kept and one action, Drop, once the owner has looked.
    const recovered = data.recovered ? h('div.banner.info.wk-recovered', icon('check', { size: 18 }), h('span', data.recovered)) : null;
    const interrupted = data.interrupted ? h('div.banner.warn.wk-interrupted', icon('alert', { size: 18 }), h('span', data.interrupted.message),
      btn('small secondary', { label: 'Drop the record', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api('/api/work/save/drop', {});
          toast('Dropped: Save works again');
        } catch (x) {
          toast(x, { kind: 'error', ms: 6000 });
        }
        load();
      } })) : null;
    const lead = [recovered, interrupted, owner, tidy, doubles];
    let plan;
    try {
      plan = await api('/api/work/save');
    } catch {
      return fill(top, lead);
    }
    if (!alive) return;
    if (plan.problem || plan.nothing) return fill(top, lead);
    const words = saveBand(plan, data.place);
    if (!words) return fill(top, lead);
    const save = () => saveSheet().then(load);
    // An earlier copy of the Work file not on the server (an older version, or made by hand): said quietly; the button
    // sends it. A save of this version never leaves one: it reaches the server or stays a change in the file.
    if (words.quiet) return fill(top, lead, h('p.hint.wk-hint', icon('git', { size: 14 }), ` ${words.text} `, btn('small secondary', { label: words.label, onclick: save })));
    fill(top, lead, h('div.banner.info.wk-savebar', icon('git', { size: 18 }),
      h('span', words.text),
      btn('small primary', { icon: 'upload', label: words.label, onclick: save })));
  }

  function paintFoot() {
    if (!data || !data.place) return fill(foot);
    fill(foot, h('p.hint.wk-hint', icon('folder', { size: 14 }), ` Kept in ${data.place.label}/${data.place.fileName} · `, h('a', { href: '#/settings/work' }, 'change where')));
  }

  let activity = null; // the Activity part's handle (workhistory.js paintHistory): refresh, working
  let plansPart = null; // the Plans part's handle (paintPlans): drawn once, then refreshed
  let schedulesPart = null; // the Schedules part's handle (paintSchedules): drawn once
  let teamPart = null; // the Team part's or a mission's handle (mission.js): drawn once, then refreshed
  const briefSlot = h('div.ms-brief-slot'); // Today: Tia's morning brief (mission.js paintBrief), only when she has missions
  let shipPart = null; // the Go live part's handle (ship.js paintShip): drawn once, it loads its own data
  const historySlot = h('div.wk-history-slot');
  const openRuns = (id) => {
    const it = data && data.items.find((x) => x.id === id);
    if (it) runsSheet(it, load);
    else toast('That task is not in the list any more');
  };
  function paint() {
    activity = null;
    if (tab === 'team') {
      const m = /^mission\/([^/]+)$/.exec(sub);
      if (teamPart) teamPart.refresh();
      else teamPart = m ? viewMission(content, decodeURIComponent(m[1])) : paintTeam(content, { onGoal: () => goalSheet((data && data.projects) || []).then((r) => r && teamPart && teamPart.refresh()) });
      paintTop();
      paintFoot();
      return;
    }
    if (tab === 'golive') {
      if (!shipPart) shipPart = paintShip(content);
      fill(top); // Work's own banners (where its list is kept) are not about going live
      paintFoot();
      return;
    }
    if (tab === 'schedules') {
      if (!schedulesPart) schedulesPart = paintSchedules(content, { open: (id) => {
        const it = data && data.items.find((x) => x.id === id);
        if (it) itemSheet(it, ctx()).then((ok) => ok && (load(), schedulesPart && schedulesPart.refresh()));
        else toast('That task is not in the list any more');
      } });
      paintTop();
      paintFoot();
      return;
    }
    if (tab === 'plans' && !data.problem) {
      if (plansPart) plansPart.refresh();
      else plansPart = paintPlans(content, { sub, data: live, ctx, reload: () => load({ quiet: true }) });
      paintTop();
      paintFoot();
      return;
    }
    if (data.problem) {
      fill(content, data.place ? null : h('div.card.wk-start', emptyState('folder', 'Work keeps its list in a folder of your workspace. Choose where in Settings → Work.', btn('primary', { label: 'Open Settings → Work', onclick: () => (location.hash = '#/settings/work') }))),
        // The history (what the automations did, Hands-off's answers among them, the sessions, the commits) needs no
        // list of tasks: it is shown all the same.
        tab === 'activity' ? h('section.wk-section', historySlot) : null);
      if (tab === 'activity') activity = paintHistory(historySlot, { prefs, isAlive: () => alive });
    } else if (tab === 'today') paintToday();
    else if (tab === 'activity') {
      // The one history: sessions, the runs of the tasks, commits, saves, what the automations did and errors.
      if (!content.contains(historySlot)) fill(content, historySlot);
      activity = paintHistory(historySlot, { prefs, today: data.today, onTask: openRuns, isAlive: () => alive });
    }
    else paintTasks();
    paintTop();
    paintFoot();
  }

  let drawn = null; // what the page was drawn from: a look that brings the same draws nothing (focus and filters stay)
  let failed = false; // a refresh failed and said so: said once, until one works again
  async function load(opts) {
    const quiet = !!(opts && opts.quiet === true); // (load is also a callback, with whatever its caller passes)
    try {
      const next = await api('/api/work');
      if (!alive) return;
      failed = false;
      readable(true);
      const key = JSON.stringify(next);
      data = cache = next;
      if (quiet && key === drawn) return;
      drawn = key;
      keepFocus(content, paint);
    } catch (e) {
      if (!alive) return;
      if (!data) {
        readable(false);
        fill(content, errorBox('Hoprig could not read your task list. Try again; if it stays, the details below say why.', load, e.message));
      } else if (!failed) {
        failed = true;
        toast(`Could not refresh: ${e.message}`, { kind: 'error' });
      }
    }
  }

  if (data) paint();
  else fill(content, skeletonRows(4));
  load();
  // While a session of this computer works on a task, look again now and then: its end (review, or open again) shows
  // by itself. Activity looks at its own runs.
  const watch = setInterval(() => {
    if (!alive || !data) return;
    if (tab === 'activity') {
      if (activity && activity.working()) activity.refresh();
    } else if (tab === 'plans' && plansPart && plansPart.working()) plansPart.refresh();
    else if (watching(data)) load({ quiet: true });
  }, 5000);
  return () => {
    alive = false;
    plansPart?.stop?.();
    teamPart?.stop?.();
    shipPart?.stop?.();
    clearInterval(watch);
    unsubscribe();
  };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Whether the page looks again by itself: while a session of this computer works on one of its tasks, or plans. */
export const watching = (d) => !!(d && ((d.runs && Object.values(d.runs).some((r) => r.state === 'running' && r.here)) || (d.proposals && d.proposals.some((p) => p.state === 'working'))));

/** What is not saved yet, in words: "2 changes and 3 runs" (a run file is a run, not a change of the list). */
/**
 * The band over Work in plain words, or null for none. The list is saved already (in its file on this computer); the
 * band offers a copy in the AI brain's (or the project's) history on its git server. Where that repository has no
 * server there is no band: the copy would stay on this computer as well. No git words: no commit, push or upstream.
 */
export function saveBand(plan, place) {
  if (!plan || plan.problem || plan.nothing || !plan.repo || !plan.repo.upstream) return null;
  const where = !place || place.kind === 'brain' ? 'your AI brain' : place.project || place.label;
  if (!plan.files.length) {
    const n = plan.unsent.saves;
    return { quiet: true, text: `${n === 1 ? 'An earlier copy' : `${n} earlier copies`} of your list ${n === 1 ? 'is' : 'are'} not on the server yet.`, label: 'Upload' };
  }
  return { quiet: false, text: 'Your list is saved on this computer.', label: `Keep a copy in ${where}` };
}

export function unsavedText(plan) {
  const parts = [plan.changes.length ? plural(plan.changes.length, 'change') : null, plan.runs ? plural(plan.runs, 'run') : null, plan.plans ? plural(plan.plans, 'plan file') : null].filter(Boolean);
  return parts.length ? parts.join(' and ') : plural(plan.files.length, 'change');
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The groups of the Tasks part, in order: by status first (waiting, review, doing), then open ones by date. */
export function taskGroups(items) {
  const rank = (a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || String(a.date || '9').localeCompare(String(b.date || '9')) || a.title.localeCompare(b.title);
  const g = [
    { id: 'waiting', title: 'Waiting for you', test: (i) => i.status === 'waiting' },
    { id: 'review', title: 'Ready for your review', test: (i) => i.status === 'review' },
    { id: 'doing', title: 'A session works on it', test: (i) => i.status === 'doing' },
    { id: 'overdue', title: 'Overdue', test: (i) => typeof i.days === 'number' && i.days < 0 },
    { id: 'today', title: 'Today', test: (i) => i.days === 0 },
    { id: 'week', title: 'Next seven days', test: (i) => i.inWeek }, // the server's one rule (model.mjs inWeek)
    { id: 'later', title: 'Later', test: (i) => typeof i.days === 'number' },
    { id: 'nodate', title: 'No date', test: () => true },
  ];
  const open = items.filter((i) => !CLOSED.includes(i.status));
  const out = g.map((x) => ({ ...x, items: [] }));
  for (const it of open) out.find((x) => x.test(it)).items.push(it);
  for (const x of out) x.items.sort(rank);
  out.push({ id: 'done', title: 'Done', closed: true, items: items.filter((i) => i.status === 'done').sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || ''))) });
  out.push({ id: 'dropped', title: 'Dropped', closed: true, items: items.filter((i) => i.status === 'dropped') });
  return out;
}

const CHANGE_WORDS = { added: 'Added', removed: 'Removed', done: 'Done', dropped: 'Dropped', 'opened again': 'Opened again', changed: 'Changed', 'new id': 'New id' };
const changeList = (list) => h('ul.wk-changes', list.map((c) => h('li', h('span.badge.soft', CHANGE_WORDS[c.what] || cap(c.what)), h('span', c.title))));
const STATUS_TEXT = { open: 'open', doing: 'a session works on it', review: 'ready for review', waiting: 'waiting for you', done: 'done', dropped: 'dropped' };

/** One version of a conflicted task in a few words: its title, status, date and note, or "Removed". */
function versionText(v) {
  if (!v) return 'Removed';
  if (v.items) return v.items.length ? v.items.map(versionText).join(' / ') : 'None of them';
  if (v.text) return v.text;
  return [v.title, v.status ? STATUS_TEXT[v.status] || v.status : null, v.date, v.note ? `"${v.note.slice(0, 80)}"` : null].filter(Boolean).join(' · ');
}

/**
 * The tasks changed differently here and on another computer: one choice each (this computer's or the other's).
 * `decisions` is filled as the owner chooses; `onchange` after each choice.
 */
function conflictChoices(conflicts, decisions, onchange) {
  return h('div.wk-conflicts', conflicts.map((c, i) => {
    const group = radioCards(`wk-conflict-${i}`, [
      { value: 'mine', title: 'Keep this computer\'s', sub: versionText(c.mine) },
      { value: 'theirs', title: 'Keep the other computer\'s', sub: versionText(c.theirs) },
    ], decisions[c.key] || null, (v) => {
      decisions[c.key] = v;
      for (const l of group.querySelectorAll('.radiocard')) l.classList.toggle('on', l.querySelector('input').checked);
      onchange();
    });
    return h('div.wk-conflict', h('p.wk-conflict-title', c.title), group);
  }));
}

/** "Tidy the file once": the exact difference first, written only on a yes. Resolves true when it was written. */
function tidySheet() {
  return openSheet({ title: 'Tidy the file once' }, (close) => {
    const body = h('div.wk-save', skeletonRows(2));
    api('/api/work/tidy').then((t) => {
      if (!t.alters.length) return fill(body, h('p.sheet-text', 'The file comes back as it is: nothing to tidy.'), h('div.sheet-actions', btn('primary', { label: 'Close', onclick: () => close(true) })));
      const err = h('p.form-error', { role: 'alert' });
      const go = btn('primary', { label: 'Write it', onclick: async () => {
        go.disabled = true;
        try {
          await api('/api/work/tidy', { hash: t.hash });
          toast('Tidied: changes work again');
          close(true);
        } catch (e) {
          err.textContent = e.message;
          go.disabled = false;
        }
      } });
      fill(body,
        h('p.sheet-text', 'Work writes the file back in its own style. These would change, and nothing else:'),
        h('ul.wk-alters', t.alters.map((a) => h('li', cap(a.text)))),
        t.cut ? h('p.hint', `Shown: ${t.shownChanged.toLocaleString('en')} of the ${t.changed.toLocaleString('en')} changed lines, long lines cut at 300 characters. hoprig tasks tidy --dry-run shows all of it.`) : null,
        h('pre.wk-diff', { 'aria-label': 'The difference, line by line' }, t.diff.map((d) => h(`span.wk-d${d.op === '+' ? '-add' : d.op === '-' ? '-del' : d.op === '…' ? '-gap' : ''}`,
          d.op === '…' ? `…${d.text ? ` ${d.text}` : ''}` : `${d.op} ${d.text}`))),
        err,
        h('div.sheet-actions', btn('secondary', { label: 'Cancel', onclick: () => close(false) }), go));
    }, (e) => fill(body, errorBox(e)));
    return body;
  }).then((x) => x === true);
}

/** Save: what will be committed first (the repository, the file, each change), then the result in plain words. */
function saveSheet() {
  return openSheet({ title: 'Keep a copy of your list' }, (close) => {
    const body = h('div.wk-save', skeletonRows(2));
    const closeOnly = () => h('div.sheet-actions', btn('primary', { label: 'Close', onclick: () => close() }));
    // One plan drawn: the repository, the file, each change, and Commit. A plan that is out of date when Commit is
    // pressed (the file or the server changed meanwhile) comes back from the server, and is drawn again with the
    // reason on top.
    function paintPlan(plan, notice = null) {
      if (plan.recovered) notice = [notice, h('div.banner.info', icon('check', { size: 18 }), h('span', plan.recovered))];
      if (plan.problem) return fill(body, notice, h('p.banner.warn', plan.problem), closeOnly());
      if (plan.nothing) return fill(body, notice, h('p.sheet-text', 'Nothing to keep: the copy in the history has every change of your list already.'), closeOnly());
      const r = plan.repo;
      const remote = plan.remote || null;
      if (remote && remote.mode === 'blocked') return fill(body, notice, h('div.banner.warn', icon('alert', { size: 18 }), h('span', remote.message)), closeOnly());
      const merge = remote && remote.mode === 'merge' ? remote : null;
      const decisions = {};
      if (merge) for (const c of merge.conflicts) if (c.decided) decisions[c.key] = c.decided;
      const go = btn('primary', { icon: 'upload', label: merge ? 'Bring together and upload' : !plan.files.length ? 'Upload' : r.upstream ? 'Keep a copy and upload' : 'Keep a copy' });
      const left = h('span.wk-left');
      const ready = () => {
        const open = merge ? merge.conflicts.filter((c) => !decisions[c.key]).length : 0;
        go.disabled = open > 0;
        left.textContent = open ? `${open} still to decide` : '';
      };
      const result = h('div');
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.classList.add('busy');
        try {
          const res = await api('/api/work/save', { hash: plan.hash, ...(remote ? { upstream: remote.upstream } : {}), ...(merge ? { decisions } : {}) });
          if (res.code === 'moved') return paintPlan(res.plan, h('div.banner.warn', icon('alert', { size: 18 }), h('span', res.message)));
          fill(result, h(`div.banner.${res.ok ? 'info' : 'warn'}`, icon(res.ok ? 'check' : 'alert', { size: 18 }), h('span', res.message)));
          if (res.ok) fill(go.parentNode, btn('primary', { label: 'Done', onclick: () => close() }));
        } catch (e) {
          fill(result, h('div.banner.warn', icon('alert', { size: 18 }), h('span', e.message)));
        } finally {
          go.classList.remove('busy');
          if (go.isConnected) ready();
        }
      });
      const parts = [];
      if (merge) {
        const counts = [plural(merge.mine.length, 'change') + ' of yours', `${plural(merge.theirs.length, 'change')} from another computer`, merge.conflicts.length ? `${merge.conflicts.length} to decide` : null].filter(Boolean).join(', ');
        parts.push(h('p.sheet-text', h('strong', cap(counts)), `. ${r.name} changed on your git server too, so the two lists are brought together task by task, then kept in its history and uploaded. Nothing else there changes.`));
        if (merge.conflicts.length) parts.push(h('h3.wk-save-head', 'Changed on both computers: choose one'), conflictChoices(merge.conflicts, decisions, ready));
        if (merge.mine.length) parts.push(h('h3.wk-save-head', 'Yours'), changeList(merge.mine));
        if (merge.theirs.length) parts.push(h('h3.wk-save-head', 'From another computer'), changeList(merge.theirs));
      } else {
        const list = plan.files.filter((f) => !plan.runs || !f.path.includes('/runs/') && !f.path.startsWith('runs/'));
        const named = [...list.map((f) => f.path), ...(plan.runs ? [plural(plan.runs, 'run')] : [])].join(' and ');
        parts.push(h('p.sheet-text', plan.files.length
          ? `Keeps ${named} in the history of ${r.name}${r.upstream ? ' and uploads it to your git server; if it cannot be uploaded, it stays here as it is' : ''}. Nothing else there changes.`
          : `Uploads ${plan.unsent.saves === 1 ? 'an earlier copy' : `${plan.unsent.saves} earlier copies`} of your list to your git server. Nothing new is kept.`));
        if (remote && remote.mode === 'ff') parts.push(h('p.hint', `Your git server has ${plural(remote.behind, 'newer change')}; ${remote.behind === 1 ? 'it comes' : 'they come'} here first.`));
        parts.push(changeList(plan.changes));
      }
      fill(body, notice, parts, result, h('div.sheet-actions', left, btn('secondary', { label: 'Cancel', onclick: () => close() }), go));
      ready();
    }
    api('/api/work/save?fetch=1').then((plan) => paintPlan(plan), (e) => fill(body, errorBox(e)));
    return body;
  });
}

registerPage({ id: 'work', title: 'Work', icon: 'tasks', group: 'main', order: 5, render: viewWork });

// ---------- Settings → Work ----------

registerSettingsPage({
  id: 'work', title: 'Work', icon: 'tasks', order: 16, onlyHere: true,
  desc: 'Where your tasks are kept, and how a save is committed.',
  summary: () => api('/api/work').then((w) => (w.place ? `Kept in ${w.place.label}` : 'Not set up yet'), () => ''),
  render: () => {
    const slot = h('div', skeletonRows(2));
    api('/api/work').then((w) => fill(slot, settingsPanels(w)), (e) => fill(slot, errorBox(e)));
    return [slot];
  },
});

function settingsPanels(w) {
  const s = { ...w.settings };
  const projectPart = h('div.wk-where');
  const paintProject = () => fill(projectPart, s.place !== 'project' ? null : [
    field('Project', h('select.field', { onchange: (e) => (s.project = e.target.value) },
      h('option', { value: '' }, 'Choose a project'), w.projects.map((p) => h('option', { value: p, selected: p === s.project }, p))), 'One of the projects of your workspace.'),
    field('Folder in the project', h('input.field.mono', { value: s.path, placeholder: 'docs/plans', autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (s.path = e.target.value) }),
      'A folder inside the project. A planning list already there (deadlines.json) is used as it is.'),
  ]);
  paintProject();
  const where = panel({ icon: 'folder', title: 'Work data lives in', desc: 'Your tasks are one file in a git repository of your workspace, so every computer that has it sees the same list.' },
    radioCards('work-place', [
      { value: 'brain', title: 'The AI brain', sub: 'ai_brain/work: on every computer that has your brain' },
      { value: 'project', title: 'A project', sub: 'A folder of one project, for a list that belongs to it' },
    ], s.place, (v) => {
      s.place = v;
      paintProject();
    }),
    projectPart,
    saveBar('Save', () => api('/api/work/settings', { place: s.place, project: s.project, path: s.path }), 'Saved: Work uses this folder'));
  const more = panel({ title: 'Saving, dates and planning files' },
    field('Commit subject', h('input.field', { value: s.saveSubject, maxlength: 100, oninput: (e) => (s.saveSubject = e.target.value) }), 'The message of the commit each Save makes.'),
    field('Time zone', h('input.field', { value: s.timeZone, placeholder: 'This computer\'s own', autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (s.timeZone = e.target.value.trim()) }), 'What "today" means for due dates. Empty: this computer\'s clock. Or a name such as Europe/Berlin.'),
    field('Your id in a planning file', h('input.field.mono', { id: 'owner-id', value: s.ownerId, autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (s.ownerId = e.target.value.trim()) }), 'A planning tool\'s list names who does an item; this is the word it uses for you. Items with it are yours, and only the ones you added can be removed.'),
    saveBar('Save', () => api('/api/work/settings', { saveSubject: s.saveSubject, timeZone: s.timeZone, ownerId: s.ownerId })));
  return [where, more, accessPanel()];
}
