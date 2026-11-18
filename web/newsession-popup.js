// New session: one popup over the page it was opened on (the kit's sheet: a dialog on a wide screen, a full-height
// sheet on a phone). First HOW to work, App or Terminal, then WITH WHAT, one tile per coding tool with its state on
// the computer, then the project: a tap on one starts a new session (the recent ones first; where something runs, its
// own button beside the row opens that). Opened from a project, the project is set and "Start" starts it. Everything else waits under a
// closed "Options": the provider, what it may do without asking, how hard it thinks, the model, the conversation, a
// plain terminal. Where several computers are linked, the computer comes first. `#/new` shows it over Home (app.js).
import { chatTools, knownChatTools, startChat } from './chat/start.js';
import { icon } from './icons.js';
import { TOOL_NAMES, api, at, cardTool, chooseSheet, confirmSheet, fill, h, isCodingCard, link, machine, openSheet, prefs, tildePath, toast } from './lib.js';
import { chooseTool, computerTiles, openAsDefault, openAsTiles, toolState, toolTiles, wayState } from './newsession-choice.js';
import { optionsFor } from './newsession-options.js';
import { folderSub, outsideProjects, repoWords, runningIn } from './newsession-words.js';
import { atNewAddress, startSession } from './newsession-start.js';
import { sessionHref } from './sessionitem.js';
import { fold, groupHead } from './shell.js';
import { runsSessions, store } from './store.js';

