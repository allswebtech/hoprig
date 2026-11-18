// The parts of the Work page that show and change one item (work.js draws the page): the words for a date and for
// who does it, one row of the list, the sheet that adds or changes an item, and the item's actions (done, open
// again, drop, remove). Every change goes to /api/work/…, which checks it; the page only shows what it answered.
import { icon } from './icons.js';
import { api, btn, chooseSheet, confirmSheet, h, openSheet, toast } from './lib.js';
import { accept, doItSheet, openable, runsSheet, sendBack, sessionLink } from './workdo.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const STATUS_WORDS = { open: 'Open', doing: 'A session works on it', review: 'Ready for your review', waiting: 'Waiting for you', done: 'Done', dropped: 'Dropped' };
const CLOSED = ['done', 'dropped'];

/** "Wed 19 Nov" for a YYYY-MM-DD day (the year only when it is not `thisYear`). */
export function dayName(date, thisYear = null) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[m - 1]}${thisYear && y !== thisYear ? ` ${y}` : ''}`;
}

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** A day of "This week" in two parts: ["Today" | "Tomorrow" | "Thursday", "19 Nov"]. `i`: days from today. */
export function weekLabel(date, i) {
  const [y, m, d] = date.split('-').map(Number);
  const name = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : LONG_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return [name, `${d} ${MONTHS[m - 1]}`];
}

/** A day as Today and the list say it: "Today", "Tomorrow", "Yesterday", else "Wed 19 Nov". */
export function dayWord(date, days, thisYear = null) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return dayName(date, thisYear);
}

/** When an item is due, in words: "3 days overdue", "Due today", "Due about Wed 19 Nov", "No date". */
export function whenText(it, thisYear = null) {
  if (!it.date) return 'No date';
  const about = it.approx ? 'about ' : '';
  if (!CLOSED.includes(it.status) && it.days < 0) return `${-it.days} day${it.days === -1 ? '' : 's'} overdue`;
  if (it.days === 0) return `Due ${about}today`;
  if (it.days === 1) return `Due ${about}tomorrow`;
  return `Due ${about}${dayName(it.date, thisYear)}`;
}

/** Who does it: "You", "AI", or the role's name. */
export const whoText = (by) => (by === 'me' ? 'You' : by === 'ai' ? 'AI' : by ? by.charAt(0).toUpperCase() + by.slice(1) : 'You');

const yearOf = (today) => Number(String(today || '').slice(0, 4)) || null;

// ---------- actions ----------

async function act(path, body, okText, after) {
  try {
    await api(path, body);
    if (okText) toast(okText);
  } catch (e) {
    toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
  }
  after();
}
const enc = encodeURIComponent;
// Every change names the item by its place in the list and its id together (two items may share an id).
export const setStatus = (it, status, after, okText = null) => act(`/api/work/items/${enc(it.id)}/status`, { at: it.at, status }, okText, after);

export async function removeItem(it, after) {
  if (!(await confirmSheet({ title: 'Remove this task?', text: `"${it.title}" is taken out of the list. Until you save, the last saved version still has it.`, ok: 'Remove', danger: true }))) return;
  act(`/api/work/items/${enc(it.id)}/remove`, { at: it.at }, 'Task removed', after);
}

/** The "more" choices of an item: Do it, its runs, change, the statuses it can move to, drop, remove (only one you added). */
export async function moreActions(it, ctx, after) {
  const closed = CLOSED.includes(it.status);
  const run = ctx.runs && ctx.runs[it.id];
  const items = [
    canDoIt(it, ctx) ? { value: 'do', label: 'Do it with a session', sub: 'A coding session works on it; you look at what it did', icon: 'play' } : null,
    run ? { value: 'runs', label: 'Runs', sub: 'What the sessions did: their answers, commits and changed files', icon: 'text' } : null,
    { value: 'edit', label: 'Change', icon: 'pencil' },
    closed ? { value: 'open', label: 'Open again', icon: 'undo' } : { value: 'done', label: 'Mark done', icon: 'check' },
    !closed && it.status !== 'waiting' ? { value: 'waiting', label: 'Waiting for you', sub: 'It needs you first: an account, a purchase, a yes', icon: 'clock' } : null,
    !closed ? { value: 'dropped', label: 'Drop', sub: 'Not doing it; it stays in the list as dropped', icon: 'x' } : null,
    it.removable
      ? { value: 'remove', label: 'Remove', sub: 'Take it out of the list', icon: 'trash', danger: true }
      : { value: 'none', label: 'Remove', sub: 'It came from a plan, so it is dropped instead of removed', icon: 'trash', disabled: true },
  ].filter(Boolean);
  const pick = await chooseSheet({ title: it.title, items });
  if (pick === 'do') return doItSheet(it).then((r) => r && after());
  if (pick === 'runs') return runsSheet(it, after);
  if (pick === 'edit') return itemSheet(it, ctx).then((ok) => ok && after());
  if (pick === 'remove') return removeItem(it, after);
  if (pick === 'open') return setStatus(it, 'open', after, 'Open again');
  if (pick === 'done' || pick === 'waiting' || pick === 'dropped') return setStatus(it, pick, after, pick === 'done' ? 'Done' : pick === 'dropped' ? 'Dropped' : 'Waiting for you');
  return null;
}

// ---------- one row ----------

/**
 * One item in a list: a round button that marks it done (or open again), its title and the line under it (when, its
 * project, who does it, why it needs you), a High mark, and "more". Pressing the title opens the change sheet.
 */
export function itemRow(it, ctx, after, { why = null } = {}) {
  const closed = CLOSED.includes(it.status);
  const late = !closed && typeof it.days === 'number' && it.days < 0;
  const check = h(`button.wk-check${it.status === 'done' ? '.wk-checked' : ''}`, {
    type: 'button',
    title: it.status === 'done' ? 'Open again' : 'Mark done',
    'aria-label': `${it.status === 'done' ? 'Open again' : 'Mark done'}: ${it.title}`,
    disabled: !it.editable || it.status === 'dropped',
    onclick: () => setStatus(it, it.status === 'done' ? 'open' : 'done', after, it.status === 'done' ? 'Open again' : 'Done'),
  }, icon('check', { size: 16 }));
  const bits = [
    h(`span${late ? '.wk-late' : ''}`, why || whenText(it, yearOf(ctx.today))),
    // (A task left doing by a run that ended: the line under it says no session works on it, not this.)
    it.status !== 'open' && !why && !closed && runLineKind(it, ctx.runs && ctx.runs[it.id]) !== 'ended' ? h('span', STATUS_WORDS[it.status]) : null,
    it.project ? h('span.wk-tag', icon('folder', { size: 13 }), it.project) : null,
    !it.project && it.brands.length ? h('span.wk-tag', it.brands.join(', ')) : null,
    h('span.wk-tag', icon(it.by === 'ai' ? 'sparkle' : 'user', { size: 13 }), whoText(it.by)),
  ].filter(Boolean);
  return h(`div.row.static.wk-item.wk-st-${it.status}`, { dataset: { id: it.id } },
    check,
    h('div.wk-main',
      h('button.wk-title', { type: 'button', disabled: !it.editable, onclick: () => itemSheet(it, ctx).then((ok) => ok && after()) }, it.title),
      h('div.wk-sub', bits),
      it.note ? h('p.wk-note', it.note) : null,
      runLine(it, ctx, after)),
    it.priority === 'high' ? h('span.badge.wk-high', 'High') : it.priority === 'low' ? h('span.badge.soft', 'Low') : null,
    canDoIt(it, ctx) && it.status !== 'doing' ? btn('icon small ghost.wk-doit', { icon: 'play', title: `Do it with a session: ${it.title}`, onclick: () => doItSheet(it).then((r) => r && after()) }) : null,
    btn('icon small ghost', { icon: 'more', title: `More for ${it.title}`, disabled: !it.editable, onclick: () => moreActions(it, ctx, after) }));
}

/**
 * Whether "Do it" is offered for item `it`: not closed, not in review (its answer waits for Accept or Send back), and no
 * session of this computer at work on it (a task left doing by a run that ended can be done again).
 */
export function canDoIt(it, ctx) {
  const run = ctx.runs && ctx.runs[it.id];
  if (!ctx.doIt || !it.editable || CLOSED.includes(it.status) || it.status === 'review') return false;
  return !(run && run.state === 'running' && run.here);
}

/**
 * What the line under a task says of its runs (runLine draws it): null, or one of
 *   working   a session of this computer works on it       elsewhere  one works on it on another computer
 *   review    its answer, with Accept and Send back          ended      it is doing, but no session works on it any more
 *   refused   the run's status could not be written: why     why        the last run ended without a result: why
 *   sentback  it is open again after a run that did it (sent back, or opened again by hand)
 */
export function runLineKind(it, run) {
  if (!run) return null;
  if (run.state === 'running') return run.here ? 'working' : 'elsewhere';
  if (it.status === 'review') return 'review';
  if (it.status === 'doing') return 'ended';
  if (run.statusError) return 'refused';
  if (['open', 'waiting'].includes(it.status) && run.state !== 'done' && run.reason) return 'why';
  if (it.status === 'open' && run.state === 'done') return 'sentback';
  return null;
}

/**
 * Under a task a session works on or has done: its session to open, or what it answered with Accept and Send back. A
 * run that ended without a result says why while the task is open again; a status that could not be written says why
 * whatever the status is, and a task left doing by a run that ended offers Do it again.
 */
function runLine(it, ctx, after) {
  const run = ctx.runs && ctx.runs[it.id];
  const kind = runLineKind(it, run);
  if (!kind) return null;
  const runs = h('button.wk-link', { type: 'button', onclick: () => runsSheet(it, after) }, 'Runs');
  const why = (text) => h('span.wk-runline-text.wk-runline-why', icon('alert', { size: 14 }), text);
  const warn = run.statusError ? why(run.statusError) : null;
  if (kind === 'working') {
    // (The line above says "A session works on it" already.)
    return h('div.wk-runline', openable(run) ? h('a.wk-link', { href: sessionLink(run.session) }, 'Open the session') : null, runs);
  }
  if (kind === 'elsewhere') return h('div.wk-runline', h('span.wk-runline-text', icon('cpu', { size: 14 }), 'A session works on it on another computer'), runs);
  if (kind === 'review') {
    return h('div.wk-runline.wk-runline-review',
      warn,
      run.answer ? h('p.wk-answer', run.answer) : null,
      h('div.wk-runline-actions',
        btn('small primary', { icon: 'check', label: 'Accept', onclick: () => accept(it, after) }),
        btn('small secondary', { icon: 'undo', label: 'Send back', onclick: () => sendBack(it, after) }),
        runs));
  }
  if (kind === 'ended') {
    return h('div.wk-runline', why('No session works on it any more: its last run ended'), warn,
      h('div.wk-runline-actions', canDoIt(it, ctx) ? btn('small secondary', { icon: 'play', label: 'Do it again', onclick: () => doItSheet(it).then((r) => r && after()) }) : null, runs));
  }
  if (kind === 'refused') return h('div.wk-runline', warn, runs);
  if (kind === 'why') return h('div.wk-runline', why(`Last run: ${run.reason}`), runs);
  return h('div.wk-runline', h('span.wk-runline-text', icon('undo', { size: 14 }), 'Open again after its last run'), runs);
}

// ---------- the sheet ----------

function segmented(label, options, value, onpick) {
  const buttons = options.map(([v, text]) => h('button.seg', { type: 'button', role: 'radio', dataset: { v }, onclick: () => {
    paint(v);
    onpick(v);
  } }, text));
  function paint(v) {
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.v === v));
  }
  paint(value);
  return h('div.segmented', { role: 'radiogroup', 'aria-label': label }, buttons);
}

/**
 * Add (`it` null) or change an item. ctx: { projects, today, project?: the filter's project for a new one }.
 * Resolves true when the server took it.
 */
export function itemSheet(it, ctx) {
  const v = {
    title: it ? it.title : '',
    date: it ? it.date || '' : '',
    project: it ? it.project || '' : ctx.project || '',
    priority: it ? it.priority : 'normal',
    by: it ? it.by : 'me',
    note: it ? it.note : '',
    status: it ? it.status : 'open',
  };
  return openSheet({ title: it ? 'Change the task' : 'Add a task' }, (close) => {
    const err = h('p.form-error', { role: 'alert' });
    const title = h('input.field', { value: v.title, autofocus: true, maxlength: 200, autocomplete: 'off', placeholder: 'What is to be done, in a few words', oninput: (e) => (v.title = e.target.value) });
    const date = h('input.field.wk-date', { type: 'date', value: v.date, oninput: (e) => (v.date = e.target.value) });
    const noDate = btn('small ghost', { label: 'No date', onclick: () => {
      date.value = '';
      v.date = '';
    } });
    const projects = [...new Set([...(ctx.projects || []), ...(v.project ? [v.project] : [])])];
    const project = h('select.field', { onchange: (e) => (v.project = e.target.value) },
      h('option', { value: '' }, 'No project'), projects.map((p) => h('option', { value: p, selected: p === v.project }, p)));
    const whoOptions = [['me', 'Me'], ['ai', 'The AI']];
    if (!['me', 'ai'].includes(v.by)) whoOptions.push([v.by, whoText(v.by)]);
    const status = it ? h('select.field', { onchange: (e) => (v.status = e.target.value) },
      Object.entries(STATUS_WORDS).map(([s, text]) => h('option', { value: s, selected: s === v.status }, text))) : null;
    const note = h('textarea.field', { rows: 3, maxlength: 2000, value: v.note, placeholder: 'Anything that helps: a link, a name, the next step', oninput: (e) => (v.note = e.target.value) });
    const submit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      const body = { title: v.title, date: v.date || null, project: v.project || null, priority: v.priority, by: v.by, note: v.note || null };
      if (it) {
        if (v.status !== it.status) body.status = v.status;
        // Only what changed: a planning tool's file keeps every untouched value exactly as it was.
        const was = { title: it.title, date: it.date, project: it.project, priority: it.priority, by: it.by, note: it.note || null };
        for (const k of Object.keys(was)) if (body[k] === was[k]) delete body[k];
        if (!Object.keys(body).length) return close(false);
      } else {
        if (!body.note) delete body.note;
        if (!body.project) delete body.project;
      }
      const b = e.submitter || null;
      if (b) b.disabled = true;
      try {
        await api(it ? `/api/work/items/${enc(it.id)}` : '/api/work/items', it ? { at: it.at, ...body } : body);
        toast(it ? 'Task changed' : 'Task added');
        close(true);
      } catch (x) {
        err.textContent = x.message;
      } finally {
        if (b) b.disabled = false;
      }
    };
    const row = (label, ...input) => h('div.fieldrow', h('span.field-label', label), ...input);
    return h('form.wk-form', { onsubmit: submit },
      h('label.fieldrow', h('span.field-label', 'Task'), title),
      h('div.wk-pair',
        row('Due', h('div.wk-dateline', date, noDate)),
        h('label.fieldrow', h('span.field-label', 'Project'), project)),
      h('div.wk-pair',
        row('Priority', segmented('Priority', [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']], v.priority, (x) => (v.priority = x))),
        row('Who does it', segmented('Who does it', whoOptions, v.by, (x) => (v.by = x)))),
      status ? h('label.fieldrow', h('span.field-label', 'Status'), status) : null,
      h('label.fieldrow', h('span.field-label', 'Note'), note),
      err,
      h('div.sheet-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'),
        h('button.btn.primary', { type: 'submit' }, it ? 'Save changes' : 'Add task')));
  }).then((x) => x === true);
}
