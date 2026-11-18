// "Do it" on the Work page (src/work/doit.mjs does it): the sheet that shows what will start and lets the owner change
// it, a task's runs (what each session did), Accept and Send back for a task in review, and the Activity part (the
// runs of all tasks). Every choice goes to /api/work/…, which checks it; a folder is one of the project's choices,
// never a path.
import { icon } from './icons.js';
import { api, btn, fill, h, link, openSheet, promptSheet, toast } from './lib.js';
import { emptyState, errorBox, groupHead, skeletonRows } from './shell.js';

const enc = encodeURIComponent;
// The product's own words: "Limit reached", as Home and Today say it (lib.js stateOf), with the icon of a limit.
export const RUN_WORDS = { running: 'Working', done: 'Done', failed: 'Failed', limit: 'Limit reached', stopped: 'Stopped' };
const RUN_ICONS = { running: 'clock', done: 'check', failed: 'alert', limit: 'zap', stopped: 'stop' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_WORDS = { changed: 'changed', added: 'added', deleted: 'deleted', renamed: 'renamed', new: 'new' };

/** Where a run's session works, in words: "shop" or "shop/code/web". */
export const whereText = (r) => (r.folder === '.' ? r.project : `${r.project}/${r.folder}`);
/** The page of a run's session (an App session has its own page), on the computer whose page this is. */
export const sessionLink = (id) => link(`#/chat/${id}`);
/** A run's session can be opened here only when it ran on this computer (here): another computer's is not here. */
export const openable = (r) => !!(r && r.session && r.here);

/** "17 Nov, 14:05" for an ISO time (this browser's clock). */
export function timeText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A run's state as a small badge. */
export const runBadge = (state) => h(`span.badge.wk-run-badge.wk-run-${state}`, icon(RUN_ICONS[state] || 'info', { size: 12 }), RUN_WORDS[state] || state);

// ---------- the Do it sheet ----------

/**
 * "Do it" for item `it`: what will start (the brief, the project and its folder, the coding tool, the provider, the
 * model and the effort), changed before Start. Resolves the started run, or null.
 */
export function doItSheet(it) {
  return openSheet({ title: 'Do it with a session', subtitle: it.title }, (close) => {
    const body = h('div.wk-do', skeletonRows(3));
    const v = {}; // the owner's choices; left out: the task's own and the defaults
    let plan = null;
    let briefTouched = false;
    const brief = h('textarea.field.wk-brief', { rows: 6, maxlength: 4000, 'aria-label': 'The brief', oninput: (e) => {
      v.brief = e.target.value;
      briefTouched = true;
    } });
    const err = h('p.form-error', { role: 'alert' });
    // What is wrong with the brief itself stands right under it, where it is seen also on a phone, whose sheet shows
    // its top. A brief with characters nobody can see: he cannot find them in the box, so one tap takes them out (the
    // server sends the brief without them and checks it again on Start; the changed brief is kept on the task).
    const briefErr = h('p.form-error.wk-brief-problem', { role: 'alert' });
    const fix = h('div.wk-do-fix');
    const briefProblem = (text, clean) => {
      briefErr.textContent = text;
      fill(fix, typeof clean === 'string' && clean.trim() ? btn('secondary.wk-do-clean', { label: 'Take them out', onclick: () => {
        brief.value = clean;
        v.brief = clean;
        briefTouched = true;
        briefProblem('', null);
        brief.focus();
      } }) : null);
    };
    // A refused Start says why where it is seen: the sheet may be scrolled away from it.
    const show = (el) => el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });

    async function load(want = {}) {
      const q = new URLSearchParams({ at: String(it.at) });
      for (const [k, x] of Object.entries(want)) if (x !== undefined) q.set(k, x === null ? '' : x);
      try {
        plan = await api(`/api/work/items/${enc(it.id)}/do?${q}`);
      } catch (e) {
        if (!plan) return fill(body, errorBox(e.message));
        err.textContent = e.message;
        return null;
      }
      paint();
      return plan;
    }
    const select = (label, value, options, onchange, hint = null) => h('label.fieldrow', h('span.field-label', label),
      h('select.field', { onchange: (e) => onchange(e.target.value) }, options.map(([val, text]) => h('option', { value: val, selected: val === (value ?? '') }, text))),
      hint ? h('span.hint', hint) : null);

    function paint() {
      const p = plan;
      if (p.running) {
        return fill(body,
          h('p.sheet-text', 'A session works on this task already.'),
          h('div.sheet-actions', btn('secondary', { label: 'Close', onclick: () => close(null) }), h('a.btn.primary', { href: sessionLink(p.running.session), onclick: () => close(null) }, icon('external', { size: 16 }), 'Open the session')));
      }
      if (!briefTouched) brief.value = p.brief;
      const elsewhere = p.elsewhere ? h('p.wk-do-line', icon('info', { size: 16 }), h('span', `A session works on this task on another computer too (started ${timeText(p.elsewhere.startedAt)}). Start begins another one here.`)) : null;
      // A brief made from a task that came from elsewhere may hold what cannot start: said before Start.
      if (p.briefProblem && !briefTouched) briefProblem(`${p.briefProblem.charAt(0).toUpperCase()}${p.briefProblem.slice(1)}.`, p.briefClean);
      const project = v.project !== undefined ? v.project : p.project;
      const folder = v.folder || p.folder;
      const where = project ? (folder === '.' ? project : `${project}/${folder}`) : null;
      const go = h('button.btn.primary', { type: 'submit', disabled: !project }, icon('play', { size: 16 }), 'Start');
      const submit = async (e) => {
        e.preventDefault();
        err.textContent = '';
        briefProblem('', null);
        go.disabled = true;
        go.classList.add('busy');
        const send = { at: it.at, ...(project ? { project } : {}), folder, tool: v.tool || p.tool, ...(v.provider || p.provider ? { provider: v.provider || p.provider } : {}),
          ...(v.model ? { model: v.model } : {}), ...(v.effort ? { effort: v.effort } : {}),
          // The brief he changed, or the one shown: the server refuses when the task changed since (a merge, a save).
          ...(briefTouched && brief.value.trim() !== p.brief.trim() ? { brief: brief.value } : { seen: p.brief }) };
        try {
          const r = await api(`/api/work/items/${enc(it.id)}/do`, send);
          const run = r.run;
          if (run.state === 'failed') {
            err.textContent = run.reason || 'The session did not start.';
            go.disabled = false;
            show(err);
            return;
          }
          toast(r.existing ? 'A session works on it already' : 'Started: a session works on the task', openable(run) ? { action: { label: 'Open', run: () => (location.hash = sessionLink(run.session)) } } : {});
          close(run);
        } catch (x) {
          go.disabled = false;
          if (x.code === 'brief-changed') {
            // Shown again as it is now, with what he wrote kept if he wrote something.
            await load({ ...(project ? { project, folder } : {}), ...(v.tool ? { tool: v.tool } : {}) });
            err.textContent = 'The task changed since its brief was shown: here it is as it is now. Look at it, then Start again.';
            show(err);
          } else if (x.code === 'brief-hidden') {
            briefProblem(`${x.message}.`, x.data.clean);
            show(fix);
          } else {
            err.textContent = x.message;
            show(err);
          }
        } finally {
          go.classList.remove('busy');
        }
      };
      fill(body, h('form.wk-form', { onsubmit: submit },
        h('label.fieldrow', h('span.field-label', 'Brief'), brief, h('span.hint', p.briefKept ? 'The brief kept on this task.' : 'The task and its note. A brief you change here is kept on the task.')),
        briefErr,
        fix,
        h('div.wk-pair',
          select('Project', project, [...(project ? [] : [['', 'Choose a project']]), ...p.projects.map((x) => [x, x])], (x) => {
            v.project = x || null;
            v.folder = '.';
            delete v.provider;
            load({ project: v.project, folder: '.', tool: v.tool });
          }),
          project ? select('Folder', folder, p.folders.map((f) => [f.value, f.value === '.' ? `${project} (its own folder)` : f.label]), (x) => {
            v.folder = x;
            delete v.provider;
            load({ project, folder: x, tool: v.tool });
          }) : h('div')),
        // What it runs on: the coding tool (when there is a choice), the provider (the folder's own, as New session
        // picks it), the model and the effort (Settings' defaults).
        h('div.wk-trio',
          p.tools.length > 1 ? select('Coding tool', v.tool || p.tool, p.tools.map((x) => [x.id, x.name]), (x) => {
            v.tool = x;
            delete v.provider;
            delete v.model;
            delete v.effort;
            load({ ...(project ? { project, folder } : {}), tool: x });
          }) : null,
          select('Provider', v.provider || p.provider || '', [...(p.provider ? [] : [['', 'Choose one']]), ...p.providers.map((x) => [x.name, x.label])], (x) => (v.provider = x)),
          select('Model', v.model || p.model || '', [['', p.model ? `Default (${p.model})` : 'Default'], ...p.models.filter((m) => m !== p.model).map((m) => [m, m])], (x) => (v.model = x || null)),
          select('Effort', v.effort || p.effort || '', [['', p.effort ? `Default (${p.effort})` : 'Default'], ...p.efforts.filter((x) => x !== p.effort).map((x) => [x, x])], (x) => (v.effort = x || null))),
        elsewhere,
        h('p.wk-do-line', icon('info', { size: 16 }), h('span', where
          ? `A session starts in ${where} with this brief. It changes files there as you allow in that session; nothing is pushed or merged by this.`
          : 'This task has no project: choose the project a session works in.')),
        err,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go)));
    }
    load();
    return body;
  });
}

