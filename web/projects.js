// Projects (the address stays #/workspace): the projects of the open computer (src/pcsetup/feature.mjs + the session
// poll). Three tabs first (Projects, Skills, Memory: brainlink.js), then one row per project: its name, one line of
// state in plain words, one New session. "Add project" is the one door in (a sheet of three ways: New, Get from
// GitHub, Found on this computer); Sync, Other folders, Groups and the projects folder are one fold at the end.
//   #/workspace                      the rows
//   #/workspace/project/<folder>     one project: New session and Open code, its sessions (earlier ones folded),
//                                    its repositories as one row with a status, Skills as one row, Memory as a fold;
//                                    Sync, "Add a repository" and the path under Advanced
// (#/projects… addresses from before land here: app.js.)
//   #/new-project          name, brief, kind and scope → what it creates (shown before anything is made), "Start with AI"
//                          → done, "Start a session", or the App session that sets it up from the brief (newproject.js)
//   #/get-project          name or address → what happens → done, "Start a session"
// With several computers the switcher picks whose projects these are (#/m/<computer>/workspace). A "project" is a
// folder in the projects folder: a plain git repository, or a parent repository with its code repositories in
// code/ (docs/PC-SETUP.md).
import { chatTools, startChat } from './chat/start.js';
import { icon } from './icons.js';
import { add, ago, api, btn, fill, h, link, machine, needsYouFirst, openSheet, promptSheet, tildePath, toast, toolBadge } from './lib.js';
import { groupOf } from './home.js';
import { sessionRow } from './sessionitem.js';
import { projectBrain } from './brain.js';
import { projectsTabs } from './brainlink.js';
import { commandLine, freshFork, workspaceStrip } from './workspace.js';
import { asOfWords, computersPanel, dropSheet, groupSheet, removeGroup } from './wsplaces.js';
import { groupTools } from './workspacetool.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, fold, groupHead, listRow, okBox, radioCards, skeletonRows as skeleton, stepHeader } from './shell.js';
import { store } from './store.js';
import { canDeleteConversation, deleteConversation } from './chat/deletes.js';
import { editorButton } from './editor/index.js';
import { openNewSession } from './newsession-popup.js';
import { needsBlock } from './projectneeds.js';
import { needsAfterGet } from './getneeds.js';
import { aiReady, briefFields, markCards, newBody, optionsPart, previewQuery, startLater, startPart, startSession, willLines } from './newproject.js';
import { projectOutSwitch } from './operator-tia.js';
import { projectNoteBox } from './operator-decide.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/**
 * A name as a person types it ("Bakery Website") made into a folder name ("bakery-website"): spaces and other signs
 * become "-", the ends are trimmed. '' when nothing usable is left (then the rule is said).
 */
export function toFolderName(typed) {
  const v = String(typed || '').trim();
  if (NAME_RE.test(v)) return v;
  const f = v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[^a-z0-9]+|[-._]+$/g, '').slice(0, 100);
  return NAME_RE.test(f) ? f : '';
}
const enc = encodeURIComponent;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const busy = (text) => h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));

// ---------- the projects and their git state, in words ----------

