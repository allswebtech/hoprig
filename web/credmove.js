// Move credentials to another computer of yours, by your press (src/workspace/credweb.mjs, credmove.mjs).
// One sheet: from which computer, to which, what (one project, or everything), then "Look": the sender seals the files for
// the receiver, the receiver opens them in memory and lists what would happen (names, sizes, new, same or different; never
// a value). "Move" writes the new ones; ones that differ are left as they are until "Replace". A computer's key that
// changed, or that is not in the AI brain yet, shows one more button: Trust. Only sealed bytes travel through this page.
import { at, api, btn, fill, h, machine, openSheet, url } from './lib.js';
import { errorBox, okBox } from './shell.js';

const MOVE = '/api/workspace/credmove';
const busyLine = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));
const STATE = { new: 'New', same: 'Already the same', different: 'Differs', blocked: 'Something is in the way' };
const bytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A raw upload of the sealed bytes to the receiver; an answer that is not ok throws as `api` does (with its code). */
function upload(to, query, sealed) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url(at(to, `${MOVE}/upload${query}`)));
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.onerror = () => reject(Object.assign(new Error('Cannot reach the computer. Check the connection.'), { status: 0 }));
    x.onload = () => {
      let data = {};
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* no body */
      }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || `Request failed (${x.status})`), { status: x.status, data, code: data.code || null }));
    };
    x.send(sealed);
  });
}

/** The button that opens the sheet; nothing while this computer has no other one to move to. */
export function credMoveButton() {
  const box = h('div.savebar.start.hidden');
  api('~/api/machines').then((d) => {
    if (!(d.machines || []).length && !machine.current) return;
    fill(box, btn('secondary', { icon: 'key', label: 'Move to another computer', onclick: () => openCredMove() }));
    box.classList.remove('hidden');
  }, () => {});
  return box;
}

