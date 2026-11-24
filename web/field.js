// Field reports on the page (docs/FIELD-REPORTS.md): Settings → Field reports, and the lines Home shows for them (a
// trouble that came up twice, the one question about sending, a report that waits with "ask each time"). Every press
// is the owner's own: nothing here sends, changes or installs anything without one.
import { icon } from './icons.js';
import { api, btn, fill, h, link, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { field, panel, radioCards, savedMark } from './shell.js';

const CHOICES = [
  { value: 'never', title: 'Never', sub: 'Reports stay on this computer. This is the default.' },
  { value: 'ask', title: 'Ask each time', sub: 'Each new report waits on Home with Send and Don\'t send.' },
  { value: 'always', title: 'Always', sub: 'Each new report is sent as soon as it is made.' },
];

const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
// Home shows at most this many waiting reports at once (each folded); the rest are named by their count.
const WAIT_SHOWN = 5;

// The control with this `data-keep` key inside `n` (a repaint makes new controls: the keyboard's focus goes back to
// the one that stands where the pressed one stood).
const findKeep = (n, k) => {
  if (n.dataset && n.dataset.keep === k) return n;
  for (const c of n.children || []) {
    const f = findKeep(c, k);
    if (f) return f;
  }
  return null;
};
const reportText = (text) => h('pre.output.field-report', { tabindex: '0', 'aria-label': 'The whole report, exactly as it would be sent' }, text);

// ---------- Settings → Field reports ----------

function fieldPage() {
  const box = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…')));
  let v = null;
  async function set(patch, mark) {
    const was = document.activeElement;
    const keep = was && box.contains(was) && was.dataset ? was.dataset.keep : null;
    try {
      v = await api('/api/field/settings', patch);
      paint();
      const again = keep ? findKeep(box, keep) : null;
      if (again) again.focus();
      if (mark) mark.show();
      return true;
    } catch (e) {
      toast(e, { kind: 'error' });
      return false;
    }
  }
  function paint() {
    const s = v.settings;
    const addr = h('input.field', { type: 'url', value: s.sendTo, placeholder: 'https://…', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'field-addr-hint', dataset: { keep: 'addr' } });
    const addrMark = savedMark();
    const copy = h('input.field', { type: 'text', value: s.copyDir, placeholder: 'A folder of yours, its whole path', autocomplete: 'off', spellcheck: 'false', dataset: { keep: 'copy' } });
    const copyMark = savedMark();
    const choiceMark = savedMark();
    const last = v.reports[0];
    fill(box,
      panel({ icon: 'info', title: 'What a field report is' },
        h('p', 'When Hoprig finishes a piece of its own work (a setup, a kit, hoprig get, hoprig drop, an update, a doctor run that found a problem), it writes a small report on this computer: what kind of work it was, how each step ended, what kind of error it was, where someone had to step in, and how long it took.'),
        h('p', 'A report never holds a path, a computer\'s or a person\'s name, an address, a project or repository name, a file\'s content or a line a program printed. Only words from fixed lists, counts and times. ', h('a', { href: 'https://github.com/allswebtech/hoprig/blob/main/docs/FIELD-REPORTS.md', target: '_blank', rel: 'noopener' }, 'Every field explained')),
        h('p.hint', `The newest 50 are kept, each under 1 KB. ${v.reports.length ? `${v.reports.length} on this computer now.` : 'None on this computer yet.'}`),
        last ? h('details.fold', h('summary.fold-summary', h('span', `The newest report (${when(last.time)})`), icon('chevronDown', { size: 18 })), h('div.fold-body', reportText(last.text))) : null),
      panel({ icon: 'send', title: 'Send reports to Hoprig\'s developers', desc: 'Only if you want to, and only what you can read first.' },
        field('Where reports go', h('div.field-addr', addr, addrMark),
          h('span', { id: 'field-addr-hint' }, 'An https address the developers give you. Empty means nothing is ever sent and nothing is asked.')),
        h('div.savebar', btn('secondary', { label: 'Save the address', dataset: { keep: 'addr-save' }, onclick: () => set({ sendTo: addr.value }, addrMark) })),
        s.sendTo ? [
          h('p.field-label', h('span', { id: 'field-choice' }, 'Send them?'), choiceMark),
          v.question ? h('p.hint', 'You have not chosen yet, so nothing is sent.') : null,
          radioCards('field-choice', CHOICES, v.choice, (c) => set({ choice: c }, choiceMark), { labelledBy: 'field-choice' }),
        ] : null),
      panel({ icon: 'folder', title: 'Also write each report into this folder', desc: 'For your own computers: one folder of yours gathers the reports of each. Off when empty.' },
        field('Folder', h('div.field-addr', copy, copyMark), 'Only the report\'s own file is written there, never anything else.'),
        h('div.savebar', btn('secondary', { label: 'Save the folder', dataset: { keep: 'copy-save' }, onclick: () => set({ copyDir: copy.value }, copyMark) }))));
  }
  api('/api/field').then((d) => {
    v = d;
    paint();
  }, (e) => fill(box, h('div.empty', icon('alert', { size: 28 }), h('p', e.message))));
  return [box];
}

registerSettingsPage({
  id: 'field', title: 'Field reports', icon: 'info', order: 68, onlyHere: true,
  desc: 'Small reports of Hoprig\'s own work: kept here, and sent to its developers only if you choose.',
  summary: async () => {
    const v = await api('/api/field');
    return v.choice === 'never' ? `${v.reports.length} kept here, none sent` : v.choice === 'ask' ? 'Asks before each one is sent' : 'Each one is sent';
  },
  render: fieldPage,
});

// ---------- the Home lines ----------

/** The lines Home shows: an element that fills itself (empty while there is nothing to say). */
export function fieldLines() {
  const box = h('div.field-lines');
  let v = null;
  async function press(path, done) {
    try {
      v = await api(path, {});
      if (done) done(v);
      paint();
    } catch (e) {
      toast(e, { kind: 'error' });
    }
  }
  function paint() {
    if (!v) return fill(box);
    const lines = [];
    for (const t of v.twice) {
      lines.push(h('div.banner.muted.field-line', { role: 'status' }, icon('alert', { size: 18 }),
        h('div.field-line-text',
          h('strong', `This went wrong twice: ${t.words}.`),
          h('span', ` (${t.kindWords}, last on ${when(t.last)})`),
          h('p', t.help, t.command && !t.help.includes(t.command) ? [' ', h('code', t.command)] : null)),
        h('span.banner-actions',
          btn('small secondary', { label: 'Dismiss', 'aria-label': `Dismiss: ${t.words}`, onclick: () => press(`/api/field/twice/${t.key}/dismiss`) }),
          !t.draft ? null : btn('small secondary', { label: 'Make a skill draft of this', 'aria-label': `Make a skill draft of: ${t.words}`, onclick: () => press(`/api/field/twice/${t.key}/draft`, () => toast('A draft waits in Skills → Learned. Nothing is used until you install it.', { ms: 8000, action: { label: 'Open', title: 'Open Skills → Learned', run: () => (location.hash = link('#/skills/learned')) } })) }))));
    }
    if (v.question) {
      lines.push(h('div.banner.muted.field-line', { role: 'status' }, icon('send', { size: 18 }),
        h('div.field-line-text', h('strong', 'Send field reports to Hoprig\'s developers?'),
          h('p', 'An address is set in Settings → Field reports. Until you choose, nothing is sent.')),
        h('span.banner-actions', h('a.btn.small.primary', { href: link('#/settings/field') }, 'Choose'))));
    }
    // "Ask each time": one line for all that wait, each report folded under it (its whole text one press away).
    const waiting = v.waiting;
    if (waiting.length) {
      const more = waiting.length - WAIT_SHOWN;
      lines.push(h('div.banner.muted.field-line.field-wait', { role: 'group', 'aria-labelledby': 'field-wait-head' }, icon('send', { size: 18 }),
        h('div.field-line-text',
          h('strong', { id: 'field-wait-head' }, waiting.length === 1 ? 'A field report waits for your answer' : `${waiting.length} field reports wait for your answer`),
          h('p', 'Open one to read the whole report, exactly what would be sent, then answer.'),
          waiting.slice(0, WAIT_SHOWN).map((w) => {
            // To the second and with the id's start (what hoprig field show takes): two reports of one minute differ.
            const at = `${new Date(w.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })}, id ${w.id.slice(0, 8)}`;
            const what = `the report of ${w.kindWords || w.kind} at ${at}`;
            return h('details.fold.field-wait-one',
              h('summary.fold-summary', h('span', `${(w.kindWords || w.kind).replace(/^./, (c) => c.toUpperCase())}, ${at}`), icon('chevronDown', { size: 18 })),
              h('div.fold-body', reportText(w.text),
                h('span.banner-actions',
                  btn('small secondary', { label: 'Don\'t send', 'aria-label': `Don't send ${what}`, onclick: () => press(`/api/field/report/${w.id}/dont-send`) }),
                  btn('small primary', { label: 'Send', 'aria-label': `Send ${what}`, onclick: (e) => {
                    e.currentTarget.disabled = true;
                    press(`/api/field/report/${w.id}/send`, (r) => toast(r.sent && r.sent.ok ? 'Sent.' : 'It could not be sent; it is tried again with the next one.', { kind: r.sent && r.sent.ok ? 'info' : 'error' }));
                  } }))));
          }),
          more > 0 ? h('p.hint', `${more} more wait${more === 1 ? 's' : ''}: ${more === 1 ? 'it shows' : 'they show'} here as you answer these.`) : null)));
    }
    fill(box, lines);
  }
  api('/api/field').then((d) => {
    v = d;
    paint();
  }, () => {}); // an older computer has no field reports
  return box;
}
