// New session (#/new): one tap — pick a project (the recent ones first) and a chat with Claude opens there, with
// the provider, mode, model and effort the last chat in that project had (kept on the server; the first time: the
// default provider and Settings). Everything else waits under a closed "Options": the computer, a terminal or a
// plain shell instead of the chat, the provider, what Claude may do without asking, how hard it thinks, the model,
// which conversation. Another folder is one row away.
import { startChat } from './chat/start.js';
import { icon } from './icons.js';
import { ago, api, at, chooseSheet, confirmSheet, fill, h, kindLabel, link, machine, prefs, profileState, servesClaude, tildePath, toast } from './lib.js';
import { fold, frame, groupHead } from './shell.js';
import { runsSessions, store } from './store.js';

// The same plain words as Settings → New-session defaults (sessiondefaults.js).
import { EFFORT, MODELS, MODES } from './sessiondefaults.js';

/**
 * Sessions this page just started or moved to another account: until Claude reports itself again (a few seconds),
 * they read "Starting Claude…" instead of "Terminal" (Home, session.js).
 */
const justStarted = new Map();
const keyOf = (machineName, name) => `${machineName || ''}/${name}`;
export const markStarting = (machineName, name) => justStarted.set(keyOf(machineName, name), Date.now());
export const isStarting = (s, machineName = s.machine) => s.kind !== 'claude' && Date.now() - (justStarted.get(keyOf(machineName, s.name)) || 0) < 30_000;
export const startingPill = () => h('span.pill.st-starting', h('span.dot'), 'Starting Claude…');

/**
 * True when `dir` is outside the projects folder: not it, not inside it, and not one of the folders that hold it (the
 * home folder is no project to make). Either separator, so Windows paths too.
 */
export function outsideProjects(dir, projectsDir) {
  if (!projectsDir || !dir) return false;
  const norm = (x) => x.replace(/[\\/]+$/, '');
  const under = (a, b) => a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
  const root = norm(projectsDir);
  const d = norm(dir);
  return !under(d, root) && !under(root, d);
}

/**
 * The second line of a folder's row: its path only when it says something the name does not, i.e. when the folder is
 * not simply <projects folder>/<name>. `short` is the "~/…" path, `projectsShort` the projects folder written the same way.
 */
