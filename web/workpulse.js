// Progress on the page (GET /api/work/progress, src/work/pulse.mjs): the same lines as `hoprig tasks progress`, read
// from the files and never told by a model. Today shows it first ("Progress": what runs, how far, the estimate with
// its basis, what waits for you, what finished and failed in the last 24 hours); a task's runs sheet shows that
// task's part. Every number on it is the server's: nothing is worked out here.
import { icon } from './icons.js';
import { api, fill, h } from './lib.js';
import { groupHead } from './shell.js';
import { store } from './store.js';

const enc = encodeURIComponent;
const STATE_ICON = { running: 'play', waiting: 'clock', done: 'check', failed: 'alert', stopped: 'alert', limit: 'alert' };

/**
 * A unit's title on its row. A session that is a chat of the App is named by the chat's title, as Home names it
 * (the server knows only its folder: "A session in shop"); a unit's id holds its conversation (src/work/pulse.mjs).
 */
export function unitTitle(u, sessions = store.all.flatMap((m) => m.sessions || [])) {
  if (u.type !== 'session' || typeof u.id !== 'string') return u.title;
  const conv = u.id.slice('session:'.length);
  const chat = conv && sessions.find((s) => s.kind === 'chat' && s.sessionId === conv && (s.display || s.title));
  return chat ? chat.display || chat.title : u.title;
}

const chatKey = () => JSON.stringify(store.all.flatMap((m) => m.sessions || []).filter((s) => s.kind === 'chat').map((s) => [s.sessionId, s.display || s.title]));

/** One unit as a row: its title and project, and what the server says of it. */
function unitRow(u, kind) {
  const steps = u.steps && u.steps.agents ? `Step ${u.steps.phase || 1} of ${u.steps.phases || 1} · ${u.steps.done} of ${u.steps.agents} agents done` : null;
  // A row without a basis says nothing of it: the one line under the count says it once (noEstimateLine).
  const est = kind === 'running' && !noBasis(u) ? (u.eta.past ? u.eta.text : `${u.eta.text} (${u.basis.text})`) : null;
  const sub = kind === 'running' ? [u.sinceText ? cap(u.sinceText) : 'Running', steps, est].filter(Boolean).join(' · ')
    : kind === 'waiting' ? (u.why === 'review' ? 'Finished: look at it and accept it' : 'Waits for your answer in its session')
      : kind === 'done' ? `Finished · used ${u.tokensText}`
        : `${cap(u.state === 'limit' ? 'hit a usage limit' : u.state)}${u.reason ? `: ${u.reason}` : ''}`;
  return h(`div.row.static.wk-pulse-row.wk-pulse-${kind}`,
    h('span.row-icon', icon(STATE_ICON[kind === 'waiting' ? 'waiting' : kind === 'failed' ? 'failed' : kind] || 'clock')),
    h('span.row-main', h('span.row-title', unitTitle(u), u.type === 'session' ? null : h('span.wk-pulse-project', ` · ${u.project}`)), h('span.row-sub', whole(sub))));
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const noBasis = (u) => !u.basis || u.basis.count < 2;

/** The one line under the count for the running ones without an estimate, or null when each has one. */
export function noEstimateLine(running) {
  const none = running.filter(noBasis).length;
  if (!none) return null;
  if (none === running.length) return `No estimate${none === 1 ? '' : 's'} yet: nothing like ${none === 1 ? 'it' : 'these'} has finished here.`;
  return `No estimate yet for ${none} of ${running.length}: nothing like ${none === 1 ? 'it' : 'them'} has finished here.`;
}
// "1 h 10" and "20 min" stay on one line on a phone.
const whole = (s) => s.replace(/(\d) (h|min)\b/g, '$1\u00a0$2').replace(/\bh (\d{2})\b/g, 'h\u00a0$1');

/** The parts of a progress, as sections of rows (running first). `fold`: done and failed folded in a details. */
export function progressParts(p, { title = 'Progress' } = {}) {
  const total = p.counts.running + p.counts.waiting + p.counts.done + p.counts.failed;
  const head = groupHead(title);
  const line = h('p.wk-pulse-line', { role: 'status' }, p.line);
  if (!total) return h('section.wk-section.wk-pulse', head, line);
  const none = noEstimateLine(p.running);
  const part = (label, list, kind) => (list.length ? h('div.wk-pulse-part', h('h3.wk-pulse-label', label), h('div.rows', list.map((u) => unitRow(u, kind)))) : null);
  const ended = p.done.length + p.failed.length;
  return h('section.wk-section.wk-pulse', head, line,
    none ? h('p.wk-pulse-none', none) : null,
    part('Running', p.running, 'running'),
    part('Waits for you', p.waiting, 'waiting'),
    ended ? h('details.wk-pulse-ended', h('summary', `Finished and failed in the last 24 hours (${ended})`),
      part('Done', p.done, 'done'), part('Failed or stopped', p.failed, 'failed')) : null);
}

/** What runs now: one group of rows, nothing at all when nothing runs (Activity's top). */
export function runningNow(p) {
  if (!p || !p.running.length) return null;
  const none = noEstimateLine(p.running);
  return h('section.wk-section.wk-pulse', groupHead('Running now', p.running.length),
    h('div.rows', p.running.map((u) => unitRow(u, 'running'))),
    none ? h('p.wk-pulse-none', none) : null);
}

/** Activity's "Running now" into `slot` (drawn again on each look of the page). → the progress, or null. */
export async function paintRunning(slot) {
  try {
    const p = await api('/api/work/progress');
    fill(slot, runningNow(p));
    // A chat's row takes its title from the store (unitTitle), which may answer after the progress: drawn again when
    // the chats' titles change, until the slot leaves the page.
    let seen = chatKey();
    if (slot.offRunning) slot.offRunning(); // one listener per slot, however often the page is drawn
    const off = store.subscribe(() => {
      if (slot.isConnected === false) return off();
      const now = chatKey();
      if (now === seen) return;
      seen = now;
      fill(slot, runningNow(p));
    });
    slot.offRunning = off;
    return p;
  } catch {
    fill(slot); // the rest stands without it
    return null;
  }
}

/** A task's own progress, for its runs sheet: only when something of it runs or waits. */
export async function taskProgress(slot, id) {
  try {
    const p = await api(`/api/work/progress?item=${enc(id)}`);
    if (p.counts.running || p.counts.waiting) fill(slot, progressParts(p, { title: 'Now' }));
  } catch {
    /* the runs below stand without it */
  }
}
