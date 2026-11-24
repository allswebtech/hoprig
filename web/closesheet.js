// "End them…" beside Home's fold (home.js, homefold.js): one sheet that names each session that has waited for more
// than 6 hours, a tick each (all ticked), and ONE button with the number. Nothing ends by itself: only his press.
// The press reads the sessions again right before each end and ends a ticked one only while it is still as the sheet
// showed it, through the route a single session's End session uses (POST /api/sessions/<name>/kill, web/session.js),
// on its own computer. One that works again, has a card, runs a background command or changed its state time is left
// open and named.
import { api, at, fill, h, openSheet, stateOf, toast } from './lib.js';
import { hasCard, runsInBackground, waitedFor, waitedSince } from './homefold.js';

// The same act as End session in a session's menu, said in the words of its own question (web/session.js): no menu
// and no "program" a person may not know.
export const END_TEXT = 'This ends each session: everything running in it stops. Its conversation is kept, and you can continue it from the project\'s page.';
export const endLabel = (n) => `End ${n} session${n === 1 ? '' : 's'}`;
const nameOf = (s) => s.display || s.name;
const keyOf = (s) => `${s.machine ?? '~'}/${s.name}`;
// The App's chats end in the App, not through a terminal session's route: they are not in this sheet.
export const closable = (s) => Boolean(s) && s.kind !== 'chat' && typeof s.name === 'string' && s.name !== '';

/** Why `now` (read again at the press) is no longer the session `was` the sheet showed; null when it still is. */
export function changedSince(was, now) {
  if (!now) return 'it has ended already';
  const key = stateOf(now).key;
  if (key === 'attention' || key === 'limit' || key === 'failed') return 'it needs you now';
  if (key !== 'waiting' && key !== 'ended') return 'it started working again';
  if (hasCard(now)) return 'it has a question for you';
  if (runsInBackground(now)) return 'a command of it still runs in the background';
  if (waitedSince(now) !== waitedSince(was)) return 'it changed since the list was shown';
  return null;
}

/** Every session as read now: key → session, and the computers that did not answer. */
async function readAgain(read) {
  const machines = (await read()).machines || [];
  const byKey = new Map();
  const silent = new Set();
  for (const m of machines) {
    const machine = m.machine ?? null;
    if (m.status && m.status !== 'online') silent.add(machine ?? '~');
    for (const s of m.sessions || []) byKey.set(keyOf({ ...s, machine }), { ...s, machine });
  }
  return { byKey, silent };
}

/**
 * The press: ends each of `ticked` that is still as it was. `read()` answers like GET /api/machines/sessions, `kill(s)`
 * ends one. Returns { ended, left: [{ s, why }], failed: [{ s, why }] }.
 */
export async function closeWaited(ticked, { read = () => api('~/api/machines/sessions'), kill = (s) => api(at(s.machine, `/api/sessions/${encodeURIComponent(s.name)}/kill`), {}) } = {}) {
  const out = { ended: [], left: [], failed: [] };
  for (const s of ticked) {
    // Read again right before each end, not once before all of them: the ends go one after another, some to a slow
    // computer over a relay, and a session that works again or gets a card meanwhile is left, never ended as it was.
    let now;
    try {
      now = await readAgain(read);
    } catch (e) {
      out.failed.push({ s, why: e.message || 'the sessions could not be read again' });
      continue;
    }
    if (now.silent.has(s.machine ?? '~')) {
      out.left.push({ s, why: 'its computer does not answer' });
      continue;
    }
    const why = changedSince(s, now.byKey.get(keyOf(s)));
    if (why) {
      out.left.push({ s, why });
      continue;
    }
    try {
      await kill(s);
      out.ended.push(s);
    } catch (e) {
      out.failed.push({ s, why: e.message || 'it could not be ended' });
    }
  }
  return out;
}

/** The result in plain words: one line each for ended, left open and not ended. */
export function resultLines({ ended, left, failed }) {
  const lines = [];
  if (ended.length) lines.push(`Ended ${ended.length} session${ended.length === 1 ? '' : 's'}.`);
  if (left.length) lines.push(`Left open: ${left.map(({ s, why }) => `${nameOf(s)} (${why})`).join(', ')}.`);
  if (failed.length) lines.push(`Not ended: ${failed.map(({ s, why }) => `${nameOf(s)} (${why})`).join(', ')}.`);
  if (!lines.length) lines.push('Nothing was ended.');
  return lines;
}

