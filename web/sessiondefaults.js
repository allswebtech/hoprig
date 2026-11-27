// Settings → New sessions: how every new session starts (config "sessionDefaults"; the launcher adds them first, so
// options a session is given itself still win), which coding tools New session offers (codingtools.js) and the
// Bypass permissions switch. A choice is kept when it is made ("Saved"), with POST /api/settings, checked there. The
// folders sessions may start in are under Settings → Security and sign-in; a session's title and the folder and size
// of attached files are the product's own values (an old setting file that names them is still read).
import { api, confirmSheet, fill, h, link, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { fold, panel, savedMark } from './shell.js';
import { codingToolsPanel } from './codingtools.js';
import { MODE } from './chat/words.js';
import { ALL_DEFAULT_NOTE, ALL_MEANS, askOnce } from './allowall.js';
import { helpParts } from './helpline.js';
import { modelPicker } from './modelpicker.js';
import { leadSwitch } from './leadswitch.js';
import { store } from './store.js';

// The modes in the App's words (its chip, then what it does), so this page names Bypass permissions as its switch does.
export const MODES = Object.fromEntries(['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'allowEverything'].map((m) => [m, `${MODE[m].chip}: ${MODE[m].sub}`]));
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
  desc: `For new sessions. A session started with its own options keeps them.${others ? ' The model is for Claude Code only.' : ''}`,
});
const SHORT_MODE = Object.fromEntries(Object.entries(MODE).map(([m, w]) => [m, w.chip]));

/** The one line in the Settings list. */
export function summary({ settings }) {
  const d = settings.sessionDefaults || {};
  const parts = [d.permissionMode ? SHORT_MODE[d.permissionMode] || d.permissionMode : null, d.effort ? `effort ${d.effort}` : null, d.model ? `model ${d.model}` : null, d.lead ? 'split across models' : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Each coding tool\'s own defaults';
}

function defaultsPanel(settings, cur, others = false) {
  const { dflt: DEFAULT, desc } = toolWords(others);
  const choices = settings.sessionChoices || { permissionModes: Object.keys(MODES), efforts: Object.keys(EFFORT) };
  const warn = h('p.banner.muted', BYPASS_MEANS);
  const showWarn = () => warn.classList.toggle('hidden', cur.permissionMode !== 'bypassPermissions');
  const allWarn = h('p.banner.muted', ALL_MEANS, ' ', ALL_DEFAULT_NOTE);
  const showAll = () => allWarn.classList.toggle('hidden', cur.permissionMode !== 'allowEverything');
  const ack = {}; // the acknowledgement, asked once (web/allowall.js)
  // A choice is kept at once: one "Saved" line under the card.
  const mark = savedMark();
  const keep = async () => {
    try {
      await api('/api/settings', { sessionDefaults: { permissionMode: cur.permissionMode || null, effort: cur.effort || null, model: cur.model || null, lead: cur.lead === true, others: cur.lead === true ? cur.others || [] : [] } });
      mark.show('Saved: new sessions start this way');
    } catch (e) {
      toast(e, { kind: 'error' });
    }
  };
  const sel = (key, label, options, hint) =>
    h('label.fieldrow', h('span.field-label', label), h('select.field', { 'data-key': key, onchange: async (e) => {
        // Allow everything: the first time on this computer he is asked once; a no puts the choice back.
        if (key === 'permissionMode' && e.target.value === 'allowEverything' && !(await askOnce(ack))) {
          e.target.value = cur[key] || '';
          return;
        }
        cur[key] = e.target.value; showWarn(); showAll(); keep();
      } },
      options.map(([v, t]) => h('option', { value: v, selected: v === cur[key] }, t))), hint ? h('span.hint', hint) : null);
  // The models of the provider new sessions start on here (src/defaultprovider.mjs), asked when this is drawn; a name
  // saved earlier that its list leaves out stays, marked.
  const here = store.all.find((x) => !x.machine) || {};
  showWarn();
  showAll();
  // As root (settings.rootBypass): Bypass is not offered, and the line says why. A default that names it already is
  // shown as it is and kept (never changed silently); a start that would use it is refused with the same line.
  const kept = settings.rootBypass && cur.permissionMode === 'bypassPermissions' ? [['bypassPermissions', `${MODES.bypassPermissions} (kept from before; refused as root)`]] : [];
  return panel({ title: 'How new sessions start', desc },
    sel('permissionMode', 'What it may do without asking', [DEFAULT, ...choices.permissionModes.map((m) => [m, MODES[m] || m]), ...kept],
      'How often it stops to ask for your OK.'),
    settings.rootBypass ? h('p.banner.warn.root-bypass', settings.rootBypass) : null,
    warn,
    allWarn,
    sel('effort', 'How hard it thinks', [DEFAULT, ...choices.efforts.map((e) => [e, EFFORT[e] || e])],
      'More thinking: better on hard problems, slower, uses more of your plan.'),
    modelPicker({ provider: here.recommended || null, tool: 'claude', value: cur.model, key: 'model', emptyLabel: CLAUDE_DEFAULT[1], quiet: true, at: (p) => `~${p}`,
      onchange: (v) => { cur.model = v || ''; keep(); }, hint: 'Which Claude model answers in Claude Code. A provider that names its own model keeps it.' }),
    // For new App sessions and plans; a session's own choice wins.
    fold('settings-new-sessions-more', 'More',
      leadSwitch({ value: cur.lead === true, partMode: cur.permissionMode || null, modes: choices.permissionModes, provider: here.recommended || null, at: (p) => `~${p}`,
        onchange: (on) => { cur.lead = on; keep(); }, others: cur.others || [], onothers: (l, changed) => { cur.others = l; if (changed) keep(); } })),
    h('p.hint.saved-line', mark));
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
    // The warning stands in the one line; the rest is under "More" (helpline.js).
    ...helpParts({ line: 'Claude Code then runs commands and changes files without asking: use it only for folders you could lose.',
      more: 'It lets you choose Bypass permissions as a session\'s mode. The Claude Code desktop app has this switch under Settings > Code.' }, { tag: 'p.hint' }));
}

registerSettingsPage({
  id: 'new-sessions', title: 'New sessions', icon: 'sparkle', order: 10,
  desc: 'How every new session starts, and which coding tools are offered.',
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
    return [slot, codingToolsPanel(), bypass,
      h('p.hint', 'Where sessions may start: ', h('a', { href: link('#/settings/security?show=folders') }, 'Security and sign-in → Folders Hoprig may open'), '.')];
  },
});
