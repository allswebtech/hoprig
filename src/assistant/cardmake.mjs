// The cards her tools' results carry (cardkinds.mjs has the kinds): made here, by code, from what the tool did and
// read, never from her words. Each builder gets the tool's name, its checked input and its result, and returns
// { kind, fields, hidden? } or null (the result stays plain text). `hidden` is what only the server keeps for the card
// (the undo record a result card offers). The dynamic kinds (status, progress, needs) carry their SUBJECT, and the
// same functions build their fields again from the subject as it is now (core.mjs refreshViews).
import { shortText } from './cardkinds.mjs';
import { LOCAL } from './shown.mjs';

const SESSION_STATE = { needs_ok: 'asks', working: 'working', starting: 'starting', waiting: 'waiting', limit: 'limit', ended: 'ended', shell: 'shell' };
const at = (computer, hash) => (computer && computer !== LOCAL ? `#/m/${computer}${hash.slice(1)}` : hash);
const ms = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? Math.floor(t) : undefined;
};
const sessionHref = (s) => at(s.computer, /^chat:/.test(s.session) ? `#/chat/${s.session.slice(5)}` : `#/s/${encodeURIComponent(s.session)}`);
const lastPart = (f) => String(f || '').split(/[\\/]/).filter(Boolean).pop() || '';

/** A row's second line, "<folder> · <computer>": left out where it would only say the first line again. */
function rowSub(title, s, computer) {
  const folder = lastPart(s.folder);
  const sub = shortText([folder !== title ? folder : '', computer].filter(Boolean).join(' · '), 120);
  return sub && sub !== title ? { sub } : {};
}

/** A session (as list_sessions and read_session show it) → a status card's fields. */
export function sessionStatus(s, now) {
  const state = SESSION_STATE[s.status] || 'unknown';
  const title = shortText(s.title || lastPart(s.folder) || s.session, 120) || 'A session';
  const note = state === 'asks' && s.asks ? shortText(s.asks, 200) : state === 'limit' ? 'Stopped at a usage limit.' : s.last_message ? shortText(s.last_message, 200) : undefined;
  return {
    subject: { type: 'session', computer: s.computer || LOCAL, id: s.session, ...(ms(s.created) ? { created: ms(s.created) } : {}), ...(typeof s.term === 'string' && s.term ? { term: s.term.slice(0, 40) } : {}) },
    title, state,
    ...(Number.isInteger(s.minutes_in_state) ? { since: Math.floor(now - s.minutes_in_state * 60_000) } : {}),
    ...(note ? { note } : {}),
    step: { label: state === 'asks' ? 'Answer it' : 'Open the session', href: sessionHref(s) },
  };
}

const JOB_STEPS = ['Session started', 'Working on it', 'Checked', 'Told you'];
/** One of her jobs → a progress card's fields (the time so far from its start; no estimate: none is measured). */
export function jobProgress(j) {
  const ended = ['done', 'stuck', 'stopped'].includes(j.state);
  const anyEnded = (j.sessions || []).some((e) => e.ended);
  const done = j.state === 'done' ? 4 : j.state === 'waiting' ? 2 : anyEnded ? 2 : (j.sessions || []).length ? 1 : 0;
  return {
    subject: { type: 'job', computer: LOCAL, id: j.id },
    title: shortText(j.goal, 160) || 'A job', steps: JOB_STEPS, done, state: j.state,
    ...(ms(j.createdAt) ? { started: ms(j.createdAt) } : {}),
    ...(ended && ms(j.updatedAt) ? { ended: ms(j.updatedAt) } : {}),
    step: { label: 'Open the jobs', href: '#/tia/jobs' },
  };
}