/** One list of projects from GET /api/pcsetup/projects: parents with their code repositories, and plain ones. */
export function projectsOf(d) {
  const label = (rel, name) => (rel === '.' ? name : rel.replace(/^code\//, ''));
  return [
    ...d.workspaces.map((w) => ({ id: w.id || w.dir.split(/[\\/]/).pop(), name: w.name, place: w.place || '', dir: w.dir, workspace: true, memories: w.memories || {}, repos: w.repos.map((r) => ({ ...r, label: label(r.rel, w.name) })), notFollowed: w.notFollowed || [] })),
    ...d.repos.map((r) => ({ id: r.id || r.rel, name: r.rel, place: r.place || '', dir: r.dir, workspace: false, memories: {}, repos: [{ ...r, rel: '.', label: r.rel }] })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Check step's first line (the details are folded under "What exactly"): what is made, in one sentence a person
 * who does not know the files can judge. `pv`: the preview (folder, template, files), `st`: the brief typed or not.
 */
export function checkLine(pv, st) {
  const name = String(pv.dir || '').split(/[\\/]/).filter(Boolean).pop() || st.name;
  const brief = st.brief && st.brief.trim() ? 'your brief and ' : '';
  const files = pv.template === 'built-in' ? 'the starting files the AI needs' : 'the files of your own project template';
  const count = Array.isArray(pv.files) && pv.files.length ? ` (${plural(pv.files.length, 'file')})` : '';
  return `A folder ${name} with ${brief}${files}${count}.${st.github ? ' It is uploaded to a private GitHub repository too.' : ''} Nothing else on the computer changes.`;
}

/** "Sign in to GitHub": GitHub's sign-in sheet opens over the step he is on (the same sheet as Setup's Sign in), so
 * what he typed stays; `after()` once he is signed in draws the step again. The address stays Setup's, for a new tab.
 * `onPress(signing)`: told at the press, with the sign-in's promise (true when signed in). A link inside a sheet needs
 * it: the sign-in sheet takes that sheet's place (one sheet at a time), so the sheet opens itself again once it ends. */
export const signInLink = (after, { onPress = null } = {}) => h('a', { href: link('#/computer/setup?show=git'), onclick: async (e) => {
  e.preventDefault();
  const signing = import('./gitsetup.js').then(({ signinSheet }) => signinSheet());
  onPress?.(signing);
  if (await signing) after?.();
} }, 'sign in to GitHub');

/**
 * "Add a repository" of project `p`: the name and where it goes. → { repo, github } or null. "sign in to GitHub" in it
 * opens GitHub's sign-in in this sheet's place; once that ends (signed in or not) this sheet opens again with the name
 * he typed and his choice, now with the GitHub choice when he signed in. `alive()`: the page is still open.
 */
export async function repoSheet(p, { alive = () => true } = {}) {
  const keep = { name: '', github: false };
  for (;;) {
    let gh = { signedIn: false };
    try {
      gh = (await api(`/api/pcsetup/project/preview?name=${enc(p.id)}`)).github || gh;
    } catch {
      /* without GitHub */
    }
    let signing = null;
    const choice = await openSheet({ title: 'Add a repository', subtitle: `A new code repository inside ${p.name}, in its code folder.` }, (close) => {
      const input = h('input.field', { value: keep.name, placeholder: 'web', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', autofocus: true });
      const err = h('p.form-error', { role: 'alert' });
      const shown = h('p.hint');
      const showName = () => {
        keep.name = input.value;
        const v = input.value.trim();
        shown.textContent = v ? `It is called ${v.startsWith(`${p.id}-`) ? v : `${p.id}-${v}`}, in code/.` : 'For example "web", "api" or "app".';
      };
      input.addEventListener('input', showName);
      showName();
      const where = h('div');
      const paintWhere = () => fill(where, gh.signedIn
        ? radioCards('repo-where', [
          { value: 'local', title: 'Only on this computer', sub: 'You can put it on GitHub later.' },
          { value: 'github', title: 'Also on GitHub, private', sub: `A private repository under ${gh.account || 'your account'}, uploaded now.` },
        ], keep.github ? 'github' : 'local', (v) => { keep.github = v === 'github'; paintWhere(); })
        : h('p.hint', 'To also put it on GitHub, ', signInLink(null, { onPress: (x) => (signing = x) }),
          ' first (it opens here, and you come back to this sheet with the name you typed).'));
      paintWhere();
      return h('form', { onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!NAME_RE.test(v)) err.textContent = 'Letters, digits, ".", "_" and "-"';
        else close({ repo: v, github: gh.signedIn && keep.github });
      } },
      h('label.fieldrow', h('span.field-label', 'Name'), input, shown), err, where,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'Add it')));
    });
    if (choice || !signing) return choice;
    // The sign-in took this sheet's place: once it ends (signed in or not), the sheet opens again with what he typed.
    const ran = await signing.then(() => true, () => false);
    if (!ran || !alive()) return null;
  }
}

/**
 * The words of "This link is mine" (`link`, where it leads `to`, both as the page shows them): what changes on his yes.
 * → { title, lines, ok }.
 */
export function myLinkWords(link, to) {
  return {
    title: 'Is this link yours?',
    lines: [
      `${link} is a link that leads out of the project, to ${to}.`,
      'If you made it yourself (a folder of yours kept on another disk or in another place), Hoprig follows it from now on, on this computer only, as part of the project: it syncs it, installs in it and links memory into it.',
      'If the link came with a repository from a git server and you do not know it, press Cancel: Hoprig keeps leaving it alone. If it is pointed elsewhere later, Hoprig stops following it and says so.',
    ],
    ok: 'Yes, it is mine',
  };
}

/** "This link is mine": where it leads is asked first (nothing saved), then his yes names it as his (the same step as
 * `hoprig workspace mylink add`, POST /api/workspace/mylink). Resolves true when it was named. */
export async function myLinkSheet(linkPath, home) {
  let look;
  try {
    look = await api('/api/workspace/mylink', { path: linkPath, dryRun: true });
  } catch (e) {
    toast(e, { kind: 'error', ms: 7000 });
    return false;
  }
  const w = myLinkWords(tildePath(linkPath, home), look.to);
  return openSheet({ title: w.title }, (close) => {
    const state = h('div', { 'aria-live': 'polite' });
    const yes = btn('primary', { icon: 'check', label: w.ok, onclick: async () => {
      yes.disabled = true;
      try {
        await api('/api/workspace/mylink', { path: linkPath, seen: look.seen });
        toast('Hoprig follows that link now.');
        close(true);
      } catch (e) {
        yes.disabled = false;
        fill(state, errorBox(e));
      }
    } });
    return [...w.lines.map((t, i) => h(i ? 'p.hint' : 'p.sheet-text', t)), state,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', autofocus: true, onclick: () => close(false) }, 'Cancel'), yes)];
  }).then((v) => v === true);
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
// first message. On the computer whose Workspace is open.
const startIn = (dir, { sessionId = null, prompt = null, tool = null } = {}) => startChat(dir, { sessionId, text: prompt, tool }, machine.current);

/** The earlier conversations of `dir` in every coding tool a chat can run here, newest first, each with its tool. */
async function conversationsIn(dir) {
  const tools = await chatTools(); // the open computer's tools, as its folders are
  const lists = await Promise.all(tools.map((t) => api(`/api/folders/sessions?${new URLSearchParams({ path: dir, ...(t.id !== 'claude' ? { tool: t.id } : {}) })}`)
    .then((r) => r.sessions.map((c) => ({ ...c, tool: t.id })), (e) => (t.id === 'claude' ? Promise.reject(e) : []))));
  return lists.flat().sort((a, b) => b.at - a.at);
}

/** A button that opens a chat and says so while it does; an error stays next to it until the next press. */
export function startButton(dir, { cls = 'small secondary', label = 'Start', title = 'Open the App here', ...how } = {}) {
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

/** "New session" in a project: the popup with the project set; App or Terminal and the coding tool are chosen there. */
const newIn = (dir, name) => openNewSession({ m: machine.current, project: { path: dir, name, short: tildePath(dir) } });
const newSessionButton = (dir, name, { cls = 'small secondary', label = 'New session' } = {}) =>
  btn(cls, { icon: 'plus', label, title: `A new session in ${name}`, onclick: (e) => {
    e.preventDefault();
    e.stopPropagation();
    newIn(dir, name);
  } });

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
  const key = `${machine.current || '~'}:${dir}`;
  if (!pastOf.has(key)) pastOf.set(key, conversationsIn(dir).catch(() => []));
  return pastOf.get(key);
}

/**
 * Delete beside an ended conversation of Claude Code's (deletes.js deleteConversation, the App's own Delete: the trash,
 * its journal, a conversation someone else writes is never moved). Another coding tool's is not offered. done(): the
 * list changed.
 */
function pastDelete(dir, c, done) {
  if (!canDeleteConversation(c, c.tool)) return null; // another tool's, or open in an App session
  const name = c.title && c.title !== '(untitled)' ? c.title : 'Untitled conversation';
  return h('button.btn.icon.ghost.small.pj-pastdel', { type: 'button', title: `Delete "${name}"`, 'aria-label': `Delete ${name}`, onclick: async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // After the Delete and after its Undo: the list read again (it changed both times).
    await deleteConversation(dir, c.id, name, { after: () => {
      store.refresh();
      done();
    } });
  } }, icon('trash', { size: 16 }));
}

/** "Earlier conversations (n)", folded, only when there are some. */
function earlier(p) {
  const slot = h('div.ws-pastslot');
  const again = () => {
    pastOf.delete(`${machine.current || '~'}:${p.dir}`);
    fill(slot, earlier(p));
  };
  pastIn(p.dir).then((list) => {
    if (!list.length) return fill(slot);
    fill(slot, fold(`ws-past-${p.id}`, `Earlier conversations (${list.length})`,
      h('div.rows.ws-pastrows', list.slice(0, 8).map((c) => h('div.row.static',
        h('span.row-icon', icon('text')),
        h('span.row-main', h('span.row-title', c.title, toolBadge(c.tool)), h('span.row-sub', ago(c.at))),
        startButton(p.dir, { sessionId: c.id, tool: c.tool, label: 'Continue', title: 'Continue this conversation in the App' }),
        pastDelete(p.dir, c, again))))));
  });
  return slot;
}

/** The ways into a new project: the three choices of "Add project" (one door; the pages behind them stay as they are). */
export const ADD_WAYS = [
  { id: 'new', icon: 'plus', title: 'New project', sub: 'A new folder, ready for coding', href: '#/new-project' },
  { id: 'get', icon: 'download', title: 'Get from GitHub', sub: 'One you already have online', href: '#/get-project' },
  { id: 'found', icon: 'search', title: 'Found on this computer', sub: 'Folders you already have here', href: '#/adopt' },
];

/** "Add project": the sheet of the three ways; a press closes it and opens that page. */
function addSheet() {
  return openSheet({ title: 'Add project' }, (close) => h('div.rows', ADD_WAYS.map((w) => listRow({ icon: w.icon, title: w.title, sub: w.sub, onclick: () => {
    close(null);
    location.hash = link(w.href);
  } }))));
}

/** The one line under a project's name: a session that needs you first, then its git state in words. */
export function projectLine(p, sessions) {
  const need = sessions.filter((s) => groupOf(s) === 'needs').length;
  const words = projectWords(p);
  return { text: need ? `${need === 1 ? 'Needs you' : `${need} need you`} · ${words}` : words, attn: need > 0 || needsLook(p) };
}

/** One project: its name and state (a press opens its page) and one New session. */
function projectRow(p, sessions) {
  const line = projectLine(p, sessions);
  return h('div.row.static.pj-row', { 'aria-label': p.name },
    h('a.pj-rowmain', { href: link(`#/workspace/project/${enc(p.id)}`) },
      h('span.row-icon', icon('folder')),
      h('span.row-main', h('span.row-title', p.name), h(`span.row-sub.pj-git${line.attn ? '.attn' : ''}`, { title: line.text }, line.text))),
    newSessionButton(p.dir, p.name));
}

/** A project of the workspace map that is not on this computer (the normal state): the one way to get it. */
function awayRow(e, on) {
  return h('div.row.static.pj-row.pj-away', { 'aria-label': `${e.label}: not on this computer` },
    h('span.pj-rowmain', h('span.row-icon', icon('download')),
      h('span.row-main', h('span.row-title', e.label), h('span.row-sub.pj-git', on.length ? `On ${on.join(', ')}` : 'Not on this computer'))),
    e.url ? h('a.btn.small.secondary', { href: link(`#/get-project/${enc(e.url)}`), title: `Get ${e.label}` }, icon('download', { size: 16 }), h('span', 'Get it')) : null);
}

/** Sessions started outside the projects folder, with the advice to make a project of it. */
function otherFolders(sessions, profiles) {
  return h('section.ws-other',
    groupHead('Other folders', sessions.length),
    h('p.hint.ws-advice', 'These run outside the projects folder. Make a project of the folder you keep working in: its coding tools then get its memory and skills.'),
    h('div.rows', [...sessions].sort(needsYouFirst).map((s) => sessionRow(s, profiles, () => store.refresh()))));
}

function viewList(frame, query = new URLSearchParams()) {
  pastOf.clear();
  // The workspace's state through git (workspace.js): drawn again when its answer arrives. It lives in the fold at the end.
  const strip = workspaceStrip(() => paint());
  const body = h('div.pj-page', skeleton(4));
  const rest = h('div.pj-rest');
  const more = fold('projects-more', 'More', strip.el, rest);
  more.classList.add('hidden');
  const moreLabel = more.querySelector('.fold-summary span');
  frame({
    title: 'Projects',
    page: 'workspace',
    primary: { label: 'Add project', icon: 'plus', onclick: addSheet },
    body: [projectsTabs('projects'), body, more],
  });
  let alive = true;
  let data = null;
  let asked = false;
  const paint = () => {
    if (!data) return;
    const list = projectsOf(data);
    const map = strip.map();
    // Projects of the workspace map that are not on this computer (the normal state; "missing" from an older
    // computer): quiet rows with "Get it" and the computers whose own file says they have it.
    const away = map ? map.entries.filter((e) => e.kind === 'project' && (e.state === 'notHere' || e.state === 'missing')) : [];
    const sessions = (store.data && store.data.sessions) || [];
    const profiles = (store.data && store.data.profiles) || [];
    const of = new Map(list.map((p) => [p, sessions.filter((s) => inside(p.dir, s.cwd))]));
    // Sessions in the product's own folders (Tia's working folders, `own`) are no folder of the owner's.
    const others = sessions.filter((s) => !s.own && !list.some((p) => inside(p.dir, s.cwd)));
    const ordered = [...list].sort((a, b) => projectRank(of.get(a)) - projectRank(of.get(b)) || lastUse(of.get(b)) - lastUse(of.get(a)) || a.name.localeCompare(b.name));
    // Which other computer has an entry of the map: the one reader (whohas), else an older computer's own list.
    const whoEntry = (label) => (data.who ? data.who.entries.find((x) => x.name === label) : null);
    // An old file says so on the row too: "box2, as of 6 Nov 2026" (it may have changed since).
    const said = (l) => {
      const c = data.who.computers.find((x) => x.label === l);
      return c && c.old ? `${l}, ${asOfWords(c).replace(/ \(old.*$/, '')}` : l;
    };
    const onOthers = (label) => (data.who ? (whoEntry(label) || { on: [] }).on.filter((l) => l !== data.who.label).map(said) : ((data.computers && data.computers.computers) || []).filter((c) => !c.mine && c.here.includes(label)).map((c) => c.label));
    const rows = (ps, aw) => h('div.rows.pj-rows', [...ps.map((p) => projectRow(p, of.get(p))), ...aw.map((e) => awayRow(e, onOthers(e.label)))]);
    fill(body, list.length || away.length
      ? (placesOf(data).length > 1 ? byPlace(placesOf(data), ordered, away, rows) : rows(ordered, away))
      // A fresh computer (no projects, no map): bring the workspace from git, or start a new project.
      : map && !map.exists ? freshFork(() => { strip.load(); load(); })
      : emptyState('folder', 'No projects yet. A project is a folder with your code.', btn('primary', { icon: 'plus', label: 'Add project', onclick: addSheet })));
    // The end fold: Sync (the strip), Other folders, Groups, the computers, the projects folder. Shown when it holds something.
    fill(rest,
      others.length ? otherFolders(others, profiles) : null,
      map && map.exists ? groupsLine(data, map, () => { strip.load(); load(); }) : null,
      computersPanel(data.who),
      folderLine(data, load));
    more.classList.remove('hidden');
    if (moreLabel) moreLabel.textContent = strip.el.classList.contains('warn') ? 'More: needs a look' : 'More';
    // Tia's card (or a link) opens a sheet filled in: the owner answers and presses there himself.
    if (!asked && map) {
      asked = true;
      // Another computer's page: the sheet names it. Closed: the address loses its query (a reload or Back would open
      // the sheet again) and focus goes to the page's heading, as there is no button that opened it.
      const on = machine.current ? (store.data && store.data.machineLabel) || machine.current : null;
      const closed = () => {
        const [path] = location.hash.split('?');
        // replaceState: no hashchange, so the page is not drawn again and its heading can take the focus.
        if (path !== location.hash) history.replaceState(null, '', path);
        const head = document.querySelector('h1.page-title');
        if (head) {
          head.setAttribute('tabindex', '-1');
          head.focus();
        }
      };
      if (query.get('drop')) dropSheet(query.get('drop'), () => { strip.load(); load(); }, { on }).then(closed);
      else if (query.get('group')) groupSheet({ group: query.get('group'), repo: query.get('repo') || '', holds: query.get('holds') || '' }, () => { strip.load(); load(); }).then(closed);
    }
  };
  async function load() {
    try {
      data = await api('/api/pcsetup/projects');
      // Which other computer has a project of the map (each computer's own file); an older computer has no answer.
      data.computers = await api('/api/workspace/computers').catch(() => null);
      data.who = await api('/api/workspace/whohas').catch(() => null);
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

/** The places of GET /api/pcsetup/projects: the projects folder first, then each group of the workspace map. */
export const placesOf = (d) => (Array.isArray(d.places) && d.places.length ? d.places : [{ id: '', dir: d.projectsDir }]);
/** Where a project of the map is: "<place>/<name>" → "<place>", "<name>" → "" (the projects folder). */
export const placeOfLabel = (label) => (label.includes('/') ? label.slice(0, label.lastIndexOf('/')) : '');

/** With groups in the map: one section per place, the projects folder first, each with its projects (and the ones only in the map). */
function byPlace(places, ordered, away, rows) {
  return h('div.ws-places', places.map((pl) => {
    const ps = ordered.filter((p) => (p.place || '') === pl.id);
    const aw = away.filter((e) => placeOfLabel(e.label) === pl.id);
    return h('section.ws-place', { 'aria-label': pl.id || 'Projects' },
      groupHead(pl.id || 'Projects', ps.length + aw.length),
      pl.id ? h('p.ws-place-sub', pl.members === 'group' ? `In the group ${pl.group}: its projects come with the group's repository` : pl.group && pl.group !== pl.id ? `In the group ${pl.group}` : 'A group of projects') : null,
      ps.length || aw.length ? rows(ps, aw) : h('p.ws-none', 'No project here yet'));
  }));
}

/** The groups of the map: add one, or take one out of the map (never its folder). */
function groupsLine(d, map, reload) {
  const groups = [...new Set(((map.map && map.map.groups) || []).map((g) => g.dir))];
  return h('section.ws-groups', { 'aria-label': 'Groups' },
    groupHead('Groups', groups.length),
    h('p.ws-place-sub', groups.length ? 'Folders of projects of your own beside the projects folder, kept in the map for every computer.' : 'A folder of projects of your own, for example one for client work.'),
    groups.length ? h('div.rows', groups.map((g) => h('div.row.static', h('span.row-icon', icon('folder')),
      h('span.row-main', h('span.row-title', g), h('span.row-sub', ((map.map.groups || []).find((x) => x.dir === g) || {}).url || 'a folder of projects')),
      btn('small ghost', { icon: 'minus', label: 'Take out of the map', title: `Take ${g} out of the map; its folder stays`, onclick: () => removeGroup(g, reload) })))) : null,
    groups.length ? groupTools() : null,
    h('div.btnrow', btn('small secondary', { icon: 'plus', label: 'Add a group', onclick: () => groupSheet({}, reload) }),
      btn('small ghost', { icon: 'text', label: 'Text for coding sessions', title: 'The short text about this workspace that your coding tools read: shown first, written on your yes', onclick: () => rulesSheet() })));
}

/** "Your workspace" for coding sessions: the text first; written into Hoprig's own file only on his press. */
async function rulesSheet() {
  let r;
  try {
    r = await api('/api/workspace/rules');
  } catch (e) {
    return void toast(e, { kind: 'error', ms: 7000 });
  }
  const state = { current: 'It is written and up to date.', older: 'The file is older than this text.', 'not-written': 'It is not written yet.', 'not-ours': 'A file of that name is there that Hoprig did not make: it is left alone.', link: r.why || 'It is not written there.' }[r.state] || '';
  const ok = await openSheet({ title: 'Text for coding sessions', subtitle: `${r.file}. ${state}`, wide: true }, (close) => [
    h('pre.output', r.text),
    (r.left || []).length ? h('ul.hint', r.left.map((x) => h('li', `${x.name}: ${x.why}`))) : null,
    h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Close'),
      ['older', 'not-written'].includes(r.state) ? h('button.btn.primary', { type: 'button', autofocus: true, onclick: () => close(true) }, 'Write it') : null),
  ]);
  if (ok !== true) return;
  try {
    await api('/api/workspace/rules', {});
    toast('The text for coding sessions is written');
  } catch (e) {
    toast(e, { kind: 'error', ms: 7000 });
  }
}

/** At the end: where new projects go, and a way to change it. */
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
        toast(e, { kind: 'error', ms: 6000 });
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
  'not-online': () => 'Not linked to a copy on a git server yet, so there is nothing to sync with. Your coding tool can do it for you: ask in a session.',
  diverged: () => 'Changed here and online at the same time. This needs a decision: your coding tool can bring the two together.',
  'kept-back': () => 'The new changes put files where something git does not track is here (a file of your own, or a repository of its own). Nothing was changed: move it away first, then sync again.',
  'pull-blocked': () => 'There are new changes online in the same files you changed here. Save (commit) your changes first, then sync again.',
  uncommitted: (t) => `${(/^(\d+)/.exec(t.why) || [, 'Some'])[1]} change${/^1 /.test(t.why) ? ' is' : 's are'} not saved to git yet; sync leaves ${/^1 /.test(t.why) ? 'it' : 'them'} alone.`,
  'fetch-failed': () => 'Could not reach the online copy. Check the internet connection and the GitHub sign-in.',
  'push-failed': () => 'Could not upload the saved changes. Check the GitHub sign-in and that you may write there.',
  missing: () => 'Not on this computer yet.',
  other: (t) => t.why,
};
const DID = { pulled: (n) => `Downloaded ${plural(n, 'new change')}.`, pushed: (n) => `Uploaded ${plural(n, 'saved change')}.` };

/**
 * The result of a sync, one row per repository: what it did, what it left in words, "Sort it out in the App" where
 * a decision is needed (in `dir`, the repository's folder when known) and the git command under "Show the git
 * command". `items`: [{ label, did: [{ kind, count } | string], todo: [{ kind, why, command }], dir }].
 */
export function syncRows(items) {
  return h('div.rows.pj-sync', items.map((x) => {
    const lines = [...x.did.map((d) => (typeof d === 'string' ? d : DID[d.kind] ? DID[d.kind](d.count) : d.text)), ...x.todo.map((t) => (TODO[t.kind] || TODO.other)(t))];
    const fine = !x.todo.length;
    // Never where something git ignores is in the way: a merge or a rebase would delete it (a repository of its own).
    const decide = x.dir && !x.todo.some((t) => t.kind === 'kept-back') && x.todo.find((t) => t.kind === 'diverged' || t.kind === 'pull-blocked');
    return h('div.row.static.col.mrow',
      h('div.mrow-top',
        h(`span.row-icon.pj-mark${fine ? '.ok' : '.warn'}`, icon(fine ? 'check' : 'alert')),
        h('span.row-main', h('span.row-title', x.label), h('span.row-sub.pj-wrap', lines.length ? lines.join(' ') : 'Already up to date.'))),
      decide ? h('div.mrow-actions', startButton(x.dir, { label: 'Sort it out in the App', prompt: `The repository ${x.label} and its online copy have both changed. Show me what differs, then ask me before you merge or rebase. A folder this repository ignores may be a repository of its own: a merge or a rebase deletes it when the other side's commits put files there, so check that first.` })) : null,
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

/** A closed fold that reads as one row: its title with one line of state under it (a count, a status). */
function foldRow(title, sub, body) {
  return h('details.fold.pj-foldrow',
    h('summary.fold-summary', h('span.pj-fold-text', h('span.pj-fold-title', title), sub), icon('chevronDown', { size: 18 })),
    h('div.fold-body', body));
}

function viewProject(frame, id) {
  const sessionsBox = h('div.pj-wrapsub', skeleton(1));
  const pastBox = h('div');
  const reposBox = h('div', skeleton(1));
  const reposLabel = h('span.pj-fold-sub', 'Reading…');
  const reposFold = foldRow('Repositories', reposLabel, h('div.pj-fold-body', reposBox));
  const resultBox = h('div', { 'aria-live': 'polite' });
  const skillsBox = h('div.pj-wrapsub', skeleton(1));
  const brainBox = h('div.pj-wrapsub');
  const brainLabel = h('span.pj-fold-sub', '');
  const brainFold = foldRow('Memory', brainLabel, brainBox);
  const needsBox = h('div.pj-wrapsub');
  const advanced = h('div');
  const projectOutBox = h('div');
  const noteBox = h('div.op-note-box');
  const log = logBox();
  let alive = true;
  let p = null;
  let data = null;
  let working = false;

  const draw = (title) => frame({
    title,
    page: 'workspace',
    back: link('#/workspace'),
    backLabel: 'Projects',
    primary: { label: 'New session', icon: 'plus', onclick: () => p && newIn(p.dir, p.name) },
    actions: p ? [editorButton(p.dir, { name: p.name })] : [],
    body: [sessionsBox, pastBox, reposFold, needsBox, skillsBox, brainFold, fold('project', 'Advanced', advanced)],
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
  // Earlier conversations: one closed fold under the sessions (the same part as before), only when there are some.
  const loadPast = () => fill(pastBox, earlier(p));

  // ---- repositories ----
  const installDir = (r) => (p.workspace ? (r.rel === '.' ? p.id : `${p.id}/${r.rel}`) : p.id);
  function paintRepos() {
    fill(reposBox,
      h('div.rows', p.repos.map((r) => h('div.row.static.col.mrow',
        h('div.mrow-top',
          h('span.row-icon', icon(r.rel === '.' ? 'folder' : 'text')),
          h('span.row-main',
            h('span.row-title', r.label, r.rel === '.' && p.workspace ? h('span.badge.soft', 'the project itself') : null, r.worktree ? h('span.badge.soft', { title: 'A second checkout of a repository (git worktree): not an entry of the workspace map' }, 'worktree') : null),
            h(`span.row-sub.pj-wrap${!r.ok || r.changes || r.behind ? '.attn' : ''}`, gitWords(r)))),
        h('div.mrow-actions',
          editorButton(r.dir || p.dir, { name: r.label }),
          r.changes > 0 ? editorButton(r.dir || p.dir, { name: r.label, changes: r.changes }) : null,
          r.ok && r.installs && r.installs.length ? btn('small secondary', { icon: 'download', label: `Install what it needs (${r.installs[0]})`, onclick: (e) => job(e.currentTarget, '/api/pcsetup/install', { dir: installDir(r) }, 'Installing…') }) : null))),
        // A folder that leads out of the project through a link: never synced, installed or opened from here.
        ...(p.notFollowed || []).map((x) => h('div.row.static.col.mrow.pj-notfollowed',
          h('div.mrow-top',
            h('span.row-icon', icon('lock')),
            h('span.row-main',
              h('span.row-title', x.rel, h('span.badge.soft', 'not followed')),
              h('span.row-sub.pj-wrap', 'It leads out of the project through a link, so Hoprig does not sync it, install in it or link memory into it.'),
              x.link ? h('span.row-sub.pj-wrap', 'If you made that link yourself (a folder of yours kept elsewhere), say so and Hoprig follows it.') : null)),
          x.link ? h('div.mrow-actions', btn('small secondary', { icon: 'check', label: 'This link is mine', onclick: () => myLinkSheet(x.link, data && data.home).then((ok) => ok && load(true)) })) : null))));
    // The one row's status: the project's git state in words, in the colour of "needs a look".
    reposLabel.textContent = projectWords(p);
    reposLabel.classList.toggle('attn', needsLook(p));
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
      fill(resultBox, errorBox(e));
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

  async function addRepo(b) {
    const choice = await repoSheet(p, { alive: () => alive });
    if (!choice) return;
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
        listRow({ href: link(`#/skills/${enc(p.dir)}`), icon: 'book', title: 'Skills',
          sub: [here.length ? `${here.length} installed here` : 'none installed here yet', open.length ? `${open.length} suggested` : '', forYou ? `${forYou} for you in every project` : ''].filter(Boolean).join(' · ') })));
  }

  // ---- advanced ----
  function paintAdvanced() {
    fill(advanced,
      h('div.pj-adv',
        h('div.inforow', h('div.inforow-top', h('span', 'Folder'), h('strong.pj-wrap', tildePath(p.dir, data.home)))),
        h('div.pj-actions',
          btn('small secondary', { icon: 'refresh', label: 'Sync', title: 'Download new changes and upload saved ones; never merges, rebases or overwrites', onclick: (e) => sync(e.currentTarget, false) }),
          p.workspace ? btn('small secondary', { icon: 'plus', label: 'Add a repository', onclick: (e) => addRepo(e.currentTarget) }) : null),
        resultBox,
        h('div.pj-actions',
          btn('small secondary', { icon: 'terminal', label: 'Open a terminal here', onclick: async () => {
            try {
              const { name } = await api('/api/shells', { dir: p.dir });
              location.hash = link(`#/s/${enc(name)}`);
            } catch (e) {
              toast(e, { kind: 'error' });
            }
          } }),
          btn('small secondary', { icon: 'trash', label: 'Take it off this computer', title: 'Drop: only when all of it is on its git server; Get brings it back', onclick: () => dropSheet(p.place ? `${p.place}/${p.dir.split(/[\\/]/).pop()}` : p.dir.split(/[\\/]/).pop(), () => (location.hash = link('#/workspace'))) }),
          p.workspace && Object.keys(p.memories).length ? btn('small secondary', { icon: 'refresh', label: 'Sync and save the AI memory', title: 'Also commits the AI memory folder before syncing', onclick: (e) => sync(e.currentTarget, true) }) : null),
        projectOutBox,
        noteBox,
        h('p.field-label', 'Details of the last action'),
        log));
    projectNoteBox(noteBox, p.id); // his standing note for Tia's decisions here
    projectOutSwitch(projectOutBox, p.id); // by its ref, as the server names it (a project in a group: <place>/<name>)
  }

  async function load(again = false) {
    try {
      data = await api('/api/pcsetup/projects');
      // Which other computer has a project of the map (each computer's own file); an older computer has no answer.
      data.computers = await api('/api/workspace/computers').catch(() => null);
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
      reposLabel.textContent = '';
      return;
    }
    const first = !p;
    p = found;
    if (first) {
      draw(p.name); // the frame keeps these boxes: drawing it again with the real name (and Open code) moves nothing
      loadPast();
      loadSkills();
      needsBlock(needsBox, p.dir);
      projectBrain(brainBox, p.name).then(() => {
        if (!alive) return;
        const n = brainBox.querySelectorAll('a.row').length;
        brainLabel.textContent = n ? plural(n, 'file') : 'nothing yet';
        if (!n) fill(brainBox, h('p.hint', 'Nothing remembered for this project yet.'));
      });
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

function viewProjects({ frame, sub, query }) {
  store.viewing = null;
  const one = /^project\/(.+)$/.exec(sub);
  return one ? viewProject(frame, decodeURIComponent(one[1])) : viewList(frame, query);
}

// ======================= New project / Get an existing project =======================

const STEPS = ['Name', 'Check', 'Done'];
const stepper = (i, names = STEPS) => stepHeader(names, i);

/**
 * How a step page's job ended: done | needs-you (not done: the owner runs the job's `fix`, e.g. the mv for a project
 * here under another name) | failed.
 */
export const jobOutcome = (r) => (r && r.data && r.data.fix ? 'needs-you' : r && (r.ok || (r.data && r.data.made)) ? 'done' : 'failed');

/** The step pages' last step: the job's output while it runs, then the result with what to do next. */
async function finish(box, { path, body, doing, done, alive, back, plainError = (e) => e, refused = () => false, then = null, extra = null }) {
  const log = logBox();
  fill(box, stepper(2), busy(doing), fold('project-steps', 'Details', log));
  let r;
  try {
    r = await runJob(path, body, log, alive);
  } catch (e) {
    if (refused(e)) return; // the page asks again for what was refused (a brief with characters nobody can see)
    r = { ok: false, error: e.message };
  }
  if (!r || !alive()) return;
  // The job's own result first: a cloned project's folder is known only once its project.json was read.
  const where = (r.data && r.data.dir) || (r.started && r.started.dir);
  const id = (r.data && r.data.name) || (r.started && r.started.name);
  const outcome = jobOutcome(r);
  // What follows a project that was made (New project's "Start with AI"): when it goes elsewhere, nothing is drawn here.
  let after = null;
  if (outcome === 'done' && r.ok && then) {
    fill(box, stepper(2), busy('Starting the session…'), fold('project-steps', 'Details', log));
    after = await then(where, id); // true: it went to the session; else what to show under the result
    if (after === true || !alive()) return;
  }
  fill(box, stepper(2),
    outcome === 'needs-you'
      ? [h('div.banner.warn', { role: 'status' }, icon('alert', { size: 18 }), h('span', `Not done yet: this needs you. ${String(r.error || '').replace(/^./, (c) => c.toUpperCase())}`)),
        h('p.hint', 'Run this, then try again:'), commandLine(r.data.fix),
        h('div.pj-next', btn('secondary', { icon: 'back', label: 'Back', onclick: back }))]
      : outcome === 'done'
      ? [okBox(done(where)), r.ok ? null : h('p.hint', `Some of it did not work: ${r.error || 'see the details below'}.`), after,
        // Get: what the project needs that is not here, offered as the terminal offers it (getneeds.js).
        extra ? extra(r) : null,
        // One main button: what follows the project's start (after) has its own, then this one is a plain choice.
        h('div.pj-next', newSessionButton(where, id || String(where).split(/[\\/]/).pop(), { cls: after ? 'secondary' : 'primary', label: 'Start a session' }), h('a.btn.secondary', { href: link(`#/workspace/project/${enc(id)}`) }, icon('folder', { size: 18 }), h('span', 'Open the project')))]
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
  frame({ title: 'New project', page: 'new-project', back: link('#/workspace'), backLabel: 'Projects', intro: 'A new project folder, ready for coding, and if you give a brief an AI session that sets it up from it. You see everything it creates before anything is made.',
    body: [named ? h('p.banner.info.pj-from', icon('folder', { size: 18 }), h('span', `Named after the folder you picked. The project is made new in your projects folder; that folder stays where it is: move its files into the project, or ask in a session there.`)) : null, box] });
  let alive = true;
  // brief, kind: as typed (newproject.js); start: "Start with AI"; choices and v: the session's choices and his picks.
  const st = { name: named, github: false, preview: null, brief: '', kind: '', scope: 'product', skill: true, fit: true, start: true, choices: null, v: {} };
  let briefRefused = null; // the server's refusal of the brief, said under it when the first step is drawn again

  function stepName(error = '') {
    const brief = briefFields(st);
    const options = optionsPart(st);
    brief.el.addEventListener('input', () => options.sync()); // a brief keeps the skill ticked
    const refused = briefRefused;
    if (refused) brief.problem(refused.message, refused.clean);
    briefRefused = null;
    const input = h('input.field', { value: st.name, placeholder: 'my-project', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', autofocus: true, maxlength: 100 });
    const err = h('p.form-error', { role: 'alert' }, error);
    // What the folder will be called, said as he types: a name with spaces is turned, not refused.
    const folderHint = h('span.hint', 'It becomes the folder name.');
    const sayFolder = () => {
      const f = toFolderName(input.value);
      folderHint.textContent = f && f !== input.value.trim() ? `The folder will be called ${f}.` : 'It becomes the folder name.';
    };
    input.addEventListener('input', sayFolder);
    sayFolder();
    const next = h('button.btn.primary', { type: 'submit' }, 'Next');
    fill(box, stepper(0), h('form.pj-form', { onsubmit: async (e) => {
      e.preventDefault();
      const v = toFolderName(input.value);
      if (!v) return void (err.textContent = 'Use letters, digits, ".", "_" and "-", starting with a letter or a digit.');
      if (brief.tooBig()) return void brief.problem('The brief is at most 24 KiB: keep it to what the product is, who uses it and its main features; more can follow in the chat.');
      next.disabled = true;
      next.textContent = 'Checking…';
      try {
        const pv = await api(`/api/pcsetup/project/preview?name=${enc(v)}${previewQuery(st)}`);
        if (pv.exists) throw new Error(`There is already a folder called ${v} in the projects folder: pick another name.`);
        if (st.name !== v) Object.assign(st, { choices: null, v: {} }); // the provider is the new folder's own
        Object.assign(st, { name: v, preview: pv });
        if (alive) stepCheck();
      } catch (er) {
        err.textContent = er.message;
        next.disabled = false;
        next.textContent = 'Next';
      }
    } },
    h('label.fieldrow', h('span.field-label', 'Project name'), input, folderHint),
    err,
    brief.el,
    options,
    h('div.pj-next', next)));
    // After a refused brief the brief is what changes (its reason and "Take them out" stand under it), else the name.
    if (refused) brief.focus();
    else input.focus();
  }

  function stepCheck() {
    const pv = st.preview;
    const whereOpts = [
      { value: 'local', title: 'Only on this computer', sub: 'You can put it on GitHub later.' },
      { value: 'github', title: 'Also on GitHub, private', sub: `Makes a private repository ${pv.github.account ? `under ${pv.github.account} ` : ''}and uploads the project to it.` },
    ];
    // Marked in place (markCards): the radio keeps the keyboard's focus.
    const where = pv.github.signedIn
      ? radioCards('new-where', whereOpts, st.github ? 'github' : 'local', (v) => { st.github = v === 'github'; markCards(where, whereOpts, v); })
      : h('p.hint', 'It stays on this computer. To also put it on GitHub, ', signInLink(async () => {
        // Signed in: the step asks again (its GitHub part), keeping the name and the brief he typed.
        try {
          st.preview = await api(`/api/pcsetup/project/preview?name=${enc(st.name)}${previewQuery(st)}`);
        } catch {
          /* the step as it was */
        }
        if (alive) stepCheck();
      }), ' first (it opens here, and you come back to this step); you can do it later.');
    const hasBrief = Boolean(st.brief.trim());
    // git knows no name and e-mail on this computer: the first save needs them. Asked here, used for this project's
    // first save only (the server checks them).
    const idName = pv.askIdentity ? h('input.field', { value: st.gitName || '', autocomplete: 'name', maxlength: 200, oninput: (e) => (st.gitName = e.target.value) }) : null;
    const idEmail = pv.askIdentity ? h('input.field', { type: 'email', value: st.gitEmail || '', autocomplete: 'email', maxlength: 200, oninput: (e) => (st.gitEmail = e.target.value) }) : null;
    const identity = pv.askIdentity ? h('div.pj-identity',
      h('p.field-label', 'Your name and e-mail for git'),
      h('p.hint', 'git saves every change with a name and an e-mail, and this computer has none yet. They are used for this project\'s first save.'),
      h('label.fieldrow', h('span.field-label', 'Name'), idName),
      h('label.fieldrow', h('span.field-label', 'E-mail'), idEmail)) : null;
    const who = () => (pv.askIdentity ? { gitName: (st.gitName || '').trim(), gitEmail: (st.gitEmail || '').trim() } : {});
    const starts = () => hasBrief && st.start && aiReady(st);
    // "Start with AI": once the project is made, the session opens and the page goes to it; when it cannot start, the
    // project is still made and the reason stands under it, with the button to try again. A project made with a brief
    // but not started (switched off, no provider) gets that button too: its brief and skill wait for a session.
    const then = async () => {
      try {
        await startSession(st, machine.current);
        return true;
      } catch (e) {
        return startLater(st, machine.current, e);
      }
    };
    const later = async () => startLater(st, machine.current);
    // The button says what it will do; a choice of "Start with AI" changes it in place (the focus stays on the choice).
    const createButton = () => btn('primary', { icon: starts() ? 'play' : 'check', label: starts() ? 'Create and start with AI' : 'Create project', onclick: () => finish(box, {
      path: '/api/pcsetup/project/new', body: newBody(st, who()), doing: `Creating ${st.name}…`, alive: () => alive,
      done: (dir) => `${st.name} is ready in ${tildePath(dir, pv.home)}.${st.github ? ' It is on GitHub too.' : ''}`,
      back: stepCheck,
      plainError: (e) => (/git does not know your name/.test(e) ? 'git needs your name and e-mail before it can save anything: go Back, type them in the two fields, then create the project again.' : e),
      refused: (e) => {
        if (!/^brief-/.test(e.code || '') && !/brief/.test(e.message)) return false;
        briefRefused = { message: e.message, clean: e.data && e.data.clean };
        stepName();
        return true;
      },
      then: starts() ? then : hasBrief ? later : null,
    }) });
    let create = createButton();
    const changed = () => {
      const b = createButton();
      create.replaceWith(b);
      create = b;
    };
    // The step starts at its heading for the keyboard and a screen reader (the step before had the focus).
    const heading = h('h2.panel-title', { tabindex: '-1' }, 'What it creates');
    fill(box, stepper(1),
      h('section.card.panel',
        heading,
        h('p.sheet-text', checkLine(pv, st)),
        fold('new-what', 'What exactly', h('ul.pj-will',
          h('li', 'The folder ', h('strong.pj-wrap', tildePath(pv.dir, pv.home))),
          pv.template === 'built-in'
            ? h('li', 'A small set of starting files: the rules your coding tools read (AGENTS.md), a place for the AI memory and notes (ai_brain), docs and decisions, and a code folder for the project\'s code repositories.')
            : h('li', 'The files of your own project template.'),
          ...willLines(st),
          st.fit !== false ? h('li', 'Skills that fit its technology: Hoprig looks now and once more when it first has code. Text-only ones go in by themselves, with Undo, on the project\'s Skills page; anything else waits for you there.') : null,
          h('li', 'A first save in git, so every later change can be seen and undone.'),
          st.github ? h('li', 'A private GitHub repository, with the project uploaded to it.') : null),
        pv.files ? fold('new-files', `All ${pv.files.length} files`, h('ul.pj-files.mono', pv.files.map((f) => h('li', f)))) : null)),
      identity,
      h('p.field-label', 'Where it is kept'), where,
      hasBrief ? [h('p.field-label', 'After it is made'), startPart(st, changed)] : null,
      h('div.pj-next', btn('secondary', { icon: 'back', label: 'Back', onclick: () => stepName() }), create));
    heading.focus();
  }

  stepName();
  return () => {
    alive = false;
  };
}

/** The repository name in a project spec (as the server's parseProjectSpec): the last part, without ".git". */
const specName = (s) => s.trim().replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || '';
/** The folder it most likely gets (getproject.mjs): without a trailing "-workspace"; the job says the real one. */
const folderName = (s) => specName(s).replace(/(.)-workspace$/, '$1');

function viewGetProject({ frame, sub }) {
  store.viewing = null;
  const box = h('div.pj-wizard');
  frame({ title: 'Get an existing project', page: 'get-project', back: link('#/workspace'), backLabel: 'Projects', intro: 'Download a project you already have on GitHub (or another git server) to this computer.', body: [box] });
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
    const name = folderName(spec);
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
          done: (dir) => `${String(dir).split(/[\\/]/).pop() || name} is on this computer now, in ${folder ? tildePath(dir, folder.home) : dir}.`,
          back: stepCheck,
          extra: (r) => (r.data && r.data.name ? needsAfterGet(r.data.place ? `${r.data.place}/${r.data.name}` : r.data.name, { alive: () => alive }) : null),
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

registerPage({ id: 'workspace', title: 'Projects', icon: 'folder', group: 'main', order: 10, perComputer: true, render: viewProjects });
registerPage({ id: 'new-project', title: 'New project', icon: 'plus', navAs: 'workspace', perComputer: true, render: viewNewProject });
registerPage({ id: 'get-project', title: 'Get an existing project', icon: 'download', navAs: 'workspace', perComputer: true, render: viewGetProject });
