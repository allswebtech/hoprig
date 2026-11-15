// The workspace kept through git (src/workspace/feature.mjs, docs/WORKSPACE.md): the status strip and Sync on the
// Workspace page, the projects of the map that are not on this computer, the fork a fresh computer needs ("Bring my
// workspace from git" or a new project), and Settings → Workspace (where things are, the folders, the map, syncing
// with another computer, keeping it in step by itself). Every route answers for the open computer.
import { icon } from './icons.js';
import { add, api, btn, confirmSheet, copyText, fill, h, link, openSheet, promptSheet, tildePath, toast } from './lib.js';
import { workspaceFolders } from './brain.js';
import { startButton, syncRows } from './projects.js';
import { registerSettingsPage } from './registry.js';
import { errorBox, groupHead, okBox, panel, toggle } from './shell.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyLine = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));

/** A command to copy, with its copy button (a long one wraps). */
export const commandLine = (cmd) => h('div.cmdline', h('code', cmd), btn('icon ghost', { icon: 'copy', title: 'Copy', onclick: async () => toast((await copyText(cmd)) ? 'Copied' : 'Select and copy it by hand') }));

/**
 * A command the server wrote with a full path, for a person to copy: the home folder as ~ outside the quotes, so the
 * line still works when pasted (`git -C ~/"Workspace/ai_brain" …`), as the server's own tildeText does.
 */
export function homeCommand(cmd, home = (typeof window !== 'undefined' && window.__home) || '') {
  if (!home) return cmd;
  return cmd.split(`"${home}/`).join('~/"').split(`"${home}"`).join('~');
}

/** Follow the workspace's background job into `out` until it ends; resolves its answer. */
async function followJob(out, isAlive = () => true) {
  let from = 0;
  for (;;) {
    const r = await api(`/api/workspace/job?from=${from}`);
    if (r.lines.length) {
      add(out, `${r.lines.join('\n')}\n`);
      out.scrollTop = out.scrollHeight;
    }
    from = r.next;
    if (!r.running || !isAlive()) return r;
    await sleep(700);
  }
}

// ======================= the state of the workspace =======================

/**
 * The one line under the Workspace page's head, from the map (GET /api/workspace/map) and the last job: { text, warn,
 * missing, todo }. A project of the map that is not here counts as missing; the last sync's open points (not the
 * ones that are only "not here") as todo.
 */
export function workspaceLine(map, job) {
  const entries = (map && map.entries) || [];
  const missing = entries.filter((e) => e.kind === 'project' && e.state === 'missing');
  const sync = job && job.kind === 'sync' && job.result && job.result.data && Array.isArray(job.result.data.repos) ? job.result.data : null;
  const todo = sync ? sync.repos.filter((r) => r.todo.some((t) => t.kind !== 'missing')).length : 0;
  const parts = [];
  if (todo) parts.push(`${plural(todo, 'repository', 'repositories')} ${todo === 1 ? 'has' : 'have'} changes to look at`);
  if (missing.length) parts.push(`${plural(missing.length, 'project')} in your map ${missing.length === 1 ? 'is' : 'are'} not on this computer`);
  if (parts.length) return { text: parts.join(' · '), warn: true, missing, todo };
  if (!map || !map.exists) return { text: 'No workspace map yet: Settings → Workspace makes one', warn: false, missing, todo, noMap: true };
  if (map.saved && map.saved.unsaved) return { text: UNSAVED, warn: false, missing, todo, unsaved: true };
  if (sync && !sync.todo) return { text: 'In step with git', warn: false, missing, todo };
  return { text: 'Not synced from here yet', warn: false, missing, todo };
}

const UNSAVED = 'The map changed and is not saved in the AI brain\'s history yet';

/** The label → folder of each repository the map knows (for "Ask Claude to sort it out"). */
const dirsOf = (map) => new Map(((map && map.entries) || []).map((e) => [e.label, e.path]));

