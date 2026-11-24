// The Operator page's "Computers" part: each computer of the hub with its room for new work (src/operator/rooms.mjs):
// reached or since when not, its load against its processors, its free memory, the room in one word with the why.
// Read when the page opens and on Refresh (GET /api/operator/rooms?look=1); the 15 s redraw reads only what is kept.
// The switch "Look at my other computers too" is the owner's (POST /api/operator/rooms/settings).
import { MACHINE_STATE, NOT_ONLINE, ago, api, btn, fill, h, machine, toast } from './lib.js';
import { clock } from './operator-decide.js';
import { toggle } from './shell.js';

const A = '/api/operator/rooms';
export const ROOM_WORDS = { free: 'Has room', busy: 'Busy', full: 'Full', unknown: 'Not known' };
export const LOOK_SENTENCE = 'Look at my other computers too';
export const LOOK_HINT = 'Off: they are read only when you open this page or press Refresh. On: the dashboard asks each one at most once a minute, and one that does not answer less often.';

/** What one computer's line says, in plain words: { word, head, numbers, why, since }. */
export function roomWords(c, now = Date.now()) {
  // A computer that answered and refused (not allowed any more, too old, its host key changed) is named by its state,
  // as the Computers page names it; only one that did not answer, or is not asked yet, is "Not known".
  const refusedWord = !c.here && !c.reached && c.state && c.state !== 'offline' && c.state !== 'online' ? MACHINE_STATE[c.state] : null;
  const word = refusedWord || ROOM_WORDS[c.room] || ROOM_WORDS.unknown;
  const numbers = c.cpus && c.load1 != null
    ? `load ${Number(c.load1).toFixed(1)} on ${c.cpus} CPU${c.cpus === 1 ? '' : 's'}${c.memFreePct != null ? `, ${c.memFreePct} % memory free` : ''}`
    : null;
  const seen = c.seenAt ? Date.parse(c.seenAt) : null;
  // The page's one clock (UTC, its zone named). A computer not asked yet is not called silent.
  const refused = c.state && c.state !== 'offline' && NOT_ONLINE[c.state] ? `${NOT_ONLINE[c.state]}.` : null;
  const since = c.here || c.reached ? null : c.asked === false ? 'Not asked yet.' : refused || (seen ? `Did not answer; last answered at ${clock(c.seenAt, now)} (${ago(seen)}).` : 'Did not answer when asked.');
  // roomOf's why starts with "It is full: …" or is a short clause ("it was not reached"): one sentence either way.
  const why = c.room === 'free' ? 'Has room for new work.' : c.room === 'unknown' ? `${cap(c.why || 'not known')}.` : c.why;
  return { word, head: c.label || c.name, numbers, why: since && c.room === 'unknown' ? null : why, since, at: now };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The line of "Start new work on <name> until this computer is calm" while it stands, in the page's one clock. */
export const heldWords = (e, now = Date.now()) => `Tia's new work starts on ${e.label} since ${clock(e.since, now)}, until this computer has been calm for 10 minutes (2 hours at most). Undo ends it at once.`;

function line(c) {
  const w = roomWords(c);
  return h(`li.op-room.op-room-${c.room}`, { 'data-computer': c.name },
    h('div.op-room-head', h('span.op-room-name', w.head), h(`span.op-room-word.op-room-${c.room}`, w.word)),
    w.numbers ? h('span.op-room-numbers', w.numbers) : null,
    w.why ? h('span.op-room-why', w.why) : null,
    w.since ? h('span.op-room-since', ...sinceParts(w.since)) : null);
}
// The step to add a computer again is a link to that step, this dashboard's own Computers page (errorways.js
// computer-not-allowed: perComputer false), with its words as they are.
const ADD_AGAIN = 'Computers → Add a computer';
export function sinceParts(text) {
  const at = text.indexOf(ADD_AGAIN);
  if (at < 0) return [text];
  return [text.slice(0, at), h('a', { href: '#/computers/add' }, ADD_AGAIN), text.slice(at + ADD_AGAIN.length)];
}

/** The part: draws into `box`; returns { load(look) } for the page's own redraw. */
export function roomsPart(box, { onread = () => {} } = {}) {
  const list = h('ul.op-rooms');
  const held = h('div.op-rooms-held');
  let lookOthers = false;
  let drawn = null;
  const refresh = btn('secondary small', { icon: 'refresh', label: 'Refresh', onclick: () => load(true).then(() => { onread(); toast('Read again'); }) });
  const sw = toggle(LOOK_SENTENCE, false, async (v) => {
    try {
      const r = await api(`${A}/settings`, { lookOthers: v });
      lookOthers = r.lookOthers === true;
      return true;
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
      sw.querySelector('input').checked = !v;
      return false;
    }
  }, machine.current ? 'Change this on that computer\'s own dashboard.' : LOOK_HINT);
  const input = sw.querySelector('input');
  input.setAttribute('aria-label', LOOK_SENTENCE);
  if (machine.current) input.disabled = true;
  fill(box, h('div.op-rooms-head', h('h2.op-h', 'Computers'), refresh), held, list, sw);
  // "Start new work on <name> until this computer is calm": what stands, since when, and its Undo.
  const drawHeld = (e) => fill(held, e ? h('p.op-hold', { role: 'status' },
    h('span', heldWords(e)),
    machine.current ? null : btn('secondary small', { label: 'Undo', onclick: async () => {
      try {
        await api(`${A}/elsewhere/end`, {});
        toast('Tia\'s new work starts here again.', { kind: 'ok' });
        drawn = null;
        await load();
        onread();
      } catch (er) {
        toast(er.message, { kind: 'error', ms: 6000 });
      }
    } })) : null);

  async function load(look = false) {
    let r;
    try {
      r = await api(`${A}${look ? '?look=1' : ''}`);
    } catch (e) {
      if (e.status === 404) return fill(box, h('h2.op-h', 'Computers'), h('p.hint', 'This computer runs an older version without the rooms of its computers.'));
      return fill(list, h('li.hint', e.message));
    }
    lookOthers = r.lookOthers === true;
    drawHeld(r.elsewhere || null);
    if (document.activeElement !== input) input.checked = lookOthers;
    const key = JSON.stringify(r.computers.map((c) => [c.name, c.room, c.why, c.load1, c.memFreePct, c.reached, c.seenAt]));
    if (key === drawn) return;
    drawn = key;
    fill(list, r.computers.length ? r.computers.map(line) : h('li.hint', 'Only this computer: add another under Computers.'));
  }
  return { load };
}
