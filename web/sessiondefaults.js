// Settings → New-session defaults: how every new session starts (config "sessionDefaults"; the launcher adds them
// first, so options a session is given itself still win), and under Advanced the folders sessions may start in and
// where attached files go. Saved with POST /api/settings, checked there.
import { api, confirmSheet, fill, h, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { field, fold, panel, saveBar } from './shell.js';
import { MODE } from './chat/words.js';
import { modelPicker } from './modelpicker.js';
import { leadSwitch } from './leadswitch.js';
import { store } from './store.js';
import { partOf } from './showpart.js';

// The modes in the App's words (its chip, then what it does), so this page names Bypass permissions as its switch does.
export const MODES = Object.fromEntries(['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].map((m) => [m, `${MODE[m].chip}: ${MODE[m].sub}`]));
// What that last mode means, said wherever it is chosen: the one rule of src/asking.mjs, the same for a terminal and
// for a chat (App).
export const BYPASS_MEANS = 'Claude Code runs commands and changes files without asking. Use it only for folders you could lose. It still asks you: a question, a plan, a tool your settings say "ask" for, and before some deletes. Where it stops before a delete, Hoprig allows it by itself only when the delete is plainly inside the folder the command runs in (never your home, workspace or projects folder).';
export const EFFORT = { low: 'Low: fastest, least thinking', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum: slowest, most thinking' };
const CLAUDE_DEFAULT = ['', 'Claude Code\'s own default'];
/**
 * The words that depend on which coding tools are on: with Claude Code alone, its own name; with another one too,
 * the neutral words and a line on what another tool's chat takes of these.
 */
export const toolWords = (others) => ({
  dflt: others ? ['', 'The coding tool\'s own default'] : CLAUDE_DEFAULT,
  desc: `For sessions started from now on. A session started with its own options keeps them.${others ? ' The model is for Claude Code; another coding tool in the App takes the mode and the effort where it has them.' : ''}`,
});
const SHORT_MODE = Object.fromEntries(Object.entries(MODE).map(([m, w]) => [m, w.chip]));

/** The one line in the Settings list. */
export function summary({ settings }) {
  const d = settings.sessionDefaults || {};
  const parts = [d.permissionMode ? SHORT_MODE[d.permissionMode] || d.permissionMode : null, d.effort ? `effort ${d.effort}` : null, d.model ? d.model : null, d.lead ? 'Lead model' : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Each coding tool\'s own defaults';
}

function defaultsPanel(settings, cur, others = false) {
  const { dflt: DEFAULT, desc } = toolWords(others);
  const choices = settings.sessionChoices || { permissionModes: Object.keys(MODES), efforts: Object.keys(EFFORT) };
  const warn = h('p.banner.muted', BYPASS_MEANS);
  const showWarn = () => warn.classList.toggle('hidden', cur.permissionMode !== 'bypassPermissions');
  const sel = (key, label, options, hint) =>
    field(label, h('select.field', { onchange: (e) => { cur[key] = e.target.value; showWarn(); } },
      options.map(([v, t]) => h('option', { value: v, selected: v === cur[key] }, t))), hint);
  // The models of the provider new sessions start on here (src/defaultprovider.mjs), asked when this is drawn; a name
  // saved earlier that its list leaves out stays, marked.
  const here = store.all.find((x) => !x.machine) || {};
  showWarn();
  // As root (settings.rootBypass): Bypass is not offered, and the line says why. A default that names it already is
  // shown as it is and kept (never changed silently); a start that would use it is refused with the same line.
  const kept = settings.rootBypass && cur.permissionMode === 'bypassPermissions' ? [['bypassPermissions', `${MODES.bypassPermissions} (kept from before; refused as root)`]] : [];
  return panel({ title: 'How new sessions start', desc },
    sel('permissionMode', 'What it may do without asking', [DEFAULT, ...choices.permissionModes.map((m) => [m, MODES[m] || m]), ...kept],
      'How often it stops to ask for your OK.'),
    settings.rootBypass ? h('p.banner.warn.root-bypass', settings.rootBypass) : null,
    warn,
    sel('effort', 'How hard it thinks', [DEFAULT, ...choices.efforts.map((e) => [e, EFFORT[e] || e])],
      'More thinking gives better answers to hard problems, but takes longer and uses more of your plan.'),
    modelPicker({ provider: here.recommended || null, tool: 'claude', value: cur.model, key: 'model', emptyLabel: CLAUDE_DEFAULT[1], at: (p) => `~${p}`,
      onchange: (v) => (cur.model = v || ''), hint: 'Which Claude model answers in Claude Code. A provider that names its own model keeps it.' }),
    // For new App sessions and plans; a session's own choice wins.
    leadSwitch({ value: cur.lead === true, partMode: cur.permissionMode || null, modes: choices.permissionModes, provider: here.recommended || null, at: (p) => `~${p}`, onchange: (on) => (cur.lead = on), others: cur.others || [], onothers: (l) => (cur.others = l) }),
    saveBar('Save', () => api('/api/settings', { sessionDefaults: { permissionMode: cur.permissionMode || null, effort: cur.effort || null, model: cur.model || null, lead: cur.lead === true, others: cur.lead === true ? cur.others || [] : [] } }), 'Saved: new sessions start this way'));
}

/**
 * "Allow bypass permissions mode", as the Claude Code desktop app's Settings has it: off, Bypass permissions is
 * offered nowhere and refused (src/bypassgate.mjs); turning it on asks first. `changed()`: draw the page again (the
 * mode lists change with it).
 */
export function bypassPanel(state, changed) {
  const box = h('input', { type: 'checkbox', checked: !!state.allow, 'data-key': 'allowBypass', onchange: async (e) => {
    const on = e.target.checked;
    e.target.checked = !on; // stays as it was until the answer
    if (on && !(await confirmSheet({ title: 'Allow bypass permissions mode?', text: `${BYPASS_MEANS} With this on, Bypass permissions is offered in the App's mode menu, a new session's options and these defaults.`, ok: 'Allow bypass permissions', danger: true }))) return;
    try {
      const r = await api('/api/settings/bypass', on ? { allow: true, confirm: true } : { allow: false });
      state.allow = r.allow;
      state.terminals = r.terminals || 0;
      e.target.checked = r.allow;
      toast(on ? 'Bypass permissions mode is allowed' : `Bypass permissions mode is off${r.changed ? `: ${r.changed === 1 ? '1 App session goes' : `${r.changed} App sessions go`} on in Manual` : ''}${r.defaults ? '; new sessions start with Claude Code\'s own mode' : ''}`);
      changed();
    } catch (err) {
      toast(err, { kind: 'error' });
    }
  } });
  return panel({ id: 'bypass', icon: 'alert', title: 'Bypass permissions', desc: 'While this is off, Bypass permissions is offered nowhere in this dashboard.' },
    h('label.toggle-line', box, h('span', 'Allow bypass permissions mode ', h('span.muted', '(it never asks you)'))),
    // A terminal started in bypass keeps its process until it ends; its next start (a move, a restore) is without it.
    !state.allow && state.terminals ? h('p.hint.bypass-terminals', `${state.terminals === 1 ? '1 terminal session still runs' : `${state.terminals} terminal sessions still run`} in bypass: it stays so until you end ${state.terminals === 1 ? 'it' : 'them'}; started again, ${state.terminals === 1 ? 'it starts' : 'they start'} without bypass.`) : null,
    h('p.hint', 'Lets you choose Bypass permissions, where Claude Code runs commands and changes files without asking. Use it only for folders you could lose. (The Claude Code desktop app has this switch under Settings > Code.)'));
}

/**
 * "Name sessions with a short title": after a session's first turn the App asks Claude Code for a title of the
 * conversation, as Claude Code in a terminal makes one by itself (src/chat/chat.mjs askTitle). On by default.
 */
export function titlesPanel(settings) {
  const box = h('input', { type: 'checkbox', checked: settings.sessionTitles !== false, 'data-key': 'sessionTitles', onchange: async (e) => {
    const on = e.target.checked;
    try {
      const r = await api('/api/settings', { sessionTitles: on });
      e.target.checked = r.sessionTitles !== false;
      toast(on ? 'New sessions get a short title' : 'New sessions keep their first words as their name');
    } catch (err) {
      e.target.checked = !on;
      toast(err, { kind: 'error' });
    }
  } });
  return panel({ icon: 'text', title: 'Session names', desc: 'How a new App session gets its name.' },
    h('label.toggle-line', box, h('span', 'Name sessions with a short title')),
    h('p.hint', 'After its first reply, a session asks its own provider for a short title, as Claude Code does in a terminal: one small request. Off, a session keeps its first words as its name until you rename it.'));
}

/** The query of an address such as "#/settings/new-sessions?show=folders". */
export const queryOf = (hash) => new URLSearchParams(String(hash || '').split('?')[1] || '');

function foldersPanel(roots) {
  const area = h('textarea.field.mono', { rows: Math.max(2, roots.length + 1), value: roots.join('\n'), spellcheck: 'false', autocapitalize: 'off' });
  return panel({ id: 'folders', icon: 'folder', title: 'Folders', desc: 'Where new sessions can start. Everything inside these folders can be opened from this page.' },
    field('Folders (one full path per line)', area, 'Fewer folders means less of the computer is reachable from here.'),
    saveBar('Save', () => api('/api/settings', { server: { roots: area.value.split('\n').map((x) => x.trim()).filter(Boolean) } })));
}

function uploadsPanel(u) {
  const st = { dir: u.dir, maxMB: u.maxMB };
  return panel({ icon: 'paperclip', title: 'Files you attach', desc: 'Files sent from this page (a screenshot, say) are saved inside the session\'s folder.' },
    field('Folder name', h('input.field.mono', { value: st.dir, oninput: (e) => (st.dir = e.target.value.trim()) }), 'Created inside the session folder and kept out of git.'),
    field('Largest file (MB)', h('input.field', { type: 'number', min: 1, max: 1024, value: String(st.maxMB), oninput: (e) => (st.maxMB = Number(e.target.value)) }), 'Larger files are refused.'),
    saveBar('Save', () => api('/api/settings', { server: { uploadsDir: st.dir, uploadMaxMB: st.maxMB } })));
}

registerSettingsPage({
  id: 'new-sessions', title: 'New-session defaults', icon: 'sparkle', order: 10,
  desc: 'How every new session starts, and where sessions may start.',
  summary,
  render: ({ settings }) => {
    // Drawn for Claude Code alone, then again in neutral words once another coding tool is known to be on (the
    // choices made meanwhile are kept in `cur`).
    const cur = { permissionMode: '', effort: '', model: '', ...(settings.sessionDefaults || {}) };
    const slot = h('div', defaultsPanel(settings, cur));
    let others = false;
    api('/api/codetools').then((v) => {
      others = (v.tools || []).some((t) => t.id !== 'claude' && t.on);
      if (others) fill(slot, defaultsPanel(settings, cur, true));
    }, () => {});
    // The switch changes the modes offered: the defaults are drawn again with the dashboard's new lists.
    const bypass = h('div');
    const again = async () => {
      const s = await api('/api/settings').catch(() => null);
      if (!s) return;
      if ((s.sessionDefaults || {}).permissionMode !== 'bypassPermissions' && cur.permissionMode === 'bypassPermissions') cur.permissionMode = '';
      fill(slot, defaultsPanel(s, cur, others));
    };
    api('/api/settings/bypass').then((b) => fill(bypass, bypassPanel(b, again)), () => {}); // an older computer: no switch
    const adv = fold('settings-new-sessions', 'Advanced', foldersPanel(settings.server.roots), uploadsPanel(settings.uploads));
    // "?show=folders": the list is under Advanced, so it is opened for him (settings.js then brings the panel into view).
    if (partOf(queryOf(typeof location === 'undefined' ? '' : location.hash)) === 'folders') adv.open = true;
    return [slot, bypass, titlesPanel(settings), adv];
  },
});