/**
 * The sheet's content for `list`: { el, press, tick(s, on) }. `press` ends the ticked ones once: pressed again (a
 * double tap, Enter twice) it gives back the same run, so no session is sent two ends. `done(result)` runs after it.
 */
export function closeSheetBody(list, { read, kill, done = () => {}, close = () => {}, now = Date.now() } = {}) {
  const ticked = new Set(list.map(keyOf));
  const go = h('button.btn.danger', { type: 'button', onclick: () => press() }, endLabel(list.length));
  const count = () => {
    go.textContent = endLabel(ticked.size);
    go.disabled = ticked.size === 0;
  };
  const tick = (s, on) => {
    if (on) ticked.add(keyOf(s));
    else ticked.delete(keyOf(s));
    count();
  };
  const boxes = [];
  const rows = list.map((s) => {
    const box = h('input', { type: 'checkbox', checked: true, 'aria-label': `End ${nameOf(s)}`, onchange: (e) => tick(s, e.target.checked) });
    boxes.push(box);
    const where = [s.machineLabel, waitedFor(s, now) ? `waited ${waitedFor(s, now)}` : null].filter(Boolean).join(' · ');
    return h('label.close-row', box, h('span.close-row-main', h('span.close-row-title', nameOf(s)), where ? h('span.close-row-sub', where) : null));
  });
  const cancel = h('button.btn.secondary', { type: 'button', autofocus: true, onclick: () => close(null) }, 'Cancel');
  const el = h('div.close-sheet', h('p.sheet-text', END_TEXT), h('div.close-list', rows), h('div.sheet-actions', cancel, go));
  let run = null;
  const press = () => {
    if (run) return run;
    go.disabled = true;
    cancel.disabled = true;
    for (const b of boxes) b.disabled = true;
    const chosen = list.filter((s) => ticked.has(keyOf(s)));
    run = closeWaited(chosen, { ...(read ? { read } : {}), ...(kill ? { kill } : {}) }).then((result) => {
      done(result);
      return result;
    });
    return run;
  };
  return { el, press, tick };
}

/**
 * Where the result is said, once: in the sheet while it is open (`open()`), drawn by `show(lines)`; a toast only when he
 * closed the sheet before the press ended, so nothing is said twice and no toast covers the page head over the sheet.
 */
export function sayResult(result, { open, show, say = toast }) {
  const lines = resultLines(result);
  if (open()) show(lines);
  else say(lines.join(' '), { kind: result.failed.length ? 'error' : 'info', ms: 6000 });
  return lines;
}

/** The sheet's title once the press has ended its sessions. */
export const AFTER_TITLE = 'Sessions that had waited';
/** The subtitle under it then: the same fact, in the past as the title. */
export const AFTER_SUBTITLE = 'They had waited for more than 6 hours.';

/** Open the sheet for `list` (Home's fold). `after()` runs once the press has ended its sessions (a fresh poll). */
export function openCloseSheet(list, { after = () => {} } = {}) {
  const sessions = list.filter(closable);
  if (!sessions.length) return Promise.resolve(null);
  let open = true;
  const shown = openSheet({ title: 'End the sessions that have waited?', subtitle: 'They have waited for more than 6 hours.' }, (close) => {
    const body = closeSheetBody(sessions, {
      close,
      done: (result) => {
        sayResult(result, { open: () => open, show: (lines) => {
          // The question is answered: the title says what the sheet shows now.
          const sheet = typeof body.el.closest === 'function' ? body.el.closest('dialog') : null;
          const title = sheet ? sheet.querySelector('.sheet-title') : null;
          if (title) title.textContent = AFTER_TITLE;
          const sub = sheet ? sheet.querySelector('.sheet-sub') : null;
          if (sub) sub.textContent = AFTER_SUBTITLE;
          fill(body.el,
            h('div.close-result', { role: 'status' }, lines.map((l) => h('p.sheet-text', l))),
            h('div.sheet-actions', h('button.btn.primary', { type: 'button', autofocus: true, onclick: () => close(result) }, 'Done')));
          const ok = body.el.querySelector('[autofocus]');
          if (ok) ok.focus();
        } });
        after(result);
      },
    });
    return body.el;
  });
  shown.then(() => (open = false));
  return shown;
}
