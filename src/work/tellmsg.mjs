// The words of what Work tells the owner by itself (tell.mjs), made by code from templates. Each message fits a
// phone's lock screen: a title of at most TITLE_MAX characters that says what happened, and a body whose first line
// (at most LINE_MAX) says what he can do. No path and no session text: only a task's title, a project's name and, for
// a failure, the tool's own words cut to WHY_MAX.
//
// The digest is made as a TEMPLATE with placeholders ({n1}, {n2}, …) for every number and name, and its values: the
// plain digest is the template filled in. Tia may word the template in his language (tellwords.mjs); the values are
// put in by code after her words, so no number of hers ever reaches him.
import { MESSAGE_MAX } from '../server/notify.mjs';
import { clockText } from './estimate.mjs';
import { shortWords } from './pulse.mjs';

export const TITLE_MAX = 50;
export const LINE_MAX = 90;
export const WHY_MAX = 80;
export const PLACEHOLDER = /\{n\d{1,2}\}/g;

const fit = (s, max) => shortWords(s, max);
/** The tool's own words of a failure, without the product's own lead-in, cut to WHY_MAX. */
export const whyOf = (reason) => {
  const w = fit(String(reason || '').replace(/^The run ended in an error: /, '').replace(/^The run did not start: /, ''), WHY_MAX);
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const FAILED_WORD = { stopped: 'Stopped', limit: 'Hit a usage limit', failed: 'Failed' };

/** One event as a message: { title, body }. ev: { what, title, project, state, reason, minutes }. */
export function oneMessage(ev) {
  if (ev.what === 'finished' && ev.schedule) return { title: fit(`Done: ${ev.title}`, TITLE_MAX), body: 'Open Work → Activity to look at what it did.' };
  if (ev.what === 'finished') return { title: fit(`Done: ${ev.title}`, TITLE_MAX), body: 'Open Work → Today to look at it and accept it.' };
  if (ev.what === 'live') return { title: fit(`Accepted: ${ev.title}`, TITLE_MAX), body: 'Nothing to do. It is in Work → Done lately.' };
  if (ev.what === 'failed') {
    const why = whyOf(ev.reason);
    return { title: fit(`${FAILED_WORD[ev.state] || 'Failed'}: ${ev.title}`, TITLE_MAX), body: `Open Work → Activity to see why.${why ? `\n${why}` : ''}` };
  }
  // The project's name is shortened, not the sentence: what happened stays on the lock screen.
  return { title: `A session in ${fit(ev.project, TITLE_MAX - 'A session in  waits for you'.length)} waits for you`, body: `Open it on the dashboard and answer (waiting ${ev.minutes} min).` };
}

/** "a, b and 3 more", as long as fits in `max`. */
export function namesText(names, max = LINE_MAX) {
  const list = names.map((x) => fit(x, 40));
  for (let k = list.length; k >= 1; k--) {
    const rest = list.length - k;
    const shown = list.slice(0, k);
    const s = rest ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
    if (s.length <= max) return s;
  }
  return `${list.length} of them`;
}

/** Several held events as ONE message ("3 done, 1 failed: a, b and 2 more"); `off`: they happened while the dashboard was off. */
export function groupMessage(evs, { off = false } = {}) {
  if (evs.length === 1 && !off) return oneMessage(evs[0]);
  const n = (w) => evs.filter((e) => e.what === w).length;
  // A run stopped at its time limit did not fail: the title says which, so a short title stays true.
  const failedOnly = evs.filter((e) => e.what === 'failed' && e.state !== 'stopped').length;
  const stopped = evs.filter((e) => e.what === 'failed' && e.state === 'stopped').length;
  const parts = [[n('finished'), 'done'], [failedOnly, 'failed'], [stopped, 'stopped'], [n('live'), 'accepted'], [n('waits'), n('waits') === 1 ? 'waits for you' : 'wait for you']]
    .filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
  const head = parts.join(', ');
  const title = off && `While it was off: ${head}`.length <= TITLE_MAX ? `While it was off: ${head}` : fit(head, TITLE_MAX);
  const today = evs.some((e) => (e.what === 'finished' && !e.schedule) || e.what === 'waits');
  const todo = today ? 'Open Work → Today to look at them.' : n('finished') ? 'Open Work → Activity to look at them.' : n('failed') ? 'Open Work → Activity to see why.' : 'Nothing to do. Work → Done lately has them.';
  // Each name once, in the order first told, with how often when it came more than once (a schedule that ran twice).
  const seen = new Map();
  for (const e of evs) {
    const k = e.what === 'waits' ? `a session in ${fit(e.project, 27)}` : e.title;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return { title, body: `${todo}\n${namesText([...seen].map(([k, n]) => (n > 1 ? `${k} (${n}×)` : k)))}` };
}

/**
 * The digest as a template and its values. d: { done, failed, running, waiting (progress units), tokens, unreported,
 * tz }. → { title, lines: [what he can do, …], values: { n1: '3', … } } with {nK} in title and lines. The body filled
 * in fits in MESSAGE_MAX (what the push channel keeps): running ones are named fewer, and counted, until it fits.
 */
export function digestTemplate(d) {
  for (let shown = Math.min(3, d.running.length); shown >= 0; shown--) {
    const t = digestOf(d, shown);
    if (shown === 0 || digestMessage(t).body.length <= MESSAGE_MAX) return t;
  }
  return digestOf(d, 0);
}

function digestOf(d, shown) {
  const values = {};
  let k = 0;
  const v = (x) => {
    k += 1;
    values[`n${k}`] = String(x);
    return `{n${k}}`;
  };
  // The title says what matters now (what waits for him, what runs); what finished is in the lines, with its count.
  const head = [];
  if (d.waiting.length) head.push(`${v(d.waiting.length)} ${d.waiting.length === 1 ? 'waits' : 'wait'} for you`);
  if (d.running.length) head.push(`${v(d.running.length)} running`);
  if (!head.length && d.done.length) head.push(`${v(d.done.length)} done`);
  if (!head.length && d.failed.length) head.push(`${v(d.failed.length)} failed`);
  const title = `Work: ${head.join(', ')}`;
  // The screen's name is a value too: a wording in his language must not rename a page the dashboard does not have.
  const lines = [d.waiting.length ? `Open ${v('Work → Today')} to look at what waits for you.` : `Nothing waits for you. ${v('Work → Today')} has the rest.`];
  for (const u of d.running.slice(0, shown)) {
    const name = v(fit(u.title, 30));
    if (u.basis.count < 2) lines.push(`Running: ${name}, no estimate yet`);
    else if (u.eta.past) lines.push(`Running: ${name}, longer than any like it`);
    else lines.push(`Running: ${name}, done by about ${v(clockText(Date.parse(u.eta.doneFrom), d.tz))} to ${v(clockText(Date.parse(u.eta.doneTo), d.tz))} (from ${v(u.basis.count)} like it)`);
  }
  if (d.running.length > shown) lines.push(shown ? `And ${v(d.running.length - shown)} more running` : `${v(d.running.length)} running: ${v('Work → Today')} names them`);
  if (d.done.length) lines.push(`Done (${v(d.done.length)}): ${v(namesText(d.done.map((u) => u.title), 60))}`);
  if (d.failed.length) lines.push(`Failed or stopped (${v(d.failed.length)}): ${v(namesText(d.failed.map((u) => u.title), 50))}`);
  if (d.tokens !== null) lines.push(`Used: ${v(d.tokens.toLocaleString('en-US'))} tokens${d.unreported ? ` (${v(d.unreported)} did not report)` : ''}`);
  else if (d.unreported) lines.push('Used: not reported');
  return { title, lines, values };
}

/** A template filled in with its values. */
export const fill = (s, values) => s.replace(PLACEHOLDER, (m) => values[m.slice(1, -1)] ?? m);

/** The plain digest message: { title, body }. */
export function digestMessage(t) {
  return { title: fit(fill(t.title, t.values), TITLE_MAX), body: t.lines.map((l) => fill(l, t.values)).join('\n') };
}
