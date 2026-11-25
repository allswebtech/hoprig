// "Look on the git server" in Settings → Workspace, for each place of the map with a naming rule ("find" in the map,
// docs/WORKSPACE.md): what GitHub has that fits (GET /api/workspace/find), "Add these to the map" (nothing cloned,
// asked first, with "Take them out again") and "Get" for one (asked first, then the workspace's background job).
// Every check is the server's (src/workspace/findweb.mjs calls the command's own functions); the page only shows.
import { icon } from './icons.js';
import { add, api, btn, fill, h, openSheet, tildePath } from './lib.js';
import { errorBox, fold, okBox } from './shell.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const SIGNIN_WORDS = 'GitHub is not signed in on this computer, so its repositories cannot be looked at. Sign in with the GitHub sign-in this dashboard already has, then look again.';
export const NO_RULE_WORDS = 'This place has no naming rule, so there is nothing to look up on the git server.';
export const NONE_FITS = 'Nothing on GitHub fits this place\'s naming rule yet.';
export const ALL_IN_MAP = 'The map has every project that fits.';
export const ADD_NOTE = 'Nothing is cloned: each one stays only in the map until you get it, here or on another computer.';
export const GET_NOTE = 'A clone is not undone from here. When you no longer need it here, Drop on the project\'s page puts it away again.';

/** The places of the map that have a naming rule: [{ id, rule }] (the map's own shape, as mapcheck.mjs keeps it). */
export function rulePlaces(map) {
  const out = [];
  for (const g of (map && map.groups) || []) {
    if (g.holds) for (const x of g.holds) if (x.find && x.parent !== 'group') out.push({ id: `${g.dir}/${x.dir}`, rule: x.find });
    if (!g.holds && !g.url && g.find) out.push({ id: g.dir, rule: g.find });
  }
  return out;
}

/** A refusal in the page's words: the sign-in and "no rule" said plainly, anything else as the server said it. */
export function refusalWords(e) {
  if (e && e.data && e.data.code === 'gh-signin') return SIGNIN_WORDS;
  if (e && /has no naming rule/.test(e.message || '')) return NO_RULE_WORDS;
  return (e && e.message) || 'It could not be looked up.';
}

/** Where a found or mapped project is: "here on this computer" or "only in the map". */
const whereWords = (ref, m) => {
  const e = ((m && m.entries) || []).find((x) => x.kind === 'project' && x.label === ref);
  return e && e.state === 'here' ? 'In the map, here on this computer' : 'In the map, not on this computer';
};

/** The part of the map panel: one row per place with a rule, each with its button. Null when no place has one. */
export function findPlaces(m, refresh) {
  const places = rulePlaces(m && m.map);
  if (!places.length) return null;
  return h('div.find-places',
    h('p.field-label', 'On the git server'),
    h('p.hint', 'A place with a naming rule can look up the projects of your GitHub account that fit the rule and are not in the map yet.'),
    h('div.rows.find-rows', places.map((pl) => h('div.row.static',
      h('span.row-icon', icon('search')),
      h('span.row-main', h('span.row-title', pl.id), h('span.row-sub.pj-wrap', `Projects are named ${pl.rule.parent}`)),
      btn('small secondary', { icon: 'search', label: 'Look on the git server', onclick: () => lookSheet(pl.id, m, refresh) })))));
}