export function folderSub(f, projectsShort) {
  const norm = (x) => String(x || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  if (projectsShort && norm(f.short) === `${norm(projectsShort)}/${f.name}`) return 'project';
  return f.short;
}

/** A repository of a project as a person names it: "bookshop-api", "repository in bookshop" (not "code/bookshop-api"). */
export function repoWords(rel, project) {
  if (!rel || rel === '.') return { name: project, sub: 'project' };
  const name = rel.split(/[\\/]/).filter(Boolean).pop() || rel;
  return { name, sub: project ? `repository in ${project}` : 'repository' };
}

/**
 * Where a tap on a recent folder goes when something already works there: the terminal session that runs in it, or
 * the chat at work in it (a second one there is what nobody tapping a "running" project means). Null: open a chat.
 */
export function runningIn(f) {
  if (!f || !f.live) return null;
  if (f.chat) return `#/chat/${f.chat}`;
  return f.session ? `#/s/${encodeURIComponent(f.session)}` : null;
}

export function viewNew({ query = new URLSearchParams() } = {}) {
  store.viewing = null;
  const opts = h('div.newopts');
  const body = h('div');
  const computers = h('div.ns-computers');
  frame({
    title: 'New session',
    page: 'home',
    back: '#/',
    backLabel: 'Home',
    intro: 'Pick a project: a chat with Claude opens there, set up as your last chat in that project. A terminal instead, and the rest, are under Options.',
    body: [computers, body, fold('new-options', 'Options', opts)],
  });
  const st = {
    m: machine.current,
    profile: '', // '' = the computer's recommended account
    permissionMode: '',
    effort: '',
    model: '',
    models: null, // the computer's list (GET /api/settings sessionChoices), null until known
    conversation: 'new',
    run: 'chat', // chat | claude (Claude Code in a terminal) | shell (a plain terminal)
    hidden: false,
  };
  let alive = true;
  let projectsDir = null; // the computer's projects folder, from the list of projects (null: not known)
  let projectsShort = null; // the same, as "~/…", to tell a plain project path from one worth showing
  const where = () => store.all.find((x) => x.machine === st.m) || null;
  // Claude Code on each computer ('~' for this one): its version, null when not installed (GET /api/machines).
  const claudeOf = new Map();
  const can = (m) => runsSessions(m, claudeOf.get(m.machine || '~'));

  // ---------- the computer: the first choice when there are several ----------
  // The choice is the address (#/m/<computer>/new), the same state as the computer pill on the other pages.
  let painted = '';
  function paintComputers() {
    const key = store.multi ? JSON.stringify([st.m, store.all.map((m) => [m.machine, m.machineLabel, can(m)])]) : '';
    if (key === painted) return;
    painted = key;
    if (!key) return fill(computers);
    fill(computers, groupHead('Computer'),
      h('div.ns-pcs', { role: 'radiogroup', 'aria-label': 'Computer' }, store.all.map((m) => {
        const c = can(m);
        const on = m.machine === st.m;
        const providers = (m.profiles || []).filter((p) => !p.virtual && servesClaude(p)).length;
        return h(`button.ns-pc${on ? '.on' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(on), disabled: !c.ok && !on,
          onclick: () => {
            if (on) return;
            prefs.set('new.machine', m.machine === null ? '~' : m.machine);
            location.hash = link('#/new', m.machine);
          },
        },
        h('span.ns-pc-icon', icon('cpu', { size: 18 })),
        h('span.ns-pc-text', h('span.ns-pc-name', m.machineLabel), h('span.ns-pc-sub', c.ok ? `${providers} provider${providers === 1 ? '' : 's'}` : c.why)),
        on ? h('span.ns-pc-tick', icon('check', { size: 16 })) : null);
      })));
  }
  // With no computer in the address: the one used last, else this one, else the first that can run a session.
  let chose = machine.current !== null;
  function preselect() {
    if (chose || !store.multi) return;
    chose = true;
    const last = prefs.get('new.machine', '~');
    const order = [last, '~', ...store.all.map((m) => m.machine || '~')].map((k) => store.all.find((m) => (m.machine || '~') === k)).filter(Boolean);
    const pick = order.find((m) => can(m).ok);
    if (pick && pick.machine !== null) location.replace(link('#/new', pick.machine));
  }
  const busy = (text) => fill(body, h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text)));
  const failed = (e, retry) => fill(body, h('div.empty', icon('alert', { size: 32 }), h('p', e.message), h('button.btn.secondary', { type: 'button', onclick: retry }, 'Try again')));

  // ---------- Options ----------
  const select = (label, value, options, onchange, hint) =>
    h('label.fieldrow', h('span.field-label', label),
      h('select.field', { onchange: (e) => onchange(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))),
      hint ? h('span.hint', hint) : null);
  function paintOptions() {
    const m = where();
    const profiles = m ? m.profiles.filter(servesClaude) : []; // these sessions are Claude Code's
    const rec = m && m.recommended;
    const recLabel = (profiles.find((p) => p.name === rec) || {}).label;
    const chat = st.run === 'chat';
    // Left as it is, a chat takes what the last chat in that project had; a terminal takes Settings.
    const same = chat ? 'As your last chat in the project' : 'As in Settings';
    const run = select('Open in', st.run, [['chat', 'A chat (the default)'], ['claude', 'Claude Code in a terminal'], ['shell', 'A plain terminal, without Claude']], (v) => {
      st.run = v;
      paintOptions();
    }, st.run === 'shell' ? 'A shell in the folder you pick; nothing else applies to it.' : null);
    // A plain terminal runs no Claude: no provider, mode, model or conversation to choose.
    if (st.run === 'shell') return fill(opts, run);
    fill(opts, run,
      select('Provider', st.profile, [['', chat ? `${same}${recLabel ? `, else ${recLabel}` : ''}` : recLabel ? `The default: ${recLabel}` : 'The default'], ...profiles.map((p) => [p.name, p.virtual ? `${p.label} · uses your providers in order` : `${p.label} · ${kindLabel(p)} · ${profileState(p).text}`])], (v) => (st.profile = v)),
      select('What Claude may do without asking', st.permissionMode, [['', same], ...Object.entries(MODES)], (v) => (st.permissionMode = v),
        st.permissionMode === 'bypassPermissions' ? 'Claude can run any command and change any file without asking.' : null),
      select('How hard it thinks', st.effort, [['', same], ...Object.entries(EFFORT)], (v) => (st.effort = v)),
      // A model for this one session: try something cheaper without changing the setting for every session.
      select('Model', st.model, [['', same], ...(st.models || MODELS.map(([v]) => v)).map((v) => [v, (MODELS.find(([x]) => x === v) || [v, v])[1]])], (v) => (st.model = v),
        chat ? 'The chips of the chat change it at any time.' : 'Only this session. A provider that names its own model keeps it.'),
      select('Conversation', st.conversation, [['new', 'A new conversation'], ['continue', 'Continue the last one in the folder'], ['pick', 'Pick an earlier one']], (v) => (st.conversation = v)));
  }

  // ---------- the projects ----------
  const row = (f, sub, onclick, end = null, go = 'play') =>
    h('button.row', { type: 'button', onclick },
      h('span.row-icon', icon('folder')),
      h('span.row-main', h('span.row-title', f.name), h('span.row-sub', sub)),
      end,
      h('span.row-end', icon(go, { size: 18 })));
  // A folder where a session runs: the tap opens that session (a second one in the same folder is what nobody
  // tapping a "running" project means). Another one starts from "Another folder" → Start here.
  const recentRow = (f) => (runningIn(f)
    ? row(f, folderSub(f, projectsShort), () => (location.hash = link(runningIn(f), st.m)), h('span.badge.soft', 'running'), 'chevronRight')
    : row(f, folderSub(f, projectsShort), () => start(f), f.live ? h('span.badge.soft', 'running') : null));

  async function projects() {
    const m = where();
    const c = m ? can(m) : { ok: true };
    if (m && !c.ok && (m.hub || m.status !== 'online' || claudeOf.get(m.machine || '~') === null)) {
      // This computer cannot run a session at all: say why, and where one can.
      const other = store.all.some((x) => x !== m && can(x).ok);
      return fill(body, h('div.empty.compact', icon('cpu', { size: 28 }), h('p', `${m.machineLabel}: ${c.why}.${other ? ' Choose a computer above.' : ''}`),
        other ? null : h('a.btn.secondary', { href: '#/computers' }, icon('cpu', { size: 18 }), h('span', 'Computers'))));
    }
    if (m && st.run !== 'shell' && !m.profiles.some((p) => !p.virtual && servesClaude(p))) {
      // Nothing could start: say what is missing and lead there.
      return fill(body, h('div.empty.compact', icon('user', { size: 28 }), h('p', `No provider on ${m.machineLabel} yet. Add the provider Claude should use first.`),
        h('a.btn.primary', { href: link('#/providers', st.m) }, icon('plus', { size: 18 }), h('span', 'Add provider'))));
    }
    busy('Loading projects…');
    let recent;
    let proj = null;
    try {
      let settings;
      [recent, proj, settings] = await Promise.all([
        api(at(st.m, '/api/folders/recent')),
        api(at(st.m, '/api/pcsetup/projects')).catch(() => null), // an older computer, or no projects folder
        api(at(st.m, '/api/settings')).catch(() => null), // the models it offers (an older computer: the usual three)
      ]);
      const models = settings && settings.sessionChoices && settings.sessionChoices.models;
      if (Array.isArray(models) && JSON.stringify(models) !== JSON.stringify(st.models)) {
        st.models = models;
        if (st.model && !models.includes(st.model)) st.model = '';
        paintOptions();
      }
    } catch (e) {
      return failed(e, projects);
    }
    if (!alive) return;
    projectsDir = proj && proj.projectsDir ? proj.projectsDir : null;
    projectsShort = proj && (proj.projectsShort || (proj.projectsDir && tildePath(proj.projectsDir))) || null;
    const seen = new Set(recent.folders.map((f) => f.path));
    const more = proj
      ? [...proj.workspaces.flatMap((w) => w.repos.map((r) => ({ path: r.dir, ...repoWords(r.rel, w.name) }))), ...proj.repos.map((r) => ({ path: r.dir, ...repoWords(r.rel, null), sub: 'project' }))].filter((f) => !seen.has(f.path))
      : [];
    fill(body,
      recent.folders.length || more.length ? null : h('p.muted', 'No projects yet. Open a folder below, or add a project under Workspace.'),
      recent.folders.length ? [groupHead('Recent'), h('div.rows', recent.folders.map(recentRow))] : null,
      more.length ? [groupHead('Projects'), h('div.rows', more.map((f) => row(f, f.sub, () => start({ ...f, short: f.name }))))] : null,
      groupHead('Somewhere else'),
      h('div.rows', recent.roots.map((r) => h('button.row', { type: 'button', onclick: () => browse(r.path) },
        h('span.row-icon', icon('folderUp')), h('span.row-main', h('span.row-title', 'Another folder'), h('span.row-sub', `Browse ${r.short}`)), h('span.row-end', icon('chevronRight', { size: 18 }))))));
  }

  async function browse(p) {
    busy('Opening…');
    let d;
    try {
      d = await api(at(st.m, `/api/folders/browse?${new URLSearchParams({ path: p, hidden: st.hidden ? '1' : '0' })}`));
    } catch (e) {
      return failed(e, () => browse(p));
    }
    if (!alive) return;
    const folder = (x) => h('button.row', { type: 'button', onclick: () => browse(x.path) }, h('span.row-icon', icon('folder')), h('span.row-main', h('span.row-title', x.name)), h('span.row-end', icon('chevronRight', { size: 18 })));
    fill(body,
      h('div.crumbbar',
        d.parent ? h('button.btn.icon.secondary', { type: 'button', title: 'Up one folder', 'aria-label': 'Up one folder', onclick: () => browse(d.parent) }, icon('folderUp', { size: 18 }))
          : h('button.btn.icon.secondary', { type: 'button', title: 'Back to the projects', 'aria-label': 'Back to the projects', onclick: projects }, icon('back', { size: 18 })),
        h('span.crumb', d.short)),
      outsideProjects(d.path, projectsDir) ? projectAdvice(d) : null,
      h('div.stickybar', h('button.btn.primary.block', { type: 'button', onclick: () => start({ path: d.path, short: d.short, name: d.short.split('/').pop() || d.short }) }, icon('play', { size: 18 }), h('span', 'Start here'))),
      d.dirs.length ? h('div.rows', d.dirs.map(folder)) : h('p.muted', 'No folders inside.'),
      h('label.toggle-line', h('input', { type: 'checkbox', checked: st.hidden, onchange: (e) => { st.hidden = e.target.checked; browse(d.path); } }), h('span', 'Show hidden folders')));
    window.scrollTo(0, 0);
  }

  // A folder outside the projects folder: a quiet line that a project is the better place, and the way to make one.
  function projectAdvice(d) {
    const name = (d.short.split(/[\\/]/).pop() || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100);
    return h('p.hint.ns-advice', icon('folder', { size: 15 }),
      h('span', 'This folder is outside your projects folder. Inside a project, Claude gets its memory, rules and skills. ',
        h('a', { href: link(name ? `#/new-project/${encodeURIComponent(name)}` : '#/new-project', st.m) }, 'Make it a project')));
  }

  async function start(f) {
    const m = where();
    if (st.run === 'shell') {
      busy('Opening a terminal…');
      try {
        const { name } = await api(at(st.m, '/api/shells'), { dir: f.path });
        location.hash = link(`#/s/${encodeURIComponent(name)}`, st.m);
      } catch (e) {
        failed(e, projects);
      }
      return;
    }
    const profile = st.profile || (m && m.recommended);
    if (!profile) return toast('No provider yet: add one under Providers first.', { kind: 'error', ms: 6000 });
    let mode = st.conversation === 'pick' ? 'resume' : st.conversation;
    let sessionId = null;
    if (mode !== 'new') {
      const { sessions: convs } = await api(at(st.m, `/api/folders/sessions?${new URLSearchParams({ path: f.path })}`)).catch(() => ({ sessions: [] }));
      if (!convs.length) mode = 'new'; // nothing to continue in this folder: a new conversation
      else if (mode === 'resume') {
        sessionId = await chooseSheet({ title: 'Pick a conversation', subtitle: f.name, items: convs.map((c) => ({ value: c.id, label: c.title, sub: ago(c.at), icon: 'text' })) });
        if (!sessionId) return;
      } else if (st.run === 'chat') sessionId = convs[0].id; // the newest one (a terminal finds it itself)
    }
    if (st.run === 'chat') {
      busy(`Opening a chat in ${f.name}…`);
      try {
        // What is not chosen here is left out: the server takes what the last chat in this folder had.
        await startChat(f.path, { sessionId, profile: st.profile, permissionMode: st.permissionMode, effort: st.effort, model: st.model }, st.m);
      } catch (e) {
        failed(e, projects);
      }
      return;
    }
    busy(`Starting Claude in ${f.name}…`);
    try {
      const { name } = await api(at(st.m, '/api/sessions'), {
        dir: f.path, profile, mode, sessionId, permissionMode: st.permissionMode || null, effort: st.effort || null, model: st.model || null,
      });
      markStarting(st.m, name);
      store.refresh();
      location.hash = link(`#/s/${encodeURIComponent(name)}`, st.m);
    } catch (e) {
      failed(e, projects);
    }
  }

  // "#/new?dir=<folder>" (hoprig chat, a link): one tap opens a chat there, set up as the last one in that folder.
  // A link from anywhere never opens one by itself (each open chat counts against the open ones, and evicts idle ones).
  const asked = query.get('dir');
  if (asked) {
    history.replaceState(null, '', link('#/new', st.m)); // a reload or Back shows New session, not the question again
    confirmSheet({ title: 'Open a chat here?', text: `A chat in ${tildePath(asked)}, set up as the last one in that folder. Nothing is sent until you write.`, ok: 'Open a chat' }).then((yes) => {
      if (!yes || !alive) return;
      busy('Opening a chat…');
      startChat(asked, {}, st.m).catch((e) => failed(e, projects));
    });
  }
  preselect();
  paintComputers();
  const knownAtStart = !!where();
  projects();
  // Which computers have Claude Code: asked once; a computer without it is shown greyed with the reason.
  api('~/api/machines').then((d) => {
    if (!alive) return;
    claudeOf.set('~', d.self ? d.self.claude || null : undefined);
    for (const x of d.machines || []) claudeOf.set(x.name, x.state === 'online' ? x.claude || null : undefined);
    paintComputers();
    const m = where();
    if (m && !can(m).ok) projects();
  }).catch(() => {}); // an older computer: every online one with a provider counts
  // The list of computers may arrive after the first paint.
  let seen = '';
  const unsubscribe = store.subscribe(() => {
    preselect();
    paintComputers();
    const m = where();
    const now = JSON.stringify([store.all.map((x) => [x.machine, x.status]), m && m.profiles.map((p) => p.name), m && m.recommended, m && can(m).ok]);
    if (now !== seen) {
      const first = !seen;
      const before = seen;
      seen = now;
      paintOptions();
      // The providers or whether it can run sessions were not known yet, or changed.
      if (first ? !knownAtStart && m && !can(m).ok : JSON.parse(before)[3] !== (m && can(m).ok)) projects();
    }
  });
  return () => {
    alive = false;
    unsubscribe();
  };
}
