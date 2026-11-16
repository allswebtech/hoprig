// Settings → New-session defaults: how every new session starts (config "sessionDefaults"; the launcher adds them
// first, so options a session is given itself still win), and under Advanced the folders sessions may start in and
// where attached files go. Saved with POST /api/settings, checked there.
import { api, fill, h } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { field, fold, panel, saveBar } from './shell.js';

export const MODES = {
  manual: 'Ask before every change',
  acceptEdits: 'Change files without asking; ask before commands',
  plan: 'Plan only: read and propose, change nothing',
  auto: 'Decide by itself what is safe; ask for the rest',
  dontAsk: 'Never ask: anything not already allowed is refused',
  bypassPermissions: 'Run anything without asking (riskiest)',
};
export const EFFORT = { low: 'Low: fastest, least thinking', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum: slowest, most thinking' };
export const MODELS = [['opus', 'Opus: the most capable'], ['sonnet', 'Sonnet: fast and capable'], ['haiku', 'Haiku: the fastest']];
const CLAUDE_DEFAULT = ['', 'Claude Code\'s own default'];
/**
 * The words that depend on which coding tools are on: with Claude Code alone, its own name; with another one too,
 * the neutral words and a line on what another tool's chat takes of these.
 */
export const toolWords = (others) => ({
  dflt: others ? ['', 'The coding tool\'s own default'] : CLAUDE_DEFAULT,
  desc: `For sessions started from now on. A session started with its own options keeps them.${others ? ' The model is for Claude Code; a chat of another coding tool takes the mode and the effort where it has them.' : ''}`,
});
const SHORT_MODE = { manual: 'Asks before changes', acceptEdits: 'Edits without asking', plan: 'Plan only', auto: 'Decides what is safe', dontAsk: 'Never asks', bypassPermissions: 'Runs anything' };

/** The one line in the Settings list. */
export function summary({ settings }) {
  const d = settings.sessionDefaults || {};
  const parts = [d.permissionMode ? SHORT_MODE[d.permissionMode] || d.permissionMode : null, d.effort ? `effort ${d.effort}` : null, d.model ? d.model : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Each coding tool\'s own defaults';
}

function defaultsPanel(settings, cur, others = false) {
  const { dflt: DEFAULT, desc } = toolWords(others);
  const choices = settings.sessionChoices || { permissionModes: Object.keys(MODES), efforts: Object.keys(EFFORT) };
  const warn = h('p.banner.muted', 'The coding tool can then run any command and change any file on this computer without asking. Use it only for folders you could lose.');
  const showWarn = () => warn.classList.toggle('hidden', cur.permissionMode !== 'bypassPermissions');
  const sel = (key, label, options, hint) =>
    field(label, h('select.field', { onchange: (e) => { cur[key] = e.target.value; showWarn(); } },
      options.map(([v, t]) => h('option', { value: v, selected: v === cur[key] }, t))), hint);
  const models = [...MODELS];
  if (cur.model && !models.some(([v]) => v === cur.model)) models.push([cur.model, cur.model]);
  showWarn();
  return panel({ title: 'How new sessions start', desc },
    sel('permissionMode', 'What it may do without asking', [DEFAULT, ...choices.permissionModes.map((m) => [m, MODES[m] || m])],
      'How often it stops to ask for your OK.'),
    warn,
    sel('effort', 'How hard it thinks', [DEFAULT, ...choices.efforts.map((e) => [e, EFFORT[e] || e])],
      'More thinking gives better answers to hard problems, but takes longer and uses more of your plan.'),
    sel('model', 'Model', [CLAUDE_DEFAULT, ...models], 'Which Claude model answers in Claude Code. A provider that names its own model keeps it.'),
    saveBar('Save', () => api('/api/settings', { sessionDefaults: { permissionMode: cur.permissionMode || null, effort: cur.effort || null, model: cur.model || null } }), 'Saved: new sessions start this way'));
}

function foldersPanel(roots) {
  const area = h('textarea.field.mono', { rows: Math.max(2, roots.length + 1), value: roots.join('\n'), spellcheck: 'false', autocapitalize: 'off' });
  return panel({ icon: 'folder', title: 'Folders', desc: 'Where new sessions can start. Everything inside these folders can be opened from this page.' },
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
    api('/api/codetools').then((v) => {
      if ((v.tools || []).some((t) => t.id !== 'claude' && t.on)) fill(slot, defaultsPanel(settings, cur, true));
    }, () => {});
    return [slot, fold('settings-new-sessions', 'Advanced', foldersPanel(settings.server.roots), uploadsPanel(settings.uploads))];
  },
});
