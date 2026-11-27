// Memory (#/brain, #/brain/<item>), the third tab of Projects: what the AI knows on the open computer, read-only
// (GET /api/brain, src/workspace/brain.mjs): the rules Claude gets everywhere (open), then the memory, notes, daily logs
// and what is pending, each a closed fold with its count and none drawn when empty. A file opens on a tap, never by
// itself (the right pane of a wide screen, a page of its own on a phone). Each project's part is on its own page
// (projectBrain). The skills are on the Skills tab. Texts are shown as safe formatting (mdtext.js), never as HTML from
// the file.
// Also here: "Workspace folders" (the tree the product sets up, GET /api/workspace) for a computer's Setup tab, and
// the one way to create what is missing (POST /api/workspace/setup: the dry run first, then the real run).
import { linkBrainNote, projectsTabs, toolsPart } from './brainlink.js';
import { icon } from './icons.js';
import { ago, api, btn, bytes, fill, h, link, openSheet, toast } from './lib.js';
import { mdView } from './mdtext.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, fold, groupHead, okBox, panel, skeletonRows } from './shell.js';

export { projectsTabs };
import { store } from './store.js';
import { credentialsPart } from './workspacecreds.js';

const enc = encodeURIComponent;

// ======================= create what is missing =======================

/** Show what setup would create, then do it on the owner's word and say what it did. `after()` runs when done. */
export async function setUpWorkspace(after = () => {}) {
  let plan;
  try {
    plan = await api('/api/workspace/setup', { dryRun: true });
  } catch (e) {
    return toast(e, { kind: 'error', ms: 7000 });
  }
  if (!plan.did.length) return toast('Nothing is missing: the workspace is complete.');
  await openSheet({ title: 'Create what is missing', subtitle: `In ${plan.status ? plan.status.short : plan.dir}. Nothing that is there is moved, renamed or overwritten.` }, (close) => {
    const out = h('div');
    const go = h('button.btn.primary', { type: 'button' }, icon('check', { size: 16 }), h('span', 'Create them'));
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.classList.add('busy');
      try {
        const r = await api('/api/workspace/setup', { dryRun: false });
        fill(out,
          okBox(`Created ${r.did.length} ${r.did.length === 1 ? 'thing' : 'things'}.`),
          r.left.length ? h('div', h('p.field-label', 'Left as they are'), h('ul.ws-setup-list', r.left.map((x) => h('li', h('code', x.path), ` — ${x.why}`)))) : null,
          r.git && !r.git.done && r.git.why ? h('p.hint', `The AI brain is not a git repository yet: ${r.git.why}`) : null);
        fill(go.parentElement, h('button.btn.primary', { type: 'button', onclick: () => close(true) }, 'Done'));
        after();
      } catch (e) {
        fill(out, errorBox(e));
        go.disabled = false;
        go.classList.remove('busy');
      }
    });
    return [
      h('p.sheet-text', 'These will be created:'),
      h('ul.ws-setup-list', plan.did.map((x) => h('li', h('code', x.path), ` — ${x.what}`))),
      plan.left.length ? h('p.hint', `${plan.left.length} ${plan.left.length === 1 ? 'thing is' : 'things are'} there already and stay as they are.`) : null,
      out,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), go),
    ];
  });
}

/** "Workspace folders" for a computer's Setup tab: the seven folders, there or not, and the one action. */
export function workspaceFolders() {
  const box = h('div', skeletonRows(3));
  const root = panel({ icon: 'folder', title: 'Workspace folders', desc: 'The folder tree your projects, the AI brain and your tools live in.' }, box);
  async function load() {
    let w;
    try {
      w = await api('/api/workspace');
    } catch (e) {
      return fill(box, e.status === 404 ? h('p.hint', 'This computer runs an older version without a workspace.') : errorBox(e, load));
    }
    const missing = w.folders.filter((f) => !f.exists).length + (w.exists ? 0 : 1);
    const rows = (list) => h('div.rows.ws-folders', list.map((f) => h('div.row.static',
      h(`span.row-icon.ws-mark${f.exists ? '.ok' : ''}`, icon(f.exists ? 'check' : 'minus', { size: 16 })),
      h('span.row-main',
        h('span.row-title', h('code', `${f.rel}/`), f.exists ? null : h('span.badge.soft', f.kind === 'missing' ? 'missing' : f.kind)),
        h('span.row-sub.ws-wrap', f.purpose),
        f.warning ? h('span.row-sub.ws-warn', f.warning) : null,
        f.note ? h('span.row-sub.ws-wrap', f.note) : null))));
    // Only what is missing (or warns) shows as a row; the folders that are fine fold into one line.
    const fine = w.folders.filter((f) => f.exists && !f.warning);
    const other = w.folders.filter((f) => !fine.includes(f));
    fill(box,
      h('p.hint', 'In ', h('code', w.short), w.exists ? '' : ' (not made yet)', '.'),
      other.length ? rows(other) : null,
      fine.length ? fold('workspace-folders-fine', fine.length === w.folders.length ? `All ${fine.length} folders are there` : `${fine.length} more folder${fine.length === 1 ? ' is' : 's are'} there`, rows(fine)) : null,
      credentialsPart(),
      missing
        ? h('div.savebar.start', h('button.btn.primary', { type: 'button', onclick: () => setUpWorkspace(load) }, icon('plus', { size: 16 }), h('span', 'Create what is missing')))
        : null);
  }
  load();
  return root;
}