// ---------- Accept, Send back ----------

export async function accept(it, after) {
  try {
    await api(`/api/work/items/${enc(it.id)}/accept`, { at: it.at });
    toast('Accepted: the task is done');
  } catch (e) {
    toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
  }
  after();
}

export async function sendBack(it, after) {
  const text = await promptSheet({ title: 'Send back', text: 'The task is open again. What you write here is added to its brief, so the next run starts with it.', multiline: true, ok: 'Send back', placeholder: 'What is to be done differently', label: 'What is to be done differently', check: (x) => (x.trim() ? '' : 'Say what is to be done differently') });
  if (text === null) return;
  try {
    await api(`/api/work/items/${enc(it.id)}/send-back`, { at: it.at, text });
    toast('Sent back: the task is open again');
  } catch (e) {
    toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
  }
  after();
}

// ---------- one run ----------

/** An answer of more than a few lines is folded, with a button that shows it all. */
function answerBox(text) {
  const box = h('div.wk-run-answer', text);
  if (text.length <= 320 && text.split('\n').length <= 5) return box;
  box.classList.add('wk-folded');
  const more = btn('small ghost.wk-more', { label: 'Show all', onclick: () => {
    const folded = box.classList.toggle('wk-folded');
    more.lastChild.textContent = folded ? 'Show all' : 'Show less';
  } });
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => more.setAttribute('aria-expanded', String(!box.classList.contains('wk-folded'))));
  return h('div', box, more);
}