// The last step names what comes, not a state: a run's record does not say whether he reviewed it since, and an ended
// run's card is not read again (web/tiacards.js), so it never claims a review that may be over.
const RUN_STEPS = ['Brief written', 'Session started', 'Working on it', 'Your review'];
const RUN_STATE = { running: 'working', done: 'done', failed: 'failed', limit: 'limit', stopped: 'stopped' };
/** A Work run (as the runs route gives it) → a progress card's fields. */
export function runProgress(r, computer = LOCAL) {
  // A state this code does not know is not known: never drawn as 'Working'.
  const state = RUN_STATE[r.state] || 'unknown';
  return {
    subject: { type: 'run', computer, id: String(r.id) },
    // The task by its title, as Work shows it (its id only when the run has none).
    title: shortText(r.title ? `Task: ${r.title}` : `Task ${r.item || ''}`, 160), steps: RUN_STEPS, done: r.state === 'running' ? 2 : r.state === 'done' ? 3 : 2, state,
    ...(ms(r.startedAt) ? { started: ms(r.startedAt) } : {}),
    ...(r.state !== 'running' && ms(r.endedAt) ? { ended: ms(r.endedAt) } : {}),
    step: { label: 'Open Work', href: at(computer, '#/work') },
  };
}

/** A computer of the hub list → a status card's fields. */
export function computerStatus(m) {
  return {
    subject: { type: 'computer', computer: m.computer, id: m.computer },
    title: shortText(m.label || m.computer, 120), state: m.online ? 'online' : 'offline',
    step: { label: 'Open the computer', href: at(m.computer, '#/computer') },
  };
}

/** Attention items (raw, with rev and acts) and the act catalog → a needs card's items. */
export function needsItems(items, acts = {}) {
  return items.slice(0, 3).map((it) => {
    const rec = it.acts.find((a) => a.id === it.recommended) || it.acts[0];
    const c = acts[rec.id] || {};
    return {
      id: it.id, rev: it.rev, subject: shortText(it.subject, 80), kind: it.kind,
      facts: (it.facts || []).slice(0, 4).map((f) => shortText(f, 100)).filter(Boolean),
      ...(it.why ? { why: shortText(it.why, 160) } : {}),
      ...(it.since ? { since: String(it.since).slice(0, 30) } : {}),
      act: { id: rec.id, label: shortText(rec.label || c.label || rec.id, 40), ...(c.risk ? { risk: c.risk } : {}), ...(rec.href ? { href: rec.href } : {}) },
    };
  });
}

