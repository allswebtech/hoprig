// New session: one popup over the page it was opened on (the kit's sheet: a dialog on a wide screen, a sheet from the
// foot on a phone). The project is the question: "Tap a project to start". Recent and All projects are big rows, and a
// tap on one starts an App chat with nothing else sent (the server takes the folder's last chat, else its default
// provider and Settings → New sessions); where something runs, its own button beside the row opens that. Where two or
// more computers are linked, small chips over the projects choose one. "More options" holds only what is needed at the
// start: Open in a terminal, the coding tool (with two or more ready), an earlier conversation, a branch of its own,
// other projects to read. Opened from a project, the project is set and "Start" starts it. `#/new` shows it over Home.
import { chatTools, knownChatTools, startChat } from './chat/start.js';
import { icon } from './icons.js';
import { TOOL_NAMES, api, at, cardTool, chooseSheet, confirmSheet, fill, h, isCodingCard, link, machine, openSheet, prefs, tildePath, toast, wayLink } from './lib.js';
import { chooseTool, computerChips, lackLine, openAsDefault, providerState, toolState, wayState } from './newsession-choice.js';
import { roomHint, roomsById, useHint } from './newsession-room.js';
import { alsoChoices, alsoOpen } from './newsession-also.js';
import { moreButton, optionsFor, summaryOf } from './newsession-options.js';
import { folderSub, outsideProjects, repoWords, runningIn, tellApart } from './newsession-words.js';
import { atNewAddress, startSession } from './newsession-start.js';
import { sessionHref } from './sessionitem.js';
import { groupHead } from './shell.js';
import { runsSessions, store } from './store.js';

const SEARCH_FROM = 9; // a search field over the projects from this many on
const RECENT_MAX = 5; // the Recent rows: the newest five, the rest are under All projects

/** The tool this folder's newest conversation ran in, among `ids` (null: none, or not known). */
async function lastToolIn(m, dir, ids) {
  const lists = await Promise.all(ids.map((id) => api(at(m, `/api/folders/sessions?${new URLSearchParams({ path: dir, ...(id !== 'claude' ? { tool: id } : {}) })}`))
    .then((r) => (r.sessions || []).map((c) => ({ at: c.at || 0, id })), () => [])));
  const newest = lists.flat().sort((a, b) => b.at - a.at)[0];
  return newest ? newest.id : null;
}

/**
 * Open the popup. o: { m (the computer; left out: the one used last), project ({ path, name, short }: set already,
 * "Start" starts it), address (opened by #/new: closing it goes Home) }.
 */
