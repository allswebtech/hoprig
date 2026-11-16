// Workspace: the projects of the open computer and, under each, its sessions (src/pcsetup/feature.mjs + the session
// poll). The same sessions as Home, seen project by project, drawn by the same part (sessionitem.js).
//   #/workspace                      each project: name, folder, git state in plain words, New session, the way to
//                                    its page; its sessions under it, earlier conversations folded; then "Other
//                                    folders"; "New project" (the main action), "Get an existing project"
//   #/workspace/project/<folder>     one project: its sessions (running, past ones to continue), its repositories
//                                    with Sync and "Add a repository", its skills (installed and suggested)
// (#/projects… addresses from before land here: app.js.)
//   #/new-project          name → what it creates (shown before anything is made) → done, "Start a session"
//   #/get-project          name or address → what happens → done, "Start a session"
// With several computers the switcher picks whose projects these are (#/m/<computer>/workspace). A "project" is a
// folder in the projects folder: a plain git repository, or a parent repository with its code repositories in
// code/ (docs/PC-SETUP.md).
import { chatTools, startChat } from './chat/start.js';
import { icon } from './icons.js';
import { add, ago, api, btn, fill, h, link, needsYouFirst, openSheet, promptSheet, tildePath, toast, toolBadge } from './lib.js';
import { groupOf } from './home.js';
import { sessionRow } from './sessionitem.js';
import { projectBrain } from './brain.js';
import { freshFork, missingCard, workspaceStrip } from './workspace.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, fold, groupHead, listRow, okBox, radioCards, skeletonRows as skeleton, stepHeader } from './shell.js';
import { store } from './store.js';
import { editorButton } from './editor/index.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const enc = encodeURIComponent;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const busy = (text) => h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));

// ---------- the projects and their git state, in words ----------

