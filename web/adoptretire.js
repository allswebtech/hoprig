// "Remove the old folders" on the page "Projects found on this computer", after Arrange: the terminal's
// `hoprig adopt retire <name>` on a sheet (POST /api/adopt/retire/check and /api/adopt/retire, src/adopt/retireweb.mjs).
// The sheet shows retire's own lines (what goes, what stays and why), says before the press that there is no undo, and
// goes ahead only on the project's name typed into an empty field that takes no paste; the server compares it, and
// retire checks everything again before anything goes.
import { icon } from './icons.js';
import { api, btn, fill, h, openSheet, toast } from './lib.js';
import { errorBox } from './shell.js';

export const RETIRE_LABEL = 'Remove the old folders';
const busyLine = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));

/** What retire found, in its own words: the folders that go, the ones that stay with their reason. */
export function retireView(c) {
  return h('div.adopt-retire',
    h('p', 'These old folders would be removed (their copies are in the project):'),
    h('ul.adopt-plan', c.go.map((g) => h('li', h('span.mono', g.path), g.keeps ? ` (all but the private folder${g.keeps === 1 ? '' : 's'} in it)` : ''))),
    c.leftOut && c.leftOut.length ? [h('p', { style: { marginTop: '12px' } }, c.leftHead), h('ul.adopt-plan', c.leftOut.map((l) => h('li', l.words)))] : null,
    c.lines.filter((l) => !l.startsWith('  ') && l !== c.leftHead && !/^These (originals would be removed|stay)/.test(l)).map((l) => h('p.hint', l)),
    c.stay.length ? h('p', { style: { marginTop: '12px' } }, 'These stay:') : null,
    c.stay.length ? h('ul.adopt-plan', c.stay.map((s) => h('li', h('span.mono', s.path), `: ${s.why}`))) : null);
}

/** The sheet for project `name`; `after()` when the old folders went. */
export function retireSheet(name, after = () => {}) {
  return openSheet({ title: `Remove the old folders of ${name}`, subtitle: 'The project stays in your workspace. Only the folders it was copied from go.', wide: true }, (close) => {
    const body = h('div', { 'aria-live': 'polite' }, busyLine('Looking at the old folders and their copies…'));
    const closeOnly = () => h('div.sheet-actions', h('button.btn.primary', { type: 'button', onclick: () => close(null) }, 'Close'));
    const show = (c, banner = null) => {
      if (c.refusal || !c.ticket) return fill(body, banner, h('div.banner.warn', icon('alert', { size: 18 }), h('span', c.refusal || 'Nothing of it would be removed.')), closeOnly());
      const typed = h('input.field.mono', { type: 'text', value: '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `Type ${name} to remove them`,
        onpaste: (e) => e.preventDefault(), ondrop: (e) => e.preventDefault() });
      const res = h('div', { role: 'status' });
      const go = btn('danger', { icon: 'trash', label: RETIRE_LABEL, onclick: async () => {
        go.disabled = true;
        fill(res, busyLine('Comparing each old folder with its copy again, then removing it…'));
        let r;
        try {
          r = await api('/api/adopt/retire', { ticket: c.ticket, typed: typed.value });
        } catch (e) {
          go.disabled = false;
          return void fill(res, errorBox(e));
        }
        if (r.ok) {
          after();
          toast(`The old folders of ${name} are removed; the project is in your workspace`);
          return close(true);
        }
        if (r.check) return show(r.check, h('div.banner.warn', { role: 'alert' }, icon('alert', { size: 18 }), h('span', `${r.error[0].toUpperCase()}${r.error.slice(1)}`)));
        if (r.result === 'expired') return void fill(body, errorBox(`${r.error}.`), h('div.sheet-actions', btn('secondary', { label: 'Look again', onclick: () => load() })));
        fill(body, errorBox(r.words || 'Nothing was removed.'), closeOnly());
      } });
      fill(body, banner, retireView(c),
        h('div.banner.warn', icon('alert', { size: 18 }), h('span', c.undo)),
        h('label.fieldrow', h('span.field-label', `Type the project's name (${name}) to remove them`), typed), res,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go));
      typed.focus();
    };
    const load = async () => {
      fill(body, busyLine('Looking at the old folders and their copies…'));
      try {
        show(await api('/api/adopt/retire/check', { name }));
      } catch (e) {
        fill(body, errorBox(e), closeOnly());
      }
    };
    load();
    return body;
  });
}
