// What a project needs, on the page's Get once the project is here (POST /api/pcsetup/project/needs, getneeds.mjs):
// the terminal's own lines and question (`hoprig get`), with one press "Get them too" doing what its yes does (each
// need by the same get; a need's own setup questions are never answered, as --yes never answers them) and "Not now".
// What a need just got names in its turn comes back as a new offer, never got without another press.
import { api, btn, fill, h } from './lib.js';
import { errorBox, okBox } from './shell.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyLine = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));

/** The offer `v` (the route's dry run) in `box`; `alive()`: the page is still open. */
export function needsOffer(box, v, { alive = () => true } = {}) {
  const out = h('pre.output.pj-log.hidden', { 'aria-live': 'polite' });
  const res = h('div', { role: 'status' });
  // Only needs that are here and not allowed yet: the press allows them, it gets nothing.
  const yes = btn('primary', { icon: v.missing.length ? 'download' : 'check', label: v.missing.length ? `Get ${v.missing.length === 1 ? 'it' : 'them'} too` : 'Allow', onclick: async () => {
    yes.disabled = true;
    no.disabled = true;
    out.classList.remove('hidden');
    fill(res, busyLine(v.missing.length ? 'Getting them…' : 'Allowing…'));
    let r;
    try {
      await api('/api/pcsetup/project/needs', { name: v.project, seen: v.seen });
      r = await follow(out, alive);
    } catch (e) {
      yes.disabled = false;
      no.disabled = false;
      return void fill(res, errorBox(e));
    }
    if (!r || !alive()) return;
    const d = (r.result && r.result.data) || null;
    const bad = d ? d.got.filter((x) => !x.ok) : [];
    fill(res,
      d && !bad.length ? okBox(d.got.length ? `Got ${d.got.map((x) => x.name).join(', ')}. Its sessions read ${d.got.length === 1 ? 'it' : 'them'}.` : `Allowed on this computer: ${d.allowed}.`) : errorBox((r.result && r.result.error) || (bad.length ? `${bad.map((x) => x.name).join(', ')} could not be got: see the details.` : 'It stopped without a result.')),
      ...(d ? d.more : []).map((m) => { const b = h('div'); needsOffer(b, m, { alive }); return b; }));
  } });
  const no = btn('secondary', { label: 'Not now', onclick: () => fill(box, h('p.hint', `Nothing more was got. Later:  ${v.later}`)) });
  fill(box, h('section.card.panel.pj-needs',
    h('h2.panel-title', `What ${v.project} needs`),
    h('ul.pj-will', v.lines.map((l) => h('li', l))),
    v.ask ? [h('p.sheet-text', v.question), h('p.hint', 'Each one comes the way Get brings a project. What a project asks before it installs anything is left for you on its own page.'), h('div.pj-next', no, yes)] : null,
    out, res));
}

/** The workspace-wide setup job until it ends. */
async function follow(out, alive) {
  let from = 0;
  for (;;) {
    await sleep(700);
    if (!alive()) return null;
    const j = await api(`/api/pcsetup/job?from=${from}`).catch(() => null);
    if (!j) continue;
    if (j.lines.length) out.textContent += `${j.lines.join('\n')}\n`;
    from = j.next;
    if (!j.running) return j;
  }
}

/** After Get: the offer for project `ref` (<name> or <place>/<name>), or nothing when it names no need. */
export function needsAfterGet(ref, { alive = () => true } = {}) {
  const box = h('div');
  api('/api/pcsetup/project/needs', { name: ref, dryRun: true }).then((v) => {
    if (alive() && v.lines && v.lines.length) needsOffer(box, v, { alive });
  }, () => null); // an older computer has no such route: Get is done all the same
  return box;
}