export function openNewSession({ m, project = null, address = false } = {}) {
  const st = {
    m: m === undefined ? machine.current : m,
    openAs: openAsDefault(prefs.get('new.openAs', 'app')), // remembered: App or Terminal
    tool: null, // the coding tool a start uses (chooseTool)
    picked: null, // the one chosen here by the owner
    last: null, // the one the preset project used last
    lastKnown: !project, // false while the preset project's last tool is being asked for (Start waits for it)
    saved: prefs.get('new.tool', null), // the one this browser chose last time
    tools: null, // [{ id, name, state }] of the computer, null until known
    toolList: [], // the same with the state for the way chosen: what the choice of a tool and the empty state read
    unreachable: null, // why nothing can start on the computer (it cannot be reached), or null
    earlier: false, // More options → an earlier conversation (one time, never remembered)
    worktree: false, // More options → a branch of its own (one time)
    rootDefaultBypass: false, // the computer runs as root and its default is Bypass: a terminal start asks first
    hidden: false,
    preset: project,
    query: '',
    also: [], // "Read other projects too": map names of extra folders for this session (newsession-also.js)
  };
  let alive = true;
  let picking = false; // a conversation is being picked in the sheet that took the popup's place
  let close = () => {};
  let projectsDir = null;
  let projectsShort = null;
  let optsOpen = false; // More options is open (never remembered)
  const claudeOf = new Map(); // Claude Code on each computer ('~' for this one), from GET /api/machines
  const can = (x) => runsSessions(x, claudeOf.get(x.machine || '~'));
  const where = () => store.all.find((x) => x.machine === st.m) || null;
  const run = () => (st.openAs === 'app' ? 'chat' : 'claude');
  const toolName = (id = st.tool) => TOOL_NAMES[id] || id;

  const intro = h('p.hint.ns-intro', 'Tap a project to start');
  const showIntro = (on) => intro.classList.toggle('hidden', !on);
  const moreSlot = h('div.ns-more-slot', { tabindex: '-1' });
  const opts = h('div.newopts', { tabindex: '-1' });
  const pcSlot = h('div.ns-computers', { tabindex: '-1' });
  const projSlot = h('div.ns-projects', { tabindex: '-1' });
  const actions = h('div.ns-actions', { tabindex: '-1' }); // Start / Start here, kept in view at the bottom while the popup scrolls
  let alsoData = null;
  let alsoFor = undefined; // the folder alsoData was asked for (null: before a project is chosen)
  const status = h('p.hint.ns-status', { role: 'status', 'aria-live': 'polite' }); // what a start is doing, or why it failed
  // Parts are drawn again as answers arrive. The control that has the focus keeps it: found again in the new drawing by
  // its key (a chip's choice, a project's name, a field's key), else the part's first control, else the part itself,
  // so the focus never falls out of the popup to the page under it.
  const keyOf = (el) => {
    for (const a of ['data-choice', 'data-open', 'data-key', 'data-start', 'data-starthere']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v !== null && v !== undefined) return `[${a}="${v}"]`;
    }
    const n = el.getAttribute && el.getAttribute('data-name');
    return n ? `button.row[data-name="${n}"]` : null;
  };
  function paint(slot, ...children) {
    const a = document.activeElement;
    const had = a && a !== slot && slot.contains(a) ? keyOf(a) || '' : null;
    fill(slot, ...children);
    if (had === null) return;
    const again = (had && slot.querySelector(had)) || [...slot.querySelectorAll('button, select, input, a')].find((x) => !x.disabled);
    (again || slot).focus();
  }

  // ---------- the computer: small chips, only where two or more are linked (not while a project is set) ----------
  let painted = '';
  let rooms = new Map(); // each computer's room for new work (newsession-room.js), once read
  function paintComputers() {
    const key = store.multi && !st.preset ? JSON.stringify([st.m, store.all.map((x) => [x.machine, x.machineLabel, can(x)]), [...rooms]]) : '';
    if (key === painted) return;
    painted = key;
    if (!key) return paint(pcSlot);
    const id = (x) => x.machine || '~';
    const chosen = id(where() || { machine: st.m });
    const list = store.all.map((x) => ({ id: id(x), name: x.machineLabel, ok: can(x).ok }));
    const hint = roomHint({ computers: list, rooms, chosen });
    let choose = null;
    paint(pcSlot, computerChips({
      chosen,
      computers: list.map((c) => ({ id: c.id, name: c.name, disabled: !c.ok })),
      choose: (to) => choose(to),
    }), hint ? h('p.ns-room', { role: 'status' }, h('span', hint.text), ' ', h('button.btn.small.secondary', { type: 'button', onclick: () => useHint(pcSlot, hint.to, choose) }, hint.label)) : null);
    choose = (to) => {
      const x = store.all.find((y) => id(y) === to);
      if (!x || x.machine === st.m) return;
      prefs.set('new.machine', to);
      st.m = x.machine;
      Object.assign(st, { picked: null, tools: null });
      paintComputers();
      loadTools();
      projects();
    };
  }
  // No computer given: the one used last, else this one, else the first that can run a session.
  let chose = m !== undefined || !!st.preset;
  function preselect() {
    if (chose || !store.multi) return;
    chose = true;
    const lastPc = prefs.get('new.machine', '~');
    const order = [lastPc, '~', ...store.all.map((x) => x.machine || '~')].map((k) => store.all.find((x) => (x.machine || '~') === k)).filter(Boolean);
    const pick = order.find((x) => can(x).ok);
    if (pick && pick.machine !== st.m) {
      st.m = pick.machine;
      loadTools();
      projects();
    }
  }

  // ---------- App or Terminal, and the coding tool: chosen behind More options ----------
  // The way changed (the switch, or the fix of a tool that has no App): remembered for the next popup.
  function chooseWay(id) {
    if (id === st.openAs) return;
    st.openAs = id;
    prefs.set('new.openAs', id);
    paintTools();
    paintProjectsGate();
    if (st.preset) paintPreset();
  }
  // A tool is ready only for a way it can be started in; the one a start uses is always among the ready ones.
  function readTool() {
    // Until the preset project's last tool is known a start waits, so that the choice cannot change after a tap.
    if (!st.tools || !st.lastKnown || st.unreachable) {
      st.tool = null;
      st.toolList = [];
      return;
    }
    const appTools = knownChatTools(st.m).map((t) => t.id);
    const profiles = (where() || {}).profiles || null; // the chosen computer's providers: none serving a tool, it needs one
    st.toolList = st.tools.map((t) => ({ ...t, state: wayState({ ...t, state: providerState(t, profiles, st.m) }, st.openAs, appTools, (w) => chooseWay(w)) }));
    st.tool = chooseTool(st.toolList, { picked: st.picked, last: st.preset ? st.last : null, saved: st.saved });
  }
  function paintTools() {
    readTool();
    paintOptions();
  }
  let toolsLoad = null;
  const loadTools = () => (toolsLoad = readTools());
  async function readTools() {
    const pc = st.m;
    st.unreachable = null;
    paintTools();
    let list = [];
    let unreachable = null;
    const label = () => (where() || {}).machineLabel || 'This computer';
    if (where() && where().status && where().status !== 'online') unreachable = `${label()} cannot be reached now: nothing can be started there.`;
    else {
      try {
        const r = await api(at(pc, '/api/codetools'));
        list = r.tools.map((t) => ({ id: t.id, name: t.name, state: toolState(t, pc) }));
      } catch (e) {
        // An older computer (no such route): the coding tools a chat can run there are the ones it offers.
        if (e.status === 404) list = (await chatTools(pc)).map((t) => ({ id: t.id, name: t.name, state: { ready: true } }));
        else unreachable = `${label()} cannot be reached now: nothing can be started there.`;
      }
      if (!unreachable) await chatTools(pc); // which have an App, their modes and efforts
    }
    if (!alive || pc !== st.m) return;
    st.unreachable = unreachable;
    st.tools = list;
    const ready = list.filter((t) => t.state.ready).map((t) => t.id);
    const preset = st.preset;
    if (preset && !st.lastKnown && ready.length > 1) {
      const last = await lastToolIn(pc, preset.path, ready);
      if (!alive || pc !== st.m || st.preset !== preset) return;
      st.last = last;
    }
    st.lastKnown = true;
    paintTools();
    paintProjectsGate();
    if (st.preset) paintPreset(); // Start can be pressed now
  }

  // ---------- More options ----------
  function paintOptions() {
    const ready = st.toolList.filter((t) => t.state.ready);
    paint(moreSlot, moreButton({ open: optsOpen, summary: summaryOf(st, ready), onclick: () => {
      optsOpen = !optsOpen;
      paintOptions();
    } }));
    paint(opts, optsOpen ? optionsFor({
      st, tools: ready.map((t) => ({ id: t.id, name: t.name })), toolName,
      also: alsoOpen({ data: alsoData, chosen: st.also, tool: st.tool, toolName: toolName(), onchange: () => paintOptions(), onallow: st.preset ? allowNeed : null }),
      onchange: (what) => {
        if (what === 'way') {
          prefs.set('new.openAs', st.openAs);
          paintTools();
          paintProjectsGate();
          if (st.preset) paintPreset();
        } else {
          st.saved = st.picked;
          prefs.set('new.tool', st.picked); // the next popup starts with it
          paintTools();
        }
      },
    }) : []);
  }

  // ---------- Read other projects too ----------
  // The owner's yes (or its taking back) for a need of the chosen project, on that computer; then the list again.
  async function allowNeed(name, yes) {
    const m = st.m;
    const folder = st.preset ? st.preset.path : null;
    if (!folder) return;
    try {
      await api(at(m, '/api/folders/extras/accept'), { path: folder, need: name, allow: yes });
    } catch (e) {
      toast(e, { kind: 'error', ms: 7000 });
      return;
    }
    if (!alive || m !== st.m) return;
    alsoData = null;
    alsoFor = undefined;
    loadAlso();
  }
  async function loadAlso() {
    const folder = st.preset ? st.preset.path : null;
    if (alsoFor === folder && alsoData) return paintOptions();
    alsoFor = folder;
    const m = st.m;
    const d = await alsoChoices(m, folder);
    if (!alive || m !== st.m || alsoFor !== folder) return;
    alsoData = d;
    if (d) st.also = st.also.filter((x) => d.choices.includes(x));
    paintOptions();
  }

  // ---------- the project ----------
  const loading = (text) => paint(projSlot, h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text)));
  // While the popup is open, the error shows in it; after it closed (a conversation was picked), as a toast.
  const failed = (e, retry) => (alive
    ? paint(projSlot, h('div.empty', icon('alert', { size: 32 }), h('p', e.message), h('button.btn.secondary', { type: 'button', onclick: retry }, 'Try again')))
    : toast(e, { kind: 'error', ms: 7000 }));
  // A start control (a project's row, Start, Start here, a switch): `data-startctl`, so that one start at a time can
  // turn them all off while it is on its way.
  // `err`: the error itself, so its code's place (errorways.js) gets its button beside the words.
  const say = (text, error = false, err = null) => {
    const way = err ? wayLink(err) : null;
    fill(status, text || '', way ? [' ', way] : null);
    status.classList.toggle('ns-is-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  };
  // A project's row: the whole row is the button, and a tap STARTS A NEW session there, also where something runs.
  const row = (f, sub, onclick) =>
    h('button.row', { type: 'button', onclick, 'data-name': f.name, 'data-startctl': '', title: `A new session in ${f.name}` },
      h('span.row-icon', icon('folder')),
      h('span.row-main', h('span.row-title', f.name), sub ? h('span.row-sub', sub) : null));
  // What runs in a folder stays one tap away, as its own button beside the row (a divider between the two, so a
  // thumb on a phone cannot take one for the other): the session runningIn() names, or the list where several run.
  const runningHere = (f) => ((where() || {}).sessions || []).filter((s) => s.cwd === f.path);
  function openRunning(f) {
    const list = runningHere(f);
    const one = runningIn(f);
    if (!one && !list.length) return null;
    const several = list.length > 1;
    return h('span.ns-openslot', h('button.btn.small.secondary.ns-open', {
      type: 'button', 'data-open': f.name,
      'aria-label': several ? `Continue one of the ${list.length} sessions running in ${f.name}` : `Continue the session running in ${f.name}`,
      onclick: () => (several ? pickRunning(f, list) : leave(one ? link(one, st.m) : sessionHref(list[0]))),
    }, icon(several ? 'sessions' : 'chevronRight', { size: 16 }), h('span', 'Continue', several ? h('span.ns-count', ` (${list.length})`) : null))); // the count goes under the word on a phone (style.css)
  }
  async function pickRunning(f, list) {
    // The kit's list takes the popup's place (one sheet at a time).
    alive = false;
    picking = true;
    const way = (s) => (s.kind === 'chat' ? 'App' : isCodingCard(s) ? `Terminal · ${TOOL_NAMES[cardTool(s)] || 'coding tool'}` : 'Plain terminal');
    const i = await chooseSheet({ title: 'Running here', subtitle: f.name, items: list.map((s, n) => ({ value: String(n), label: s.display || s.name, sub: way(s), icon: s.kind === 'chat' ? 'text' : 'terminal' })) });
    if (i === null) {
      if (atNewAddress()) location.replace('#/');
      return;
    }
    location.hash = sessionHref(list[Number(i)]);
  }
  const recentRow = (f) => {
    const open = openRunning(f);
    const start1 = row(f, folderSub(f, projectsShort), (e) => start(f, e.currentTarget));
    return open ? h('div.ns-runrow', start1, open) : start1;
  };
  const leave = (hash) => {
    close();
    location.hash = hash;
  };

  // Start waits until the tool it sends is known (the preset project's last one).
  const toolKnown = () => !!st.tools && st.lastKnown;
  // Nothing can start: the computer cannot be reached, or no coding tool is ready for it.
  const blocked = () => !!st.unreachable || (st.tools && st.lastKnown && !st.tool);
  let gateWas = null;
  // The projects give way to one plain line and the one button to the fix.
  function lackFix(t) {
    const words = t.state.fix ? t.state.fix.charAt(0).toUpperCase() + t.state.fix.slice(1) : '';
    if (t.state.act) return h('button.btn.secondary', { type: 'button', onclick: t.state.act }, words);
    return t.state.href ? h('a.btn.secondary', { href: t.state.href, onclick: () => close() }, words) : null;
  }
  function paintProjectsGate() {
    const now = !!blocked();
    if (now === gateWas) return;
    gateWas = now;
    if (now) {
      showIntro(false);
      const t = st.toolList.find((x) => x.id === 'claude') || st.toolList[0];
      paint(projSlot, h('div.empty.compact', icon(st.unreachable ? 'cpu' : 'code', { size: 28 }),
        h('p', st.unreachable || (t ? lackLine(t) : 'No coding tool is ready on this computer.')),
        st.unreachable ? h('a.btn.secondary', { href: '#/computers', onclick: () => close() }, 'Computers') : t ? lackFix(t) : null));
      paint(actions);
    } else projects();
  }

  function paintPreset() {
    const f = st.preset;
    loadAlso();
    showIntro(false);
    paint(projSlot,
      h('div.row.static.ns-preset',
        h('span.row-icon', icon('folder')),
        h('span.row-main', h('span.row-title', f.name), f.short ? h('span.row-sub', f.short) : null),
        h('button.btn.small.secondary', { type: 'button', onclick: () => {
          // Another project: the preset project's own tool goes, back to this browser's last choice.
          Object.assign(st, { preset: null, last: null, lastKnown: true, also: [] });
          paintTools();
          painted = '';
          paintComputers();
          projects();
        } }, 'Change')));
    const go = h('button.btn.primary', { type: 'button', 'data-start': '1', 'data-startctl': '', disabled: !toolKnown(), onclick: (e) => start(f, e.currentTarget) }, icon('play', { size: 18 }), h('span.ns-ctl-text', 'Start'));
    go.waitsForTool = true; // off again after a failed start while the tool is not known (lock)
    paint(actions, h('div.sheet-actions', go));
  }

  async function projects() {
    paint(actions);
    if (blocked()) return void (gateWas = null, paintProjectsGate());
    gateWas = false;
    if (st.preset) return paintPreset();
    showIntro(true);
    const pc = where();
    const c = pc ? can(pc) : { ok: true };
    if (pc && !c.ok && (pc.hub || pc.status !== 'online' || claudeOf.get(pc.machine || '~') === null)) {
      // This computer cannot run a session at all: say why, and where one can.
      showIntro(false);
      const other = store.all.some((x) => x !== pc && can(x).ok);
      return paint(projSlot, h('div.empty.compact', icon('cpu', { size: 28 }), h('p', `${pc.machineLabel}: ${c.why}.${other ? ' Choose a computer above.' : ''}`),
        other ? null : h('a.btn.secondary', { href: '#/computers', onclick: () => close() }, icon('cpu', { size: 18 }), h('span', 'Computers'))));
    }
    const asked = st.m;
    loading('Loading projects…');
    let recent;
    let proj = null;
    try {
      let settings;
      [recent, proj, settings] = await Promise.all([
        api(at(asked, '/api/folders/recent')),
        api(at(asked, '/api/pcsetup/projects')).catch(() => null), // an older computer, or no projects folder
        api(at(asked, '/api/settings')).catch(() => null),
      ]);
      // As root (src/bypassgate.mjs): a terminal start asks first where his default is Bypass, which the server refuses.
      st.rootDefaultBypass = !!(settings && settings.rootBypass && settings.sessionDefaults && settings.sessionDefaults.permissionMode === 'bypassPermissions');
    } catch (e) {
      return failed(e, projects);
    }
    if (!alive || asked !== st.m || st.preset || blocked()) return;
    projectsDir = proj && proj.projectsDir ? proj.projectsDir : null;
    projectsShort = proj && (proj.projectsShort || (proj.projectsDir && tildePath(proj.projectsDir))) || null;
    // Recent: the newest five. All projects: every other project and recent folder, A to Z.
    const newest = recent.folders.slice(0, RECENT_MAX);
    const seen = new Set(newest.map((f) => f.path));
    const known = proj
      ? [...proj.workspaces.flatMap((w) => w.repos.map((r) => ({ path: r.dir, ...repoWords(r.rel, w.place ? w.id : w.name) }))), ...proj.repos.map((r) => ({ path: r.dir, ...repoWords(r.rel, null), ...(r.place ? { name: r.id } : {}), sub: null }))]
      : [];
    const listed = new Set(known.map((f) => f.path));
    const more = tellApart([...known, ...recent.folders.slice(RECENT_MAX).filter((f) => !listed.has(f.path)).map((f) => ({ path: f.path, name: f.name, short: f.short, sub: folderSub(f, projectsShort) }))]
      .filter((f) => !seen.has(f.path)).sort((a, b) => String(a.name).localeCompare(String(b.name))));
    const lists = h('div', { tabindex: '-1' });
    const draw = () => {
      const q = st.query.trim().toLowerCase();
      const hit = (f, sub) => !q || [f.name, sub, f.short].some((x) => x && String(x).toLowerCase().includes(q));
      const r = newest.filter((f) => hit(f, folderSub(f, projectsShort)));
      const p = more.filter((f) => hit(f, f.sub));
      paint(lists,
        newest.length || more.length ? null : h('p.muted', 'No projects yet. Open a folder below, or add a project under Workspace.'),
        q && !r.length && !p.length ? h('p.muted', 'No project has that name.') : null,
        r.length ? [groupHead('Recent'), h('div.rows', r.map(recentRow))] : null,
        p.length ? [groupHead('All projects'), h('div.rows', p.map((f) => row(f, f.sub, (e) => start({ ...f, short: f.short || f.name }, e.currentTarget))))] : null);
    };
    draw();
    const search = newest.length + more.length >= SEARCH_FROM
      ? h('input.field.ns-search', { type: 'search', 'data-key': 'search', value: st.query, placeholder: 'Search projects', 'aria-label': 'Search projects', autocomplete: 'off', spellcheck: 'false', oninput: (e) => {
        st.query = e.target.value;
        draw();
      } })
      : null;
    loadAlso();
    const root1 = recent.roots[0];
    paint(projSlot, search, lists,
      root1 ? h('div.rows.ns-elsewhere', h('button.row', { type: 'button', onclick: () => browse(root1.path) },
        h('span.row-icon', icon('folderUp')), h('span.row-main', h('span.row-title', 'Another folder…')), h('span.row-end', icon('chevronRight', { size: 18 })))) : null);
  }

  async function browse(p) {
    loading('Opening…');
    let d;
    try {
      d = await api(at(st.m, `/api/folders/browse?${new URLSearchParams({ path: p, hidden: st.hidden ? '1' : '0' })}`));
    } catch (e) {
      return failed(e, () => browse(p));
    }
    if (!alive) return;
    showIntro(false);
    const folder = (x) => h('button.row', { type: 'button', onclick: () => browse(x.path) }, h('span.row-icon', icon('folder')), h('span.row-main', h('span.row-title', x.name)), h('span.row-end', icon('chevronRight', { size: 18 })));
    paint(projSlot,
      h('div.crumbbar',
        d.parent ? h('button.btn.icon.secondary', { type: 'button', title: 'Up one folder', 'aria-label': 'Up one folder', onclick: () => browse(d.parent) }, icon('folderUp', { size: 18 }))
          : h('button.btn.icon.secondary', { type: 'button', title: 'Back to the projects', 'aria-label': 'Back to the projects', onclick: projects }, icon('back', { size: 18 })),
        h('span.crumb', d.short)),
      outsideProjects(d.path, projectsDir) ? projectAdvice(d) : null,
      d.dirs.length ? h('div.rows', d.dirs.map(folder)) : h('p.muted', 'No folders inside.'),
      h('label.toggle-line', h('input', { type: 'checkbox', checked: st.hidden, onchange: (e) => { st.hidden = e.target.checked; browse(d.path); } }), h('span', 'Show hidden folders')));
    paint(actions, h('div.sheet-actions', h('button.btn.primary', { type: 'button', 'data-starthere': '1', 'data-startctl': '', onclick: (e) => start({ path: d.path, short: d.short, name: d.short.split('/').pop() || d.short }, e.currentTarget) }, icon('play', { size: 18 }), h('span.ns-ctl-text', 'Start here'))));
  }

  // A folder outside the projects folder: a quiet line that a project is the better place, and the way to make one.
  function projectAdvice(d) {
    const name = (d.short.split(/[\\/]/).pop() || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100);
    return h('p.hint.ns-advice', icon('folder', { size: 15 }),
      h('span', 'This folder is outside your projects folder. Inside a project, your coding tools get its memory, rules and skills. ',
        h('a', { href: link(name ? `#/new-project/${encodeURIComponent(name)}` : '#/new-project', st.m), onclick: () => close() }, 'Make it a project')));
  }

  // ---------- starting (newsession-start.js): one start at a time for the whole popup ----------
  let starting = false;
  function lock(on, pressed = null) {
    for (const c of root.querySelectorAll('[data-startctl]')) {
      c.disabled = on || (c.waitsForTool === true && !toolKnown());
      c.classList.toggle('row-busy', on && c === pressed && c.classList.contains('row'));
      const words = c.querySelector('.ns-ctl-text');
      if (words && on && c === pressed) {
        words.dataset.was = words.textContent;
        words.textContent = 'Starting…';
      } else if (words && !on && words.dataset.was) words.textContent = words.dataset.was;
    }
  }
  // An App chat of that folder that has no message yet: a tap opens it instead of making a second empty one (repeated
  // taps, or Back and again, never pile them up). Only for the plain start: no earlier conversation, no branch, nothing
  // else to read.
  const emptyChatIn = (f) => (run() === 'chat' && !st.earlier && !st.worktree && !st.also.length
    ? runningHere(f).find((s) => s.kind === 'chat' && s.status === 'waiting' && !s.lastMessage && !s.title && !s.byTia && (s.tool || 'claude') === st.tool) || null
    : null);
  async function start(f, pressed = null) {
    if (starting) return; // a second tap while one is on its way starts nothing
    if (st.unreachable) return say(st.unreachable, true);
    starting = true;
    lock(true, pressed);
    say(`Starting in ${f.name}…`);
    let ok = true;
    try {
      if (!st.tools) await toolsLoad; // tapped before the coding tools were known
      const empty = emptyChatIn(f);
      if (empty) return leave(sessionHref(empty));
      await startSession(f, {
        st, pc: where(), way: run(), toolName: toolName(), busy: (text) => say(text), leave,
        failed: (e) => {
          ok = false;
          if (alive) say(e.message, true, e);
          else toast(e, { kind: 'error', ms: 7000 });
        },
        // The list of conversations takes the popup's place; nothing more to show in it after a choice.
        picking: () => {
          alive = false;
          picking = true;
        },
      });
    } finally {
      starting = false;
      // Gone to the new session: the popup is closed. Still here (a failure, nothing to start): the controls come back.
      if (alive) {
        lock(false);
        if (ok && status.textContent.startsWith('Starting in')) say('');
      }
    }
  }

  // ---------- the popup ----------
  const root = h('div.ns-root', intro, moreSlot, opts, pcSlot, status, projSlot, actions);
  const done = openSheet({ title: 'New session', tall: true }, (c) => {
    close = c;
    return root;
  });
  paintComputers();
  preselect();
  loadTools();
  paintOptions();
  projects();
  moreSlot.querySelector('button').focus(); // the focus starts on the first control: More options (no keyboard on a phone)
  // His look: the sheet opened (where several computers are linked). An older dashboard has no rooms: no words.
  if (store.multi) api('~/api/operator/rooms?look=1').then((v) => {
    if (!alive) return;
    rooms = roomsById(v);
    paintComputers();
  }).catch(() => {});
  api('~/api/machines').then((d) => {
    if (!alive) return;
    claudeOf.set('~', d.self ? d.self.claude || null : undefined);
    for (const x of d.machines || []) claudeOf.set(x.name, x.state === 'online' ? x.claude || null : undefined);
    painted = '';
    paintComputers();
    const pc = where();
    if (pc && !can(pc).ok && !st.preset) projects();
  }).catch(() => {}); // an older computer: every online one with a provider counts
  // The list of computers may arrive after the first paint.
  let seen = '';
  const unsubscribe = store.subscribe(() => {
    if (!alive) return;
    preselect();
    paintComputers();
    const pc = where();
    const now = JSON.stringify([store.all.map((x) => [x.machine, x.status]), pc && pc.profiles.map((p) => p.name), pc && pc.recommended, pc && can(pc).ok]);
    if (now === seen) return;
    const before = seen;
    seen = now;
    paintTools(); // its providers came or went: a tool may need one now, or not any more
    paintProjectsGate();
    if (before && JSON.parse(before)[3] !== (pc && can(pc).ok) && !st.preset) projects();
  });
  // Another address (Back, a link in the popup, a start): the popup closes.
  const onHash = () => close();
  window.addEventListener('hashchange', onHash);
  done.then(() => {
    alive = false;
    unsubscribe();
    window.removeEventListener('hashchange', onHash);
    // Opened by its address and closed without going anywhere: the address becomes Home's, so a reload shows Home.
    if (address && !picking && atNewAddress()) location.replace('#/');
  });
  return done;
}

/**
 * `#/new` (app.js draws Home under it). "#/new?dir=<folder>[&tool=<id>]" (hoprig chat, a link): one question, then
 * the App opens there, set up as the last one in that folder. A link from anywhere never opens one by itself (each
 * open App counts against the open ones, and evicts idle ones).
 */
export function newFromAddress({ query = new URLSearchParams() } = {}) {
  const m = machine.current;
  const asked = query.get('dir');
  if (!asked) return openNewSession({ ...(m !== null ? { m } : {}), address: true });
  const tool = /^[a-z]{1,20}$/.test(query.get('tool') || '') ? query.get('tool') : '';
  history.replaceState(null, '', '#/'); // a reload or Back shows Home, not the question again
  const with_ = tool && tool !== 'claude' ? ` with ${TOOL_NAMES[tool] || tool}` : '';
  return confirmSheet({ title: 'Open the App here?', text: `A session in the App${with_} in ${tildePath(asked)}, set up as the last one in that folder. Nothing is sent until you write.`, ok: 'Open the App' }).then((yes) => {
    if (!yes) return;
    startChat(asked, tool ? { tool } : {}, m).catch((e) => toast(e, { kind: 'error', ms: 7000 }));
  });
}
