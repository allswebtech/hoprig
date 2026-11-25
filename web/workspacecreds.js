// The credentials folder on the Workspace page (Settings → Workspace, in Workspace folders): where it is kept (on this
// computer only, or in a private repository of yours, with its address, never a file of it) and, for a plain folder,
// "Make it a private repository": a new private repository on GitHub, or the address of one you made yourself. The
// sheet shows the server's dry run of `hoprig workspace credentials` (the cost, the steps, the visibility, that there
// is no undo), and the yes is the repository's name typed: the server compares it and runs the step as the
// workspace's background job (GET and POST /api/workspace/credentials, src/workspace/credweb.mjs).
import { icon } from './icons.js';
import { add, api, btn, fill, h, openSheet } from './lib.js';
import { errorBox, okBox } from './shell.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyLine = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));
const upper = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const MAKE = 'Make it a private repository';

/** The credentials line of the Workspace folders panel; empty while there is no folder (its own row says so). */
export function credentialsPart() {
  const box = h('div.ws-creds');
  async function load() {
    let s;
    try {
      s = await api('/api/workspace/credentials');
    } catch (e) {
      return fill(box, e.status === 404 ? null : errorBox(e, load)); // 404: a computer with an older Hoprig
    }
    if (s.folder !== 'folder' && s.folder !== 'repository') return fill(box);
    const repo = s.folder === 'repository';
    const where = s.remote || s.map;
    const sub = repo
      ? where ? `At ${where}. Restore brings it to a new computer right after the AI brain.` : 'A git repository with no address yet.'
      : 'Never in git: a new computer of yours does not get them.';
    const next = repo ? null
      : s.mapVersion === 2 ? h('div.savebar.start', btn('secondary', { icon: 'lock', label: MAKE, onclick: () => credsSheet(load) }))
        : h('p.hint', s.mapVersion === 1
          ? 'To keep them in a private repository of yours, upgrade the workspace map first (The map, below on this page).'
          : 'To keep them in a private repository of yours, make the workspace map first (The map, below on this page).');
    fill(box,
      h('div.rows', h('div.row.static',
        h(`span.row-icon.ws-mark${repo && where ? '.ok' : ''}`, icon(repo ? 'lock' : 'key', { size: 16 })),
        h('span.row-main',
          h('span.row-title.ws-wrap', repo ? 'Credentials: in a private repository of yours' : 'Credentials: on this computer only'),
          h('span.row-sub.ws-wrap', sub)))),
      next);
  }
  load();
  return box;
}

/** The sheet: choose where, read the dry run, type the name; then the job's lines and its answer. */
function credsSheet(after) {
  let alive = true;
  openSheet({ title: MAKE, subtitle: 'Your credentials folder, kept in a private git repository of yours', wide: true }, (close) => {
    const panelBox = h('div');
    let choice = 'github';
    let nameValue = 'credentials';
    let addrValue = '';
    function stepChoose(error = '') {
      const choices = h('div.choice-list', { role: 'radiogroup', 'aria-label': 'Where to keep them' });
      const fields = h('div');
      const err = h('p.form-error', { role: 'alert' }, error);
      const card = (id, ic, title, sub) => h(`button.choice${choice === id ? '.current' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(choice === id), onclick: () => ((choice = id), draw()) },
        h('span.choice-icon', icon(ic)), h('span.choice-main', h('span.choice-label', title), h('span.choice-sub', sub)));
      const look = btn('primary', { icon: 'chevronRight', label: 'Look at the plan', onclick: async () => {
        const body = choice === 'github' ? { github: nameValue.trim() || true, dryRun: true } : { repo: addrValue.trim(), dryRun: true };
        if (choice === 'repo' && !body.repo) return void (err.textContent = 'Type the address of your repository.');
        look.disabled = true;
        fill(err, busyLine(choice === 'github' ? 'Asking GitHub…' : 'Asking the git server…'));
        try {
          const plan = await api('/api/workspace/credentials', body);
          if (alive) stepPlan(body, plan);
        } catch (e) {
          look.disabled = false;
          fill(err, e.message);
        }
      } });
      function draw() {
        fill(choices,
          card('github', 'plus', 'A new private repository on GitHub', 'Hoprig creates it private, in the GitHub account this computer is signed in to.'),
          card('repo', 'git', 'A repository I made myself', 'Its address, on GitHub or another git server. It must be private.'));
        fill(fields, choice === 'github'
          ? h('label.fieldrow', h('span.field-label', 'Its name'), h('input.field.mono', { value: nameValue, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (nameValue = e.target.value) }))
          : h('label.fieldrow', h('span.field-label', 'Its address'), h('input.field.mono', { value: addrValue, placeholder: 'https://git.example.com/you/credentials.git', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (addrValue = e.target.value) })));
      }
      draw();
      fill(panelBox,
        choices, fields,
        h('p.hint', 'A new computer of yours then gets your credentials with the AI brain. Nothing changes before you look at the plan and type its name.'),
        err,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), look));
    }
    function stepPlan(body, p) {
      const err = h('p.form-error', { role: 'alert' });
      const typed = h('input.field.mono', { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', oninput: () => ready() });
      const sure = h('input', { type: 'checkbox', onchange: () => ready() });
      const go = btn('primary', { icon: 'lock', label: MAKE, disabled: true, onclick: () => yes() });
      const ready = () => (go.disabled = !typed.value.trim() || (!p.github && !sure.checked));
      async function yes() {
        go.disabled = true;
        fill(err, busyLine('Starting…'));
        const { dryRun, ...real } = body;
        try {
          await api('/api/workspace/credentials', { ...real, seen: p.seen, typed: typed.value, ...(p.github ? {} : { confirmNotGithub: sure.checked }) });
        } catch (e) {
          fill(err, e.message, e.status === 409 ? [' ', btn('secondary small', { label: 'Look again', onclick: () => stepChoose() })] : null);
          return ready();
        }
        if (alive) run();
      }
      fill(panelBox,
        h('div.banner.warn', icon('alert', { size: 18 }), h('span', p.cost)),
        h('p.field-label', 'What happens'),
        h('ol.hint', p.steps.map((s) => h('li', upper(s)))),
        h('p.hint', p.visibility),
        h('p.hint', p.undo),
        p.github ? null : h('label.toggle-line', sure, h('span', 'It is private: only I can read it')),
        h('label.fieldrow', h('span.field-label', `Type ${p.name} to go ahead`), typed),
        err,
        h('div.sheet-actions', btn('secondary', { icon: 'back', label: 'Back', onclick: () => stepChoose() }), go));
      typed.focus();
    }
    async function run() {
      const out = h('pre.output');
      const result = h('div', { 'aria-live': 'polite' }, busyLine('Making it a repository and pushing it…'));
      fill(panelBox, out, result);
      let from = 0;
      let j;
      for (;;) {
        try {
          j = await api(`/api/workspace/job?from=${from}`);
        } catch (e) {
          return fill(result, errorBox(e));
        }
        if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
        from = j.next;
        if (!j.running || !alive) break;
        await sleep(700);
      }
      if (!alive) return;
      const r = j.result || {};
      const why = (r.data && r.data.why) || r.error;
      fill(result,
        r.ok ? okBox('Done: your credentials are in your private repository, and the map names it.') : errorBox(why || 'It stopped without an answer.'),
        h('div.sheet-actions', btn('primary', { label: 'Close', onclick: () => close() })));
    }
    stepChoose();
    return [panelBox];
  }).then(() => {
    alive = false;
    after();
  });
}
