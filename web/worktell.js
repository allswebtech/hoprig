// Settings → Notifications → "Work, by itself" (src/work/tellsettings.mjs): what Work tells you through the push
// address, each item off until you turn it on, the minutes and hours, quiet hours, and "Tia writes my digest". The
// defaults are shown as they are; nothing here is on after an update.
import { fill, h } from './lib.js';
import { field, panel, saveBar, toggle } from './shell.js';

export const TELL_DEFAULTS = { finished: false, live: false, failed: false, waits: false, waitsMinutes: 15, digest: false, digestHours: 4, gapMinutes: 10, quietFrom: '', quietTo: '', tiaWords: false };
const ITEMS = [
  ['finished', 'Something finished and waits for your look', 'A session did a task: look at it and accept it.'],
  ['live', 'Something you accepted is done', 'Once, when you accept a task a session did here.'],
  ['failed', 'Something failed or stopped', 'With the reason in the coding tool\'s own words, cut short.'],
  ['waits', 'A session waits for your answer', { line: 'When it has waited longer than the minutes below.', more: 'Not held back by the gap.' }],
  ['digest', 'A digest while work runs', { line: 'What finished, what runs and when it will be done, what waits for you, what it used.', more: 'Never one with nothing new.' }],
];

/**
 * The panel. `st.work` holds the choices (only what differs from the defaults is saved); `save()` keeps them with the
 * push address as it was saved (`st.savedUrl`). Without one, or with an address typed and not saved yet, a switch
 * says nothing (no "Saved"): its choice is kept by the Save of the push address above.
 */
/**
 * The notice for a teller that cannot keep its record (GET /api/work/tell): nothing can be told then, and he should
 * know. `s`: { ok } or { ok: false, since, error }. → an element, or null.
 */
export function tellNotice(s) {
  if (!s || s.ok !== false) return null;
  return h('p.banner.warn', { role: 'status' }, h('span', 'Work cannot keep its record of what it told you, so it tells you nothing now. The dashboard\'s state folder needs to be writable again.'));
}

export function workTellPanel(st, save, { status = null } = {}) {
  const now = async () => {
    if (!st.savedUrl || st.url !== st.savedUrl) return false;
    await save();
    return true;
  };
  const w = () => ({ ...TELL_DEFAULTS, ...st.work });
  const set = (k, v) => {
    const next = { ...st.work, [k]: v };
    if (v === TELL_DEFAULTS[k]) delete next[k];
    st.work = next;
  };
  const noPush = h('p.hint', 'These go to the push address above: set it and Save it first.');
  // Whether it can tell at all: filled in when the dashboard answers (a failed look says nothing here).
  const notice = h('div.wk-tell-notice');
  if (status) Promise.resolve().then(status).then((s) => fill(notice, tellNotice(s)), () => {});
  const num = (k, label, min, max, hint) => field(label, h('input.field.wk-tell-num', { type: 'number', min, max, step: 1, value: w()[k], inputmode: 'numeric',
    oninput: (e) => {
      const n = Number(e.target.value);
      if (Number.isInteger(n) && n >= min && n <= max) set(k, n);
    } }), hint);
  const time = (k, label) => h('label.wk-tell-time', h('span', label), h('input.field', { type: 'time', value: w()[k], onchange: (e) => set(k, e.target.value) }));
  return panel({ icon: 'tasks', title: 'Work, by itself', desc: 'What runs, finishes or waits for you is told on your phone without asking. Each is off until you turn it on.' },
    notice,
    st.savedUrl ? null : noPush,
    ITEMS.map(([k, label, hint]) => toggle(label, w()[k], (v) => {
      set(k, v);
      return now();
    }, hint)),
    h('div.wk-tell-nums',
      num('waitsMinutes', 'Waits for your answer after', 1, 1440, 'Minutes (15 at first).'),
      num('digestHours', 'A digest every', 1, 24, 'Hours, while work runs (4 at first).'),
      num('gapMinutes', 'At most one message in', 0, 240, 'Minutes (10 at first); what comes meanwhile goes as one message.')),
    field('Quiet hours', h('div.wk-tell-quiet', time('quietFrom', 'From'), time('quietTo', 'to')),
      'Nothing is sent then; what happened goes as one message when they end. Empty: none.'),
    toggle('Tia writes my digest', w().tiaWords, (v) => {
      set('tiaWords', v);
      return now();
    }, { line: 'Tia writes the digest in your language, with one short call on her provider (it costs a little).',
      more: 'She uses the language you write to her in. On a provider billed by use she words it only inside your daily limit for paid use (Settings → Tia); with no limit set, or none left today, the plain digest goes. Every number and name in it is put in by the dashboard, never by her. Off: plain English, and no provider is asked.' }),
    h('div.savebar', saveBar('Save', () => save())));
}