/** The sheet. */
export function openCredMove() {
  openSheet({ title: 'Move credentials', subtitle: 'To another computer of yours, sealed so only it can read them', wide: true }, (close) => {
    const panel = h('div');
    const busy = (t) => fill(panel, busyLine(t));
    let list = [];
    async function start() {
      busy('Looking at your computers…');
      let d;
      try {
        d = await api('~/api/machines');
      } catch (e) {
        return fill(panel, errorBox(e.message, start));
      }
      list = [{ name: null, label: 'This dashboard\'s computer' }, ...(d.machines || []).map((m) => ({ name: m.name, label: m.label || m.name, own: m.own !== false }))];
      choose();
    }
    const nameOf = (v) => (v === '' ? null : v);
    function choose(error = '') {
      const sel = (id, value) => h('select.field', { id, 'aria-label': id }, list.map((m) => h('option', { value: m.name || '', ...((m.name || '') === (value || '') ? { selected: true } : {}) }, m.label)));
      const from = sel('From', machine.current);
      const first = list.find((m) => (m.name || null) !== (machine.current || null));
      const to = sel('To', first && first.name);
      const what = h('select.field', { 'aria-label': 'What' }, h('option', { value: '' }, 'Reading…'));
      const typed = h('input.field.mono', { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'its name' });
      const typedRow = h('label.fieldrow.hidden', h('span.field-label', 'This computer is not yours: type its name to send a project'), typed);
      const err = h('p.form-error', { role: 'alert' }, error);
      const fill_what = async () => {
        try {
          const s = await api(at(nameOf(from.value), MOVE));
          const toItem = list.find((m) => (m.name || '') === to.value);
          const strange = toItem && toItem.own === false;
          fill(what, (s.projects || []).map((p) => h('option', { value: `project:${p}` }, p)), strange ? null : h('option', { value: 'all' }, 'Everything'));
          typedRow.classList.toggle('hidden', !strange);
        } catch (e) {
          fill(what, h('option', { value: '' }, 'Cannot read that computer'));
          err.textContent = e.message;
        }
      };
      from.onchange = fill_what;
      to.onchange = fill_what;
      fill_what();
      const look = btn('primary', { icon: 'chevronRight', label: 'Look', onclick: () => {
        if (from.value === to.value) return void (err.textContent = 'Pick two different computers.');
        if (!what.value) return void (err.textContent = 'Nothing to send from that computer.');
        run({ from: nameOf(from.value), to: nameOf(to.value), what: what.value, typed: typed.value.trim(), replace: false });
      } });
      fill(panel,
        h('label.fieldrow', h('span.field-label', 'From'), from),
        h('label.fieldrow', h('span.field-label', 'To'), to),
        h('label.fieldrow', h('span.field-label', 'What'), what),
        typedRow,
        h('details', h('summary', 'Advanced'), h('p.hint', 'A rented server or a friend\'s computer is not yours: mark it, and it gets one project at a time.'), markRow(() => list.find((m) => (m.name || '') === to.value), start)),
        err,
        h('div.sheet-actions', btn('secondary', { label: 'Cancel', onclick: () => close() }), look));
    }
    function markRow(item, again) {
      return btn('secondary small', { label: 'Mark the "To" computer as not mine, or as mine', onclick: async () => {
        const m = item();
        if (!m || !m.name) return;
        try {
          await api(`~${MOVE}/mark`, { machine: m.name, own: m.own === false });
          await api(at(m.name, `${MOVE}/own`), { own: m.own === false });
        } catch (e) {
          return void fill(panel, errorBox(e.message, again));
        }
        again();
      } });
    }
    /** The whole move up to the list, then (when `go`) the writing. `o`: { from, to, what, typed, replace }. */
    async function run(o, go = false) {
      try {
        busy('Asking the other computer for a one-time number…');
        const src = await api(at(o.from, MOVE));
        const rec = await api(at(o.to, `${MOVE}/expect`), { from: src.label });
        busy('Sealing the files…');
        const toItem = list.find((m) => m.name === o.to);
        const body = { to: rec.label, nonce: rec.nonce, ...(o.what === 'all' ? { all: true } : { project: o.what.slice(8) }), ...(o.typed ? { typed: o.typed } : {}), ...(!o.from && o.to ? { machine: o.to } : {}) };
        let pk;
        try {
          pk = await api(at(o.from, `${MOVE}/pack`), body);
        } catch (e) {
          const code = e.code;
          if (code === 'key-changed' || code === 'key-unknown') return trustStep(o, e, { on: o.from, label: rec.label, who: rec.label });
          throw e;
        }
        const sealed = fromBase64(pk.sealed);
        busy('The other computer is opening it…');
        let dry;
        try {
          dry = await upload(o.to, '?dryRun=1', sealed);
        } catch (e) {
          const code = e.code;
          if (code === 'key-changed' || code === 'key-unknown') return trustStep(o, e, { on: o.to, label: pk.from.label, who: pk.from.label });
          throw e;
        }
        if (!go) return listStep(o, dry, sealed, toItem);
        const real = await upload(o.to, `?seen=${dry.seen}${o.replace ? '&replace=1' : ''}`, sealed);
        done(o, real);
      } catch (e) {
        fill(panel, errorBox(e.message, () => choose()));
      }
    }
    function trustStep(o, e, t) {
      // A computer the brain does not know yet: nothing to trust. Its key comes only through the brain, never from the link.
      if (e.code === 'key-unknown') return fill(panel, h('div.banner.warn', h('span', e.message)), h('div.sheet-actions', btn('secondary', { label: 'Back', onclick: () => choose() }), btn('primary', { label: 'Try again', onclick: () => run(o) })));
      const err = h('p.form-error', { role: 'alert' });
      fill(panel,
        h('div.banner.warn', h('span', e.message)),
        h('p.hint', `Trust only if you changed or just added ${t.who} yourself.`),
        err,
        h('div.sheet-actions', btn('secondary', { label: 'Back', onclick: () => choose() }), btn('primary', { icon: 'key', label: `Trust ${t.who}`, onclick: async () => {
          try {
            await api(at(t.on, `${MOVE}/trust`), { label: t.label });
          } catch (x) {
            return void (err.textContent = x.message);
          }
          run(o);
        } })));
    }
    function listStep(o, dry, sealed) {
      const rows = dry.items.map((i) => h('div.row.static', h('span.row-main', h('span.row-title.ws-wrap', i.p), h('span.row-sub', `${bytes(i.size)} · ${STATE[i.state] || i.state}`))));
      const move = btn('primary', { icon: 'download', label: 'Move', onclick: () => go(false) });
      const replace = dry.differ ? btn('secondary', { label: `Move and replace ${dry.differ} that differ`, onclick: () => go(true) }) : null;
      async function go(replaceToo) {
        move.disabled = true;
        if (replace) replace.disabled = true;
        busy('Writing…');
        try {
          done(o, await upload(o.to, `?seen=${dry.seen}${replaceToo ? '&replace=1' : ''}`, sealed));
        } catch (e) {
          fill(panel, errorBox(e.message, () => run(o)));
        }
      }
      fill(panel,
        h('p.hint', `${dry.items.length} ${dry.items.length === 1 ? 'file' : 'files'} from ${dry.from}. Nothing is written until you press Move.`),
        h('div.rows', rows),
        h('div.sheet-actions', btn('secondary', { label: 'Back', onclick: () => choose() }), replace, move));
    }
    function done(o, r) {
      fill(panel,
        okBox(`${r.wrote} ${r.wrote === 1 ? 'file' : 'files'} written${r.linked ? `, ${r.linked} ${r.linked === 1 ? 'link' : 'links'} made` : ''}.`),
        r.kept ? h('p.hint', `${r.kept} that differ ${r.kept === 1 ? 'was' : 'were'} left as ${r.kept === 1 ? 'it was' : 'they were'}.`) : null,
        h('div.sheet-actions',
          r.kept ? btn('secondary', { label: 'Replace them', onclick: () => run({ ...o, replace: true }, true) }) : null,
          btn('primary', { label: 'Close', onclick: () => close() })));
    }
    start();
    return [panel];
  });
}