/** The look: the list, then Add or Get. `refresh()` draws the map again when the sheet closes after a change. */
function lookSheet(place, m, refresh) {
  let changed = false;
  return openSheet({ title: 'Look on the git server', subtitle: place, wide: true }, (close) => {
    const box = h('div', { 'aria-live': 'polite' });
    const back = () => btn('secondary', { icon: 'back', label: 'Back', onclick: look });
    async function look() {
      fill(box, busy('Asking GitHub…'));
      let f;
      try {
        f = await api(`/api/workspace/find?in=${encodeURIComponent(place)}`);
      } catch (e) {
        const signin = e.data && e.data.code === 'gh-signin';
        return fill(box, errorBox(refusalWords(e), look), signin ? h('div.sheet-actions', btn('primary', { icon: 'git', label: 'Sign in to GitHub', onclick: async () => {
          const { signinSheet } = await import('./gitsetup.js');
          await signinSheet();
          lookSheet(place, m, refresh);
        } })) : null);
      }
      fill(box,
        h('p.sheet-text', `What your GitHub account${f.owners.length > 1 ? 's' : ''} (${f.owners.join(', ')}) ${f.owners.length > 1 ? 'have' : 'has'} that fits ${f.rule.parent}.`),
        (f.unlisted || []).map((u) => h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${u.why}: its repositories were not looked at.`))),
        f.found.length ? h('div.rows.find-rows', f.found.map((p) => h('div.row.static',
          h('span.row-icon', icon('folder')),
          h('span.row-main',
            h('span.row-title', p.ref),
            h('span.row-sub.pj-wrap', `${p.parent}${p.code.length ? ` · code: ${p.code.map((c) => c.name).join(', ')}` : ''}`),
            p.skipped.length ? h('span.row-sub.pj-wrap', `Left out: ${p.skipped.map((c) => `${c.name} (the word "${c.word}")`).join(', ')}`) : null,
            h('span.row-sub', 'Not in the map yet, not on this computer')),
          btn('small secondary', { icon: 'download', label: 'Get', onclick: () => getStep(p) })))) : h('p.hint', f.inMap.length ? ALL_IN_MAP : NONE_FITS),
        f.inMap.length ? fold('find-inmap', `In the map already (${f.inMap.length})`, h('div.rows.find-rows', f.inMap.map((ref) => h('div.row.static',
          h('span.row-icon', icon('check')), h('span.row-main', h('span.row-title', ref), h('span.row-sub', whereWords(ref, m))))))) : null,
        f.misfits.length ? fold('find-misfits', `Does not fit the rule (${f.misfits.length})`, h('p.hint', 'Never guessed: these are left as they are.'),
          h('div.rows.find-rows', f.misfits.map((x) => h('div.row.static', h('span.row-icon', icon('alert')), h('span.row-main', h('span.row-title', x.repo), h('span.row-sub.pj-wrap', x.why)))))) : null,
        h('div.sheet-actions',
          btn('secondary', { label: 'Close', onclick: () => close() }),
          f.found.length ? btn('primary', { icon: 'plus', label: 'Add these to the map', onclick: addStep }) : null));
    }
    async function addStep() {
      fill(box, busy('Working out what goes into the map…'));
      let dry;
      try {
        dry = await api('/api/workspace/find/add', { in: place, dryRun: true });
      } catch (e) {
        return fill(box, errorBox(refusalWords(e)), h('div.sheet-actions', back()));
      }
      if (!dry.added.length) return fill(box, h('p.sheet-text', ALL_IN_MAP), h('div.sheet-actions', back()));
      fill(box,
        h('p.sheet-text', `${plural(dry.added.length, 'project')} will go into the map:`),
        h('div.rows.find-rows', dry.entries.map((e) => h('div.row.static', h('span.row-icon', icon('plus')),
          h('span.row-main', h('span.row-title', `${e.in}/${e.name}`), h('span.row-sub.pj-wrap', `${e.url}${e.repos.length ? ` · ${e.repos.map((r) => r.dir).join(', ')}` : ''}`))))),
        (dry.notAdded || []).length ? h('ul.hint', dry.notAdded.map((n) => h('li', `${n.repo}: not added, ${n.why}`))) : null,
        h('p.hint', ADD_NOTE),
        h('div.sheet-actions', back(), btn('primary', { icon: 'check', label: dry.added.length === 1 ? 'Add it to the map' : `Add these ${dry.added.length} to the map`, onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          try {
            const r = await api('/api/workspace/find/add', { in: place, seen: dry.seen });
            changed = true;
            addedStep(r);
          } catch (e) {
            fill(box, errorBox(refusalWords(e)), h('div.sheet-actions', back()));
          }
        } })));
    }
    function addedStep(r) {
      const undo = btn('secondary', { icon: 'undo', label: 'Take them out again', onclick: async () => {
        undo.disabled = true;
        try {
          const u = await api('/api/workspace/find/undo', { entries: r.entries });
          fill(box,
            u.removed.length ? okBox(`Out of the map again: ${u.removed.join(', ')}.`) : h('p.sheet-text', 'Nothing was taken out.'),
            u.kept.length ? h('ul.hint', u.kept.map((k) => h('li', `${k.ref}: ${k.why}.`))) : null,
            h('div.sheet-actions', back(), btn('primary', { label: 'Done', onclick: () => close() })));
        } catch (e) {
          undo.disabled = false;
          fill(box, errorBox(refusalWords(e)), h('div.sheet-actions', back()));
        }
      } });
      fill(box,
        okBox(`In the map now: ${r.added.join(', ')}.`),
        h('p.hint', 'Nothing was cloned. Save the map in the AI brain so that your other computers see them too.'),
        h('div.sheet-actions', undo, btn('primary', { label: 'Done', onclick: () => close() })));
    }
    async function getStep(p) {
      fill(box, busy('Working out where it goes…'));
      let dry;
      try {
        dry = await api('/api/workspace/find/get', { in: place, repo: p.parent, dryRun: true });
      } catch (e) {
        return fill(box, errorBox(refusalWords(e)), h('div.sheet-actions', back()));
      }
      fill(box,
        h('p.sheet-text', `${dry.parent} comes to this computer as ${dry.place}/${dry.folder}${dry.into ? `, in ${tildePath(dry.into)}` : ''}.`),
        h('ul.hint',
          h('li', `Cloned: ${dry.parent}${dry.code.length ? `, then ${dry.code.map((c) => `code/${c}`).join(', ')}` : ''}.`),
          dry.skipped.length ? h('li', `Left out by the rule: ${dry.skipped.join(', ')}.`) : null,
          h('li', 'It goes into the map once the clone has worked.')),
        h('p.hint', GET_NOTE),
        dry.lines.length ? fold('find-get-details', 'Details', h('pre.output', dry.lines.join('\n'))) : null,
        h('div.sheet-actions', back(), btn('primary', { icon: 'download', label: 'Get it', onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          try {
            await api('/api/workspace/find/get', { in: place, repo: p.parent, seen: dry.seen });
          } catch (e) {
            return fill(box, errorBox(refusalWords(e)), h('div.sheet-actions', back()));
          }
          changed = true;
          gotStep(dry);
        } })));
    }
    async function gotStep(dry) {
      const out = h('pre.output');
      const res = h('div', { 'aria-live': 'polite' }, busy(`Getting ${dry.place}/${dry.folder}…`));
      fill(box, out, res);
      let from = 0;
      let j;
      for (;;) {
        j = await api(`/api/workspace/job?from=${from}`);
        if (j.lines.length) {
          add(out, `${j.lines.join('\n')}\n`);
          out.scrollTop = out.scrollHeight;
        }
        from = j.next;
        if (!j.running) break;
        await sleep(700);
      }
      const r = j.result || {};
      const ok = r.ok && r.data && r.data.ok;
      fill(res,
        ok ? okBox(`${r.data.ref || `${dry.place}/${dry.folder}`} is on this computer now.`) : errorBox((r.data && r.data.message) || r.error || 'It could not be fetched.'),
        h('div.sheet-actions', back(), btn('primary', { label: 'Done', onclick: () => close() })));
    }
    look();
    return [box];
  }).then(() => {
    if (changed) refresh();
  });
}
