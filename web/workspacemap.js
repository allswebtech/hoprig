// Two lines of the map panel in Settings → Workspace (web/workspace.js mapPanel), each a sheet that shows its look
// before anything changes (docs/WORKSPACE.md, "The map's old form" and "A folder that differs only in letter case"):
//   - a map in the old form (version 1): "See what the upgrade changes" (POST /api/workspace/map/upgrade), with
//     Undo while the map is what the upgrade wrote;
//   - a folder whose name differs from its map entry only in letter case: "Give it the map's name"
//     (POST /api/workspace/map/case), with Undo.
// The yes sends the look's id back: a look that is not the one shown is refused ("This changed since you looked").
import { api, btn, fill, h, openSheet } from './lib.js';
import { errorBox, okBox } from './shell.js';
import { icon } from './icons.js';

export const OLD_FORM = 'Your workspace map is in the old form';
export const UPGRADED_HINT = 'The map was upgraded on this computer. Undo puts the old form back while the map has not changed since.';
export const RENAMED_HINT = 'A folder was given its name in the map on this computer.';
export const OLD_FORM_HINT = 'The new form knows groups of projects. Nothing on disk changes, and you can undo it on this computer.';
const busy = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));
const list = (items) => (items && items.length ? h('ul.map-diff', items.map((x) => h('li', x))) : null);

/**
 * One sheet: the look (`look()` → the route's dry run), its lines, and the yes (`yes(seen)`). `words(r)`: { lines,
 * after, ok } from the look; `done(r)`: the sentence after.
 */
function lookSheet({ title, subtitle, look, words, yes, done }, refresh) {
  openSheet({ title, subtitle }, (close) => {
    const box = h('div', busy('Looking…'));
    look().then((r) => {
      const w = words(r);
      fill(box,
        w.text ? h('p.sheet-text', w.text) : null,
        list(w.lines),
        w.after && w.after.length ? [h('p.field-label', 'Undo'), list(w.after)] : null,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', autofocus: true, onclick: () => close() }, w.ok ? 'Cancel' : 'Close'),
          w.ok ? btn('primary', { icon: 'check', label: w.ok, onclick: () => go(r.seen) }) : null));
    }, (e) => fill(box, errorBox(e)));
    async function go(seen) {
      fill(box, busy('Working…'));
      try {
        const r = await yes(seen);
        fill(box, okBox(done(r)), h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Done')));
        refresh();
      } catch (e) {
        fill(box, errorBox(e), h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Close')));
      }
    }
    return [box];
  });
}

const UPGRADE = '/api/workspace/map/upgrade';
const CASE = '/api/workspace/map/case';

function upgradeSheet(refresh) {
  lookSheet({
    title: 'Upgrade the map', subtitle: 'From the old form to the new one',
    look: () => api(UPGRADE, { dryRun: true }),
    words: (r) => (r.already ? { text: 'The map is in the new form already.' } : { text: 'This is what the upgrade changes:', lines: r.lines, after: r.undo, ok: 'Upgrade the map' }),
    yes: (seen) => api(UPGRADE, { seen }),
    done: () => 'The map is in the new form. Save it in the AI brain\'s history when your other computers are ready for it.',
  }, refresh);
}

function upgradeUndoSheet(refresh) {
  lookSheet({
    title: 'Undo the upgrade', subtitle: 'The map in its old form again',
    look: () => api(UPGRADE, { dryRun: true, undo: true }),
    words: (r) => (r.can ? { lines: r.lines, ok: 'Put the old map back' } : { text: r.why }),
    yes: (seen) => api(UPGRADE, { undo: true, seen }),
    done: () => 'The old map is back on this computer.',
  }, refresh);
}

function caseSheet(refresh, undo = false) {
  lookSheet({
    title: undo ? 'Give the folders their old names back' : 'Give the folder its name in the map',
    subtitle: undo ? 'The same rename, back' : 'Through a temporary name, in the same folder',
    look: () => api(CASE, { dryRun: true, ...(undo ? { undo: true } : {}) }),
    words: (r) => {
      const steps = r.steps || [];
      const can = undo ? r.can : steps.some((s) => s.action);
      if (!steps.length) return { text: undo ? r.why : 'Every folder has the name the map gives it.' };
      return { lines: steps.map((s) => (s.unseen ? `${s.words} ${s.unseen}` : s.words)), ...(undo && !r.can ? { text: r.why } : {}), ...(can ? { ok: undo ? 'Rename back' : 'Rename' } : {}) };
    },
    yes: (seen) => api(CASE, { seen, ...(undo ? { undo: true } : {}) }),
    done: (r) => (r.undone || r.done || []).map((d) => `${d.from} is ${d.to} now.`).join(' ') || 'Nothing was renamed.',
  }, refresh);
}

/** The lines for the map panel, from GET /api/workspace/map (`m`): null when there is nothing to say. */
export function mapExtras(m, refresh) {
  if (!m || m.errors) return null;
  const old = m.exists && m.map && m.map.version === 1;
  const cases = m.caseOnly || [];
  if (!old && !m.upgradeUndo && !cases.length && !m.caseUndo) return null;
  return h('div.map-extras',
    old ? [h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${OLD_FORM}.`)), h('p.hint', OLD_FORM_HINT),
      h('div.savebar.start', btn('secondary', { icon: 'eye', label: 'See what the upgrade changes', onclick: () => upgradeSheet(refresh) }))] : null,
    m.upgradeUndo ? [h('p.hint', UPGRADED_HINT), h('div.savebar.start', btn('ghost', { icon: 'undo', label: 'Undo the upgrade', onclick: () => upgradeUndoSheet(refresh) }))] : null,
    cases.length ? [h('div.banner.warn', icon('alert', { size: 18 }), h('span', cases.map((c) => `${c.words}.`).join(' '))),
      h('div.savebar.start', btn('secondary', { icon: 'pencil', label: cases.length === 1 ? 'Give it the map\'s name' : 'Give them the map\'s names', onclick: () => caseSheet(refresh) }))] : null,
    m.caseUndo ? [h('p.hint', RENAMED_HINT), h('div.savebar.start', btn('ghost', { icon: 'undo', label: 'Undo the rename', onclick: () => caseSheet(refresh, true) }))] : null);
}
