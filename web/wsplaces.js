// The workspace from the Workspace page, without a terminal (src/workspace/feature.mjs, docs/WORKSPACE.md):
//   dropSheet(name, after)    `hoprig drop`, question for question: the check first (the terminal's own lines), then
//                             exactly its questions; the server checks again at the press (dropweb.mjs)
//   groupSheet(fill, after)   `hoprig workspace group add`: what goes into the map is shown before Add
//   removeGroup(dir, after)   `hoprig workspace group remove`: out of the map, never its folder
//   computersPanel(who)       which computer has what, from each computer's own file in the AI brain
// Every route answers for the open computer (another one's goes through the hub, and is checked there).
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, openSheet, toast } from './lib.js';
import { errorBox, okBox } from './shell.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (ms) => (ms ? new Date(ms).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const busyLine = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));

/**
 * "as of 2 Nov 2026" for another computer's file; "old" after a week. This computer: "now" only when its row is what
 * its disk has (whohas.mjs fromDisk), else its own file's time.
 */
export const asOfWords = (c) => (c.mine && c.fromDisk ? 'this computer, now (from its disk)' : c.mine ? `this computer's file, as of ${day(c.written) || 'an unknown day'}` : `as of ${day(c.written) || 'an unknown day'}${c.old ? ' (old: it may have changed since)' : ''}`);

/** A line of the terminal without its mark (✓ ✗ ! ·). */
const unmark = (l) => String(l).trim().replace(/^[✓✗!·]\s+/, '');
/** What a stopped drop says, without the terminal's mark. */
export const stoppedWords = (r) => unmark((r.lines || []).filter(Boolean).pop() || 'nothing was dropped');

/** The check's own lines (the terminal's words) and the list that would go with the project. */
export function checkView(c) {
  // The terminal's own lines, without its marks (✓ ✗ ! ·) and its first line (the project and its folder: the title
  // says it). Where the sheet asks the questions itself, the terminal's "it asks: …" lines would only say them twice.
  const asked = (c.questions || []).length > 0;
  const lines = c.lines.filter(Boolean).slice(1).map(unmark).filter((l) => !(asked && /^it asks: /.test(l))).map((l) => l.replace(/ \(above\)$/, asked ? ' (the questions below)' : ''));
  return h('div.ws-drop-check',
    h('p.field-label', 'What the check found'),
    h('ul.ws-drop-lines', lines.map((l) => h('li', l))));
}

/**
 * What the scan puts into the map with a new group, in two parts: what is in the group's folder, and what it finds
 * elsewhere in the workspace (it scans all of it). An older computer's answer has only the whole list.
 */
export function mapAddedParts(r) {
  if (!r.added) return [];
  const here = r.mapAddedHere || (r.mapAddedElsewhere ? [] : r.mapAdded || []);
  const elsewhere = r.mapAddedElsewhere || [];
  const part = (title, list) => (list.length ? h('div', h('p.field-label', title), h('ul.hint', list.map((x) => h('li', x)))) : null);
  const whole = !r.mapAddedHere && !r.mapAddedElsewhere;
  return [
    part(whole ? 'And what the scan of your workspace finds now, into the map' : 'And what is in its folder now, into the map', here),
    part('And what the scan finds elsewhere in your workspace, into the map too', elsewhere),
  ];
}

/** A group as the owner reads it: its folder, its address and the folders it holds, in sentences. */
export function groupWords(g) {
  const out = [`The group ${g.dir}, a folder in your workspace.`];
  if (g.url) out.push(`It is a repository of its own: ${g.url}.`);
  for (const x of g.holds || []) out.push(x.parent === 'group' ? `It holds ${x.dir}, whose projects come with the group's repository.` : `It holds ${x.dir}, a folder of projects with repositories of their own.`);
  return out;
}

/**
 * The work question: each repository with the files that would be committed and pushed to its wip/ branch, as the
 * terminal lists them before it asks (dropcli.mjs terminalAsk: the first 20, then "… and N more").
 */