// ======================= the AI brain page =======================

const TYPE = { index: 'index', user: 'about you', feedback: 'feedback', project: 'project', reference: 'reference' };
// A file's time arrives as milliseconds or as an ISO date.
export const when = (t) => {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? ago(ms) : '';
};

/** The memory files in the order the memory's index lists them ("- [Title](file.md) — …"): their file names. */
export const indexOrder = (text) => [...String(text || '').matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1].split('/').pop());

/**
 * The groups of the list, from GET /api/brain: [{ title, rows: [{ item, title, sub, chip }] }]. `memoryOrder`: file
 * names from the memory's index; the memories follow it (the index first, anything it does not list last).
 */
export function brainGroups(b, { memoryOrder = [] } = {}) {
  const row = (item, title, sub = '', chip = null) => (item ? { item, title: title || item.title, sub, chip } : null);
  const groups = [];
  const rules = [row(b.global.rules, 'The rules every coding tool gets', b.global.linked ? 'linked into Claude Code' : 'not linked into Claude Code yet'), ...(b.global.more || []).map((x) => row(x))].filter(Boolean);
  groups.push({ id: 'rules', title: 'What your coding tools are told everywhere', rows: rules, none: 'No global rules file yet.' });
  const base = (m) => String(m.file || '').split('/').pop();
  const place = (m) => (m.type === 'index' ? -1 : memoryOrder.includes(base(m)) ? memoryOrder.indexOf(base(m)) : memoryOrder.length);
  const mem = [...(b.memory.home.items || [])].sort((x, y) => place(x) - place(y))
    .map((m) => row(m, m.type === 'index' ? 'Index of the memory' : m.name || m.title, m.description || '', TYPE[m.type] || m.type || null));
  groups.push({ id: 'memory', title: 'What they remembered', count: b.memory.home.count, rows: mem, none: 'Nothing remembered yet.' });
  groups.push({
    id: 'notes', title: 'Learnings and current context',
    rows: [row(b.brain.about, 'About this brain'), row(b.brain.learnings, 'Learnings', 'What was learned, to keep'), row(b.brain.activeContext, 'Current context', 'What is being worked on now')].filter(Boolean),
    none: 'No notes yet.',
  });
  groups.push({ id: 'logs', title: 'Daily logs', count: b.dailyLogs.count, rows: b.dailyLogs.items.map((x) => row(x, x.date || x.title, x.date && x.title !== x.date ? x.title : '')), none: 'No daily logs yet.' });
  groups.push({ id: 'pending', title: 'Pending', rows: [row(b.brain.pending, 'What is pending')].filter(Boolean), none: 'Nothing pending.' });
  for (const p of b.projects || []) {
    groups.push({
      id: `p-${p.name}`, title: p.name, project: true,
      rows: [row(p.agents, 'Rules for this project'), row(p.decisions, 'Decisions'), row(p.learnings, 'Learnings'), row(p.activeContext, 'Current context'),
        ...((p.memory && p.memory.items) || []).map((m) => row(m, m.name || m.title, m.description || '', TYPE[m.type] || m.type || null))].filter(Boolean),
      none: 'Nothing for this project yet.',
    });
  }
  return groups;
}

