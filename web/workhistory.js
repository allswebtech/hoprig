// Work → Activity: the one history of the workspace (GET /api/work/history, src/work/history.mjs). What happened,
// newest first, grouped by day: the sessions you, Tia and a schedule started (with their provider and how each
// ended), the runs of "Do it", the commits and saves of the projects, what the automations did, and errors. The 20
// newest first, "Show more" for 20 more (and for older ones from the server). The filter by project, day and who
// (kept per device) and the note about costs are closed folds. A run's line opens the
// run's card as Activity showed it before (workdo.js runCard: its session, its task's runs, and for a schedule's run
// "Done with it"), an open App session's line opens the session.
import { icon } from './icons.js';
import { api, btn, fill, h, link, openSheet, toast } from './lib.js';
import { emptyState, errorBox, fold, groupHead, skeletonRows } from './shell.js';
import { runCard } from './workdo.js';
import { useSummaryCard } from './workuse.js';

export const KINDS = {
  session: ['sessions', 'Session'],
  run: ['play', 'Run'],
  commit: ['git', 'Commit'],
  save: ['upload', 'Save'],
  automation: ['zap', 'Automation'],
  error: ['alert', 'Error'],
};
export const WHO_WORDS = { owner: 'You', tia: 'Tia', schedule: 'A schedule' };
const WHO_CHOICES = [['', 'Everyone'], ['owner', 'You'], ['tia', 'Tia'], ['schedule', 'A schedule']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const PAGE = 20; // lines shown at first, and added by each Show more
export const FIRST_USE = 'Nothing has happened here yet. The sessions you and Tia start, what a schedule runs, "Do it" runs, the commits and saves of your projects and errors show here, newest first. Sessions show from this version of Hoprig on: earlier ones are not in this list.';

/** "Today", "Yesterday" or "16 Nov" for a day (`today`: Work's today, the server's word for it). */
export function dayWords(ymd, today) {
  const [y, m, d] = ymd.split('-').map(Number);
  if (today && ymd === today) return 'Today';
  if (today && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`) === 86_400_000) return 'Yesterday';
  return `${d} ${MONTHS[m - 1]}${today && y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The address of the history with filter `f` and the page before `before`. */
export function historyUrl(f, before = null) {
  const q = new URLSearchParams();
  for (const k of ['project', 'day', 'who']) if (f[k]) q.set(k, f[k]);
  if (before) q.set('before', before);
  const s = q.toString();
  return `/api/work/history${s ? `?${s}` : ''}`;
}

/** Done with a schedule's run: its copy of the project goes when clean (POST /api/work/alone/release; the branch stays). */
async function release(r, close) {
  try {
    const x = await api('/api/work/alone/release', { run: r.id });
    toast(x.removed ? `Its copy of the project is removed; the branch ${r.branch} stays` : `${x.why.charAt(0).toUpperCase()}${x.why.slice(1)}`, x.removed ? {} : { kind: 'error', ms: 6000 });
    if (x.removed) close(true);
  } catch (e) {
    toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
  }
}

/** The card of run `id` in a sheet (GET /api/work/runs?id=). `onTask(itemId)`: the task's runs, for a task's run. */
export function runSheet(id, title, { onTask = null } = {}) {
  return openSheet({ title: 'Run', subtitle: title }, (close) => {
    const body = h('div.wk-runs', skeletonRows(2));
    api(`/api/work/runs?id=${encodeURIComponent(id)}`).then(({ runs }) => {
      const r = runs[0];
      if (!r) return fill(body, emptyState('play', 'This run is not kept any more.'));
      fill(body, runCard(r, { title: true, onTask: onTask && !r.schedule ? () => {
        close(true);
        onTask(r.item);
      } : null, onRelease: () => release(r, close) }));
    }, (e) => fill(body, errorBox(`Could not load the run: ${e.message}`)));
    return body;
  });
}

/** One line of the history: its kind's mark, its words, and below them the detail, the project, who and the time. */
export function historyLine(l, { onRun = null } = {}) {
  const [ic, word] = KINDS[l.kind] || ['info', l.kind];
  // A commit's detail names its repository already ("shop/code/web · abc1234"): the project is not said twice.
  const named = l.project && String(l.detail || '').split(' · ').some((x) => x === l.project || x.startsWith(`${l.project}/`));
  const sub = [l.detail, named ? null : l.project || (l.kind === 'session' ? 'outside the workspace' : null), WHO_WORDS[l.who] || null, timeOf(l.at)].filter(Boolean).join(' · ');
  const opens = l.run && onRun ? () => onRun(l) : null;
  const main = [h('span.wk-hist-text', l.text), h('span.row-sub.wk-hist-sub', sub)];
  const mark = h(`span.wk-hist-kind.wk-hist-${l.kind}`, icon(ic, { size: 14 }), h('span', word));
  if (l.chat && l.open) return h('a.row.wk-hist', { href: link(`#/chat/${l.chat}`), dataset: { kind: l.kind } }, mark, h('span.row-main', ...main));
  if (opens) return h('button.row.wk-hist', { type: 'button', onclick: opens, dataset: { kind: l.kind } }, mark, h('span.row-main', ...main));
  return h('div.row.static.wk-hist', { dataset: { kind: l.kind } }, mark, h('span.row-main', ...main));
}

/**
 * The Activity part: `slot` is filled with the history. `prefs` keeps the filter per device; a run's line opens its
 * card (runSheet), whose "All runs of the task" calls `onTask(itemId)`; `today`: Work's today. → { refresh, working }
 * (working: a run is still at work, so look again).
 */
export function paintHistory(slot, { prefs, onTask = null, today = null, isAlive = () => true, onRun = (l) => runSheet(l.run, l.text, { onTask }) }) {
  const f = { project: prefs.get('work.history.project', ''), day: prefs.get('work.history.day', ''), who: prefs.get('work.history.who', '') };
  let page = null; // the last answer: { lines (all shown so far), more, before, projects, days }
  let asking = 0;
  let count = PAGE; // lines shown
  if (!slot.querySelector || !slot.querySelector('.wk-history')) fill(slot, skeletonRows(4));

  const draw = () => {
    const filtered = !!(f.project || f.day || f.who);
    if (!page.lines.length && !filtered) return fill(slot, h('div.wk-history', h('div.card.wk-start', emptyState('clock', FIRST_USE))));
    const sel = (label, k, options) => h('label.wk-filter', h('span', label), h('select.field', { dataset: { key: `history-${k}` }, onchange: (e) => {
      f[k] = e.target.value;
      prefs.set(`work.history.${k}`, f[k]);
      count = PAGE;
      load();
    } }, options.map(([val, text]) => h('option', { value: val, selected: val === f[k] }, text))));
    // A filter's value the answer no longer lists (a day past 30 days) stays a choice, so the select shows it.
    const projects = [...new Set([...page.projects, ...(f.project ? [f.project] : [])])].sort();
    const days = [...new Set([...page.days, ...(f.day ? [f.day] : [])])].sort().reverse();
    const lines = page.lines.slice(0, count);
    const byDay = new Map();
    for (const l of lines) byDay.set(l.day, [...(byDay.get(l.day) || []), l]);
    const more = page.lines.length > count || page.more ? btn('secondary.wk-show-more', { label: 'Show more', dataset: { key: 'history-more' }, onclick: () => showMore(more) }) : null;
    // One press for the three filters (open while one is set, so a hidden line is never a surprise); the notes under it.
    const bar = fold('work-history-filter', filtered ? 'Filter: on' : 'Filter',
      h('div.wk-filters',
        sel('Project', 'project', [['', 'All projects'], ...projects.map((p) => [p, p])]),
        sel('Day', 'day', [['', 'Every day'], ...days.map((d) => [d, dayWords(d, today)])]),
        sel('Who', 'who', WHO_CHOICES)),
      h('p.hint.wk-hist-foot', 'The last 30 days, read from this computer. A commit shows who made it only when a run of Work made it.'));
    if (filtered) bar.open = true;
    fill(slot, h('div.wk-history',
      bar,
      lines.length
        ? [...byDay].map(([day, list]) => h('section.wk-section', groupHead(dayWords(day, today), list.length), h('div.rows.wk-hist-list', list.map((l) => historyLine(l, { onRun })))))
        : h('div.wk-hist-none', emptyState('search', 'Nothing matches this filter.', btn('secondary', { label: 'Show everything', dataset: { key: 'history-clear' }, onclick: () => {
          for (const k of ['project', 'day', 'who']) {
            f[k] = '';
            prefs.set(`work.history.${k}`, '');
          }
          count = PAGE;
          load();
        } }))),
      more,
      page.use ? fold('work-use', 'About costs', useSummaryCard(page.use)) : null)); // today's and the last 7 days' use of Work's runs (workuse.js)
  };

  async function load() {
    const n = ++asking;
    try {
      const r = await api(historyUrl(f));
      if (n !== asking || !isAlive()) return;
      page = r;
      draw();
    } catch (e) {
      if (n === asking && isAlive()) fill(slot, errorBox(`Could not load the history: ${e.message}`, load));
    }
  }

  async function showMore(button) {
    if (!page) return;
    if (page.lines.length > count) {
      count += PAGE;
      return draw();
    }
    if (!page.before) return;
    button.disabled = true;
    try {
      const r = await api(historyUrl(f, page.before));
      if (!isAlive()) return;
      page = { ...r, lines: [...page.lines, ...r.lines] };
      count += PAGE;
      draw();
    } catch (e) {
      button.disabled = false;
      toast(`Could not load more: ${e.message}`);
    }
  }

  load();
  return {
    // Looked at again only while nothing older was asked for: a "Show more" the owner pressed is not taken back.
    refresh: () => (page && count > PAGE ? null : load()),
    working: () => !!(page && page.lines.some((l) => l.kind === 'run' && l.state === 'running')),
  };
}