/** The sync sheet: the choices, the progress, the result per repository. `after` runs when it is closed. */
export function syncSheet(map, after = () => {}) {
  let alive = true;
  openSheet({ title: 'Sync the workspace', subtitle: 'Every repository of your map', wide: true }, (close) => {
    const memory = h('input', { type: 'checkbox' });
    const push = h('input', { type: 'checkbox' });
    const out = h('pre.output.hidden');
    const result = h('div', { 'aria-live': 'polite' });
    const go = btn('primary', { icon: 'refresh', label: 'Sync', onclick: async () => {
      go.disabled = true;
      out.classList.remove('hidden');
      fill(out);
      fill(result, busyLine('Syncing…'));
      try {
        await api('/api/workspace/sync', { memory: memory.checked, push: push.checked });
      } catch (e) {
        go.disabled = false;
        return fill(result, errorBox(e.message));
      }
      const j = await followJob(out, () => alive);
      if (!alive) return;
      const r = j.result || {};
      if (!r.data) return fill(result, errorBox(r.error || 'The sync stopped without an answer.'));
      const dirs = dirsOf(map);
      const items = r.data.repos.map((x) => ({ label: x.label, did: x.did, todo: x.todo, dir: dirs.get(x.label) || null }));
      const open = items.filter((x) => x.todo.length).length;
      fill(result,
        open ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${plural(open, 'repository', 'repositories')} need${open === 1 ? 's' : ''} you; the rest is in step.`)) : okBox('Everything is in step.'),
        syncRows(items),
        // Tools (SDK checkouts) are never synced: one quiet line, not a row each.
        r.data.tools && r.data.tools.length ? h('p.hint', `${plural(r.data.tools.length, 'tool')} left alone: tools are never synced.`) : null);
      go.disabled = false;
    } });
    return [
      h('p.sheet-text', 'Gets what is new from the git server for every repository of your map, and moves one forward only when nothing here is in the way. It never merges, overwrites or deletes anything.'),
      h('label.toggle-line', memory, h('span', 'Also save the AI memory (commits only the memory folders)')),
      h('label.toggle-line', push, h('span', 'Also upload my saved changes')),
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Close'), go),
      out, result,
    ];
  }).then(() => {
    alive = false;
    after();
  });
}

/**
 * The strip under the Workspace page's head. Returns { el, load(), map() }: load() asks again (after a sync, a new
 * project); map() is the last map answer (null until there is one, or on an older computer).
 */
export function workspaceStrip(onMap = () => {}) {
  const el = h('div.ws-strip.hidden', { role: 'status' });
  let map = null;
  async function load() {
    let job = null;
    try {
      [map, job] = await Promise.all([api('/api/workspace/map'), api('/api/workspace/job').catch(() => null)]);
    } catch {
      map = null; // an older computer: no strip
      el.classList.add('hidden');
      onMap(null);
      return;
    }
    const s = workspaceLine(map, job);
    el.classList.remove('hidden');
    el.classList.toggle('warn', s.warn);
    fill(el,
      h('span.ws-strip-icon', icon(s.warn ? 'alert' : s.noMap ? 'info' : 'check', { size: 16 })),
      h('span.ws-strip-text', s.noMap ? h('a', { href: link('#/settings/workspace') }, s.text) : s.text),
      stripActions(map, s, load));
    onMap(map);
  }
  load();
  return { el, load, map: () => map };
}

/**
 * The strip's buttons, each named for what it does. A project of the map that is not here: "Get invoices" (what its
 * card's Get it does), or "Get 3 projects", which leads to their cards. Sync stays beside it: it brings what is here
 * up to date and gets nothing that is not, so it never stands alone under "not on this computer".
 */
export function stripActions(map, s, load = () => {}) {
  if (!map || !map.exists) return null;
  const missing = s.missing || [];
  const one = missing.length === 1 && missing[0].url ? missing[0] : null;
  const get = one
    ? h('a.btn.small.secondary', { href: link(`#/get-project/${encodeURIComponent(one.url)}`) }, icon('download', { size: 16 }), h('span', `Get ${one.label}`))
    : missing.length
      ? btn('small secondary', { icon: 'download', label: `Get ${plural(missing.length, 'project')}`, onclick: () => document.querySelector('.ws-missing')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) })
      : null;
  const sync = btn('small secondary', { icon: 'refresh', label: 'Sync', title: 'Bring the repositories on this computer up to date', onclick: () => syncSheet(map, load) });
  return h('span.ws-strip-actions', get, sync);
}

/** A project of the map that is not on this computer: a quiet card with "Get it". */
export function missingCard(e) {
  return h('section.card.ws-project.ws-missing', { 'aria-label': `${e.label}: not on this computer yet` },
    h('div.ws-head',
      h('span.ws-name', h('span.row-icon', icon('download')),
        h('span.row-main',
          h('span.ws-title', e.label),
          h('span.row-sub', e.url || 'No address in the map: it is not on a git server yet'),
          h('span.row-sub', 'Not on this computer yet'))),
      e.url ? h('span.ws-tools', h('a.btn.small.secondary', { href: link(`#/get-project/${encodeURIComponent(e.url)}`) }, icon('download', { size: 16 }), h('span', 'Get it'))) : null));
}

// ======================= a fresh computer =======================

const ACTION = {
  clone: () => 'will be cloned',
  here: () => 'already here',
  different: (e) => `left alone: ${e.why || 'something else is in that folder'}`,
  'no-address': (e) => `skipped: ${e.why || 'no address in the map'}`,
};

/** "Bring my workspace from git": the brain's address → the plan → the job → what came and what did not. */
export function restoreSheet(git, after = () => {}) {
  let alive = true;
  openSheet({ title: 'Bring my workspace from git', subtitle: 'Your AI brain, then every project its map names', wide: true }, (close) => {
    const panelBox = h('div');
    const signed = git && git.gh && git.gh.signedIn;
    function stepAddress(value = '', error = '') {
      const input = h('input.field.mono', { value, placeholder: signed ? `${git.gh.account}/ai_brain` : 'https://github.com/you/ai_brain', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      const err = h('p.form-error', { role: 'alert' }, error);
      const look = btn('primary', { icon: 'chevronRight', label: 'Look at the plan', onclick: async () => {
        const url = input.value.trim();
        if (!url) return void (err.textContent = 'Type the address of your AI brain.');
        look.disabled = true;
        fill(err, busyLine('Reading its map…'));
        try {
          const plan = await api('/api/workspace/restore', { url, dryRun: true });
          if (alive) stepPlan(url, plan);
        } catch (e) {
          look.disabled = false;
          err.textContent = e.message;
        }
      } });
      fill(panelBox,
        h('label.fieldrow', h('span.field-label', 'The address of your AI brain'), input,
          h('span.hint', signed ? `Signed in to GitHub as ${git.gh.account}: its name is enough (owner/name).` : 'Its git address on GitHub or another git server. Sign in to GitHub first (Computers → this computer → Setup) when it is private.')),
        err, h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), look));
      input.focus();
    }
    function stepPlan(url, r) {
      const get = r.plan.filter((e) => e.action === 'clone').length;
      fill(panelBox,
        h('p.sheet-text', get ? `${plural(get, 'repository', 'repositories')} will be cloned. What is here already is left as it is; nothing is overwritten.` : 'Everything is here already.'),
        h('div.rows', r.plan.map((e) => h('div.row.static',
          h(`span.row-icon.pj-mark${e.action === 'clone' || e.action === 'here' ? '.ok' : '.warn'}`, icon(e.action === 'clone' ? 'download' : e.action === 'here' ? 'check' : 'alert')),
          h('span.row-main', h('span.row-title', e.label), h('span.row-sub', `${tildePath(e.dest)} · ${(ACTION[e.action] || ((x) => x.action))(e)}`))))),
        r.notes && r.notes.length ? h('ul.hint', r.notes.map((n) => h('li', n))) : null,
        h('div.sheet-actions', btn('secondary', { icon: 'back', label: 'Back', onclick: () => stepAddress(url) }),
          get ? btn('primary', { icon: 'download', label: 'Get everything', onclick: () => run(url) }) : null));
    }
    async function run(url) {
      const out = h('pre.output');
      const result = h('div', { 'aria-live': 'polite' }, busyLine('Cloning…'));
      fill(panelBox, out, result);
      try {
        await api('/api/workspace/restore', { url });
      } catch (e) {
        return fill(result, errorBox(e.message), h('div.sheet-actions', btn('secondary', { icon: 'back', label: 'Back', onclick: () => stepAddress(url) })));
      }
      const j = await followJob(out, () => alive);
      if (!alive) return;
      const r = j.result || {};
      if (!r.data) return fill(result, errorBox(r.error || 'It stopped without an answer.'));
      const bad = r.data.plan.filter((e) => /^(failed|skipped|left alone)/.test(String(e.result || '')));
      const got = r.data.plan.filter((e) => e.result === 'cloned').length;
      fill(result,
        bad.length ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${plural(got, 'repository', 'repositories')} cloned; ${bad.length === 1 ? 'one' : bad.length} could not be:`)) : okBox(`Done: ${plural(got, 'repository', 'repositories')} cloned.`),
        bad.length ? h('div.rows', bad.map((e) => h('div.row.static', h('span.row-icon.pj-mark.warn', icon('alert')), h('span.row-main', h('span.row-title', e.label), h('span.row-sub.pj-wrap', e.result))))) : null,
        r.data.projectsDir ? h('p.hint', `Projects are in ${tildePath(r.data.projectsDir)}.`) : null,
        h('div.sheet-actions', btn('primary', { label: 'To the workspace', onclick: () => close() })));
    }
    stepAddress();
    return [panelBox];
  }).then(() => {
    alive = false;
    after();
  });
}

/** The empty Workspace page of a fresh computer: bring the workspace from git, or start a new project. */
export function freshFork(after) {
  const git = api('/api/workspace/git').catch(() => null);
  const card = (ic, title, sub, onclick) => h('button.choice', { type: 'button', onclick },
    h('span.choice-icon', icon(ic)), h('span.choice-main', h('span.choice-label', title), h('span.choice-sub', sub)), h('span.choice-end', icon('chevronRight')));
  return h('div.ws-fresh',
    h('p.ws-fresh-lead', 'No projects on this computer yet.'),
    h('div.choice-list',
      card('git', 'Bring my workspace from git', 'Your AI brain and every project its map names, cloned in their places. For a new computer of yours.', async () => restoreSheet(await git, after)),
      card('plus', 'Start a new project', 'An empty project folder, ready for Claude.', () => (location.hash = link('#/new-project')))),
    h('p.hint', 'Already have one project on GitHub? ', h('a', { href: link('#/get-project') }, 'Get an existing project'), '.'));
}

// ======================= Settings → Workspace =======================

const GROUPS = [
  ['brain', 'AI brain'],
  ['project', 'Projects and their code repositories'],
  ['other', 'Other repositories'],
  ['tool', 'Tools: restored on a fresh computer, never synced'],
];
const STATE = {
  here: ['here', 'On this computer'],
  missing: ['missing', 'Not on this computer yet'],
  different: ['different', 'Something else is in its folder'],
  unmapped: ['unmapped', 'Here, not in the map yet: Update the map adds it'],
};

/** The map's entries in the groups a person reads: [{ id, title, rows: [entry + { repos }] }]. */
export function mapGroups(m) {
  const entries = (m && m.entries) || [];
  const tools = new Set((((m && m.map) || {}).others || []).filter((o) => o.sync === false).map((o) => o.dir));
  const isTool = (e) => e.tool === true || (e.kind === 'other' && (tools.has(e.label) || e.sync === false));
  const out = GROUPS.map(([id, title]) => ({ id, title, rows: [] }));
  const of = (id) => out.find((g) => g.id === id).rows;
  for (const e of entries) {
    if (e.kind === 'brain') of('brain').push(e);
    else if (e.kind === 'project') of('project').push({ ...e, repos: entries.filter((r) => r.kind === 'repo' && r.label.startsWith(`${e.label}/`)) });
    else if (e.kind === 'repo') {
      if (!entries.some((p) => p.kind === 'project' && e.label.startsWith(`${p.label}/`))) of('other').push(e);
    } else of(isTool(e) ? 'tool' : 'other').push(e);
  }
  return out.filter((g) => g.rows.length);
}

function mapRow(e, refresh, sub = false) {
  const [key, words] = STATE[e.state] || [e.state, e.state];
  const forget = !sub && (e.kind === 'project' || e.kind === 'other')
    ? btn('small ghost', { icon: 'minus', label: 'Forget', title: 'Take it out of the map', onclick: async () => {
      const ok = await confirmSheet({ title: `Forget ${e.label}?`, text: 'It is taken out of the map, and "Update the map" does not add it back. No file is deleted: the folder stays on every computer that has it.', ok: 'Forget it' });
      if (!ok) return;
      try {
        await api('/api/workspace/forget', { name: e.label });
        toast(`${e.label} is out of the map`);
        refresh();
      } catch (er) {
        toast(er.message, { kind: 'error', ms: 7000 });
      }
    } })
    : null;
  return h(`div.row.static.map-row.ms-${key}${sub ? '.map-sub' : ''}`,
    h('span.row-icon', icon(e.kind === 'brain' ? 'brain' : e.kind === 'project' ? 'folder' : e.kind === 'repo' ? 'git' : 'git')),
    h('span.row-main',
      h('span.row-title', sub ? e.label.slice(e.label.indexOf('/') + 1) : e.label, h(`span.badge.soft.map-state.ms-${key}`, words.split(':')[0])),
      h('span.row-sub.pj-wrap', e.url || 'No address: not on a git server yet'),
      e.state === 'unmapped' ? h('span.row-sub', words) : null),
    forget);
}

/**
 * What stays in the map though it is not on this computer (the map is every computer's; only Forget removes): one
 * quiet line, with "Get it" for each project (its code repositories come with it; another repository is restored with
 * the workspace).
 */
export function notHereLine(r) {
  const labels = r.notHere || [];
  const m = r.map || { projects: [], others: [] };
  const top = labels.filter((l) => !labels.some((o) => o !== l && l.startsWith(`${o}/`)));
  if (!top.length) return null;
  const urlOf = (l) => ((m.projects || []).find((p) => p.name === l) || {}).url || null;
  return h('div.map-nothere',
    h('p.hint', `Stays in the map, not on this computer: ${top.join(', ')}`),
    h('div.btnrow', top.filter(urlOf).map((l) => h('a.btn.small.secondary', { href: link(`#/get-project/${encodeURIComponent(urlOf(l))}`) }, icon('download', { size: 16 }), h('span', `Get ${l}`)))));
}

/** "Update the map": what would change, then write it; then the commit to run in the brain. */
function updateMapSheet(refresh) {
  openSheet({ title: 'Update the map', subtitle: 'From what is on this computer', wide: true }, (close) => {
    const box = h('div', busyLine('Looking at every repository…'));
    const list = (title, items) => (items.length ? [h('p.field-label', title), h('ul.map-diff', items.map((x) => h('li', x)))] : []);
    api('/api/workspace/map', { dryRun: true }).then((r) => {
      const d = r.diff;
      // Only its settings changed (the projects folder, memory links, which entries are tools): still worth writing.
      const nothing = d.same && !d.created && !r.otherChanges;
      fill(box,
        nothing ? okBox('The map already matches this computer.')
          : h('p.sheet-text', d.created ? 'There is no map yet: this writes the first one.' : d.same ? 'Settings changed (the projects folder, memory links or which entries are tools); no repository did.' : 'This changes the map:'),
        list('Added', d.added),
        list('A changed address', d.changed.map((c) => `${c.label}: ${c.from || 'none'} → ${c.to || 'none'}`)),
        // Only a present project's own project.json takes a code repository out; nothing else is ever removed.
        (r.takenOut || []).length ? list('Taken out by its project\'s project.json', r.takenOut.map((t) => `${t.project}: ${t.dir}`)) : null,
        notHereLine(r),
        r.notes && r.notes.length ? h('ul.hint', r.notes.map((n) => h('li', n))) : null,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'),
          nothing ? null : btn('primary', { icon: 'check', label: 'Write the map', onclick: write })));
    }, (e) => fill(box, errorBox(e.message)));
    async function write() {
      fill(box, busyLine('Writing the map…'));
      try {
        const r = await api('/api/workspace/map', {});
        const brain = (r.file || '').replace(/[\\/][^\\/]+$/, '');
        fill(box,
          okBox('The map is written. It is saved in the AI brain\'s history once it is committed:'),
          commandLine(homeCommand(r.commit)),
          h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Done'),
            startButton(brain, { cls: 'primary', label: 'Ask Claude to do it', title: 'Start Claude in the AI brain to commit the map', prompt: 'Commit the updated workspace map (workspace.json) in this repository with the message "Update the workspace map", then push it if it has a git server.' })));
        refresh();
      } catch (e) {
        fill(box, errorBox(e.message));
      }
    }
    return [box];
  });
}

/** "Sync with another computer": computers added by SSH only; pull only. */
function peerPanel() {
  const box = h('div', busyLine('Looking for computers added by SSH…'));
  api('/api/machines').then((d) => {
    const ssh = (d.machines || []).filter((m) => m.via === 'ssh');
    if (!ssh.length) return fill(box, h('p.hint', 'Only a computer added by SSH can be used (Computers → Add a computer → "I can reach it by SSH").'));
    fill(box, h('div.rows', ssh.map((m) => {
      const out = h('pre.output.hidden');
      const res = h('div');
      return h('div.row.static.col.mrow',
        h('div.mrow-top', h('span.row-icon', icon('cpu')), h('span.row-main', h('span.row-title', m.label), h('span.row-sub', 'Gets its commits for the repositories both have'))),
        h('div.mrow-actions', btn('small secondary', { icon: 'download', label: 'Get its commits', onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          out.classList.remove('hidden');
          fill(out);
          fill(res, busyLine(`Getting the commits of ${m.label}…`));
          try {
            await api('/api/workspace/sync', { with: m.name });
            const j = await followJob(out);
            const r = j.result || {};
            fill(res, r.data ? syncRows(r.data.repos.map((x) => ({ label: x.label, did: x.did, todo: x.todo, dir: null }))) : errorBox(r.error || 'It stopped without an answer.'));
          } catch (er) {
            fill(res, errorBox(er.message));
          }
          b.disabled = false;
        } })),
        out, res);
    })));
  }, (e) => fill(box, errorBox(e.message)));
  return panel({ icon: 'swap', title: 'Sync with another computer', desc: 'For a repository without a git server, or one this computer cannot reach. Pull only: this computer gets the other one\'s commits; nothing is written there.' }, box);
}

/**
 * By itself: the automation setting workspace { map, commitMap, sync, push, everyHours }. Saving the map in the
 * brain's history needs the map kept up to date; uploading applies to that commit and to the sync.
 */
function autoPanel() {
  const box = h('div', busyLine('…'));
  let w = null;
  const save = async (patch) => {
    try {
      await api('/api/automation/settings', { workspace: patch });
      Object.assign(w, patch);
      return true;
    } catch (e) {
      toast(`${e.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
      return false;
    }
  };
  const paint = () => {
    const hours = h('input.field', { type: 'number', min: 1, max: 168, value: String(w.everyHours || 6), style: { maxWidth: '110px' } });
    const commit = toggle('Save a change of the map in the AI brain\'s history', !!w.commitMap, (v) => save({ commitMap: v }),
      w.map ? 'Commits that one file, workspace.json, when the map changed; nothing else in the brain.' : 'Needs the map kept up to date (above).');
    commit.querySelector('input').disabled = !w.map;
    commit.classList.toggle('is-off', !w.map);
    fill(box,
      toggle('Keep the map up to date', !!w.map, async (v) => { const ok = await save({ map: v }); if (ok) paint(); return ok; },
        'Adds what is new on this computer to the map; written only when something changed, and only where a map exists.'),
      commit,
      toggle('Keep the workspace in step', !!w.sync, (v) => save({ sync: v }),
        'Gets what is new for every repository of the map and moves one forward only when nothing is in the way; what needs a decision is told once.'),
      toggle('Also upload', !!w.push, (v) => save({ push: v }),
        'Uploads what is only ahead here: the map\'s commit and, with keeping in step, every repository. Off: nothing leaves this computer by itself.'),
      h('label.fieldrow', h('span.field-label', 'Every how many hours'), h('div.inlineform', hours, btn('small secondary', { label: 'Save', onclick: async () => {
        const n = Number(hours.value);
        if (!Number.isInteger(n) || n < 1 || n > 168) return toast('A whole number of hours, 1 to 168.', { kind: 'error' });
        if (await save({ everyHours: n })) toast('Saved');
      } }))));
  };
  api('/api/automation').then((st) => {
    w = { map: true, commitMap: false, sync: false, push: false, everyHours: 6, ...((st.settings && st.settings.workspace) || {}) };
    paint();
  }, (e) => fill(box, errorBox(e.message)));
  return panel({ icon: 'clock', title: 'By itself', desc: 'What the computer does with the workspace on its own.' }, box);
}

/** Where the workspace and the projects folder are; changing it moves nothing. */
function placesPanel(st, refresh) {
  const res = h('div', { 'aria-live': 'polite' });
  const change = (key, title, now) => btn('small ghost', { icon: 'pencil', label: 'Change', onclick: async () => {
    const v = await promptSheet({ title, text: 'For everything from now on. Nothing is moved: the command that would move the files is shown, to run yourself.', value: now, ok: 'Save', check: (x) => (/^(~|\/|[A-Za-z]:\\)/.test(x.trim()) ? '' : 'A full path, like ~/Workspace') });
    if (v === null) return;
    try {
      const r = await api('/api/workspace/settings', { [key]: v.trim() });
      fill(res,
        okBox(r.changed ? 'Saved. Nothing was moved.' : 'That is where it is already.'),
        r.moves && r.moves.length ? [h('p.field-label', 'To move the files there yourself:'), r.moves.map((m) => commandLine(homeCommand(m)))] : null,
        r.notes && r.notes.length ? h('ul.hint', r.notes.map((n) => h('li', n))) : null);
      refresh();
    } catch (e) {
      fill(res, errorBox(e.message));
    }
  } });
  return panel({ icon: 'folder', title: 'Where things are', desc: 'The workspace holds the AI brain, your projects and your tools; the same tree on every computer.' },
    h('div.rows',
      h('div.row.static', h('span.row-main', h('span.row-title', 'Workspace'), h('span.row-sub.mono', st.short)), change('dir', 'Workspace folder', st.short)),
      h('div.row.static', h('span.row-main', h('span.row-title', 'Projects folder'), h('span.row-sub.mono', st.projectsShort)), change('projects', 'Projects folder', st.projectsShort))),
    res);
}

/** The map changed and is not committed in the brain: the command, and Claude to do it. */
function unsavedBox(m) {
  if (!m.saved || !m.saved.unsaved) return null;
  const brain = ((m.entries || []).find((e) => e.kind === 'brain') || {}).path || (m.file || '').replace(/[\\/][^\\/]+$/, '');
  return h('div.map-unsaved',
    h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${UNSAVED}.`)),
    m.saved.command ? commandLine(homeCommand(m.saved.command)) : null,
    h('div.btnrow', startButton(brain, { label: 'Ask Claude to do it', title: 'Start Claude in the AI brain to commit the map', prompt: 'Commit the workspace map (workspace.json) in this repository with the message "Update the workspace map", then push it if it has a git server.' })));
}

function mapPanel(m, refresh) {
  const groups = mapGroups(m);
  const counts = m.counts || {};
  const said = [counts.here ? `${counts.here} here` : '', counts.missing ? `${counts.missing} not on this computer` : '', counts.different ? `${counts.different} with something else in the folder` : '', counts.unmapped ? `${counts.unmapped} not in the map yet` : ''].filter(Boolean).join(' · ');
  return panel({ icon: 'git', title: 'The map', desc: 'Every repository of your workspace by its address, kept in the AI brain. A new computer gets everything it names.' },
    m.errors ? errorBox(`The map cannot be used: ${m.errors.join('; ')}`) : null,
    !m.exists ? h('p.hint', 'No map yet. Update the map writes the first one from what is on this computer.') : said ? h('p.hint', said) : null,
    unsavedBox(m),
    groups.map((g) => [h('p.field-label.map-group', g.title), h('div.rows', g.rows.flatMap((e) => [mapRow(e, refresh), ...(e.repos || []).map((r) => mapRow(r, refresh, true))]))]),
    h('div.savebar.start', btn('primary', { icon: 'refresh', label: 'Update the map', onclick: () => updateMapSheet(refresh) }),
      m.exists ? btn('secondary', { icon: 'refresh', label: 'Sync', onclick: () => syncSheet(m, refresh) }) : null));
}

function settingsRender() {
  const box = h('div', busyLine('Reading the workspace…'));
  const draw = async () => {
    try {
      const [st, m] = await Promise.all([api('/api/workspace'), api('/api/workspace/map')]);
      fill(box, placesPanel(st, draw), workspaceFolders(), mapPanel(m, draw), peerPanel(), autoPanel());
    } catch (e) {
      fill(box, errorBox(`The workspace could not be read: ${e.message}`, draw));
    }
  };
  draw();
  return [box];
}

/** The line in the Settings list: "~/Workspace · 4 projects · in step". */
export async function settingsSummary() {
  const [st, m, job] = await Promise.all([api('/api/workspace'), api('/api/workspace/map').catch(() => null), api('/api/workspace/job').catch(() => null)]);
  const s = workspaceLine(m, job);
  const tail = s.todo ? `${s.todo} to look at` : s.missing.length ? `${s.missing.length} not here` : s.noMap ? 'no map yet' : /In step/.test(s.text) ? 'in step' : 'mapped';
  return `${st.short} · ${plural(st.projects.length, 'project')} · ${tail}`;
}

registerSettingsPage({ id: 'workspace', title: 'Workspace', icon: 'folder', order: 15, desc: 'Where your workspace is, its map of every repository, and keeping it in step through git.', summary: settingsSummary, render: settingsRender });

