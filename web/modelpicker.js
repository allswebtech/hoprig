// The one model picker of the page (the Tia page, Plan with AI, the new-session sheet, Work's Do it, Settings): the
// provider's own models from GET /api/models (src/models/catalog.mjs), asked when the picker is drawn. A saved model
// the list leaves out is shown as it is, marked, never replaced. When no list could be had: one line that says why,
// the family names, and a field for an exact model name, checked by the server (POST /api/models/check).
import { api, fill, h } from './lib.js';

export const NOT_LISTED = 'not in this provider\'s list';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/; // as src/server/endpoint.mjs

/** What an entry says of itself, in a few words: "1M window · pictures". */
const extras = (m) => [m.window1m ? '1M window' : null, m.images ? 'pictures' : null, m.efforts && m.efforts.length ? `efforts ${m.efforts.join(', ')}` : null].filter(Boolean).join(' · ');
/** One option's text: its label, its exact id where the label is another, and what it says of itself. */
export const optionText = (m) => [m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id, extras(m)].filter(Boolean).join(' · ');

/**
 * The options of a view for a select: [[value, text]], the empty choice first, the saved value marked at the end when
 * the list leaves it out. Pure, for the tests.
 */
export function pickerOptions(view, value, emptyLabel) {
  const models = (view && view.models) || [];
  const out = [['', emptyLabel], ...models.map((m) => [m.id, optionText(m)])];
  if (value && !models.some((m) => m.id === value)) out.push([value, marked(view, value) ? `${value} (${NOT_LISTED})` : listed(view) ? value : `${value} (typed)`]);
  return out;
}
/** Whether the server marked `value` as left out by the provider's list (only where its check would refuse it). */
const marked = (view, value) => Boolean(view) && Array.isArray(view.notListed) && view.notListed.includes(value);
/** Whether the view is a provider's real list (a name it leaves out was not typed into the fallback's field). */
const listed = (view) => Boolean(view) && ['endpoint', 'tool', 'subscription'].includes(view.source);

/**
 * o: { provider, tool ('claude'), value, onchange(v), emptyLabel, label ('Model'), hint, at (path → path: another
 * computer), key (data-key) } → a node whose `.value` is the choice.
 */
export function modelPicker(o) {
  const at = o.at || ((p) => p);
  let value = o.value || '';
  const set = (v) => {
    value = v || '';
    wrap.value = value;
    o.onchange(value || null);
  };
  const sel = h('select.field', { 'data-key': o.key || 'model', 'aria-label': o.label || 'Model', disabled: true, onchange: (e) => set(e.target.value) }, h('option', { value }, value || o.emptyLabel));
  const note = h('span.hint.model-note');
  const typed = h('div.model-typed.hidden');
  const hint = o.hint ? h('span.hint', o.hint) : null;
  const wrap = h('div.fieldrow.model-picker', h('span.field-label', o.label || 'Model'), sel, note, typed, hint);
  wrap.value = value;
  const draw = (view) => {
    fill(sel, pickerOptions(view, value, o.emptyLabel).map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
    sel.disabled = false;
    const n = view.models.length;
    const left = value && marked(view, value) && !view.models.some((m) => m.id === value);
    note.textContent = [
      view.why || (view.source === 'endpoint' || view.source === 'tool' ? `${n} model${n === 1 ? '' : 's'} this provider lists.` : view.source === 'subscription' ? `The models Claude Code offers a subscription (read for version ${view.read ? view.read.version : '?'}).` : view.note || ''),
      left ? `The saved model "${value}" is ${NOT_LISTED}; it stays chosen until you pick another.` : '',
    ].filter(Boolean).join(' ');
    typed.classList.toggle('hidden', !view.typed);
    if (view.typed) fill(typed, typedField(view));
  };
  let lastSaid = ''; // what the exact-name field said last: kept when the picker is drawn again
  // The fallback's field: an exact model name, its characters checked here, then by the server against the provider.
  const typedField = (view) => {
    const input = h('input.field.mono', { type: 'text', 'aria-label': 'Exact model name', placeholder: 'Exact model name, e.g. claude-sonnet-5-5', spellcheck: 'false', autocapitalize: 'off' });
    const said = h('span.hint.model-typed-said', { role: 'status' }, lastSaid);
    const use = h('button.btn.secondary', { type: 'button', onclick: async () => {
      const name = input.value.trim();
      if (!MODEL_RE.test(name)) return void (said.textContent = 'That is not a model name: letters, digits and . _ : / @ + - [ ], a letter or digit first.');
      use.disabled = true;
      try {
        const r = await api(at('/api/models/check'), { provider: o.provider, tool: o.tool || 'claude', model: name });
        if (!r.ok) return void (said.textContent = `Not used: ${r.why}.`);
        set(name);
        lastSaid = `Using "${name}".`;
        draw(view);
      } catch (e) {
        said.textContent = e.message;
      } finally {
        use.disabled = false;
      }
    } }, 'Use this name');
    return h('div.model-typed-row', input, use, said);
  };
  if (!o.provider) {
    draw({ models: [], source: 'unknown', why: 'Choose a provider first.', typed: false });
    return wrap;
  }
  note.textContent = 'Asking the provider for its models…';
  const q = `?provider=${encodeURIComponent(o.provider)}&tool=${encodeURIComponent(o.tool || 'claude')}${value ? `&saved=${encodeURIComponent(value)}` : ''}`;
  api(at(`/api/models${q}`)).then(draw, (e) => draw({ models: [], source: 'fallback', why: e.message, typed: false }));
  return wrap;
}
