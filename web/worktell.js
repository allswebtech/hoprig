// Settings → Notifications, what Work tells by itself (src/work/tellsettings.mjs): the four things and the digest in
// the one "Tell me when" list, each off until you turn it on, the quiet hours, and under "More" the minutes and hours
// and "Tia writes my digest". All of it is kept by the page's one Save, with the push address. The defaults are shown
// as they are; nothing here is on after an update.
import { fill, h } from './lib.js';
import { field, toggle } from './shell.js';

export const TELL_DEFAULTS = { finished: false, live: false, failed: false, waits: false, waitsMinutes: 15, digest: false, digestHours: 4, gapMinutes: 10, quietFrom: '', quietTo: '', tiaWords: false };
const ITEMS = [
  ['finished', 'Something finished and waits for your look', 'A session did a task: look at it and accept it.'],
  ['live', 'Something you accepted is done', 'Once, when you accept a task a session did here.'],
  ['failed', 'Something failed or stopped', 'With the reason in the coding tool\'s own words, cut short.'],
  ['waits', 'A session waits for your answer', { line: 'When it has waited longer than the minutes set under More.', more: 'Not held back by the gap.' }],
  ['digest', 'A digest while work runs', { line: 'What finished, what runs and when it will be done, what waits for you, what it used.', more: 'Never one with nothing new.' }],
];

/**
 * The notice for a teller that cannot keep its record (GET /api/work/tell): nothing can be told then, and he should
 * know. `s`: { ok } or { ok: false, since, error }. → an element, or null.
 */
export function tellNotice(s) {
  if (!s || s.ok !== false) return null;
  return h('p.banner.warn', { role: 'status' }, h('span', 'Work cannot keep its record of what it told you, so it tells you nothing now. The dashboard\'s state folder needs to be writable again.'));
}

/**
 * The pieces of the page. `st.work` holds the choices (only what differs from the defaults is saved; the page's Save
 * keeps them with the push address). → { notice, items (check boxes for the "Tell me when" list), quiet (a field),
 * more (the minutes, the hours and the digest's words) }.
 */
export function workTellParts(st, { status = null } = {}) {
  const w = () => ({ ...TELL_DEFAULTS, ...st.work });
  const set = (k, v) => {
    const next = { ...st.work, [k]: v };
    if (v === TELL_DEFAULTS[k]) delete next[k];
    st.work = next;
  };
  // Whether it can tell at all: filled in when the dashboard answers (a failed look says nothing here).
  const notice = h('div.wk-tell-notice');
  if (status) Promise.resolve().then(status).then((s) => fill(notice, tellNotice(s)), () => {});
  const num = (k, label, min, max, hint) => field(label, h('input.field.wk-tell-num', { type: 'number', min, max, step: 1, value: w()[k], inputmode: 'numeric',
    oninput: (e) => {
      const n = Number(e.target.value);
      if (Number.isInteger(n) && n >= min && n <= max) set(k, n);
    } }), hint);
  const time = (k, label) => h('label.wk-tell-time', h('span', label), h('input.field', { type: 'time', value: w()[k], onchange: (e) => set(k, e.target.value) }));
  return {
    notice,
    // The chips of the list are short; what each one means is its tooltip.
    items: ITEMS.map(([k, label, hint]) => h('label.check', { title: typeof hint === 'string' ? hint : hint.line },
      h('input', { type: 'checkbox', checked: w()[k], 'data-key': `work-${k}`, onchange: (e) => set(k, e.target.checked) }),
      h('span', label))),
    quiet: field('Quiet hours', h('div.wk-tell-quiet', time('quietFrom', 'From'), time('quietTo', 'to')),
      'Nothing is sent then; what happened goes as one message when they end. Empty: none.'),
    more: [
      h('div.wk-tell-nums',
        num('waitsMinutes', 'Waits for your answer after', 1, 1440, 'Minutes (15 at first).'),
        num('digestHours', 'A digest every', 1, 24, 'Hours, while work runs (4 at first).'),
        num('gapMinutes', 'At most one message in', 0, 240, 'Minutes (10 at first); what comes meanwhile goes as one message.')),
      toggle('Tia writes my digest', w().tiaWords, (v) => {
        set('tiaWords', v);
        return false; // kept by the page's Save
      }, { line: 'Tia writes the digest in your language, with one short call on her provider (it costs a little).',
        more: 'She uses the language you write to her in. On a provider billed by use she words it only inside your daily limit for paid use (Settings → Tia); with no limit set, or none left today, the plain digest goes. Every number and name in it is put in by the dashboard, never by her. Off: plain English, and no provider is asked.' }),
    ],
  };
}