const words = (s) => String(s).replace(/[/_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const taskLine = (d) => shortText(d.title || d.task || '', 120);

function workCard(a, result, ctx) {
  const d = result.data || {};
  const c = a.computer || LOCAL;
  const tasks = (list) => list.slice(0, 8).map((x) => ({ label: taskLine(x) || 'A task', ...(x.why || x.date ? { sub: shortText(x.why || `Due ${x.date}`, 120) } : {}), href: at(c, '#/work/tasks') }));
  switch (a.action) {
    case 'today': {
      const all = [...(d.needs_you || []), ...(d.to_review || [])];
      if (!all.length) return null;
      return { kind: 'list', fields: { title: 'Work that needs you', items: tasks(all), total: all.length, all: { label: 'Show all', href: at(c, '#/work') } } };
    }
    case 'list':
      if (!(d.tasks || []).length) return null;
      return { kind: 'list', fields: { title: 'Tasks', items: tasks(d.tasks), total: d.tasks.length + (d.more || 0), all: { label: 'Show all', href: at(c, '#/work/tasks') } } };
    case 'run':
      return d.run ? { kind: 'progress', fields: runProgress({ id: d.run, item: d.task, title: result.cardData && result.cardData.title, state: d.state, startedAt: d.started, endedAt: d.ended }, c) } : null;
    case 'add': case 'edit': case 'done': case 'reopen': {
      // Undo takes back her last act of this conversation: the card offers it for the act it is about, and only while
      // that act is still the last one (core.mjs undoView).
      const top = ctx.undoTop();
      const undo = top && top !== ctx.undoBefore ? top : null;
      const what = { add: 'Added the task', edit: 'Changed the task', done: 'Marked done', reopen: 'Opened again' }[a.action];
      const changed = a.action === 'edit' ? Object.keys(a).filter((k) => ['title', 'date', 'project', 'by', 'note'].includes(k)).map((k) => `${words(k)} changed`) : d.status ? [`Status: ${d.status}`] : [];
      return { kind: 'result', fields: { ok: true, title: shortText(`${what}: ${taskLine(d) || a.task || ''}`, 160), changed: changed.slice(0, 6), see: { label: 'Open Work', href: at(c, '#/work/tasks') }, ...(undo ? { undo: true } : {}) }, hidden: undo ? { undo } : {} };
    }
    case 'undo':
      return { kind: 'result', fields: { ok: true, title: shortText(`Taken back: ${d.task || 'the last change'}`, 160), changed: [], see: { label: 'Open Work', href: at(c, '#/work/tasks') } } };
    case 'start':
      return d.run ? { kind: 'progress', fields: runProgress({ id: d.run, item: d.task, title: result.cardData && result.cardData.title, state: d.state || 'running', startedAt: d.started }, c) } : null;
    case 'accept': case 'send_back': case 'drop': case 'remove':
      return { kind: 'result', fields: { ok: true, title: shortText(`${{ accept: 'Accepted', send_back: 'Sent back', drop: 'Dropped', remove: 'Removed' }[a.action]}: ${a.task || ''}`, 160), changed: d.status ? [`Status: ${d.status}`] : [], see: { label: 'Open Work', href: at(c, '#/work/tasks') } } };
    default:
      return null;
  }
}

function computerCard(a, result, now) {
  const d = result.data || {};
  if (a.providers) {
    const rows = [];
    for (const p of d.accounts || []) {
      const name = shortText(p.label || p.account, 40);
      if (p.usage && p.usage.fiveHour && Number.isFinite(p.usage.fiveHour.pct)) rows.push({ label: `${name}: 5-hour limit`, value: p.usage.fiveHour.pct, unit: '%', of: 100, ...(p.limited ? { note: 'At its limit now' } : {}) });
      if (p.usage && p.usage.week && Number.isFinite(p.usage.week.pct)) rows.push({ label: `${name}: weekly limit`, value: p.usage.week.pct, unit: '%', of: 100 });
      if (!p.usage) rows.push({ label: name, value: p.in_use || 0, unit: 'sessions', ...(p.limited ? { note: 'At its limit now' } : {}) });
    }
    return rows.length ? { kind: 'numbers', fields: { title: 'Providers: what is used', rows: rows.slice(0, 8), asOf: Math.floor(now) } } : null;
  }
  if (a.setup) {
    const bad = (d.checks || []).filter((x) => !['ok', 'info', 'skip'].includes(x.status));
    return { kind: 'list', fields: { title: bad.length ? 'Setup: what is missing' : 'Setup: all good', items: bad.slice(0, 8).map((x) => ({ label: shortText(x.title || x.check, 120), ...(x.detail ? { sub: shortText(x.detail, 120) } : {}), href: at(a.computer, '#/computer/setup') })), total: bad.length, all: { label: 'Open the setup', href: at(a.computer, '#/computer/setup') } } };
  }
  if (a.coding_tools || a.settings) return null;
  if (!a.computer) {
    const list = d.computers || [];
    if (!list.length) return null;
    return { kind: 'list', fields: { title: 'Computers', items: list.slice(0, 8).map((m) => ({ label: shortText(m.label || m.computer, 120), state: m.online ? 'online' : 'offline', href: at(m.computer, '#/computer') })), total: list.length, all: { label: 'Show all', href: '#/computers' } } };
  }
  const rows = [];
  if (Array.isArray(d.load) && Number.isFinite(d.load[0])) rows.push({ label: 'Load', value: d.load[0], unit: 'load' });
  if (d.memory && Number.isFinite(d.memory.usedPct)) rows.push({ label: 'Memory used', value: d.memory.usedPct, unit: '%', of: 100 });
  for (const disk of (d.disks || []).slice(0, 4)) if (Number.isFinite(disk.usedPct)) rows.push({ label: shortText(`Disk ${disk.mount || ''}`, 60), value: disk.usedPct, unit: '%', of: 100 });
  return rows.length ? { kind: 'numbers', fields: { title: shortText(`This computer now: ${a.computer}`, 120), rows, asOf: Math.floor(now) } } : null;
}

/**
 * The card of one tool result, or null. ctx: { now, jobs, undoTop() (the newest undo record of this conversation),
 * undoBefore (the one before the call) }.
 */
export function cardOf(name, a, result, ctx) {
  const d = result.data || {};
  const now = ctx.now();
  switch (name) {
    case 'list_sessions': {
      const list = d.sessions || [];
      if (!list.length) return null;
      const labels = (result.cardData && result.cardData.labels) || {};
      // The computer only where the list holds more than one, by its label (never its inner id).
      const many = new Set(list.map((s) => s.computer)).size > 1;
      return { kind: 'list', fields: { title: 'Sessions', items: list.slice(0, 8).map((s) => { const st = sessionStatus(s, now); return { label: st.title, ...rowSub(st.title, s, many ? labels[s.computer] || (s.computer === LOCAL ? 'This computer' : 'Another computer') : '') , state: st.state, href: st.step.href }; }), total: list.length, all: { label: 'Show all', href: '#/' } } };
    }
    case 'read_session':
      return d.session ? { kind: 'status', fields: sessionStatus({ ...d.session, ...(result.cardData && result.cardData.asks ? { asks: result.cardData.asks } : {}), created: result.cardData && result.cardData.created, term: result.cardData && result.cardData.term }, now) } : null;
    case 'start_session': case 'start_chat': case 'watch_session': {
      const job = d.job ? ctx.jobs.get(d.job) : null;
      if (job) return { kind: 'progress', fields: jobProgress(job) };
      if (!d.session || d.existing || d.already_open) return null;
      return { kind: 'status', fields: sessionStatus({ session: d.session, computer: d.computer, status: 'starting', minutes_in_state: 0, title: lastPart(a.folder), created: result.cardData && result.cardData.created, term: result.cardData && result.cardData.term }, now) };
    }
    case 'finish_job': {
      const job = ctx.jobs.get(a.job);
      return { kind: 'result', fields: { ok: a.state === 'done', title: shortText(`${a.state === 'done' ? 'Done' : 'Stuck'}: ${job ? job.goal : a.job}`, 160), changed: [], see: { label: 'Open the jobs', href: '#/tia/jobs' } } };
    }
    case 'stop_session':
      return { kind: 'result', fields: { ok: true, title: shortText(`Stopped the session ${a.session}`, 160), changed: ['Its conversation is kept: you can continue it later.'], see: { label: 'Open Home', href: '#/' } } };
    case 'switch_account':
      return { kind: 'result', fields: { ok: true, title: shortText(`Moved the session ${a.session} to another provider`, 160), changed: [], see: { label: 'Open the session', href: sessionHref({ session: a.session, computer: a.computer || LOCAL }) } } };
    case 'get_computer_status':
      return computerCard(a, result, now);
    case 'read_attention': {
      const raw = result.cardData;
      if (!raw || !raw.items.length) return null;
      // The kind it was read with is kept for the card (core.mjs refreshViews reads it again with that kind).
      return { kind: 'needs', fields: { items: needsItems(raw.items, raw.acts), total: raw.total, all: { label: 'Show all', href: '#/operator' } }, hidden: { kind: a.kind && a.kind !== 'all' ? a.kind : null } };
    }
    case 'manage_work':
      return workCard(a, result, ctx);
    case 'open_screen':
      return d.link ? { kind: 'open', fields: { label: shortText(`Open ${String(a.screen).split('/').map(words).join(' → ')}`, 80), href: d.link } } : null;
    case 'notify_owner':
      return a.options ? { kind: 'choice', fields: { question: shortText(a.message, 300), options: a.options.map((o) => shortText(o, 60)), free: a.free === true } } : null;
    default:
      return null;
  }
}