/** What one run did: its state and when, the reason, the answer, the commits and the files left changed. */
export function runCard(r, { title = false, onTask = null } = {}) {
  const repoOf = (x) => (x.repo === '.' || x.repo === r.folder ? '' : `${x.repo}/`);
  const files = r.changed.length + (r.more || 0);
  return h(`article.wk-run.wk-run-is-${r.state}`,
    h('div.wk-run-head',
      runBadge(r.state),
      title ? h('strong.wk-run-title', r.title) : null,
      h('span.wk-run-when', timeText(r.startedAt), r.endedAt ? ` – ${timeText(r.endedAt).split(', ')[1] || ''}` : ''),
      h('span.wk-tag', icon('folder', { size: 13 }), whereText(r)),
      h('span.wk-tag', { title: 'The provider it ran on' }, icon('user', { size: 13 }), `${r.providerLabel || r.provider}${r.model ? ` · ${r.model}` : ''}`),
      r.here === false ? h('span.wk-tag', icon('cpu', { size: 13 }), 'Another computer') : null),
    r.reason ? h('p.wk-run-reason', r.reason) : null,
    r.statusError ? h('p.wk-run-reason.wk-run-warn', icon('alert', { size: 14 }), h('span', r.statusError)) : null,
    r.answer ? answerBox(r.answer) : r.state === 'running' ? h('p.hint', 'The answer comes when the session\'s turn ends.') : null,
    r.commits.length ? h('div.wk-run-list', h('span.wk-run-label', icon('git', { size: 13 }), `${r.commits.length === 1 ? '1 commit' : `${r.commits.length} commits`}`),
      h('ul', r.commits.map((c) => h('li', h('code', `${repoOf(c)}${c.short}`), ' ', c.subject)))) : null,
    files ? h('div.wk-run-list', h('span.wk-run-label', icon('pencil', { size: 13 }), `${files === 1 ? '1 file' : `${files} files`} changed, not committed`),
      h('ul', r.changed.map((f) => h('li', h('code', `${repoOf(f)}${f.path}`), ` ${KIND_WORDS[f.kind] || f.kind}`)), r.more ? h('li.wk-more-files', `and ${r.more} more`) : null)) : null,
    openable(r) || onTask ? h('div.wk-run-actions',
      openable(r) ? h('a.btn.small.secondary', { href: sessionLink(r.session) }, icon('external', { size: 14 }), 'Open the session') : null,
      onTask ? btn('small ghost', { label: 'All runs of the task', onclick: onTask }) : null) : null);
}

