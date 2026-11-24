// "Also open" in the new-session sheet (newsession-popup.js): other projects of the workspace map that this one session
// may read (its file tools cannot write there), as extra folders of its coding tool (src/workspace/needs.mjs). Closed,
// before the project choice (a tap on a project row starts the session). The project's own needs (its project.json's
// "needs") come by themselves once the owner allowed them on this computer (a project.json can come from anyone): each
// one here shows "allow" or "take back" (POST /api/folders/extras/accept). Every name is checked again on the server;
// nothing is written to the project. Claude Code only: another coding tool cannot keep an extra folder read-only, so it says so instead.
import { icon } from './icons.js';
import { api, at, h } from './lib.js';
import { fold } from './shell.js';

/** What may be opened beside a session in `folder` (null: before a project is chosen), or null on an older computer. */
export async function alsoChoices(m, folder) {
  try {
    return await api(at(m, `/api/folders/extras${folder ? `?${new URLSearchParams({ path: folder })}` : ''}`));
  } catch {
    return null; // an older computer (no such route), or no workspace map: nothing to offer
  }
}

/**
 * The fold, or null when there is nothing to offer. o: { data (alsoChoices), chosen (names, changed here), tool (the
 * coding tool's id), toolName, onchange(), onallow(name, yes) (absent: no button) }.
 */
export function alsoOpen({ data, chosen, tool, toolName, onchange, onallow = null }) {
  if (!data || (!data.choices.length && !data.needs.length)) return null;
  const n = chosen.length;
  const label = n ? `Also open (${n})` : 'Also open';
  if (tool && tool !== 'claude') {
    return fold('new-also', label, h('p.hint', `${toolName} gets no extra folders: Hoprig cannot keep them read-only there. Choose Claude Code to read another project beside this one.`));
  }
  const needs = data.needs.length
    ? h('div.ns-also-needs',
      h('p.ns-also-head', `${data.project} needs, and gets by itself once you allow it here:`),
      h('ul.ns-also-list', data.needs.map((x) => {
        const open = x.here && x.accepted !== false;
        const words = x.here ? (open ? `${data.project} reads ${x.name}` : `${data.project} reads ${x.name}: not allowed on this computer yet, so it is not opened`)
          : x.fix ? `${data.project} reads ${x.name}: not on this computer, so it is not opened (${x.fix})${x.accepted ? '; allowed once it is here' : ''}` : `${x.name}: not opened: ${x.why || 'it cannot be an extra folder'}`;
        const can = onallow && (x.here || x.fix) && x.accepted !== undefined;
        return h('li', icon(open ? 'check' : 'alert', { size: 15 }), h('span', words),
          can ? h('button.btn.small.secondary.ns-also-allow', { type: 'button', 'data-key': `allow:${x.name}`, 'aria-label': `${x.accepted ? 'Take back' : 'Allow'}: ${data.project} reads ${x.name}`, onclick: () => onallow(x.name, !x.accepted) }, x.accepted ? 'Take back' : 'Allow') : null);
      })))
    : null;
  const boxes = data.choices.map((name) => h('label.toggle-line.ns-also-pick',
    h('input', { type: 'checkbox', checked: chosen.includes(name), 'data-key': `also:${name}`, 'data-startctl': '', onchange: (e) => {
      const at2 = chosen.indexOf(name);
      if (e.target.checked && at2 < 0) chosen.push(name);
      if (!e.target.checked && at2 >= 0) chosen.splice(at2, 1);
      onchange();
    } }),
    h('span', name)));
  return fold('new-also', label,
    h('p.hint', 'Other projects this one session may read. Its file tools cannot write there; a shell command still could. Nothing is saved in the project.'),
    needs,
    boxes.length ? h('div.ns-also-picks', { role: 'group', 'aria-label': 'Projects to open beside it' }, boxes) : null,
    data.project ? null : h('p.hint', 'A project\'s own needs come with it by themselves.'));
}