/** One list of projects from GET /api/pcsetup/projects: parents with their code repositories, and plain ones. */
export function projectsOf(d) {
  const label = (rel, name) => (rel === '.' ? name : rel.replace(/^code\//, ''));
  return [
    ...d.workspaces.map((w) => ({ id: w.id || w.dir.split(/[\\/]/).pop(), name: w.name, dir: w.dir, workspace: true, memories: w.memories || {}, repos: w.repos.map((r) => ({ ...r, label: label(r.rel, w.name) })) })),
    ...d.repos.map((r) => ({ id: r.id || r.rel, name: r.rel, dir: r.dir, workspace: false, memories: {}, repos: [{ ...r, rel: '.', label: r.rel }] })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** A repository's state as a person says it: "branch main · 2 changes not saved to git · not on GitHub yet". */
export function gitWords(s) {
  if (!s.ok) return s.error === 'not cloned' ? 'not downloaded to this computer yet' : `git could not read it (${s.error})`;
  const parts = [`branch ${s.branch}`];
  if (s.changes) parts.push(`${plural(s.changes, 'change')} not saved to git`);
  if (!s.upstream) parts.push('not on GitHub yet');
  else {
    if (s.ahead) parts.push(`${plural(s.ahead, 'saved change')} to upload`);
    if (s.behind) parts.push(`${plural(s.behind, 'new change')} to download`);
    if (!s.changes && !s.ahead && !s.behind) parts.push('up to date');
  }
  return parts.join(' · ');
}

/** The one line under a project in the list: its only repository's state, or a summary of all of them. */
export function projectWords(p) {
  if (p.repos.length === 1) return gitWords(p.repos[0]);
  const ok = p.repos.filter((r) => r.ok);
  const sum = (k) => ok.reduce((n, r) => n + (r[k] || 0), 0);
  const parts = [plural(p.repos.length, 'repository', 'repositories')];
  if (ok.length < p.repos.length) parts.push(`${p.repos.length - ok.length} not readable`);
  if (sum('changes')) parts.push(`${plural(sum('changes'), 'change')} not saved to git`);
  if (sum('ahead')) parts.push(`${plural(sum('ahead'), 'saved change')} to upload`);
  if (sum('behind')) parts.push(`${plural(sum('behind'), 'new change')} to download`);
  if (parts.length === 1) parts.push(ok.every((r) => !r.upstream) ? 'not on GitHub yet' : ok.some((r) => !r.upstream) ? 'not all on GitHub yet' : 'all up to date');
  return parts.join(' · ');
}

const needsLook = (p) => p.repos.some((r) => !r.ok || r.changes || r.behind || (r.upstream && r.ahead));

/** Sessions of the open computer running in a project's folder (or a folder inside it). */
const inside = (dir, cwd) => !!cwd && (cwd === dir || cwd.startsWith(`${dir}/`) || cwd.startsWith(`${dir}\\`));
const sessionsIn = (dir) => ((store.data && store.data.sessions) || []).filter((s) => inside(dir, s.cwd));

// ---------- starting Claude: a chat, as the New session page opens one ----------

// A chat in `dir`, set up as the last chat there (the server keeps that per folder, its coding tool too); `sessionId`
// continues that conversation of coding tool `tool` (the chat that already runs it opens instead), `prompt` is its
// first message.
const startIn = (dir, { sessionId = null, prompt = null, tool = null } = {}) => startChat(dir, { sessionId, text: prompt, tool });

/** The earlier conversations of `dir` in every coding tool a chat can run here, newest first, each with its tool. */
async function conversationsIn(dir) {
  const tools = await chatTools();
  const lists = await Promise.all(tools.map((t) => api(`/api/folders/sessions?${new URLSearchParams({ path: dir, ...(t.id !== 'claude' ? { tool: t.id } : {}) })}`)
    .then((r) => r.sessions.map((c) => ({ ...c, tool: t.id })), (e) => (t.id === 'claude' ? Promise.reject(e) : []))));
  return lists.flat().sort((a, b) => b.at - a.at);
}

/** A button that opens a chat and says so while it does; an error stays next to it until the next press. */
export function startButton(dir, { cls = 'small secondary', label = 'Start', title = 'Open a chat with Claude here', ...how } = {}) {
  const b = btn(cls, { icon: 'play', label, title });
  b.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    b.disabled = true;
    fill(b, icon('play', { size: 18 }), h('span', 'Starting…'));
    try {
      await startIn(dir, how);
    } catch (er) {
      toast(er.message, { kind: 'error', ms: 7000 });
      b.disabled = false;
      fill(b, icon('play', { size: 18 }), h('span', label));
    }
  });
  return b;
}

// ---------- background jobs (clone, new, sync): their output, followed until they end ----------

/** Start a job with POST `path`, print its lines into `log` (a <pre>), resolve its result { ok, error, data }. */
async function runJob(path, body, log, alive) {
  const r = await api(path, body);
  if (log) fill(log);
  let from = 0;
  for (;;) {
    await new Promise((res) => setTimeout(res, 700));
    if (!alive()) return null;
    const j = await api(`/api/pcsetup/job?from=${from}`).catch(() => null);
    if (!j) continue;
    if (log && j.lines.length) {
      add(log, `${j.lines.join('\n')}\n`);
      log.scrollTop = log.scrollHeight;
    }
    from = j.next;
    if (!j.running) return { ...(j.result || { ok: false, error: 'it stopped without a result' }), started: r };
  }
}

const logBox = () => h('pre.output.pj-log', { 'aria-live': 'polite' });

// ======================= the list: each project with its sessions under it =======================

const RANK = { needs: 0, working: 1, waiting: 2, terminals: 3 };
/** How urgent a project is: a session that needs you, then one working, then the newest use. */
const projectRank = (sessions) => Math.min(4, ...sessions.map((s) => RANK[groupOf(s)] ?? 4));
const lastUse = (sessions) => Math.max(0, ...sessions.map((s) => s.statusAt || s.activity || 0));

/** Which repository of a parent project a session runs in ("web"), or null for the project itself. */
function repoOf(p, s) {
  if (p.repos.length < 2) return null;
  const r = [...p.repos].filter((x) => x.rel !== '.' && inside(x.dir, s.cwd)).sort((a, b) => b.dir.length - a.dir.length)[0];
  return r ? r.label : null;
}

// Earlier conversations per project folder, read once while the page is open (the page is drawn again often).
const pastOf = new Map();
async function pastIn(dir) {
  if (!pastOf.has(dir)) pastOf.set(dir, conversationsIn(dir).catch(() => []));
  return pastOf.get(dir);
}

/** "Earlier conversations (n)", folded, only when there are some. */
function earlier(p) {
  const slot = h('div.ws-pastslot');
  pastIn(p.dir).then((list) => {
    if (!list.length) return;
    fill(slot, fold(`ws-past-${p.id}`, `Earlier conversations (${list.length})`,
      h('div.rows.ws-pastrows', list.slice(0, 8).map((c) => h('div.row.static',
        h('span.row-icon', icon('text')),
        h('span.row-main', h('span.row-title', c.title, toolBadge(c.tool)), h('span.row-sub', ago(c.at))),
        startButton(p.dir, { sessionId: c.id, tool: c.tool, label: 'Continue', title: 'Continue this conversation in a chat' }))))));
  });
  return slot;
}

/** "N changes" on a project: opens Source Control on the repository with the changes (the project when several have). */
function changesButton(p) {
  const changed = p.repos.filter((r) => r.changes > 0);
  if (!changed.length) return null;
  const n = changed.reduce((sum, r) => sum + r.changes, 0);
  return editorButton(changed.length === 1 ? changed[0].dir || p.dir : p.dir, { name: p.name, changes: n });
}

/** One project: its head (name, folder, git state, New session, the way to its page), its sessions under it. */
function projectCard(p, sessions, profiles, home) {
  const page = link(`#/workspace/project/${enc(p.id)}`);
  return h('section.card.ws-project', { 'aria-label': p.name },
    h('div.ws-head',
      h('a.ws-name', { href: page }, h('span.row-icon', icon('folder')),
        h('span.row-main',
          h('span.ws-title', p.name),
          h('span.row-sub', tildePath(p.dir, home)),
          h(`span.row-sub.pj-git${needsLook(p) ? '.attn' : ''}`, projectWords(p)))),
      h('span.ws-tools',
        startButton(p.dir, { label: 'New session', title: `Open a chat with Claude in ${p.name}, set up as your last one there` }),
        changesButton(p),
        editorButton(p.dir, { name: p.name, compact: true }),
        h('a.btn.icon.ghost.small', { href: page, title: `Open ${p.name}`, 'aria-label': `Open ${p.name}` }, icon('chevronRight', { size: 18 })))),
    sessions.length
      ? h('div.ws-sessions', [...sessions].sort(needsYouFirst).map((s) => sessionRow(s, profiles, () => store.refresh(), { where: repoOf(p, s) })))
      : h('p.ws-none', 'No session yet'),
    earlier(p));
}

/** Sessions started outside the projects folder, with the advice to make a project of it. */
function otherFolders(sessions, profiles) {
  return h('section.ws-other',
    groupHead('Other folders', sessions.length),
    h('p.hint.ws-advice', 'These run outside the projects folder. Inside a project, Claude gets its memory, rules and skills: make it a project when you keep working there.'),
    h('div.rows', [...sessions].sort(needsYouFirst).map((s) => sessionRow(s, profiles, () => store.refresh()))));
}

function viewList(frame) {
  pastOf.clear();
  // The workspace's state through git (workspace.js): drawn again when its answer arrives.
  const strip = workspaceStrip(() => paint());
  const body = h('div.pj-page', skeleton(4));
  const advanced = h('div');
  frame({
    title: 'Workspace',
    page: 'workspace',
    intro: 'Your projects and the sessions in each. Open a session, or start a new one in a project.',
    primary: { label: 'New project', icon: 'plus', href: link('#/new-project') },
    actions: [h('a.btn.secondary.pj-get', { href: link('#/get-project') }, icon('download', { size: 16 }), h('span', 'Get an existing project'))],
    body: [strip.el, body, fold('projects', 'Advanced', advanced)],
  });
  let alive = true;
  let data = null;
  const paint = () => {
    if (!data) return;
    const list = projectsOf(data);
    const map = strip.map();
    // Projects of the workspace map that are not on this computer: quiet cards with "Get it".
    const away = map ? map.entries.filter((e) => e.kind === 'project' && e.state === 'missing') : [];
    const sessions = (store.data && store.data.sessions) || [];
    const profiles = (store.data && store.data.profiles) || [];
    const of = new Map(list.map((p) => [p, sessions.filter((s) => inside(p.dir, s.cwd))]));
    // Sessions in the product's own folders (Tia's working folders, `own`) are no folder of the owner's.
    const others = sessions.filter((s) => !s.own && !list.some((p) => inside(p.dir, s.cwd)));
    const ordered = [...list].sort((a, b) => projectRank(of.get(a)) - projectRank(of.get(b)) || lastUse(of.get(b)) - lastUse(of.get(a)) || a.name.localeCompare(b.name));
    fill(body, list.length || away.length
      ? h('div.ws-list', ordered.map((p) => projectCard(p, of.get(p), profiles, data.home)), away.map(missingCard))
      // A fresh computer (no projects, no map): bring the workspace from git, or start a new project.
      : map && !map.exists ? freshFork(() => { strip.load(); load(); })
      : emptyState('folder', 'No projects yet. A project is a folder with your code: start a new one, or get one you already have on GitHub.',
        h('div.pj-empty-actions',
          h('a.btn.primary', { href: link('#/new-project') }, icon('plus', { size: 16 }), h('span', 'New project')),
          h('a.btn.secondary', { href: link('#/get-project') }, icon('download', { size: 16 }), h('span', 'Get an existing project')))),
    others.length ? otherFolders(others, profiles) : null);
    fill(advanced, folderLine(data, load));
  };
  async function load() {
    try {
      data = await api('/api/pcsetup/projects');
    } catch (e) {
      if (alive) fill(body, errorBox(`Could not read the projects: ${e.message}`, () => { fill(body, skeleton(4)); load(); }));
      return;
    }
    if (alive) paint();
  }
  load();
  // The sessions change while the page is open: drawn again when one of them changes.
  let seen = '';
  const unsubscribe = store.subscribe((d) => {
    const now = JSON.stringify(((d && d.sessions) || []).map((s) => [s.name, s.cwd, s.status, s.limit, s.lastMessage, s.profile && s.profile.name]));
    if (now !== seen) {
      seen = now;
      paint();
    }
  });
  return () => {
    alive = false;
    unsubscribe();
  };
}

/** Advanced: where new projects go, and a way to change it. */
function folderLine(d, reload) {
  const mark = h('span.saved-mark', { role: 'status' });
  return h('div.pj-folder',
    h('span.pj-folder-text', 'Projects folder: ', h('strong', tildePath(d.projectsDir, d.home)), mark),
    btn('small ghost', { icon: 'pencil', label: 'Change', onclick: async () => {
      const v = await promptSheet({ title: 'Projects folder', text: 'New and downloaded projects go into this folder, and the list here shows what is in it. Nothing is moved.', value: tildePath(d.projectsDir, d.home), ok: 'Save', check: (x) => (/^(~|\/|[A-Za-z]:\\)/.test(x.trim()) ? '' : 'A full path, like ~/projects') });
      if (v === null) return;
      try {
        await api('/api/pcsetup/projects-dir', { dir: v.trim() });
        toast('Projects folder changed');
        reload();
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
      }
    } }));
}

// ======================= one project =======================

/**
 * What a sync did and what it left, in words: the server's kinds (src/pcsetup/feature.mjs todoKind; the workspace's
 * sync adds to-push and missing). One wording for a project's Sync and the workspace's.
 */
export const TODO = {
  'to-push': () => 'Changes saved here are not uploaded yet: Sync with "also upload my saved changes" does it.',
  'not-online': () => 'Not on GitHub yet, so there is no online copy to sync with. Claude can put it there for you: ask in a session.',
  diverged: () => 'Changed here and online at the same time. This needs a decision: Claude can bring the two together.',
  'pull-blocked': () => 'There are new changes online in the same files you changed here. Save (commit) your changes first, then sync again.',
  uncommitted: (t) => `${(/^(\d+)/.exec(t.why) || [, 'Some'])[1]} change${/^1 /.test(t.why) ? ' is' : 's are'} not saved to git yet; sync leaves ${/^1 /.test(t.why) ? 'it' : 'them'} alone.`,
  'fetch-failed': () => 'Could not reach the online copy. Check the internet connection and the GitHub sign-in.',
  'push-failed': () => 'Could not upload the saved changes. Check the GitHub sign-in and that you may write there.',
  missing: () => 'Not on this computer yet.',
  other: (t) => t.why,
};
const DID = { pulled: (n) => `Downloaded ${plural(n, 'new change')}.`, pushed: (n) => `Uploaded ${plural(n, 'saved change')}.` };

/**
 * The result of a sync, one row per repository: what it did, what it left in words, "Ask Claude to sort it out" where
 * a decision is needed (in `dir`, the repository's folder when known) and the git command under "Show the git
 * command". `items`: [{ label, did: [{ kind, count } | string], todo: [{ kind, why, command }], dir }].
 */
export function syncRows(items) {
  return h('div.rows.pj-sync', items.map((x) => {
    const lines = [...x.did.map((d) => (typeof d === 'string' ? d : DID[d.kind] ? DID[d.kind](d.count) : d.text)), ...x.todo.map((t) => (TODO[t.kind] || TODO.other)(t))];
    const fine = !x.todo.length;
    const decide = x.dir && x.todo.find((t) => t.kind === 'diverged' || t.kind === 'pull-blocked');
    return h('div.row.static.col.mrow',
      h('div.mrow-top',
        h(`span.row-icon.pj-mark${fine ? '.ok' : '.warn'}`, icon(fine ? 'check' : 'alert')),
        h('span.row-main', h('span.row-title', x.label), h('span.row-sub.pj-wrap', lines.length ? lines.join(' ') : 'Already up to date.'))),
      decide ? h('div.mrow-actions', startButton(x.dir, { label: 'Ask Claude to sort it out', prompt: `The repository ${x.label} and its online copy have both changed. Show me what differs, then ask me before you merge or rebase.` })) : null,
      x.todo.some((t) => t.command) ? h('details.pj-cmd', h('summary', 'Show the git command'), h('code.mono', x.todo.filter((t) => t.command).map((t) => t.command).join('\n'))) : null);
  }));
}

function syncResult(p, data) {
  // Code repositories without an online address are not synced at all: say so instead of leaving them out.
  const skipped = p.repos.filter((r) => !data.repos.some((x) => x.rel === r.rel)).map((r) => ({ rel: r.rel, did: [], todo: [{ kind: r.ok ? 'not-online' : 'missing', why: '', command: '' }] }));
  return syncRows([...data.repos, ...skipped].map((x) => {
    const repo = p.repos.find((r) => r.rel === x.rel);
    return { label: repo ? repo.label : x.rel, did: x.did, todo: x.todo, dir: p.dir };
  }));
}

function viewProject(frame, id) {
  const sessionsBox = h('div.pj-wrapsub', skeleton(1));
  const pastBox = h('div');
  const reposBox = h('div', skeleton(1));
  const resultBox = h('div', { 'aria-live': 'polite' });
  const skillsBox = h('div.pj-wrapsub', skeleton(1));
  const brainBox = h('div.pj-wrapsub', skeleton(1));
  const advanced = h('div');
  const log = logBox();
  let alive = true;
  let p = null;
  let data = null;
  let working = false;

  const draw = (title) => frame({
    title,
    page: 'workspace',
    back: link('#/workspace'),
    backLabel: 'Workspace',
    intro: 'Everything about this project: the sessions in it, its code and the skills Claude uses here.',
    primary: { label: 'Start a session', icon: 'play', onclick: () => p && startIn(p.dir).catch((e) => toast(e.message, { kind: 'error', ms: 7000 })) },
    body: [
      groupHead('Sessions'), sessionsBox, pastBox,
      groupHead('Repositories'), h('p.hint.pj-lead', 'Where the code is kept with its history (git). Sync brings each one up to date with its online copy and never decides anything for you.'),
      reposBox, resultBox,
      groupHead('Skills'), skillsBox,
      groupHead('AI brain'), brainBox,
      fold('project', 'Advanced', advanced),
    ],
  });
  draw(id);

  // ---- sessions: the same row as Workspace and Home, drawn again only when one of them changes ----
  let seen = null;
  function paintSessions() {
    if (!p) return;
    const list = sessionsIn(p.dir);
    const now = JSON.stringify(list.map((s) => [s.name, s.cwd, s.status, s.limit, s.lastMessage, s.note, s.profile && s.profile.name]));
    if (now === seen) return;
    seen = now;
    const profiles = (store.data && store.data.profiles) || [];
    fill(sessionsBox, list.length
      ? h('div.rows.pj-sessions', [...list].sort(needsYouFirst).map((s) => sessionRow(s, profiles, () => store.refresh(), { where: repoOf(p, s) })))
      : h('div.rows', h('div.row.static.pj-none', h('span.row-sub', 'No session yet'))));
  }
  async function loadPast() {
    let r;
    try {
      r = { sessions: await conversationsIn(p.dir) };
    } catch {
      return fill(pastBox); // a folder outside the dashboard's folders: nothing to continue from here
    }
    if (!alive || !r.sessions.length) return fill(pastBox);
    let all = false;
    const paint = () => fill(pastBox,
      h('p.field-label.pj-sublabel', 'Earlier conversations: continue one where it stopped'),
      h('div.rows', (all ? r.sessions : r.sessions.slice(0, 4)).map((c) => h('div.row.static.pj-past',
        h('span.row-icon', icon('text')),
        h('span.row-main', h('span.row-title', c.title, toolBadge(c.tool)), h('span.row-sub', ago(c.at))),
        startButton(p.dir, { label: 'Continue', title: 'Continue this conversation in a chat', sessionId: c.id, tool: c.tool })))),
      !all && r.sessions.length > 4 ? h('button.btn.ghost.small.pj-more', { type: 'button', onclick: () => { all = true; paint(); } }, `Show all ${r.sessions.length}`) : null);
    paint();
  }

  // ---- repositories ----
  const installDir = (r) => (p.workspace ? (r.rel === '.' ? p.id : `${p.id}/${r.rel}`) : p.id);
  function paintRepos() {
    fill(reposBox,
      h('div.rows', p.repos.map((r) => h('div.row.static.col.mrow',
        h('div.mrow-top',
          h('span.row-icon', icon(r.rel === '.' ? 'folder' : 'text')),
          h('span.row-main',
            h('span.row-title', r.label, r.rel === '.' && p.workspace ? h('span.badge.soft', 'the project itself') : null),
            h(`span.row-sub.pj-wrap${!r.ok || r.changes || r.behind ? '.attn' : ''}`, gitWords(r)))),
        h('div.mrow-actions',
          editorButton(r.dir || p.dir, { name: r.label }),
          r.changes > 0 ? editorButton(r.dir || p.dir, { name: r.label, changes: r.changes }) : null,
          r.ok && r.installs && r.installs.length ? btn('small secondary', { icon: 'download', label: `Install what it needs (${r.installs[0]})`, onclick: (e) => job(e.currentTarget, '/api/pcsetup/install', { dir: installDir(r) }, 'Installing…') }) : null)))),
      h('div.pj-actions',
        btn('secondary', { icon: 'refresh', label: 'Sync', title: 'Download new changes and upload saved ones; never merges, rebases or overwrites', onclick: (e) => sync(e.currentTarget, false) }),
        p.workspace ? btn('ghost', { icon: 'plus', label: 'Add a repository', onclick: addRepo }) : null));
  }

  /** Run a job from a button: the button says what is happening, the result shows under the repositories. */
  async function job(button, path, body, doing) {
    if (working) return;
    working = true;
    const label = button.textContent;
    button.disabled = true;
    fill(button, h('span.pj-spin', { 'aria-hidden': 'true' }), h('span', doing));
    fill(resultBox);
    try {
      const r = await runJob(path, body, log, () => alive);
      if (!r) return null;
      if (!r.ok && !r.data) fill(resultBox, errorBox(r.error || 'That did not work: the details are under Advanced.'));
      else if (!r.data) fill(resultBox, okBox('Done.'));
      return r;
    } catch (e) {
      fill(resultBox, errorBox(e.message));
      return null;
    } finally {
      working = false;
      if (alive) {
        button.disabled = false;
        button.textContent = label;
        load(true);
      }
    }
  }

  async function sync(button, memory) {
    const r = await job(button, '/api/pcsetup/project/sync', { name: p.id, memory }, 'Syncing…');
    if (!r || !r.data || !alive) return;
    const did = r.data.repos.reduce((n, x) => n + x.did.length, 0);
    fill(resultBox,
      r.ok ? okBox(did ? 'Synced.' : 'Synced: everything was already up to date.') : h('div.banner.warn', icon('alert', { size: 18 }), h('span', did ? 'Synced what could be synced. Some of it needs you:' : 'Nothing was changed. Some of it needs you:')),
      r.data.memory ? h('p.hint', r.data.memory.committed ? 'The AI memory was saved to git.' : `AI memory: ${r.data.memory.why}.`) : null,
      syncResult(p, r.data));
  }

  async function addRepo() {
    let gh = { signedIn: false };
    try {
      gh = (await api(`/api/pcsetup/project/preview?name=${enc(p.id)}`)).github;
    } catch {
      /* without GitHub */
    }
    const choice = await openSheet({ title: 'Add a repository', subtitle: `A new code repository inside ${p.name}, in its code folder.` }, (close) => {
      const input = h('input.field', { placeholder: 'web', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', autofocus: true });
      const err = h('p.form-error', { role: 'alert' });
      const shown = h('p.hint');
      const showName = () => (shown.textContent = input.value.trim() ? `It is called ${input.value.trim().startsWith(`${p.id}-`) ? input.value.trim() : `${p.id}-${input.value.trim()}`}, in code/.` : 'For example "web", "api" or "app".');
      input.addEventListener('input', showName);
      showName();
      let github = false;
      const where = h('div');
      const paintWhere = () => fill(where, gh.signedIn
        ? radioCards('repo-where', [
          { value: 'local', title: 'Only on this computer', sub: 'You can put it on GitHub later.' },
          { value: 'github', title: 'Also on GitHub, private', sub: `A private repository under ${gh.account || 'your account'}, uploaded now.` },
        ], github ? 'github' : 'local', (v) => { github = v === 'github'; paintWhere(); })
        : h('p.hint', 'To also put it on GitHub, sign in to GitHub first (Computers → this computer → Setup).'));
      paintWhere();
      return h('form', { onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!NAME_RE.test(v)) err.textContent = 'Letters, digits, ".", "_" and "-"';
        else close({ repo: v, github });
      } },
      h('label.fieldrow', h('span.field-label', 'Name'), input, shown), err, where,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'Add it')));
    });
    if (!choice) return;
    const b = reposBox.querySelector('.pj-actions .btn.ghost') || reposBox.querySelector('.pj-actions .btn');
    const r = await job(b, '/api/pcsetup/project/add', { name: p.id, ...choice }, 'Adding…');
    if (r && r.ok) fill(resultBox, okBox(`Repository added: ${choice.repo.startsWith(`${p.id}-`) ? choice.repo : `${p.id}-${choice.repo}`}, in the code folder.`));
  }

  // ---- skills ----
  async function loadSkills() {
    let installed;
    let suggested;
    try {
      [installed, suggested] = await Promise.all([api(`/api/skillhub?project=${enc(p.dir)}`), api(`/api/skillhub/suggest?project=${enc(p.dir)}`)]);
    } catch (e) {
      if (alive) fill(skillsBox, h('p.hint', `Skills cannot be shown for this folder: ${e.message}`));
      return;
    }
    if (!alive) return;
    const here = (installed.project && installed.project.skills) || [];
    const forYou = installed.user.skills.length;
    const open = suggested.suggestions.filter((s) => !s.installed);
    fill(skillsBox,
      h('div.rows',
        here.map((s) => h('div.row.static', h('span.row-icon', icon('sparkle')), h('span.row-main', h('span.row-title', s.name), h('span.row-sub', s.description || 'no description')))),
        listRow({ href: link(`#/skills/${enc(p.dir)}`), icon: 'book', title: open.length ? `${plural(open.length, 'skill')} suggested for this project` : 'Skills for this project',
          sub: [here.length ? `${here.length} installed here` : 'none installed here yet', forYou ? `${forYou} for you in every project` : ''].filter(Boolean).join(' · ') })));
  }

  // ---- advanced ----
  function paintAdvanced() {
    fill(advanced,
      h('div.pj-adv',
        h('div.inforow', h('div.inforow-top', h('span', 'Folder'), h('strong.pj-wrap', tildePath(p.dir, data.home)))),
        h('div.pj-actions',
          btn('small secondary', { icon: 'terminal', label: 'Open a terminal here', onclick: async () => {
            try {
              const { name } = await api('/api/shells', { dir: p.dir });
              location.hash = link(`#/s/${enc(name)}`);
            } catch (e) {
              toast(e.message, { kind: 'error' });
            }
          } }),
          p.workspace && Object.keys(p.memories).length ? btn('small secondary', { icon: 'refresh', label: 'Sync and save the AI memory', title: 'Also commits the AI memory folder before syncing', onclick: (e) => sync(e.currentTarget, true) }) : null),
        h('p.field-label', 'Details of the last action'),
        log));
  }

  async function load(again = false) {
    try {
      data = await api('/api/pcsetup/projects');
    } catch (e) {
      if (alive) fill(reposBox, errorBox(`Could not read the project: ${e.message}`), btn('secondary', { icon: 'refresh', label: 'Try again', onclick: () => load() }));
      return;
    }
    if (!alive) return;
    const found = projectsOf(data).find((x) => x.id === id);
    if (!found) {
      fill(sessionsBox);
      fill(reposBox, emptyState('folder', `There is no project "${id}" in ${tildePath(data.projectsDir, data.home)} on this computer.`, h('a.btn.secondary', { href: link('#/workspace') }, 'All projects')));
      fill(skillsBox);
      fill(brainBox);
      return;
    }
    const first = !p;
    p = found;
    if (first) {
      if (p.name !== id) draw(p.name); // the frame keeps these boxes: drawing it again with the real name moves nothing
      loadPast();
      loadSkills();
      projectBrain(brainBox, p.name);
    }
    paintSessions();
    paintRepos();
    if (!again || first) paintAdvanced();
  }
  load();
  const unsubscribe = store.subscribe(() => paintSessions());
  return () => {
    alive = false;
    unsubscribe();
  };
}

function viewProjects({ frame, sub }) {
  store.viewing = null;
  const one = /^project\/(.+)$/.exec(sub);
  return one ? viewProject(frame, decodeURIComponent(one[1])) : viewList(frame);
}

// ======================= New project / Get an existing project =======================

const STEPS = ['Name', 'Check', 'Done'];
const stepper = (i, names = STEPS) => stepHeader(names, i);

/** The step pages' last step: the job's output while it runs, then the result with what to do next. */
async function finish(box, { path, body, doing, done, alive, back, plainError = (e) => e }) {
  const log = logBox();
  fill(box, stepper(2), busy(doing), fold('project-steps', 'Details', log));
  let r;
  try {
    r = await runJob(path, body, log, alive);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (!r || !alive()) return;
  const made = r.data && r.data.made;
  const where = (r.started && r.started.dir) || (r.data && r.data.dir);
  const id = (r.started && r.started.name) || (r.data && r.data.name);
  fill(box, stepper(2),
    r.ok || made
      ? [okBox(done(where)), r.ok ? null : h('p.hint', `Some of it did not work: ${r.error || 'see the details below'}.`),
        h('div.pj-next', startButton(where, { cls: 'primary', label: 'Start a session' }), h('a.btn.secondary', { href: link(`#/workspace/project/${enc(id)}`) }, icon('folder', { size: 18 }), h('span', 'Open the project')))]
      : [errorBox(plainError(r.error || 'That did not work.')), h('div.pj-next', btn('secondary', { icon: 'back', label: 'Back', onclick: back }))],
    fold('project-steps', 'Details', log));
}

function viewNewProject({ frame, sub }) {
  store.viewing = null;
  const box = h('div.pj-wizard');
  // "#/new-project/<name>": from New session's "Make it a project", named after the folder that was picked. A project
  // is made new in the projects folder (no route takes in a folder that exists elsewhere), so the page says so.
  let named = '';
  try {
    named = decodeURIComponent(sub || '');
  } catch {}
  if (!NAME_RE.test(named)) named = '';
  frame({ title: 'New project', page: 'new-project', back: link('#/workspace'), backLabel: 'Workspace', intro: 'A new, empty project folder, ready for Claude. You see everything it creates before anything is made.',
    body: [named ? h('p.banner.info.pj-from', icon('folder', { size: 18 }), h('span', `Named after the folder you picked. The project is made new in your projects folder; that folder stays where it is: move its files into the project, or ask Claude there to.`)) : null, box] });
  let alive = true;
  const st = { name: named, github: false, preview: null };

  function stepName(error = '') {
    const input = h('input.field', { value: st.name, placeholder: 'my-project', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', autofocus: true, maxlength: 100 });
    const err = h('p.form-error', { role: 'alert' }, error);
    const next = h('button.btn.primary', { type: 'submit' }, 'Next');
    fill(box, stepper(0), h('form.pj-form', { onsubmit: async (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!NAME_RE.test(v)) return void (err.textContent = 'Use letters, digits, ".", "_" and "-", starting with a letter or a digit.');
      next.disabled = true;
      next.textContent = 'Checking…';
      try {
        const pv = await api(`/api/pcsetup/project/preview?name=${enc(v)}`);
        if (pv.exists) throw new Error(`There is already a folder called ${v} in the projects folder: pick another name.`);
        Object.assign(st, { name: v, preview: pv });
        if (alive) stepCheck();
      } catch (er) {
        err.textContent = er.message;
        next.disabled = false;
        next.textContent = 'Next';
      }
    } },
    h('label.fieldrow', h('span.field-label', 'Project name'), input, h('span.hint', 'It becomes the folder name. Letters, digits, ".", "_" and "-".')),
    err,
    h('div.pj-next', next)));
    input.focus();
  }

  function stepCheck() {
    const pv = st.preview;
    const where = h('div');
    const paintWhere = () => fill(where, pv.github.signedIn
      ? radioCards('new-where', [
        { value: 'local', title: 'Only on this computer', sub: 'You can put it on GitHub later.' },
        { value: 'github', title: 'Also on GitHub, private', sub: `Makes a private repository ${pv.github.account ? `under ${pv.github.account} ` : ''}and uploads the project to it.` },
      ], st.github ? 'github' : 'local', (v) => { st.github = v === 'github'; paintWhere(); })
      : h('p.hint', 'It stays on this computer. To also put it on GitHub, sign in to GitHub first (Computers → this computer → Setup); you can do it later.'));
    paintWhere();
    const create = btn('primary', { icon: 'check', label: 'Create project', onclick: () => finish(box, {
      path: '/api/pcsetup/project/new', body: { name: st.name, github: st.github }, doing: `Creating ${st.name}…`, alive: () => alive,
      done: (dir) => `${st.name} is ready in ${tildePath(dir, pv.home)}.${st.github ? ' It is on GitHub too.' : ''}`,
      back: stepCheck,
      plainError: (e) => (/git does not know your name/.test(e) ? 'git needs your name and e-mail once before it can save anything. Open a terminal (Computers → this computer → Setup), set them as the details below show, then try again.' : e),
    }) });
    fill(box, stepper(1),
      h('section.card.panel',
        h('h2.panel-title', 'What it creates'),
        h('ul.pj-will',
          h('li', 'The folder ', h('strong.pj-wrap', tildePath(pv.dir, pv.home))),
          pv.template === 'built-in'
            ? h('li', 'A small set of starting files: the rules Claude and other AI tools read (AGENTS.md), a place for the AI memory and notes (ai_brain), docs and decisions, and a code folder for the project\'s code repositories.')
            : h('li', 'The files of your own project template.'),
          h('li', 'A first save in git, so every later change can be seen and undone.'),
          st.github ? h('li', 'A private GitHub repository, with the project uploaded to it.') : null),
        pv.files ? fold('new-files', `All ${pv.files.length} files`, h('ul.pj-files.mono', pv.files.map((f) => h('li', f)))) : null),
      h('p.field-label', 'Where it is kept'), where,
      h('div.pj-next', btn('secondary', { icon: 'back', label: 'Back', onclick: () => stepName() }), create));
  }

  stepName();
  return () => {
    alive = false;
  };
}

/** The folder name a project spec gets (as the server's parseProjectSpec): the last part, without ".git". */
const specName = (s) => s.trim().replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || '';

function viewGetProject({ frame, sub }) {
  store.viewing = null;
  const box = h('div.pj-wizard');
  frame({ title: 'Get an existing project', page: 'get-project', back: link('#/workspace'), backLabel: 'Workspace', intro: 'Download a project you already have on GitHub (or another git server) to this computer.', body: [box] });
  let alive = true;
  // "#/get-project/<address>": a project of the workspace map that is not on this computer yet ("Get it").
  let spec = '';
  try {
    spec = decodeURIComponent(sub || '').trim().slice(0, 300);
  } catch {}
  let folder = null; // { projectsDir, home }
  api('/api/pcsetup/projects').then((d) => (folder = d), () => {});

  function stepName(error = '') {
    const input = h('input.field', { value: spec, placeholder: 'owner/project', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', autofocus: true });
    const err = h('p.form-error', { role: 'alert' }, error);
    const mine = h('div', h('p.hint', 'Looking for your GitHub repositories…'));
    fill(box, stepper(0), h('form.pj-form', { onsubmit: (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return void (err.textContent = 'Type its name, owner/name or its address.');
      if (/^-|\s|^file:/i.test(v) || !NAME_RE.test(specName(v))) return void (err.textContent = 'That is not a name or a git address this can use.');
      spec = v;
      stepCheck();
    } },
    h('label.fieldrow', h('span.field-label', 'Its name on GitHub, owner/name, or its address'), input, h('span.hint', 'For example myname/shop, or https://github.com/myname/shop.')),
    err,
    h('div.pj-next', h('button.btn.primary', { type: 'submit' }, 'Next')),
    mine));
    input.focus();
    api('/api/pcsetup/github').then((gh) => {
      if (!alive) return;
      fill(mine, gh.signedIn && gh.repos.length
        ? [h('p.field-label', `Or pick one of yours (${gh.account})`), h('div.rows.pj-pick', gh.repos.slice(0, 50).map((r) => h('button.row', { type: 'button', onclick: () => { input.value = r.name; spec = r.name; stepCheck(); } },
          h('span.row-icon', icon('download')), h('span.row-main', h('span.row-title', r.name)), r.private ? h('span.badge.soft', 'private') : null, h('span.row-end', icon('chevronRight', { size: 18 })))))]
        : h('p.hint', gh.signedIn ? 'No repositories found on your GitHub account.' : 'Signed in to GitHub, this page lists your own repositories, and private ones can be downloaded too (Computers → this computer → Setup).'));
    }, () => fill(mine));
  }

  function stepCheck() {
    const name = specName(spec);
    const dest = folder ? tildePath(`${folder.projectsDir}/${name}`, folder.home) : `the projects folder, as ${name}`;
    fill(box, stepper(1),
      h('section.card.panel',
        h('h2.panel-title', 'What happens'),
        h('ul.pj-will',
          h('li', 'It downloads ', h('strong.pj-wrap', spec), ' into ', h('strong.pj-wrap', dest), '.'),
          h('li', 'When it is a project with code repositories in its code folder, those come down too, and its AI memory is linked.'),
          h('li', 'Nothing is installed or run: the project\'s page offers to install what it needs.'))),
      h('div.pj-next',
        btn('secondary', { icon: 'back', label: 'Back', onclick: () => stepName() }),
        btn('primary', { icon: 'download', label: 'Get it', onclick: () => finish(box, {
          path: '/api/pcsetup/project/clone', body: { spec }, doing: `Downloading ${name}…`, alive: () => alive,
          done: (dir) => `${name} is on this computer now, in ${folder ? tildePath(dir, folder.home) : dir}.`,
          back: stepCheck,
          plainError: (e) => (/clone failed|no repository|needs the GitHub sign-in/.test(e)
            ? `${name} could not be downloaded. Check its name; a private project needs the GitHub sign-in first (Computers → this computer → Setup). The details below say what git answered.`
            : e),
        }) })));
  }

  stepName();
  return () => {
    alive = false;
  };
}

registerPage({ id: 'workspace', title: 'Workspace', icon: 'folder', group: 'main', order: 10, perComputer: true, render: viewProjects });
registerPage({ id: 'new-project', title: 'New project', icon: 'plus', navAs: 'workspace', perComputer: true, render: viewNewProject });
registerPage({ id: 'get-project', title: 'Get an existing project', icon: 'download', navAs: 'workspace', perComputer: true, render: viewGetProject });