/** A task's runs, newest first, in a sheet; for a task in review: Accept and Send back. */
export function runsSheet(it, after) {
  return openSheet({ title: 'Runs of this task', subtitle: it.title, tall: true }, (close) => {
    const body = h('div.wk-runs', skeletonRows(2));
    api(`/api/work/runs?item=${enc(it.id)}`).then(({ runs }) => {
      const review = it.status === 'review' ? h('div.wk-review-bar',
        h('span', 'A session has done this task: look at what it did, then'),
        btn('small primary', { icon: 'check', label: 'Accept', onclick: () => {
          close(true);
          accept(it, after);
        } }),
        btn('small secondary', { icon: 'undo', label: 'Send back', onclick: () => {
          close(true);
          sendBack(it, after);
        } })) : null;
      fill(body, review, runs.length ? runs.map((r) => runCard(r)) : emptyState('play', 'No session has worked on this task yet. "Do it" starts one.'));
    }, (e) => fill(body, errorBox(e.message)));
    return body;
  });
}

// ---------- Activity ----------

export const ACTIVITY_PAGE = 30; // runs drawn at first, and added by each "Show more"

/** The filter as it can be used with these runs: a project or a day no run has any more is let go (and not kept). */
export function usableFilter(f, runs) {
  return {
    project: f.project && runs.some((r) => r.project === f.project) ? f.project : '',
    day: f.day && runs.some((r) => r.day === f.day) ? f.day : '',
  };
}

/**
 * The Activity part: the runs of every task, newest first, filtered by project and by day, ACTIVITY_PAGE at a time.
 * `slot` is filled; `prefs` keeps the filter per device. → { refresh, working } (refresh: load again, keeping the
 * filter and what is shown, drawn only when something changed; working: a run of this computer is still at work).
 */
