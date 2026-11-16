// The code editor: VS Code's editor core (Monaco) in the page, with our own Explorer, Search and Source Control, on a
// folder of this computer or of another one (its files go through the hub like every other request; Monaco's own
// files always come from this dashboard). The server part is src/editor/. Reached from a project on Workspace ("Open
// code", "Changes"), from a session's menu, and by links: #/code?dir=<folder>&file=<path>&line=<n>&view=changes.
import { btn, confirmSheet, fill, h, link, machine, tildePath } from '../lib.js';
import { icon } from '../icons.js';
import { registerPage, registerSessionAction, registerSettingsPage } from '../registry.js';
import { emptyState, listRow, panel, savedMark, toggle } from '../shell.js';
import { store } from '../store.js';
import { editorPrefs, setEditorPref } from './monaco.js';
import { codeHash, recentFolders, viewCode } from './workbench.js';

export { codeHash };

// ---------- leaving with unsaved changes ----------

// The open editor, for the guard below: { root, machine, dirty(), openFrom(query) } or null.
let current = null;
let leaving = false;

/** The editor address `hash` asks for: { machine, query } or null for another page. */
function codeTarget(hash) {
  const m = /^#(?:\/m\/([a-z0-9][a-z0-9_-]{0,31}))?\/code(?:\?(.*))?$/.exec(hash || '');
  return m ? { machine: m[1] || null, query: new URLSearchParams(m[2] || '') } : null;
}

// Registered before the router's own listener (this module loads first), so it can keep the page: a link into the
// open folder opens the file in place, and a way out with unsaved changes asks first.
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', (e) => {
    if (!current || leaving) return;
    const to = codeTarget(location.hash);
    if (to && to.machine === current.machine && to.query.get('dir') === current.root) {
      e.stopImmediatePropagation();
      current.openFrom(to.query);
      return;
    }
    const n = current.dirty();
    if (!n) return;
    e.stopImmediatePropagation();
    const next = location.href;
    history.replaceState(null, '', e.oldURL);
    confirmSheet({ title: 'Leave without saving?', text: `${n} file${n === 1 ? ' has' : 's have'} unsaved changes in the editor. They are lost if you leave.`, ok: 'Leave without saving', danger: true }).then((ok) => {
      if (!ok) return;
      leaving = true;
      location.href = next;
    });
  });
}

// ---------- the page ----------

/** #/code without a folder: where folders are opened from, and the ones opened lately. */
function viewLanding({ frame }) {
  const here = machine.current;
  const recent = recentFolders().filter((r) => (r.machine || null) === here);
  frame({
    title: 'Code editor',
    page: 'code',
    intro: 'Open a project\'s code from Workspace: every project has an Open code button.',
    body: [
      recent.length
        ? panel({ icon: 'clock', title: 'Opened lately', desc: 'In this browser.' }, h('div.rows', recent.map((r) => listRow({ href: codeHash(r.dir), icon: 'code', title: r.dir.split('/').pop() || r.dir, sub: tildePath(r.dir) }))))
        : emptyState('code', 'No folder is open yet.', h('a.btn.primary', { href: link('#/workspace') }, 'Go to Workspace')),
    ],
  });
}

registerPage({
  id: 'code', title: 'Code editor', icon: 'code', navAs: 'workspace', perComputer: true,
  render: (ctx) => {
    leaving = false;
    const q = ctx.query || new URLSearchParams();
    if (!q.get('dir') || !q.get('dir').startsWith('/') && !/^[A-Za-z]:[\\/]/.test(q.get('dir'))) return viewLanding(ctx);
    return viewCode({ query: q }, (c) => {
      current = c;
    });
  },
});

// ---------- the ways in ----------

/**
 * "Open code" for a folder: the icon alone (`compact`) or with its words. `changes`: a "N changes" button that opens
 * Source Control instead. `m`: the computer the folder is on (default: the one whose screen is open).
 */
