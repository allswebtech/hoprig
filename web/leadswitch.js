// "Lead model": one switch with one line of help, wherever a Claude Code session is set up (Settings → New-session
// defaults, the new-session sheet, Plan with AI, Settings → Tia). On, it shows more lines from the server
// (GET /api/models/lead): which models it uses on the chosen provider, or why it cannot lead there. Under it, while Lead
// is on, "Use other providers": on, the lead may hand a part to a provider ticked in the list right under it
// (GET /api/models/others: its coding tools, billed by use or not, its limit as last known).
import { api, fill, h, link } from './lib.js';
import { MODE } from './chat/words.js';
import { helpParts } from './helpline.js';

export const LEAD_LABEL = 'Lead model';
export const OTHERS_LABEL = 'Use other providers';
export const OTHERS_HELP = 'The lead may also hand a part to a provider you tick below.';
export const OTHERS_NONE = 'Tick at least one provider: with none ticked, this stays off.';
// What Lead costs, as measured on a small task of three parts: 3.3 times the tokens of the same task without it, and
// 5.7 times with one part handed to another provider. The cost stands in the one line under the switch (never folded
// away); how it works is under "More".
export const LEAD_COST = 'on a small task it costs more, three to six times in our tests.';
export const LEAD_HELP = `Your model hands parts to other models; ${LEAD_COST}`;
export const LEAD_MORE = 'The model you chose plans the work and hands easy parts to a faster model, code to a strong one. It pays on work with parts that can be done apart.';
// A terminal session of Claude Code: Hoprig sees a part's model and tokens in Claude Code's records, but not what it
// cost (only the App reads Claude Code's cost), and a part on another provider is an App session of the lead's App
// session. So it shows Lead off there, with this line, rather than half of it.
export const LEAD_TERMINAL = 'Only an App session can do this: in a terminal, Hoprig cannot see what each part costs or count it in your daily limit.';
/**
 * The mode a part runs in, in words: the session's own mode, never bypass unless it is allowed on that computer
 * (`modes`: the modes it offers now; null: not known here). → one line.
 */
export function partModeLine(mode, modes = null) {
  const m = mode === 'bypassPermissions' && Array.isArray(modes) && !modes.includes(mode) ? 'manual' : mode;
  if (!m || !MODE[m]) return 'Parts run in this session\'s mode, and never in bypass permissions unless you allow it in Settings.';
  return `Parts run in this session's mode: now ${MODE[m].chip.toLowerCase()}.`;
}
// The switch that allows bypass permissions (home.js BYPASS_SWITCH; not imported, home.js loads the whole Home page).
const BYPASS_AT = '#/settings/new-sessions?show=bypass';
/** partModeLine for the page: "allow it in Settings" opens that switch. → a string or nodes. */
export function partModeHint(mode, modes = null) {
  const line = partModeLine(mode, modes);
  const tail = 'unless you allow it in Settings.';
  return line.endsWith(tail) ? [line.slice(0, -tail.length), 'unless you ', h('a', { href: link(BYPASS_AT) }, 'allow it in Settings'), '.'] : line;
}
const TOOL_WORD = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' };

/**
 * The product's switch (as shell.js toggle draws it: role=switch), saved by the caller's Save, not at once. Enter turns
 * it as Space does: a switch is pressed, not only ticked.
 */
function switchRow(label, hint, o) {
  const input = h('input.switch', { type: 'checkbox', role: 'switch', checked: !!o.checked, disabled: !!o.disabled, 'data-key': o.key, onchange: (e) => o.onchange(e.target.checked),
    onkeydown: (e) => {
      if (e.key !== 'Enter' || input.disabled) return;
      e.preventDefault();
      input.checked = !input.checked;
      o.onchange(input.checked);
    } });
  return { input, el: h('label.switchrow', h('span.switchrow-text', h('span.switchrow-label', label), ...helpParts(hint, { input, label })), input) };
}

/**
 * o: { value (true/false), onchange(on), provider (null: none chosen yet), tool ('claude'), at (path → path), key,
 * others (the ticked names; null: not offered here), onothers(list), only (the names that may be ticked; null: every
 * other provider), billed(p) (whether a provider is billed by use here; default: its `paid`), noProvider (the line
 * without a provider), partMode (the mode the session runs in; null: its own, not known here), modes (the modes offered
 * now) } → a node.
 */