export function paintActivity(slot, { prefs, onItem, today = null }) {
  let f = { project: prefs.get('work.activity.project', ''), day: prefs.get('work.activity.day', '') };
  let runs = null;
  let key = '';
  let size = ACTIVITY_PAGE;
  fill(slot, skeletonRows(3));
  const draw = () => {
    const fixed = usableFilter(f, runs);
    for (const k of ['project', 'day']) if (fixed[k] !== f[k]) prefs.set(`work.activity.${k}`, fixed[k]);
    f = fixed;
    if (!runs.length) return fill(slot, h('div.card.wk-start', emptyState('play', 'Nothing has happened here yet. When a session does a task ("Do it" on a task), what it did shows here.')));
    const projects = [...new Set(runs.map((r) => r.project))].sort();
    const days = [...new Set(runs.map((r) => r.day))].sort().reverse();
    const sel = (label, k, options) => h('label.wk-filter', h('span', label), h('select.field', { dataset: { key: `activity-${k}` }, onchange: (e) => {
      f[k] = e.target.value;
      prefs.set(`work.activity.${k}`, f[k]);
      size = ACTIVITY_PAGE;
      draw();
    } }, options.map(([val, text]) => h('option', { value: val, selected: val === f[k] }, text))));
    const all = runs.filter((r) => (!f.project || r.project === f.project) && (!f.day || r.day === f.day));
    const shown = all.slice(0, size);
    const byDay = new Map();
    for (const r of shown) byDay.set(r.day, [...(byDay.get(r.day) || []), r]);
    const more = all.length > shown.length ? btn('secondary.wk-show-more', { label: `Show more (${all.length - shown.length} older)`, dataset: { key: 'activity-more' }, onclick: () => {
      size += ACTIVITY_PAGE;
      draw();
    } }) : null;
    fill(slot,
      h('div.wk-filters', sel('Project', 'project', [['', 'All projects'], ...projects.map((p) => [p, p])]), sel('Day', 'day', [['', 'Every day'], ...days.map((d) => [d, dayLabel(d, today)])])),
      shown.length ? [...byDay].map(([day, list]) => h('section.wk-section', groupHead(dayLabel(day, today), list.length),
        h('div.wk-activity', list.map((r) => runCard(r, { title: true, onTask: onItem ? () => onItem(r.item) : null })))))
        : emptyState('search', 'Nothing matches this filter.'),
      more);
  };
  const refresh = () => api('/api/work/runs').then((got) => {
    const k = JSON.stringify(got.runs);
    if (runs && k === key) return;
    runs = got.runs;
    key = k;
    keepFocus(slot, draw);
  }, (e) => {
    if (!runs) fill(slot, errorBox(e.message));
  });
  refresh();
  return { refresh, working: () => !!runs && runs.some((r) => r.state === 'running' && r.here) };
}

/**
 * Draw `slot` again with `draw`, and put the keyboard's focus back where it was: on the element of the same key
 * (data-key, or a row's id and the control's label) when the new drawing has one.
 */
export function keepFocus(slot, draw) {
  const was = typeof document !== 'undefined' ? document.activeElement : null;
  const keyOf = (el) => {
    if (!el || !el.closest) return null;
    if (el.dataset && el.dataset.key) return `k:${el.dataset.key}`;
    const row = el.closest('[data-id]');
    const what = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent;
    return row ? `r:${row.dataset.id}|${what}` : null;
  };
  const k = was && slot.contains && slot.contains(was) ? keyOf(was) : null;
  draw();
  if (!k) return;
  const again = [...slot.querySelectorAll('button, a, select, input, textarea')].find((el) => keyOf(el) === k);
  if (again) again.focus();
}

/** "Today", "Yesterday" or "16 Nov" for a day of the runs (`today`: Work's today, the server's word for it). */
function dayLabel(ymd, today) {
  const [y, m, d] = ymd.split('-').map(Number);
  if (today && ymd === today) return 'Today';
  if (today && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`) === 86_400_000) return 'Yesterday';
  return `${d} ${MONTHS[m - 1]}${today && y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
}