export function editorButton(dir, { name = '', compact = false, changes = 0, m = machine.current } = {}) {
  if (!dir) return null;
  if (changes > 0) {
    const words = `${changes} change${changes === 1 ? '' : 's'}`;
    return h('a.btn.small.secondary', { href: codeHash(dir, { view: 'changes' }, m), title: `See ${words}${name ? ` in ${name}` : ''} and commit them` }, h('span', words));
  }
  const title = name ? `Open ${name} in the code editor` : 'Open in the code editor';
  return compact
    ? h('a.btn.icon.ghost.small', { href: codeHash(dir, {}, m), title, 'aria-label': title }, icon('code', { size: 18 }))
    : h('a.btn.small.secondary', { href: codeHash(dir, {}, m), title }, icon('code', { size: 18 }), h('span', 'Open code'));
}

// A session's folder, wherever the session runs.
const sessionOf = (s) => ((store.all.find((x) => x.machine === (s.machine || null)) || {}).sessions || []).find((x) => x.name === s.name) || null;
registerSessionAction({
  id: 'editor',
  label: 'Open code',
  sub: 'This session\'s folder in the code editor',
  icon: 'code',
  describe: (s) => {
    const found = sessionOf(s);
    return found && found.cwd ? { sub: `${found.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || found.cwd} in the code editor` } : null;
  },
  run: (s) => {
    const found = sessionOf(s);
    if (found && found.cwd) location.hash = codeHash(found.cwd, {}, s.machine || null);
  },
});

// ---------- Settings → Editor (per browser) ----------

function settingsBody() {
  const p = editorPrefs();
  const marks = { font: savedMark(), tab: savedMark() };
  const size = h('span.fontsize');
  const paintSize = () => (size.textContent = `${editorPrefs().fontSize} px`);
  paintSize();
  const step = (d) => {
    setEditorPref('font', Math.min(24, Math.max(10, editorPrefs().fontSize + d)));
    paintSize();
    marks.font.show();
  };
  const tabs = h('div.segmented', { role: 'radiogroup' });
  const paintTabs = () => fill(tabs, [2, 4, 8].map((n) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(editorPrefs().tabSize === n), onclick: (e) => {
    e.preventDefault();
    setEditorPref('tab', n);
    paintTabs();
    marks.tab.show();
  } }, h('span', String(n)))));
  paintTabs();
  return [
    panel({ icon: 'code', title: 'The code editor', desc: 'Saved in this browser only. The colours follow the page\'s light or dark theme (Settings → Appearance).' },
      h('div.fieldrow', h('span.field-label', 'Text size', marks.font),
        h('div.stepper-inline', btn('icon secondary', { icon: 'minus', title: 'Smaller', onclick: () => step(-1) }), size, btn('icon secondary', { icon: 'plus', title: 'Larger', onclick: () => step(1) }))),
      h('div.fieldrow', h('span.field-label', 'Tab size', marks.tab), tabs, h('span.hint', 'Spaces for the Tab key and for an indent. A project\'s own .editorconfig is not read.')),
      toggle('Word wrap', p.wordWrap, (v) => setEditorPref('wrap', v), 'Long lines wrap at the edge instead of scrolling sideways.'),
      // Plain text editing (for a phone where Monaco cannot be typed into) is switched in the editor's own menu.
      h('p.hint', 'Plain text editing, for a phone where the code editor cannot be typed into, is in the editor\'s menu (…).')),
  ];
}

registerSettingsPage({
  id: 'editor', title: 'Editor', icon: 'code', order: 55,
  desc: 'The code editor: text size, tab size and word wrap, in this browser.',
  summary: () => {
    const p = editorPrefs();
    return `${p.fontSize} px · tab ${p.tabSize}${p.wordWrap ? ' · wrap' : ''}`;
  },
  render: () => settingsBody(),
});

// Tests: the guard's reading of an address.
export const _codeTarget = codeTarget;