const SEARCH_FROM = 9; // a search field over the projects from this many on

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
    openAs: openAsDefault(prefs.get('new.openAs', 'app')),
    tool: null, // the coding tool a start uses (chooseTool)
    picked: null, // the one chosen here by the owner
    last: null, // the one the preset project used last
    lastKnown: !project, // false while the preset project's last tool is being asked for (Start waits for it)
    saved: prefs.get('new.tool', null), // the one this browser chose last time
    tools: null, // [{ id, name, state }] of the computer, null until known
    unreachable: null, // why nothing can start on the computer (it cannot be reached), or null
    plain: false, // Options → a plain terminal, without a coding tool
    profile: '', permissionMode: '', effort: '', model: '', models: null, conversation: 'new',
    dir: null, // the folder open under "Another folder" (its real path), for the Provider list's words
    hidden: false,
    preset: project,
    query: '',
  };
  let alive = true;
  let picking = false; // a conversation is being picked in the sheet that took the popup's place
  let close = () => {};
  let projectsDir = null;
  let projectsShort = null;
  const claudeOf = new Map(); // Claude Code on each computer ('~' for this one), from GET /api/machines
  const can = (x) => runsSessions(x, claudeOf.get(x.machine || '~'));
  const where = () => store.all.find((x) => x.machine === st.m) || null;
  const run = () => (st.plain ? 'shell' : st.openAs === 'app' ? 'chat' : 'claude');
  const toolName = (id = st.tool) => TOOL_NAMES[id] || id;
  // A tool's own modes and efforts (another tool than Claude Code), from the chat's list of the computer.
  const toolInfo = () => (st.tool && st.tool !== 'claude' ? knownChatTools(st.m).find((t) => t.id === st.tool) || { id: st.tool, modes: null } : null);

  const pcSlot = h('div.ns-computers', { tabindex: '-1' });
  const toolSlot = h('div', { tabindex: '-1' });
  const projSlot = h('div.ns-projects', { tabindex: '-1' });
  const opts = h('div.newopts', { tabindex: '-1' });
  const actions = h('div.ns-actions', { tabindex: '-1' }); // Start / Start here, kept in view at the bottom while the popup scrolls
  const openAsSlot = h('div', { tabindex: '-1' });
  const status = h('p.hint.ns-status', { role: 'status', 'aria-live': 'polite' }); // what a start is doing, or why it failed
  // Parts are drawn again as answers arrive. The control that has the focus keeps it: found again in the new drawing by
  // its key (a tile's choice, a project's name, a field's key), else the part's first control, else the part itself,
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

  // ---------- the computer: the first choice when there are several (not while a project is set) ----------
  let painted = '';
  function paintComputers() {
    const key = store.multi && !st.preset ? JSON.stringify([st.m, store.all.map((x) => [x.machine, x.machineLabel, can(x)])]) : '';
    if (key === painted) return;
    painted = key;
    if (!key) return paint(pcSlot);
    const id = (x) => x.machine || '~';
    paint(pcSlot, groupHead('Computer'), computerTiles({
      chosen: id(where() || { machine: st.m }),
      computers: store.all.map((x) => {
        const c = can(x);
        const providers = (x.profiles || []).filter((p) => !p.virtual).length;
        return { id: id(x), name: x.machineLabel, line: c.ok ? `${providers} provider${providers === 1 ? '' : 's'}` : c.why, disabled: !c.ok };
      }),
      choose: (to) => {
        const x = store.all.find((y) => id(y) === to);
        if (!x || x.machine === st.m) return;
        prefs.set('new.machine', to);
        st.m = x.machine;
        Object.assign(st, { picked: null, tools: null, profile: '', permissionMode: '', effort: '', model: '', models: null });
        paintComputers();
        loadTools();
        projects();
      },
    }));
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

  // ---------- App or Terminal ----------
  function paintOpenAs(focus = false) {
    paint(openAsSlot, groupHead('Open as'), openAsTiles({
      chosen: st.openAs,
      choose: (id) => chooseWay(id, true),
    }));
    if (focus) openAsSlot.querySelector(`[data-choice="${st.openAs}"]`)?.focus();
  }

  // A tool is ready only for a way it can be started in: the tiles are drawn again with the way.
  function chooseWay(id, focus = false) {
    if (id === st.openAs) return;
    st.openAs = id;
    st.permissionMode = ''; // an App's modes and a terminal's differ
    prefs.set('new.openAs', id);
    paintOpenAs(focus);
    paintTools();
    paintOptions();
    paintProjectsGate();
    if (st.preset) paintPreset();
  }

  // ---------- the coding tool ----------
  function paintTools() {
    // Until the preset project's last tool is known the row says so, so that the choice cannot change after a tap.
    if (!st.tools || !st.lastKnown) {
      st.tool = null;
      return paint(toolSlot, groupHead('Coding tool'), h('p.hint', st.tools ? `Looking at what ${st.preset.name} used last…` : 'Looking at the coding tools…'));
    }
    if (st.unreachable) {
      st.tool = null;
      return paint(toolSlot, groupHead('Coding tool'), h('p.hint.ns-unreachable', st.unreachable));
    }
    const appTools = knownChatTools(st.m).map((t) => t.id);
    const tiles = st.tools.map((t) => ({ ...t, state: wayState(t, st.openAs, appTools, (w) => chooseWay(w)) }));
    st.tool = chooseTool(tiles, { picked: st.picked, last: st.preset ? st.last : null, saved: st.saved });
    paint(toolSlot, groupHead('Coding tool'), toolTiles({
      tools: tiles, chosen: st.tool, onleave: () => close(),
      choose: (id) => {
        if (id === st.tool) return;
        st.picked = id;
        st.saved = id;
        prefs.set('new.tool', id); // the next popup starts with it
        Object.assign(st, { profile: '', permissionMode: '', effort: '' });
        paintTools();
        paintOptions();
      },
    }));
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
    paintOptions();
    paintProjectsGate();
    if (st.preset) paintPreset(); // Start can be pressed now
  }

  // ---------- Options ----------
  function paintOptions() {
    paint(opts, optionsFor({
      st, where: where(), run: run(), info: toolInfo(), toolName: toolName(st.tool || 'claude'),
      onplain: (on) => {
        st.plain = on;
        paintOptions();
        paintProjectsGate();
        if (st.preset) paintPreset();
      },
    }));
  }

  // ---------- the project ----------
  const loading = (text) => paint(projSlot, h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text)));
  // While the popup is open, the error shows in it; after it closed (a conversation was picked), as a toast.
  const failed = (e, retry) => (alive
    ? paint(projSlot, h('div.empty', icon('alert', { size: 32 }), h('p', e.message), h('button.btn.secondary', { type: 'button', onclick: retry }, 'Try again')))
    : toast(e.message, { kind: 'error', ms: 7000 }));
  // A start control (a project's row, Start, Start here, the plain terminal's switch): `data-startctl`, so that one
  // start at a time can turn them all off while it is on its way.
  const say = (text, error = false) => {
    status.textContent = text || '';
    status.classList.toggle('ns-is-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  };
  // A project's row: a tap STARTS A NEW session there with the choices above, also where something runs already.
  const row = (f, sub, onclick) =>
    h('button.row', { type: 'button', onclick, 'data-name': f.name, 'data-startctl': '', title: `A new session in ${f.name}` },
      h('span.row-icon', icon('folder')),
      h('span.row-main', h('span.row-title', f.name), sub ? h('span.row-sub', sub) : null),
      h('span.row-end', icon('play', { size: 18 })));
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
      'aria-label': several ? `Choose one of the ${list.length} sessions running in ${f.name}` : `Open the session running in ${f.name}`,
      onclick: () => (several ? pickRunning(f, list) : leave(one ? link(one, st.m) : sessionHref(list[0]))),
    }, icon(several ? 'sessions' : 'chevronRight', { size: 16 }), h('span', 'Open', h('span.ns-open-what', several ? ' running' : ' running session'), several ? ` (${list.length})` : '')));
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

  // Start waits until the tool it sends is known (the preset project's last one), or a plain terminal is chosen.
  const toolKnown = () => st.plain || (!!st.tools && st.lastKnown);
  // Nothing can start: no coding tool is ready (a plain terminal still can).
  const blocked = () => !!st.unreachable || (!st.plain && st.tools && st.lastKnown && !st.tool);
  let gateWas = null;
  function paintProjectsGate() {
    const now = blocked();
    if (now === gateWas) return;
    gateWas = now;
    if (now) {
      const pc = where();
      paint(projSlot, groupHead('Project'), h('div.empty.compact', icon(st.unreachable ? 'cpu' : 'code', { size: 28 }),
        h('p', st.unreachable || `No coding tool is ready${pc ? ` on ${pc.machineLabel}` : ''} for this way yet: see above what each one needs. A plain terminal is under Options.`)));
      paint(actions);
    } else projects();
  }

  function paintPreset() {
    const f = st.preset;
    paint(projSlot, groupHead('Project'),
      h('div.row.static.ns-preset',
        h('span.row-icon', icon('folder')),
        h('span.row-main', h('span.row-title', f.name), f.short ? h('span.row-sub', f.short) : null),
        h('button.btn.small.secondary', { type: 'button', onclick: () => {
          // Another project: the preset project's own tool goes, back to this browser's last choice.
          Object.assign(st, { preset: null, last: null, lastKnown: true });
          paintTools();
          paintOptions();
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
    if (st.dir) {
      st.dir = null;
      paintOptions();
    }
    if (blocked()) return void (gateWas = null, paintProjectsGate());
    gateWas = false;
    if (st.preset) return paintPreset();
    const pc = where();
    const c = pc ? can(pc) : { ok: true };
    if (pc && !c.ok && (pc.hub || pc.status !== 'online' || claudeOf.get(pc.machine || '~') === null)) {
      // This computer cannot run a session at all: say why, and where one can.
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
        api(at(asked, '/api/settings')).catch(() => null), // the models it offers (an older computer: the usual three)
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
    if (!alive || asked !== st.m || st.preset || blocked()) return;
    projectsDir = proj && proj.projectsDir ? proj.projectsDir : null;
    projectsShort = proj && (proj.projectsShort || (proj.projectsDir && tildePath(proj.projectsDir))) || null;
    const seen = new Set(recent.folders.map((f) => f.path));
    const more = proj
      ? [...proj.workspaces.flatMap((w) => w.repos.map((r) => ({ path: r.dir, ...repoWords(r.rel, w.place ? w.id : w.name) }))), ...proj.repos.map((r) => ({ path: r.dir, ...repoWords(r.rel, null), ...(r.place ? { name: r.id } : {}), sub: null }))].filter((f) => !seen.has(f.path))
      : [];
    const lists = h('div', { tabindex: '-1' });
    const draw = () => {
      const q = st.query.trim().toLowerCase();
      const hit = (f, sub) => !q || [f.name, sub, f.short].some((x) => x && String(x).toLowerCase().includes(q));
      const r = recent.folders.filter((f) => hit(f, folderSub(f, projectsShort)));
      const p = more.filter((f) => hit(f, f.sub));
      paint(lists,
        recent.folders.length || more.length ? null : h('p.muted', 'No projects yet. Open a folder below, or add a project under Workspace.'),
        q && !r.length && !p.length ? h('p.muted', 'No project has that name.') : null,
        r.length ? [groupHead('Recent'), h('div.rows', r.map(recentRow))] : null,
        p.length ? [groupHead(q || !r.length ? 'Projects' : 'More projects'), h('div.rows', p.map((f) => row(f, f.sub, (e) => start({ ...f, short: f.name }, e.currentTarget))))] : null);
    };
    draw();
    const search = recent.folders.length + more.length >= SEARCH_FROM
      ? h('input.field.ns-search', { type: 'search', 'data-key': 'search', value: st.query, placeholder: 'Search projects', 'aria-label': 'Search projects', autocomplete: 'off', spellcheck: 'false', oninput: (e) => {
        st.query = e.target.value;
        draw();
      } })
      : null;
    paint(projSlot, groupHead('Project'), search, lists,
      h('div.rows.ns-elsewhere', recent.roots.map((r) => h('button.row', { type: 'button', onclick: () => browse(r.path) },
        h('span.row-icon', icon('folderUp')), h('span.row-main', h('span.row-title', 'Another folder…'), h('span.row-sub', `Browse ${r.short}`)), h('span.row-end', icon('chevronRight', { size: 18 }))))));
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
    st.dir = d.path;
    paintOptions();
    const folder = (x) => h('button.row', { type: 'button', onclick: () => browse(x.path) }, h('span.row-icon', icon('folder')), h('span.row-main', h('span.row-title', x.name)), h('span.row-end', icon('chevronRight', { size: 18 })));
    paint(projSlot, groupHead('Project'),
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
  async function start(f, pressed = null) {
    if (starting) return; // a second tap while one is on its way starts nothing
    if (st.unreachable) return say(st.unreachable, true);
    starting = true;
    lock(true, pressed);
    say(`Starting in ${f.name}…`);
    let ok = true;
    try {
      if (!st.plain && !st.tools) await toolsLoad; // tapped before the coding tools were known
      await startSession(f, {
        st, pc: where(), way: run(), info: toolInfo(), toolName: toolName(), busy: (text) => say(text), leave,
        failed: (e) => {
          ok = false;
          if (alive) say(e.message, true);
          else toast(e.message, { kind: 'error', ms: 7000 });
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
  const root = h('div.ns-root', pcSlot, openAsSlot, toolSlot, status, projSlot, fold('new-options', 'Options', opts), actions);
  const done = openSheet({ title: 'New session', tall: true }, (c) => {
    close = c;
    return root;
  });
  paintComputers();
  paintOpenAs(true); // the focus starts on the first choice
  preselect();
  loadTools();
  paintOptions();
  projects();
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
    paintOptions();
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
    startChat(asked, tool ? { tool } : {}, m).catch((e) => toast(e.message, { kind: 'error', ms: 7000 }));
  });
}
