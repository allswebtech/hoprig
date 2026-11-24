// "Do it" on the Work page (src/work/doit.mjs does it): the sheet that shows what will start and lets the owner change
// it, a task's runs (what each session did), Accept and Send back for a task in review, and the Activity part (the
// runs of all tasks). Every choice goes to /api/work/…, which checks it; a folder is one of the project's choices,
// never a path.
import { taskProgress } from './workpulse.js';
import { icon } from './icons.js';
import { api, btn, fill, h, link, openSheet, promptSheet, toast, wayLink } from './lib.js';
import { modelPicker } from './modelpicker.js';
import { emptyState, errorBox, fold, groupHead, skeletonRows } from './shell.js';
import { learningOn } from './skilllearned.js';

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

/** What the Do it sheet says of a task another program added (a Work token), or null: in words, not only a tooltip. */
export function fromLine(it) {
  return it && it.from && it.from.name ? `Another program added this task (the Work token "${it.from.name}"): its words are that program's, not yours. It starts only when you start it.` : null;
}

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
        if (!plan) return fill(body, errorBox(e));
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
          h('div')),
        // Folder and what it runs on, folded under Options with one line of what is chosen: the folder, the coding
        // tool (when there is a choice), the provider (the folder's own, as New session picks it), the model and the
        // effort (Settings' defaults). Same choices, same defaults; the line says when the AI account is still to be chosen.
        options(p, v, project, folder, h('div.wk-pair', project ? select('Folder', folder, p.folders.map((f) => [f.value, f.value === '.' ? `${project} (its own folder)` : f.label]), (x) => {
          v.folder = x;
          delete v.provider;
          load({ project, folder: x, tool: v.tool });
        }) : null),
        h('div.wk-trio',
          p.tools.length > 1 ? select('Coding tool', v.tool || p.tool, p.tools.map((x) => [x.id, x.name]), (x) => {
            v.tool = x;
            delete v.provider;
            delete v.model;
            delete v.effort;
            load({ ...(project ? { project, folder } : {}), tool: x });
          }) : null,
          select('Provider', v.provider || p.provider || '', [...(p.provider ? [] : [['', 'Choose one']]), ...p.providers.map((x) => [x.name, x.label])], (x) => {
            v.provider = x || null;
            delete v.model; // another provider has its own models
            paint();
          }),
          // The provider's own models (src/models/catalog.mjs), asked when the sheet is drawn.
          modelPicker({ provider: v.provider || p.provider, tool: v.tool || p.tool, value: v.model || p.model || '', key: 'Model',
            emptyLabel: p.model ? `Default (${p.model})` : 'Default', onchange: (x) => (v.model = x || null) }),
          select('Effort', v.effort || p.effort || '', [['', p.effort ? `Default (${p.effort})` : 'Default'], ...p.efforts.filter((x) => x !== p.effort).map((x) => [x, x])], (x) => (v.effort = x || null)))),
        elsewhere,
        fromLine(it) ? h('p.wk-do-line', icon('key', { size: 16 }), h('span', fromLine(it))) : null,
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

/** The Do it sheet's one line of what is chosen: "Claude Code on Auto mode", and a folder that is not the project's own. */
export function optionsLine(p, v = {}, project = p.project, folder = v.folder || p.folder) {
  const tool = (p.tools.find((x) => x.id === (v.tool || p.tool)) || {}).name || v.tool || p.tool;
  const pv = (p.providers.find((x) => x.name === (v.provider || p.provider)) || {}).label;
  const parts = [pv ? `${tool} on ${pv}` : `${tool}: choose a provider`];
  if (project && folder && folder !== '.') parts.push(`in ${(p.folders.find((f) => f.value === folder) || {}).label || folder}`);
  return parts.join(', ');
}