export function workQuestion(q, onchange) {
  const box = h('input', { type: 'checkbox', onchange });
  return h('fieldset.ws-q', h('legend', 'Work that is not committed (it would be lost with the folder)'),
    h('ul.ws-q-list', q.repos.map((r) => h('li', h('code', r.repo), ` ${plural(r.files.length, 'file')}:`,
      h('ul.ws-q-files', [...r.files.slice(0, 20).map((f) => h('li', h('code', f))), ...(r.files.length > 20 ? [h('li', `… and ${r.files.length - 20} more`)] : [])])))),
    h('label.toggle-line', box, h('span', q.words)));
}

/**
 * The drop sheet: the check, then the terminal's questions. Nothing is answered for him: the box for work starts
 * unticked, no answer is chosen for a default branch, and the name field starts empty and takes no paste or drop.
 */
/** The sheet's title for computer `on` (its label; null: the computer whose page this is). */
export const dropTitle = (name, on = null) => `Drop ${name} from ${on || 'this computer'}`;

export function dropSheet(name, after = () => {}, { on = null } = {}) {
  return openSheet({ title: dropTitle(name, on), subtitle: 'Only when all of it is on its git server, so that Get brings it back. The map keeps it.', wide: true }, (close) => {
    const body = h('div.ws-drop', { 'aria-live': 'polite' }, busyLine('Checking what exists only on this computer…'));
    const show = (c, banner = null) => {
      if (c.refusals.length || !c.ticket) {
        return fill(body, banner, checkView(c),
          c.refusals.length ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', 'It cannot be dropped yet: each line above says what to do first.')) : null,
          h('div.sheet-actions', h('button.btn.primary', { type: 'button', autofocus: true, onclick: () => close(null) }, 'Close')));
      }
      const answers = { work: false, defaults: {} };
      const qs = [];
      let typed = null;
      for (const q of c.questions) {
        if (q.ask === 'work') {
          qs.push(workQuestion(q, (e) => (answers.work = e.target.checked)));
        } else if (q.ask === 'default branch') {
          const group = `ws-q-${q.repo.replace(/[^a-z0-9]+/gi, '-')}`;
          qs.push(h('fieldset.ws-q', h('legend', q.words), h('p.hint', q.release),
            h('div.ws-q-choices', { role: 'radiogroup', 'aria-label': q.words }, q.choices.map((x) => h('label.toggle-line',
              h('input', { type: 'radio', name: group, value: x.value, onchange: () => (answers.defaults[q.repo] = x.value) }), h('span', x.words))))));
        } else {
          typed = h('input.field.mono', { type: 'text', value: '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': q.words,
            onpaste: (e) => e.preventDefault(), ondrop: (e) => e.preventDefault() });
          qs.push(h('fieldset.ws-q', h('legend', `Files that cannot be made again (${plural(q.items, 'item')}, listed above)`),
            h('label.fieldrow', h('span.field-label', `${q.words}.`), typed)));
        }
      }
      const res = h('div', { role: 'status' });
      const go = btn('danger', { icon: 'trash', label: 'Drop it', onclick: async () => {
        go.disabled = true;
        fill(res, busyLine('Fetching, pushing what you said yes to, and checking everything again…'));
        let r;
        try {
          r = await api('/api/workspace/drop', { ticket: c.ticket, work: answers.work, defaults: answers.defaults, ...(typed ? { typed: typed.value } : {}) });
        } catch (e) {
          go.disabled = false;
          return void fill(res, errorBox(e));
        }
        if (r.result === 'changed') return show(r.check, h('div.banner.warn', { role: 'alert' }, icon('alert', { size: 18 }), h('span', 'The project changed since this sheet opened, so nothing was dropped. This is what is only here now.')));
        if (r.result === 'expired') return void fill(res, errorBox(`${r.error}.`), h('div.btnrow', btn('small secondary', { label: 'Check again', onclick: () => load() })));
        if (r.result === 'dropped') {
          after();
          toast(`${name} is off ${on || 'this computer'}; Get brings it back`);
          return close(true);
        }
        // Stopped at a question: its ticket is used, so the sheet starts again from the fresh check the server gave.
        if (r.result === 'stopped' && r.check) return show(r.check, h('div.banner.muted', { role: 'alert' }, h('span', `Stopped: ${stoppedWords(r)}. Answer every question, then press Drop it again.`)));
        go.disabled = false;
        fill(res, r.result === 'stopped' ? h('div.banner.muted', h('span', `Stopped: ${stoppedWords(r)}`)) : errorBox(r.lines.filter(Boolean).slice(-3).map(unmark).join(' ') || 'Nothing was dropped.'));
      } });
      fill(body, banner, checkView(c), qs.length ? h('div.ws-qs', qs) : h('p.hint', 'No question: everything of it is on its git server.'), res,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go));
      (body.querySelector('.ws-q input') || go).focus();
    };
    const load = async () => {
      fill(body, busyLine('Checking what exists only on this computer…'));
      try {
        show(await api('/api/workspace/drop/check', { name }));
      } catch (e) {
        fill(body, errorBox(e), h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Close')));
      }
    };
    load();
    return body;
  });
}

