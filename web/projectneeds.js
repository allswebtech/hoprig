// A project's needs on its page (web/projects.js): what its project.json names in "needs", and the owner's yes for each
// one ON THIS COMPUTER (src/workspace/needsyes.mjs): a project.json can come from anyone, so a need is opened to the
// project's sessions only after "Allow", and "Take back" closes it again from their next start. Nothing is written to
// the project. Shown only when it names a need.
import { icon } from './icons.js';
import { api, fill, h, toast } from './lib.js';
import { groupHead } from './shell.js';

/** The list, from GET /api/folders/extras; an older computer or no workspace map: nothing. */
export async function needsBlock(box, dir) {
  let d;
  try {
    d = await api(`/api/folders/extras?${new URLSearchParams({ path: dir })}`);
  } catch {
    return fill(box);
  }
  if (!d || !d.project || !d.needs.length) return fill(box);
  const allow = async (name, yes, b) => {
    b.disabled = true;
    try {
      await api('/api/folders/extras/accept', { path: dir, need: name, allow: yes });
    } catch (e) {
      b.disabled = false;
      return toast(e, { kind: 'error', ms: 7000 });
    }
    needsBlock(box, dir);
  };
  fill(box,
    groupHead('Needs'),
    h('p.hint.pj-lead', `Other projects ${d.project} reads, named in its project.json. Its sessions get one only after you allow it on this computer; their file tools cannot write there (a shell command still could).`),
    h('ul.ns-also-list', d.needs.map((x) => {
      const open = x.here && x.accepted;
      const words = x.here ? (open ? `${x.name}: its sessions read it` : `${x.name}: not allowed on this computer yet, so it is not opened`)
        : x.fix ? `${x.name}: not on this computer (${x.fix})${x.accepted ? '; allowed once it is here' : ''}` : `${x.name}: not opened: ${x.why || 'it cannot be an extra folder'}`;
      const can = (x.here || x.fix) && x.accepted !== undefined;
      return h('li', icon(open ? 'check' : 'alert', { size: 15 }), h('span', words),
        can ? h('button.btn.small.secondary.ns-also-allow', { type: 'button', 'aria-label': `${x.accepted ? 'Take back' : 'Allow'}: ${d.project} reads ${x.name}`, onclick: (e) => allow(x.name, !x.accepted, e.currentTarget) }, x.accepted ? 'Take back' : 'Allow') : null);
    })));
}
