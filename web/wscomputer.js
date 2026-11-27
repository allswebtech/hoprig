// This computer in the workspace (src/workspace/computer.mjs) and set-up's one path in the page:
//   computerPanel()   Settings → Workspace: this computer's label (given once; the host name is only offered)
//   githubPath(after) the fresh computer's choice on the Workspace page once GitHub is signed in: the owner's brain on
//                     GitHub found → get it (no project comes by itself); none → start the workspace and keep its
//                     brain in a new private repository
import { icon } from './icons.js';
import { api, btn, fill, h, link, toast } from './lib.js';
import { errorBox, okBox } from './shell.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyLine = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));

/** The label form: one field with the suggestion as its placeholder; a taken label asks whether this IS that computer. */
function labelForm(suggestion, done) {
  const input = h('input.field.mono', { placeholder: suggestion || 'box2', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 32, 'aria-label': 'This computer\'s name in your workspace' });
  const res = h('div', { 'aria-live': 'polite' });
  const send = async (again = false) => {
    const label = (input.value.trim() || '').toLowerCase();
    if (!label) return void fill(res, errorBox('Type a short name, for example the one shown in the field.'));
    try {
      const r = await api('/api/workspace/label', { label, ...(again ? { again: true } : {}) });
      toast(r.state === 'back' ? `This computer is ${r.label} again` : `This computer is ${r.label}`);
      done();
    } catch (e) {
      if (/is taken/.test(e.message)) {
        return void fill(res, h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${label} is the name of another computer of yours. Is this computer ${label}, set up again (after a format, for example)? Its list of what is here then starts empty.`)),
          h('div.btnrow', btn('small secondary', { label: `Yes, this is ${label}`, onclick: () => send(true) }), btn('small ghost', { label: 'No, another name', onclick: () => (fill(res), input.focus()) })));
      }
      fill(res, errorBox(e));
    }
  };
  return h('div',
    h('label.fieldrow', h('span.field-label', 'This computer\'s name in your workspace'),
      h('div.inlineform', input, btn('small primary', { label: 'Save', onclick: () => send() })),
      h('span.hint', 'Lower-case letters, digits, "-" and "_". Given once; written into the AI brain, so it is not the same as the computer\'s name in the dashboard.')),
    res);
}

/**
 * Settings → Workspace, in "Where things are": this computer's name in the workspace. Which computer has what is
 * on the Workspace page ("Your computers"), not repeated here.
 */
export function computerPanel() {
  const box = h('div.ws-name', busyLine('…'));
  const load = () => api('/api/workspace/computers').then((d) => {
    fill(box,
      d.label
        ? h('p.hint', `This computer is `, h('strong', d.label), ' in your workspace. The name is written into the AI brain, so it is not the same as the computer\'s name in the dashboard.')
        : labelForm(d.suggestion, load),
      d.folderWhy ? errorBox(d.folderWhy) : null);
  }, (e) => fill(box, errorBox(e)));
  load();
  return box;
}

/** Follow the workspace's background job until it ends; resolves its answer. */
async function followJob(out) {
  let from = 0;
  for (;;) {
    const r = await api(`/api/workspace/job?from=${from}`);
    if (r.lines.length) out.textContent += `${r.lines.join('\n')}\n`;
    from = r.next;
    if (!r.running) return r;
    await sleep(700);
  }
}

/**
 * Set-up's one path for a fresh computer that is signed in to GitHub: the owner's brain found on GitHub → one press
 * gets it (the brain with the map, the credentials and groups' repositories; projects come when asked); none → one
 * press starts the workspace and keeps its brain in a new private repository. Null while not signed in.
 */
export function githubPath(after, { onOffer = () => {} } = {}) {
  const box = h('div.ws-github', { style: { margin: '4px 0 16px' } });
  const out = h('pre.output.hidden');
  const res = h('div', { 'aria-live': 'polite' });
  const run = async (b, call) => {
    b.disabled = true;
    out.classList.remove('hidden');
    fill(res, busyLine('Working…'));
    try {
      await call();
      const j = await followJob(out);
      const r = j.result || {};
      if (r.error || (r.data && r.data.ok === false)) return void (fill(res, errorBox(r.error || 'It did not finish: see the output.')), (b.disabled = false));
      const away = r.data && r.data.notHere ? r.data.notHere.length : 0;
      fill(res, okBox(away ? `Done. ${plural(away, 'project')} of your map ${away === 1 ? 'is' : 'are'} not on this computer: get one when you need it.` : 'Done.'));
      after();
    } catch (e) {
      fill(res, errorBox(e));
      b.disabled = false;
    }
  };
  api('/api/workspace/git/brains').then((d) => {
    if (!d.signedIn) return;
    // GitHub could not be asked: say so, and offer no new workspace (the owner's own may be one it could not see).
    if (d.error) {
      const why = d.error.replace(/^GitHub could not be asked about your workspace: /, '');
      return void fill(box, h('p.ws-fresh-lead', 'GitHub could not be asked about your workspace right now.'), h('p.hint', `${why.charAt(0).toUpperCase()}${why.slice(1)}. Nothing was started: open this page again later.`));
    }
    const b = d.brains[0];
    const press = b
      ? btn('primary', { icon: 'download', label: `Get my workspace from ${b.owner}/${b.name}`, onclick: (e) => run(e.currentTarget, () => api('/api/workspace/restore', { url: b.url })) })
      : btn('primary', { icon: 'git', label: 'Start my workspace on GitHub', onclick: (e) => run(e.currentTarget, () => api('/api/workspace/git/brain', {})) });
    fill(box,
      h('p.ws-fresh-lead', b ? 'Your workspace is on GitHub.' : 'No workspace of yours on GitHub yet.'),
      h('p.hint', b
        ? ['The AI brain with its map, your credentials and your groups come to this computer. Projects stay in the map until you get one.', d.brains.length > 1 ? [` (${d.brains.length} repositories look like a brain: this is the first; `, h('a', { href: link('#/settings/workspace') }, 'Settings → Workspace'), ' has the others.)'] : null]
        : 'This makes the workspace here, its AI brain and the first map, and keeps the brain in a new private GitHub repository. Only you can see it.'),
      h('div.btnrow', { style: { marginTop: '12px' } }, press), out, res);
    onOffer(); // the one main button on the page now
  }, () => null);
  return box;
}