/** Add a group: the folder (and, for a group that is a repository, its address and held folders); the dry run first. */
export function groupSheet(given = {}, after = () => {}) {
  return openSheet({ title: 'Add a group', subtitle: 'A folder of projects of your own beside the projects folder. Every computer of yours gets it from the map.' }, (close) => {
    const dir = h('input.field.mono', { value: given.group || '', autocomplete: 'off', spellcheck: 'false', autofocus: true, 'aria-label': 'Folder name', placeholder: 'kits' });
    const repo = h('input.field.mono', { value: given.repo || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Its own repository (optional)', placeholder: 'https://github.com/example/kits.git' });
    const holds = h('input.field.mono', { value: given.holds || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Folders it holds (optional)', placeholder: 'packs:group,builds' });
    const res = h('div', { 'aria-live': 'polite' });
    const body = () => ({ dir: dir.value.trim(), ...(repo.value.trim() ? { repo: repo.value.trim() } : {}), ...(holds.value.trim() ? { holds: holds.value.trim() } : {}) });
    let shown = null;
    const look = async (e) => {
      e.preventDefault();
      shown = null;
      fill(res, busyLine('Checking…'));
      try {
        const b = body();
        const r = await api('/api/workspace/group', { ...b, dryRun: true });
        shown = JSON.stringify(b);
        const add = btn('primary', { icon: 'plus', label: r.added ? 'Add it to the map' : 'Close', onclick: async () => {
          if (!r.added) return close(null);
          if (JSON.stringify(body()) !== shown) return void fill(res, errorBox('The fields changed since the check: check again.'));
          add.disabled = true;
          try {
            await api('/api/workspace/group', { ...b, ...(r.ignore && r.ignore.lines.length && !r.ignore.refused ? { writeIgnore: true } : {}) });
            toast(`${b.dir} is a group of your map`);
            after();
            close(true);
          } catch (er) {
            add.disabled = false;
            fill(res, errorBox(er.message));
          }
        } });
        fill(res,
          r.added ? h('p.field-label', 'Written to the workspace map') : h('p.hint', `${b.dir} is a group of the map already, the same: nothing to write.`),
          r.added ? h('ul.ws-drop-lines', groupWords(r.group).map((l) => h('li', l))) : null,
          ...mapAddedParts(r),
          r.ignore && r.ignore.lines.length ? h('div', h('p.field-label', `And to ${r.ignore.file}, so that one git add there never takes a project`), h('pre.output', r.ignore.lines.join('\n')), r.ignore.refused ? h('p.hint', `Not written: ${r.ignore.refused}`) : null) : null,
          (r.notes || []).length ? h('ul.hint', r.notes.map((n) => h('li', n))) : null,
          h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), add));
        checkRow.style.display = 'none';
        add.focus();
      } catch (er) {
        fill(res, errorBox(er.message));
      }
    };
    const checkRow = h('div.sheet-actions.ws-group-check', h('button.btn.secondary', { type: 'submit' }, 'Check what it writes'));
    // A field changed after the check: the answer no longer says what Add would write, so it goes and Check comes back.
    for (const f of [dir, repo, holds]) f.addEventListener('input', () => { if (shown) { shown = null; fill(res); checkRow.style.display = ''; } });
    return h('form', { onsubmit: look },
      h('label.fieldrow', h('span.field-label', 'Folder name, in your workspace'), dir),
      h('label.fieldrow', h('span.field-label', 'Its own repository, when the group is one (optional)'), repo),
      h('label.fieldrow', h('span.field-label', 'The folders it holds, when it is one: "name", or "name:group" when the projects come with the group (optional)'), holds),
      res,
      checkRow);
  });
}

/** Take a group out of the map: never its folder. */
export async function removeGroup(dir, after = () => {}) {
  let note = '';
  try {
    note = (await api('/api/workspace/group/remove', { dir, dryRun: true })).note;
  } catch (e) {
    return void toast(e, { kind: 'error', ms: 7000 });
  }
  const ok = await confirmSheet({ title: `Take ${dir} out of the map?`, text: `${dir} is taken out of the workspace map; ${note}. Every computer stops getting it from the map.`, ok: 'Take it out' });
  if (!ok) return;
  try {
    await api('/api/workspace/group/remove', { dir });
    toast(`${dir} is out of the map; its folder stays`);
    after();
  } catch (e) {
    toast(e, { kind: 'error', ms: 7000 });
  }
}

/** Which computer has what: each computer with what it has and when its file was written; one without a file: unknown. */
export function computersPanel(who) {
  const refused = (who && who.refused) || [];
  const conflicts = (who && who.conflicts) || [];
  if (!who || (!who.computers.length && !who.unknown.length && !refused.length && !conflicts.length && !who.folderWhy)) return null;
  // The map's entries only (a project's code repositories are no entry of their own); a group's members stay, and
  // a group is named as one.
  const kinds = new Map((who.entries || []).map((e) => [e.name, e.kind]));
  const top = (list) => (kinds.size ? list.filter((x) => kinds.has(x)) : list.filter((x) => !list.some((y) => y !== x && x.startsWith(`${y}/`)))).map((x) => (kinds.get(x) === 'group' ? `${x} (group)` : x));
  const warn = (title, sub) => h('div.row.static', h('span.row-icon', icon('alert')), h('span.row-main', h('span.row-title', title, h('span.badge.soft.warn', 'not read')), h('span.row-sub.pj-wrap', sub)));
  return h('section.ws-computers', { 'aria-label': 'Your computers' },
    h('h2.group-head', h('span', 'Your computers'), h('span.group-count', String(who.computers.length + who.unknown.length + refused.length))),
    h('p.ws-place-sub', 'From the file each computer writes about itself in the AI brain. This page writes none of them.'),
    h('div.rows', who.computers.map((c) => h('div.row.static',
      h('span.row-icon', icon('cpu')),
      h('span.row-main',
        h('span.row-title', c.label, c.mine ? h('span.badge.soft', 'this computer') : c.old ? h('span.badge.soft.warn', 'old') : null),
        h('span.row-sub.pj-wrap', top(c.here).length ? top(c.here).join(', ') : 'none of the map\'s projects'),
        h('span.row-sub.pj-wrap', asOfWords(c)),
        c.listedAs ? h('span.row-sub.pj-wrap', `Under Computers it is ${c.listedAs.join(' and ')}.`) : null))),
    who.unknown.map((n) => {
      const u = (who.unjoined || []).find((x) => x.name === n);
      return h('div.row.static',
        h('span.row-icon', icon('cpu')),
        h('span.row-main', h('span.row-title', n, h('span.badge.soft', 'unknown')), h('span.row-sub.pj-wrap', u ? `Its Hoprig has not said its name in the workspace, so it could not be joined with a computer's file. It may be ${u.maybe.join(' or ')}. Updating Hoprig there joins them.` : 'It has written no file in the AI brain, so what it has is not known.')));
    }),
    refused.map((r) => warn(r.name.replace(/\.json$/, ''), `Its file in the AI brain was refused (${r.why}), so what it has is not known.`)),
    conflicts.map((c) => warn(c.label, `${c.why}.`)),
    who.folderWhy ? warn('ai_brain/computers', `${who.folderWhy}.`) : null));
}

/** "Last here 30 Oct 2026" for an entry that is not on this computer, when the brain's history says so. */
export const lastHereWords = (e) => (e && e.lastHere ? `Last here ${day(e.lastHere)}` : '');
