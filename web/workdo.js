// "Do it" on the Work page (src/work/doit.mjs does it): the sheet that shows what will start and lets the owner change
// it, a task's runs (what each session did), Accept and Send back for a task in review, and the Activity part (the
// runs of all tasks). Every choice goes to /api/work/…, which checks it; a folder is one of the project's choices,
// never a path.
import { taskProgress } from './workpulse.js';
import { drawRows, partRows } from './chat/parts.js';
import { icon } from './icons.js';
import { api, btn, fill, h, link, openSheet, promptSheet, toast, wayLink } from './lib.js';
import { modelPicker } from './modelpicker.js';
import { emptyState, errorBox, fold, skeletonRows } from './shell.js';
import { learningOn } from './skilllearned.js';
import { useLine } from './workuse.js';

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
        const send = { at: it.at, ...(project ? { project } : {}), folder, ...(p.branch && v.inFolder ? { inFolder: true } : {}), tool: v.tool || p.tool, ...(v.provider || p.provider ? { provider: v.provider || p.provider } : {}),
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
        // Where it works: a branch of its own (the default for a git repository) or the project's folder itself.
        p.branch ? select('Where it works', v.inFolder ? 'folder' : 'branch', [['branch', `On a branch of its own, ${p.branch.name}`], ['folder', 'In the project\'s folder itself']], (x) => {
          v.inFolder = x === 'folder';
          paint();
        }) : null,
        project ? h('p.wk-do-line.wk-do-place', icon('git', { size: 16 }), h('span', placeLine(p, !!v.inFolder))) : null,
        elsewhere,
        fromLine(it) ? h('p.wk-do-line', icon('key', { size: 16 }), h('span', fromLine(it))) : null,
        h('p.wk-do-line', icon('info', { size: 16 }), h('span', where
          ? `A session starts in ${p.branch && !v.inFolder ? `its own copy of ${where}` : where} with this brief. It changes files there as you allow in that session; nothing is pushed or merged by this.`
          : 'This task has no project: choose the project a session works in.')),
        err,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go)));
    }
    load();
    return body;
  });
}

/**
 * Where a Do it run works, in one line for the sheet: on its own branch (plan.branch: { name, again }), in the project's
 * folder because he chose it, or because there can be no branch (plan.branchWhy: not-git | outside). With a branch the
 * sheet's "Where it works" choice names it already, and its info line says nothing is merged: this line does not again.
 */
export function placeLine(p, inFolder = false) {
  if (p.branch && !inFolder) return p.branch.again
    ? 'Again where the last run left its branch. Your folder is not changed.'
    : 'Your folder is not changed. Accept leaves the branch for Go live.';
  if (p.branch) return 'In the project\'s folder itself, on the branch it stands on now.';
  // Named as Settings names it, with the way there (web/sessiondefaults.js foldersPanel, under Advanced).
  if (p.branchWhy === 'outside') return 'In the project\'s folder itself: Hoprig keeps a branch\'s copy in its own folder, which is not among the folders where sessions can start (Settings → Security and sign-in → Folders Hoprig may open).';
  if (p.branchWhy === 'not-git') return 'In the project\'s folder itself: it is not a git repository, so there is no branch of its own.';
  return 'In the project\'s folder itself.';
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
    const r = await api(`/api/work/items/${enc(it.id)}/accept`, { at: it.at });
    toast(acceptWords(r));
  } catch (e) {
    toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
  }
  after();
}

/** What Accept says: a run on a branch of its own leaves that branch for Go live (worktree: what Accept did with it). */
export function acceptWords(r) {
  if (!r || !r.worktree) return 'Accepted: the task is done';
  return r.worktree.removed ? 'Accepted: the task is done. Its branch stays for Go live; its copy of the project is removed'
    : 'Accepted: the task is done. Its branch stays for Go live; its copy of the project stays too, it has files not committed';
}