export function leadSwitch(o) {
  const tool = o.tool || 'claude';
  const at = o.at || ((p) => p);
  const key = o.key || 'lead';
  const billed = o.billed || ((p) => p.paid === true);
  const line = h('span.hint.lead-line', { role: 'status', style: { whiteSpace: 'pre-line' } }); // one short line per tier
  const othersSlot = h('div.lead-others');
  const lead = switchRow(LEAD_LABEL, { line: LEAD_HELP, more: LEAD_MORE }, { checked: o.value && !o.off, disabled: tool !== 'claude' || !!o.off, key, onchange: (on) => {
    o.onchange(on);
    say();
    drawOthers(on);
  } });
  function say() {
    line.textContent = '';
    if (tool !== 'claude') return void (line.textContent = 'Only Claude Code can do this.');
    if (o.off) return void (line.textContent = o.off); // shown off here, with the one line why (`off`)
    if (!lead.input.checked) return;
    if (!o.provider) return void (line.textContent = o.noProvider || 'Which models it uses depends on the provider.');
    api(at(`/api/models/lead?provider=${encodeURIComponent(o.provider)}&tool=${encodeURIComponent(tool)}`))
      .then((r) => (line.textContent = r.line), () => (line.textContent = ''));
  }
  // The ticks that can stand: never the session's own provider (it is not another one), only names that may be ticked.
  // A tick that cannot stand is dropped here and the caller is told, so what is sent is what is shown.
  const given = Array.isArray(o.others) ? o.others : [];
  let ticks = given.filter((n) => n !== o.provider && (!o.only || o.only.includes(n)));
  if (o.onothers && ticks.length !== given.length) o.onothers(ticks);
  let useOthers = ticks.length > 0;
  function drawOthers(on) {
    if (!o.onothers || !on || tool !== 'claude' || o.off) return void fill(othersSlot);
    const list = h('div.checks.lead-ticks', h('span.hint', 'Asking for your providers…'));
    const none = h('span.hint.lead-none', { role: 'status' });
    const sayNone = () => (none.textContent = useOthers && !ticks.length ? OTHERS_NONE : '');
    // The mode parts run in changes with the session's mode: a line of its own under the switch, never folded away.
    const mode = h('span.hint.lead-mode', partModeHint(o.partMode || null, o.modes || null));
    const sw = switchRow(OTHERS_LABEL, OTHERS_HELP, { checked: useOthers, key: `${key}-others`, onchange: (v) => {
      useOthers = v;
      o.onothers(useOthers ? ticks : [], true);
      list.classList.toggle('hidden', !useOthers);
      sayNone();
    } });
    // The ticks are all this switch does: shown right under it while it is on, never folded away.
    list.classList.toggle('hidden', !useOthers);
    sayNone();
    fill(othersSlot, sw.el, mode, list, none);
    const q = o.provider ? `?provider=${encodeURIComponent(o.provider)}` : '';
    api(at(`/api/models/others${q}`)).then((r) => {
      // A tick on a name that is no longer another provider for Claude Code (removed under Providers, or a tick from
      // another computer) has no box to untick: dropped, and the caller told, so what is sent is what is shown.
      const names = r.providers.map((p) => p.name);
      if (ticks.some((n) => !names.includes(n))) {
        ticks = ticks.filter((n) => names.includes(n));
        o.onothers(useOthers ? ticks : []);
        sayNone();
      }
      const shown = r.providers.filter((p) => !o.only || o.only.includes(p.name));
      if (!shown.length) return void fill(list, h('span.hint', o.only ? 'None of the providers she may use is another one for Claude Code.' : 'You have no other provider for Claude Code.'));
      fill(list, shown.map((p) => h('label.check',
        h('input', { type: 'checkbox', checked: ticks.includes(p.name), 'data-key': `tick-${p.name}`, onchange: (e) => {
          ticks = e.target.checked ? [...new Set([...ticks, p.name])] : ticks.filter((n) => n !== p.name);
          o.onothers(ticks, true);
          sayNone();
        } }),
        h('span', p.label, h('span.hint', ` · ${p.tools.map((t) => TOOL_WORD[t] || t).join(', ')}${billed(p) ? ' · billed by use' : ''}${p.limited ? ' · at its limit' : ''}`)))));
    }, () => fill(list, h('span.hint', 'Your providers could not be listed.')));
  }
  say();
  drawOthers(!!o.value);
  return h('div.fieldrow.lead-switch', lead.el, line, othersSlot);
}