function options(p, v, project, folder, ...children) {
  const d = fold('work-do-options', `Options · ${optionsLine(p, v, project, folder)}`, ...children);
  d.classList?.add('wk-do-options');
  return d;
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

/** Done with a schedule's run: its worktree is removed when clean (the branch stays). */
async function releaseRun(r) {
  try {
    const x = await api('/api/work/alone/release', { run: r.id });
    toast(x.removed ? `Its copy of the project is removed; the branch ${r.branch} stays` : `${x.why.charAt(0).toUpperCase()}${x.why.slice(1)}`, x.removed ? {} : { kind: 'error', ms: 6000 });
  } catch (e) {
    toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
  }
}

export async function sendBack(it, after) {
  // With learning on, his words are also read for a skill draft: said here, before he writes them.
  const learn = (await learningOn()) ? [' Learning skills is on: your words are also read for a skill draft, which waits in ', h('a', { href: link('#/skills/learned') }, 'Skills → Learned'), ' until you install it.'] : [];
  const text = await promptSheet({ title: 'Send back', text: ['The task is open again. What you write here is added to its brief, so the next run starts with it.', ...learn], multiline: true, ok: 'Send back', placeholder: 'What is to be done differently', label: 'What is to be done differently', check: (x) => (x.trim() ? '' : 'Say what is to be done differently') });
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
const TIER_WORD = { fast: 'Fast', strong: 'Strong', strongest: 'Strongest', other: 'Other' };
/** Who did what in a run (Lead model): one line per tier with its parts, tokens and models, read from the tool's records. */
export function whoDidWhat(p) {
  const rows = (p.tiers || []).map((t) => `${TIER_WORD[t.tier] || t.tier}: ${t.parts} part${t.parts === 1 ? '' : 's'} · ${Number(t.tokens || 0).toLocaleString()} tokens · ${(t.models || []).join(', ') || '?'}`);
  return h('div.wk-run-parts', h('strong', 'Who did what'), ...rows.map((x) => h('p.hint', x)));
}

export function runCard(r, { title = false, onTask = null, onRelease = null, onLearn = null } = {}) {
  const repoOf = (x) => (x.repo === '.' || x.repo === r.folder ? '' : `${x.repo}/`);
  // "Learn from this" says its answer here, in the card (a toast would lie behind the open sheet).
  const said = onLearn ? h('p.wk-learn-said', { role: 'status', tabindex: '-1' }) : null;
  const files = r.changed.length + (r.more || 0);
  return h(`article.wk-run.wk-run-is-${r.state}`,
    h('div.wk-run-head',
      runBadge(r.state),
      title ? h('strong.wk-run-title', r.title) : null,
      r.from ? h('span.wk-tag.wk-from', { title: 'Added by another program with a Work token: its words are that program\'s' }, icon('key', { size: 13 }), `From ${r.from}`) : null,
      h('span.wk-run-when', timeText(r.startedAt), r.endedAt ? ` – ${timeText(r.endedAt).split(', ')[1] || ''}` : ''),
      h('span.wk-tag', icon('folder', { size: 13 }), whereText(r)),
      h('span.wk-tag', { title: 'The provider it ran on' }, icon('user', { size: 13 }), `${r.providerLabel || r.provider}${r.model ? ` · ${r.model}` : ''}`),
      r.here === false ? h('span.wk-tag', icon('cpu', { size: 13 }), 'Another computer') : null,
      // A run that ended by itself: its result waits on a branch of its own (never pushed, never merged).
      r.branch ? h('span.wk-tag', { title: 'Not pushed, not merged' }, icon('git', { size: 13 }), `on the branch ${r.branch}`) : null),
    r.parts ? whoDidWhat(r.parts) : null,
    r.reason ? h('p.wk-run-reason', r.reason) : null,
    r.statusError ? h('p.wk-run-reason.wk-run-warn', icon('alert', { size: 14 }), h('span', r.statusError)) : null,
    r.answer ? answerBox(r.answer) : r.state === 'running' ? h('p.hint', 'The answer comes when the session\'s turn ends.') : null,
    r.commits.length ? h('div.wk-run-list', h('span.wk-run-label', icon('git', { size: 13 }), `${r.commits.length === 1 ? '1 commit' : `${r.commits.length} commits`}`),
      h('ul', r.commits.map((c) => h('li', h('code', `${repoOf(c)}${c.short}`), ' ', c.subject)))) : null,
    files ? h('div.wk-run-list', h('span.wk-run-label', icon('pencil', { size: 13 }), `${files === 1 ? '1 file' : `${files} files`} changed, not committed`),
      h('ul', r.changed.map((f) => h('li', h('code', `${repoOf(f)}${f.path}`), ` ${KIND_WORDS[f.kind] || f.kind}`)), r.more ? h('li.wk-more-files', `and ${r.more} more`) : null)) : null,
    // A schedule's run has no task: its schedule, and once it ended, the worktree it keeps until he is done with it.
    r.schedule && r.state !== 'running' && r.here ? h('p.hint', `Its copy of the project (branch ${r.branch || ''}) stays on this computer until you are done with it; nothing is pushed or merged.`) : null,
    openable(r) || onTask || onLearn || r.schedule ? h('div.wk-run-actions',
      openable(r) ? h('a.btn.small.secondary', { href: sessionLink(r.session) }, icon('external', { size: 14 }), 'Open the session') : null,
      r.schedule && onRelease && r.state !== 'running' && r.here ? btn('small secondary', { icon: 'check', label: 'Done with it: remove its copy of the project', onclick: onRelease }) : null,
      r.schedule ? h('a.btn.small.ghost', { href: '#/work/schedules' }, 'Open the schedules')
        : onTask ? btn('small ghost', { label: 'All runs of the task', onclick: onTask }) : null,
      onLearn ? btn('small secondary', { icon: 'sparkle', label: 'Learn from this', title: 'Look at this run for a skill worth keeping (a draft you read first)', onclick: (e) => onLearn(e, said) }) : null) : null,
    said);
}

/** A task's runs, newest first, in a sheet; for a task in review: Accept and Send back. */
export function runsSheet(it, after) {
  return openSheet({ title: 'Runs of this task', subtitle: it.title, tall: true }, (close) => {
    const body = h('div.wk-runs', skeletonRows(2));
    const now = h('div.wk-pulse-slot');
    Promise.all([api(`/api/work/runs?item=${enc(it.id)}`), it.status === 'done' ? learningOn() : false]).then(([{ runs }, learning]) => {
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
      // "Learn from this": on the newest run that ended well of a task he accepted, while learning is on.
      const learnable = learning ? runs.find((r) => r.state === 'done') : null;
      fill(body, now, review, runs.length ? runs.map((r) => runCard(r, r === learnable ? { onLearn: (e, said) => learnFrom(r, e.currentTarget, said) } : {})) : emptyState('play', 'No session has worked on this task yet. "Do it" starts one.'));
      taskProgress(now, it.id); // what of it runs now, with its estimate (workpulse.js)
    }, (e) => fill(body, errorBox(e)));
    return body;
  });
}

/**
 * "Learn from this": one look at the run; its draft, if any, waits in Skills → Learned. The answer is said in the
 * card's line `said` (role status), and the focus goes there: the button is disabled while it waits.
 */
export async function learnFrom(r, button, said) {
  const label = button.lastChild;
  const say = (...text) => {
    fill(said, ...text);
    said.focus();
  };
  button.disabled = true;
  label.textContent = 'Looking…';
  try {
    const out = await api('/api/skills/learned/look', { run: r.id });
    if (out.skipped) {
      label.textContent = 'Not looked at';
      say(`Not looked at: ${out.why || out.skipped}.`);
    } else {
      label.textContent = 'Looked at';
      say('Looking at it. A draft, if this run shows something worth keeping, waits in ', h('a', { href: link('#/skills/learned') }, 'Skills → Learned'), '.');
    }
  } catch (e) {
    label.textContent = 'Learn from this';
    button.disabled = false;
    say(e.message, ' ', wayLink(e));
  }
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
        h('div.wk-activity', list.map((r) => runCard(r, { title: true, onTask: onItem ? () => onItem(r.item) : null, onRelease: () => releaseRun(r) })))))
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
    if (!runs) fill(slot, errorBox(e));
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