/** "Remove the branch" of a task's Do it runs: kept, with why, while work is only there or files are not committed. */
async function removeBranch(it, after) {
  try {
    const x = await api(`/api/work/items/${enc(it.id)}/remove-branch`, {});
    toast(x.removed ? `The branch ${x.branch} and its copy of the project are removed` : `${x.why.charAt(0).toUpperCase()}${x.why.slice(1)}`, x.removed ? {} : { kind: 'error', ms: 6000 });
  } catch (e) {
    toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
  }
  after();
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
/** Space is short (a phone): a card that can wait starts closed there. */
export const narrowScreen = () => typeof matchMedia === 'function' && matchMedia('(max-width: 599px)').matches;
/**
 * Who did what in a run (Lead model): the chat page's own card (web/chat/parts.js), the lead, each part with its kind,
 * model and tokens, and one line per tier, read from the tool's records. Open on a wide screen, closed on a phone.
 */
// The owner's own open or close of a run's card, by run id: the page draws its cards again while a session works, and
// that must not undo what he chose (for as long as the page is open).
const partsOpen = new Map();
export function whoDidWhat(p, { key = null, open = key && partsOpen.has(key) ? partsOpen.get(key) : !narrowScreen() } = {}) {
  const rows = partRows({ lead: p.lead || null, parts: p.parts || [], tiers: p.tiers || [] });
  const el = h('details.wk-run-parts', { open }, h('summary', 'Who did what'), h('dl.chat-rail-rows.chat-parts-rows', drawRows(rows)));
  if (key) el.addEventListener('toggle', () => partsOpen.set(key, el.open));
  return el;
}

export function runCard(r, { title = false, onTask = null, onRelease = null, onLearn = null, onRemoveBranch = null } = {}) {
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
    r.parts ? whoDidWhat(r.parts, { key: r.id }) : null,
    r.use ? useLine(r.use) : null, // what it used and what the cheaper way saved (workuse.js), from its records only
    r.reason ? h('p.wk-run-reason', r.reason) : null,
    r.statusError ? h('p.wk-run-reason.wk-run-warn', icon('alert', { size: 14 }), h('span', r.statusError)) : null,
    r.answer ? answerBox(r.answer) : r.state === 'running' ? h('p.hint', 'The answer comes when the session\'s turn ends.') : null,
    r.commits.length ? h('div.wk-run-list', h('span.wk-run-label', icon('git', { size: 13 }), `${r.commits.length === 1 ? '1 commit' : `${r.commits.length} commits`}`),
      h('ul', r.commits.map((c) => h('li', h('code', `${repoOf(c)}${c.short}`), ' ', c.subject)))) : null,
    files ? h('div.wk-run-list', h('span.wk-run-label', icon('pencil', { size: 13 }), `${files === 1 ? '1 file' : `${files} files`} changed, not committed`),
      h('ul', r.changed.map((f) => h('li', h('code', `${repoOf(f)}${f.path}`), ` ${KIND_WORDS[f.kind] || f.kind}`)), r.more ? h('li.wk-more-files', `and ${r.more} more`) : null)) : null,
    // A schedule's run has no task: its schedule, and once it ended, the worktree it keeps until he is done with it.
    r.schedule && r.state !== 'running' && r.here ? h('p.hint', `Its copy of the project (branch ${r.branch || ''}) stays on this computer until you are done with it; nothing is pushed or merged.`) : null,
    openable(r) || onTask || onLearn || onRemoveBranch || r.schedule ? h('div.wk-run-actions',
      openable(r) ? h('a.btn.small.secondary', { href: sessionLink(r.session) }, icon('external', { size: 14 }), 'Open the session') : null,
      r.schedule && onRelease && r.state !== 'running' && r.here ? btn('small secondary', { icon: 'check', label: 'Done with it: remove its copy of the project', onclick: onRelease }) : null,
      r.schedule ? h('a.btn.small.ghost', { href: '#/work/schedules' }, 'Open the schedules')
        : onTask ? btn('small ghost', { label: 'All runs of the task', onclick: onTask }) : null,
      onRemoveBranch ? btn('small secondary', { icon: 'trash', label: 'Remove the branch', title: `Remove ${r.branch} and its copy of the project: kept while a commit is only there`, onclick: onRemoveBranch }) : null,
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
      // "Remove the branch": on the newest Do it run on a branch of its own, once the task is done or dropped.
      const branchRun = ['done', 'dropped'].includes(it.status) ? runs.find((r) => r.branch && r.session && r.here && r.state !== 'running') || null : null;
      const opts = (r) => ({ ...(r === learnable ? { onLearn: (e, said) => learnFrom(r, e.currentTarget, said) } : {}), ...(r === branchRun ? { onRemoveBranch: () => {
        close(true);
        removeBranch(it, after);
      } } : {}) });
      fill(body, now, review, runs.length ? runs.map((r) => runCard(r, opts(r))) : emptyState('play', 'No session has worked on this task yet. "Do it" starts one.'));
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