function itemRow(r, current) {
  return h('a.row', { href: link(`#/brain/${enc(r.item.id)}`), 'aria-current': current ? 'page' : null },
    h('span.row-main',
      h('span.row-title', r.title, r.chip ? h('span.badge.soft', r.chip) : null),
      r.sub ? h('span.row-sub', r.sub) : null),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}

async function showItem(pane, id) {
  fill(pane, h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Reading…')));
  let t;
  try {
    t = await api(`/api/brain/item?id=${enc(id)}`);
  } catch (e) {
    return fill(pane, errorBox(e.status === 415 ? 'This file is not text, so it is not shown here.' : e.status === 403 ? 'This file is not shown here.' : e.message));
  }
  fill(pane,
    h('header.split-head', h('h2.split-title', t.title), h('p.page-intro', h('code', t.file), ` · ${bytes(t.size)}${t.modified ? ` · changed ${when(t.modified)}` : ''}`)),
    t.cut || t.masked ? h('p.hint.brain-quiet', [t.cut ? 'Only the first 200 KB is shown.' : null, t.masked ? 'Something that looked like a key or password was hidden.' : null].filter(Boolean).join(' ')) : null,
    h('div.card.brain-text', mdView(t.text)));
}

/**
 * What the Memory list draws, from brainGroups: the groups of the computer (not a project's: those are on the project's
 * page) that have rows. The first one is open; each other is one closed fold named with its count.
 */
export function memoryParts(groups) {
  const own = groups.filter((g) => !g.project && g.rows.length);
  return own.map((g, i) => ({ ...g, open: i === 0 && g.id === 'rules', label: `${g.title} (${g.count ?? g.rows.length})` }));
}

function viewBrain({ frame, sub }) {
  store.viewing = null;
  const id = sub ? decodeURIComponent(sub) : '';
  const list = h('nav.split-list.brain-list', { 'aria-label': 'What the AI knows' }, skeletonRows(4));
  const pane = h('div.split-pane');
  const split = h(`div.split${id ? '.has-page' : '.no-page'}`, list, pane);
  frame({
    title: 'Memory',
    page: 'brain',
    back: id ? link('#/brain') : null,
    backLabel: 'Memory',
    backOnPhoneOnly: true,
    wide: true,
    body: [projectsTabs('memory'), split],
  });
  let alive = true;
  async function load() {
    let b;
    try {
      b = await api('/api/brain');
    } catch (e) {
      return fill(list, e.status === 404 ? h('p.hint', 'This computer runs an older version without the AI brain.') : errorBox(e, load));
    }
    if (!alive) return;
    split.classList.toggle('pane-only', !b.brain.exists); // nothing to list: the empty state alone, centred
    if (!b.brain.exists) {
      fill(list);
      return fill(pane, emptyState('book', 'The AI brain is one folder with what your coding tools should know in every project: rules, memory, notes and logs. It is not set up on this computer yet.',
        h('button.btn.primary', { type: 'button', onclick: () => setUpWorkspace(load) }, icon('plus', { size: 16 }), h('span', 'Set up the workspace'))));
    }
    const index = (b.memory.home.items || []).find((m) => m.type === 'index');
    const memoryOrder = index ? indexOrder((await api(`/api/brain/item?id=${enc(index.id)}`).catch(() => ({}))).text) : [];
    if (!alive) return;
    const parts = memoryParts(brainGroups(b, { memoryOrder }));
    const holding = (el, g) => { // the fold of the open file stays open, so the file in view has its place in the list
      if (id && g.rows.some((r) => r.item.id === id)) el.open = true;
      return el;
    };
    const rows = (g) => [
      h('div.rows', g.rows.map((r) => itemRow(r, r.item.id === id))),
      g.count > g.rows.length ? h('p.hint.brain-none', `The newest ${g.rows.length} of ${g.count}.`) : null,
    ];
    fill(list,
      linkBrainNote({ switchOn: true, after: load }), // only while the brain is not linked: empty otherwise
      parts.length ? parts.map((g) => (g.open ? [groupHead(g.title, g.count ?? g.rows.length), rows(g)] : holding(fold(`brain-${g.id}`, g.label, rows(g)), g)))
        : h('p.hint.brain-none', 'Nothing remembered yet.'),
      fold('brain-tools', 'Coding tools',
        toolsPart({ after: load }),
        h('p.hint.brain-none', 'You and your coding tools change these files in a session. This page shows them, and Link connects them to each coding tool; it never edits them.')));
    // A file is opened by a tap (its address #/brain/<item>), never by itself.
    if (id) showItem(pane, id);
    else fill(pane, h('p.hint.brain-none', 'Pick a file to read it here.'));
  }
  load();
  return () => {
    alive = false;
  };
}

/** A project's own "AI brain" part, for its page (projects.js): rules, decisions, notes and memory of that project. */
export async function projectBrain(box, name) {
  let b;
  try {
    b = await api('/api/brain');
  } catch {
    return fill(box);
  }
  const g = brainGroups(b).find((x) => x.project && x.title === name);
  fill(box, g && g.rows.length
    ? h('div.rows', g.rows.map((r) => itemRow(r, false)))
    : h('p.hint', 'Nothing for this project in the AI brain yet.'));
}

registerPage({ id: 'brain', title: 'Memory', icon: 'brain', navAs: 'workspace', order: 25, perComputer: true, render: viewBrain });
