// Workspace → Projects found on this computer (src/adopt/feature.mjs): the three steps of `hoprig adopt` for a person
// who never opens a terminal. Look: the folders he ticks or types (nothing is looked at before his yes). Suggest: a
// plan per project as a readable page. Arrange: what will happen first, then each proof line, and that his old
// folders are untouched. Removing the old folders is not here: it needs the project's name typed on a terminal.
import { icon } from './icons.js';
import { api, btn, fill, h, link } from './lib.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, okBox, panel, stepHeader } from './shell.js';
import { commandLine } from './workspace.js';
import { RETIRE_LABEL, retireSheet } from './adoptretire.js';

const STEPS = ['Look', 'Suggest', 'Arrange'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A size in plain words: KB below a megabyte. */
export const sizeText = (b) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(1)} GB`);
const KIND = { ai: 'AI material', scripts: 'its own scripts', data: 'a copy of data (never in git, never read by AI tools)', note: 'a note', private: 'a private folder', installed: 'installed packages', own: 'the project\'s own', other: 'other' };

/** One repository's state, in plain words, and what makes a copy unsafe now. */
export function repoLine(r) {
  if (!r.ok) return { text: `git cannot read it: ${r.error}`, warn: '' };
  const bits = [`on ${r.branch}`, r.remote ? `remote ${r.remote}` : 'no remote'];
  if (r.upstream) bits.push(r.ahead || r.behind ? `${r.ahead} ahead, ${r.behind} behind (as of its last fetch)` : 'in step as of its last fetch');
  if (r.uncommitted) bits.push(`${plural(r.uncommitted, 'change')} not committed (copied as they are)`);
  if (r.eolOnly) bits.push(`${plural(r.eolOnly, 'file')} shown as changed that differ${r.eolOnly === 1 ? 's' : ''} in line endings only`);
  if (r.stashes) bits.push(plural(r.stashes, 'stash', 'stashes'));
  if (r.otherBranches) bits.push(plural(r.otherBranches, 'other branch', 'other branches'));
  if (r.worktrees) bits.push(plural(r.worktrees, 'linked worktree'));
  bits.push(`${sizeText(r.bytes)} without dependencies`);
  const warn = r.busy ? `Not safe to copy now: ${plural(r.busy, 'program')} working in it. Arrange waits until it ends.` : r.recent ? `${plural(r.recent, 'file')} changed within the hour. If you are still working in it, finish first.` : '';
  return { text: bits.join(' · '), warn };
}

function viewAdopt({ frame }) {
  const box = h('div.adopt');
  frame({ title: 'Projects found on this computer', page: 'adopt', back: link('#/workspace'), backLabel: 'Projects',
    intro: 'Copies projects here. Nothing is moved.', body: [box] });
  let alive = true;
  let state = null; // GET /api/adopt

  /** Give `el` the keyboard focus (a banner or a heading first gets tabindex -1). */
  const focusOn = (el) => {
    if (!el) return;
    if (!/^(A|BUTTON|INPUT)$/.test(el.tagName)) el.setAttribute('tabindex', '-1');
    el.focus();
  };
  const load = async (from = null) => {
    try {
      state = await api('/api/adopt');
      if (alive) (state.projects.length ? found(state, from) : look());
    } catch (e) {
      if (alive) {
        fill(box, stepHeader(STEPS, 0), errorBox(e, () => load(from)));
        focusOn(box.querySelector('.banner'));
      }
    }
  };

  // ---- Look: the folders, his yes ----
  function look(error = '') {
    const ticks = state.usual.map((d) => {
      const input = h('input', { type: 'checkbox', value: d });
      return { input, el: h('label.check', input, h('span.mono', d)) };
    });
    const typed = h('input.field', { placeholder: '~/code or D:\\work', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Another folder to look in' });
    const err = h('p.form-error', { role: 'alert' }, error);
    const go = btn('primary', { icon: 'search', label: 'Look in these folders', type: 'submit' });
    fill(box, stepHeader(STEPS, 0), homePanel(), h('form.adopt-form', { onsubmit: async (e) => {
      e.preventDefault();
      const places = [...ticks.filter((t) => t.input.checked).map((t) => t.input.value), ...typed.value.split('\n').map((s) => s.trim()).filter(Boolean)];
      if (!places.length) return void (err.textContent = 'Tick a folder or type one: nothing is looked at until you do.');
      go.disabled = true;
      fill(go, h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Looking…'));
      try {
        const r = await api('/api/adopt/scan', { places });
        state = { ...state, home: null, ...r };
        if (alive) found(state);
      } catch (x) {
        if (alive) look(x.message);
      }
    } },
    panel({ icon: 'folder', title: 'Where are your projects?', desc: 'Hoprig looks only in the folders you choose here. It reads them and changes nothing: no file, no git setting, nothing is fetched. A private folder (no-ai, ignore) is never looked into.' },
      state.usual.length ? [h('p.hint', 'Folders where projects are often kept, found on this computer (none was opened):'), h('div.checks.adopt-places', ticks.map((t) => t.el))] : h('p.hint', 'None of the usual folders (code, projects, src, …) is here: type the folder your projects are in.'),
      h('label.fieldrow', h('span.field-label', 'Another folder'), typed),
      err, h('div.pj-next', go))));
    (ticks[0] ? ticks[0].input : typed).focus();
  }

  // ---- Find the projects of the home folder: one press, a look with a budget (src/adopt/home.mjs) ----
  function homePanel() {
    const err = h('p.form-error', { role: 'alert' });
    const go = btn('primary', { icon: 'search', label: 'Find the projects on this computer' });
    go.onclick = async () => {
      go.disabled = true;
      err.textContent = '';
      fill(go, h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Looking through your home folder…'));
      try {
        const r = await api('/api/adopt/home', {});
        state = { ...state, ...r };
        if (alive) found(state);
      } catch (x) {
        if (!alive) return;
        err.textContent = x.message;
        go.disabled = false;
        fill(go, icon('search', { size: 18 }), h('span', 'Find the projects on this computer'));
      }
    };
    return panel({ icon: 'search', title: 'Find them for me', desc: 'Hoprig looks through your home folder, 4 levels down, for at most 20 seconds. It reads only folder names and whether a folder holds .git or a file such as package.json: it opens no file and changes nothing. It never goes into hidden folders, private folders (no-ai, ignore), installed packages, your workspace or the system\'s own folders, and never follows a link.' },
      err, h('div.pj-next', go));
  }

  /** What the look over the home did, in plain words (null after a look in named folders). */
  function homeSummary(x) {
    if (!x) return null;
    const bits = [
      x.inWorkspace ? `${plural(x.inWorkspace, 'project')} already in your workspace (not listed)` : '',
      x.links.length ? `${plural(x.links.length, 'link')} not followed: ${x.links.join(', ')}` : '',
      x.privates ? `${plural(x.privates, 'private folder')} never looked into` : '',
      x.unreadable ? `${plural(x.unreadable, 'folder')} it could not read` : '',
    ].filter(Boolean);
    return h('div.adopt-home', h('p.hint', x.words), bits.length ? h('p.hint', `${bits.join(' · ')}.`) : null);
  }

  // ---- what was found ----
  /** `from`: the project you came back from (its card gets the focus), else the list's banner does. */
  function found(s, from = null) {
    const cards = s.projects.map((p) => h('section.card.adopt-project', { 'aria-label': p.name },
      h('div.card-top', h('span.card-name', p.name), p.arranged ? h('span.badge.ok', 'arranged') : p.layout ? h('span.badge.soft', 'already in the layout') : null),
      p.arranged ? h('p.hint', 'Arranged into ', h('span.mono', p.arrangedTo), '. Its old folder stays until you remove it (here, or on a terminal: ', h('span.mono', `hoprig adopt retire ${p.planName || p.name}`), ').') : null,
      p.arranged ? h('div.btnrow', { style: { marginTop: '8px' } }, btn('small danger', { icon: 'trash', label: RETIRE_LABEL, onclick: async () => ((await retireSheet(p.planName || p.name)) ? load(p.name) : null) })) : null,
      h('div.card-meta', h('span.card-path.mono', p.dir)),
      h('ul.adopt-repos', p.repos.map((r) => {
        const l = repoLine(r);
        return h('li', h('span.mono', r.dir === '.' ? 'the folder itself' : r.dir), ': ', l.text, l.warn ? h('div.card-note.adopt-warn', icon('alert', { size: 14 }), h('span', l.warn)) : null);
      })),
      p.ai.length ? h('p.hint', `AI tools' files: ${p.ai.join(', ')}`) : null,
      p.neighbours.length ? h('p.hint', `Beside it: ${p.neighbours.join(', ')}`) : null,
      p.privates ? h('p.hint', `${plural(p.privates, 'private folder')}: never looked into; copied, but its contents are not checked.`) : null,
      h('div.card-actions', p.arranged
        ? h('a.btn.primary', { href: link(`#/workspace/project/${encodeURIComponent(p.planName || p.name)}`) }, icon('folder', { size: 18 }), h('span', 'Open the project'))
        : btn('primary', { icon: 'sparkle', label: p.planned ? 'See its plan again' : 'Suggest a plan', onclick: () => suggest(p, p.planned && p.planName ? { name: p.planName } : {}) }))));
    fill(box, stepHeader(STEPS, 0),
      s.home ? okBox(`Looked through your home folder (${plural(s.home.folders, 'folder')}): ${plural(s.projects.length, 'project')} found. Nothing was opened, changed or fetched, and nothing is planned until you choose.`)
        : okBox(`Looked in ${s.places.filter((x) => x.ok).map((x) => x.dir).join(', ')}: ${plural(s.projects.length, 'project')} found. Nothing was changed and nothing was fetched.`),
      homeSummary(s.home),
      ...s.places.filter((x) => !x.ok).map((x) => errorBox(`${x.dir}: ${x.error}`)),
      s.projects.length ? h('div.ws-list.adopt-list', cards) : emptyState('folder', 'No project was found there: a project is a folder with a git repository or a file such as package.json.'),
      h('div.pj-next', btn('secondary', { icon: 'search', label: 'Look in other folders', onclick: () => look() })));
    const card = from && [...box.querySelectorAll('.adopt-project')].find((c) => c.getAttribute('aria-label') === from);
    focusOn(card ? card.querySelector('.card-actions .btn') : box.querySelector('.banner'));
  }

  // ---- Suggest: the plan as a page ----
  async function suggest(p, extra = {}) {
    fill(box, stepHeader(STEPS, 1), h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', `Making a plan for ${p.name}… (only a plan file in Hoprig's own folder is written)`)));
    let plan;
    try {
      plan = await api('/api/adopt/plan', { dir: p.dir, ...extra });
    } catch (e) {
      if (!alive) return;
      fill(box, stepHeader(STEPS, 1), errorBox(e), h('div.pj-next', btn('secondary', { icon: 'back', label: 'Back to the list', onclick: () => found(state, (state.projects.find((x) => x.dir === p.dir) || p).name) })));
      return void focusOn(box.querySelector('.banner'));
    }
    // The list shows it as planned from now on (its card offers the plan again, not a new one).
    for (const x of state.projects) if (x.dir === plan.from) Object.assign(x, { planned: true, planName: plan.name });
    if (alive) showPlan(plan);
  }

  /** `idError`: why the first commit's name and e-mail are needed (then they get the focus). */
  function showPlan(plan, idError = '') {
    const rows = (items) => h('ul.adopt-plan', items);
    const goes = [
      ...plan.repos.map((r) => h('li', h('span.mono', r.rel === '.' ? 'the repository' : r.rel), ' → ', h('span.mono', r.to), h('span.hint', (plan.leftOut || []).length ? ' copied: its history, stashes, uncommitted and ignored files, except what is left out below' : ' copied whole: its history, stashes, uncommitted and ignored files'),
        r.visibility ? h('div.hint', r.visibility.state === 'local' ? '' : 'On its server: ', r.visibility.state === 'public' ? h('strong', r.visibility.words) : r.visibility.words) : null,
        ...r.worktrees.map((w) => h('div.hint', 'with its worktree ', h('span.mono', w.from), ' → ', h('span.mono', w.to))))),
      ...plan.neighbours.filter((n) => n.to).map((n) => h('li', h('span.mono', n.from), ' → ', h('span.mono', n.to), h('span.hint', ` ${KIND[n.kind] || n.kind}${n.private ? ': copied, never looked into, so its contents are not checked' : n.why ? `: ${n.why}` : ''}`))),
    ];
    const stays = plan.neighbours.filter((n) => !n.to).map((n) => h('li', h('span.mono', n.from), h('span.hint', ` ${n.why || 'not part of the project'}${n.bytes !== null && n.bytes !== undefined ? ` (${sizeText(n.bytes)})` : ''}`)));
    const left = (plan.leftOut || []).map((l) => h('li', h('span.mono', l.at), h('span.hint', ` ${sizeText(l.bytes)}, ${plural(l.files, 'file')}: `), l.remake ? ['made again with ', h('span.mono', l.remake)] : 'made again by the project\'s own build or install'));
    const copyAll = btn('secondary', { label: 'Copy them all the same', onclick: () => suggest({ name: plan.name, dir: plan.from }, { copyInstalled: true, name: plan.name }) });
    // The project's name: the plan is made again under the name typed (the server checks it by the rule of a new project).
    const nameField = h('input.field', { value: plan.name, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'The project\'s name' });
    const nameErr = h('p.form-error', { role: 'alert' });
    const rename = btn('secondary', { label: 'Use this name', onclick: async () => {
      const name = nameField.value.trim();
      if (name === plan.name) return;
      rename.disabled = true;
      try {
        const again = await api('/api/adopt/plan', { dir: plan.from, name, ...(plan.copyInstalled ? { copyInstalled: true } : {}) });
        for (const x of state.projects) if (x.dir === again.from) Object.assign(x, { planned: true, planName: again.name });
        if (alive) showPlan(again);
      } catch (x) {
        rename.disabled = false;
        nameErr.textContent = x.message;
      }
    } });
    const reads = [
      ...plan.neighbours.filter((n) => n.read).map((n) => h('li', h('span.mono', n.from), n.kind === 'own' ? `: yours, kept in ${n.to}` : [': is it the plan the project came from, or a log with secrets in it? Arrange puts it in ', h('span.mono', n.to), ' unless you change the plan first.'])),
      ...plan.tools.rules.map((r) => h('li', h('span.mono', r.file), ` (${r.tool}): a rules file. Arrange copies it as it is; afterwards, decide what in it is about you (for the brain's rules) and what is about the project (it stays).`)),
      ...(plan.nested || []).map((x) => h('li', h('span.mono', x), ': an untracked folder inside a repository that looks like another project. It is copied with the repository; decide whether it belongs there before any first push.')),
      ...plan.tools.hooks.map((x) => h('li', h('span.mono', x.file), ` (${x.tool}): a hook. It is copied and never run; if it guards something, Claude Code needs its equal.`)),
    ];
    const tools = [
      ...plan.tools.skills.map((x) => h('li', `The ${x.tool} skill `, h('b', x.name), ': copied, with a pointer in ', h('span.mono', `.claude/skills/${x.name}`), ' so your coding tools find it.')),
      ...plan.sessions.map((x) => h('li', `${plural(x.count, `${x.tool} session`)}: ${x.moves ? 'copied under the new folders (the old ones stay)' : 'stay in that tool\'s own folder'}`)),
    ];
    const breaks = plan.breaks.map((b) => h('li', h('span.mono', `${b.file}${b.line ? `:${b.line}` : ''}`), b.link ? ' is a link into the old folder' : ' names the old folder'));
    const identity = { name: h('input.field', { autocomplete: 'name', 'aria-label': 'Your name for its first commit', placeholder: 'Your name' }), email: h('input.field', { type: 'email', autocomplete: 'email', 'aria-label': 'Your e-mail for its first commit', placeholder: 'you@example.com' }) };
    const err = h('p.form-error', { role: 'alert' }, idError);
    const arrange = btn('primary', { icon: 'check', label: `Arrange ${plan.name}` });
    const who = () => (identity.name.value.trim() || identity.email.value.trim() ? { name: identity.name.value.trim(), email: identity.email.value.trim() } : undefined);
    arrange.onclick = () => {
      const id = who();
      if (id && (!id.name || !id.email)) return void (err.textContent = 'Give both a name and an e-mail, or neither (then git\'s own are used).');
      run(plan, id);
    };
    fill(box, stepHeader(STEPS, 1),
      h('h2.adopt-title', `Plan for ${plan.name}`),
      h('p.hint', 'From ', h('span.mono', plan.from), ' into ', h('span.mono', plan.to), '. Nothing has been done yet.'),
      h('label.fieldrow', h('span.field-label', 'Project name'), nameField), h('p.hint', 'Letters, digits, ".", "_" and "-". The plan is made again under the name you give.'), nameErr, h('div.btnrow', rename),
      plan.found ? h('p.hint.adopt-found', plan.found) : null,
      plan.exists ? errorBox(`${plan.to} is there already: Arrange makes a new folder and never writes into one that exists.`) : null,
      panel({ icon: 'folderPlus', title: 'What goes where' }, rows(goes)),
      tools.length ? panel({ icon: 'book', title: 'Other tools\' files and sessions' }, rows(tools)) : null,
      stays.length ? panel({ icon: 'folder', title: 'What stays where it is' }, rows(stays)) : null,
      left.length ? panel({ icon: 'folder', title: 'Left out of the copy', desc: 'Installed packages and build output that git ignores: they are not copied, and each is made again with its command in the new folder. The proof counts them as left out.' }, rows(left), h('div.btnrow', copyAll))
        : plan.copyInstalled ? h('p.hint', 'Installed packages and build output are copied with the rest.') : null,
      breaks.length ? panel({ icon: 'alert', title: 'What would break when the old folder goes', desc: 'These files name the old place. They are listed, never changed by themselves: change each when you are ready.' }, rows(breaks)) : null,
      reads.length ? panel({ icon: 'eye', title: 'What to read before or after', desc: 'Arrange does not wait for these: it does with each what is said here. To change that first, edit the plan file, or read them with a coding session that follows the adopt-projects skill.' }, rows(reads)) : null,
      panel({ icon: 'check', title: 'Arrange', desc: 'Arrange copies everything above into the new folder, then compares each copy with its original (its commits, branches, stashes, uncommitted work, worktrees, every file, git fsck). If anything differs, it stops and removes only what it made. Your old folders are not changed, renamed or deleted, and nothing is committed for you, fetched or pushed.' },
        h('p.hint', 'The new folder gets one first commit of Hoprig\'s own files. Under which name? (empty: git\'s own)'),
        h('div.adopt-who', identity.name, identity.email), err,
        h('div.pj-next', arrange, btn('secondary', { label: 'See what it would do', onclick: () => run(plan, who(), true) }), btn('ghost', { icon: 'back', label: 'Back to the list', onclick: () => found(state, (state.projects.find((x) => x.dir === plan.from) || plan).name) }))));
    box.querySelector('h2').setAttribute('tabindex', '-1');
    (idError ? identity.name : box.querySelector('h2')).focus();
  }

  // ---- Arrange: its proof ----
  async function run(plan, identity, dryRun = false) {
    fill(box, stepHeader(STEPS, 2), h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', dryRun ? 'Working out what it would do…' : `Copying ${plan.name} and comparing each copy with its original…`)));
    let r;
    try {
      r = await api('/api/adopt/apply', { name: plan.name, ...(dryRun ? { dryRun: true } : {}), ...(identity ? { identity } : {}) });
    } catch (e) {
      if (e.code === 'ENOIDENTITY' && alive) return void showPlan(plan, e.message);
      const changed = e.code === 'ECHANGED';
      if (!alive) return;
      fill(box, stepHeader(STEPS, 2), errorBox(e),
        h('div.pj-next', changed ? btn('primary', { icon: 'refresh', label: 'Make the plan again', onclick: () => suggest({ name: plan.name, dir: plan.from }, { name: plan.name, ...(plan.copyInstalled ? { copyInstalled: true } : {}) }) }) : null, btn('secondary', { icon: 'back', label: 'Back to the plan', onclick: () => showPlan(plan) })));
      return void focusOn(box.querySelector('.banner'));
    }
    if (!alive) return;
    const proof = h('ul.adopt-proof', { 'aria-label': 'What was done and proved' }, r.lines.map((l) => h(`li.${!l.ok ? 'bad' : l.warn ? 'warn' : 'ok'}`, icon(l.ok && !l.warn ? 'check' : 'alert', { size: 14 }), h('span', l.warn ? 'To look at: ' : '', l.words))));
    const head = r.dryRun ? h('div.banner.info', { role: 'status' }, icon('info', { size: 18 }), h('span', 'This is what Arrange would do. Nothing was written.'))
      : r.ok ? okBox(`${plan.name} is in your workspace now, and every copy was proved the same as its original. Your old folders at ${r.from} are untouched.`)
        : errorBox(r.error || 'A copy was not the same as its original: what this made was removed, and your old folders were not touched.');
    fill(box, stepHeader(STEPS, 2), head,
      r.needs && r.needs.length ? panel({ icon: 'alert', title: 'What still needs you', desc: 'Nothing of this was changed by itself.' }, h('ul.adopt-plan', r.needs.map((n) => h('li', h('b', `${n.kind}: `), n.words)))) : null,
      panel({ icon: 'checkAll', title: r.dryRun ? 'The steps' : 'Each step and its proof' }, proof),
      r.ok && !r.dryRun ? panel({ icon: 'trash', title: 'Your old folders', desc: 'They stay until you remove them. When you are sure, remove them here with the project\'s name typed, or on a terminal with the command below. Before anything goes it compares each old folder with its copy again (commits, branches, tags, stashes, worktrees, every file), and removes nothing if the copy lacks anything.' },
        h('div.btnrow', btn('danger', { icon: 'trash', label: RETIRE_LABEL, onclick: async () => ((await retireSheet(plan.name)) ? load(plan.name) : null) })), commandLine(`hoprig adopt retire ${plan.name}`)) : null,
      h('div.pj-next',
        r.dryRun ? btn('primary', { icon: 'check', label: `Arrange ${plan.name}`, onclick: () => run(plan, identity) }) : null,
        r.ok && !r.dryRun ? h('a.btn.primary', { href: link(`#/workspace/project/${encodeURIComponent(plan.name)}`) }, icon('folder', { size: 18 }), h('span', 'Open the project')) : null,
        btn('secondary', { icon: 'back', label: r.ok && !r.dryRun ? 'Back to the list' : 'Back to the plan', onclick: () => (r.ok && !r.dryRun ? load(plan.name) : showPlan(plan)) })));
    box.querySelector('.banner').setAttribute('tabindex', '-1');
    box.querySelector('.banner').focus();
  }

  fill(box, stepHeader(STEPS, 0), h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Loading…')));
  load();
  return () => (alive = false);
}

registerPage({ id: 'adopt', title: 'Projects found on this computer', icon: 'search', navAs: 'workspace', perComputer: false, render: viewAdopt });
