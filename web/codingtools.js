// Settings → Coding tools (#/settings/codingtools): which coding tools the dashboard offers (Claude Code, Codex,
// OpenCode), whether each is installed, the providers that serve it, and how to start a session with it. A session
// of Codex or OpenCode starts here (a folder and a provider) and in a terminal (`hoprig codex <provider>`).
// The server side: src/codetools/feature.mjs (GET /api/codetools, POST /api/codetools/<id>); a session starts
// through POST /api/sessions { tool }, an install through Settings → Updates (POST /api/updates/run).
import { icon } from './icons.js';
import { api, btn, fill, h, link, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { panel, toggle } from './shell.js';

const SCOPE = 'Claude Code can do everything here. Codex and OpenCode: sessions in a terminal, the providers that fit them, the shared AI brain and updates. Auto mode, plan usage and Tia work with Claude Code only.';

/** The one line in the Settings list. */
export const summaryOf = (v) => `On: ${v.tools.filter((t) => t.on).map((t) => t.name).join(', ')}`;

function startForm(t, folders) {
  const group = (label, list) => (list.length ? h('optgroup', { label }, list.map((f) => h('option', { value: f.path }, f.short))) : null);
  const dir = h('select.field', { 'aria-label': 'Folder' }, group('Recent', folders.recent), group('Your folders', folders.more));
  const prov = h('select.field', { 'aria-label': 'Provider' }, t.providers.map((p) => h('option', { value: p }, p)));
  const go = btn('primary', { icon: 'play', label: `Start ${t.name}`, onclick: async () => {
    go.disabled = true;
    go.classList.add('busy');
    try {
      const r = await api('/api/sessions', { tool: t.id, profile: prov.value, dir: dir.value, mode: 'new' });
      location.hash = link(`#/s/${encodeURIComponent(r.name)}`);
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 7000 });
      go.disabled = false;
      go.classList.remove('busy');
    }
  } });
  return h('div.ct-start',
    h('label.fieldrow', h('span.field-label', 'Folder'), dir),
    h('label.fieldrow', h('span.field-label', 'Provider'), prov),
    h('div.savebar', go));
}

function toolPanel(t, folders, redraw) {
  const missing = t.managed && !t.installed;
  const tag = missing ? 'Not installed' : t.on ? 'On' : 'Off';
  const providers = t.providers.length
    ? h('p.hint', `Providers for it: ${t.providers.join(', ')}.`)
    : h('p.banner.warn', icon('alert', { size: 18 }), h('span', `No provider serves ${t.name} yet. `,
      h('a', { href: link('#/providers') }, 'Providers'), t.id === 'codex'
        ? ': add an OpenAI key or a gateway (then Test it), or a Codex sign-in.'
        : ': add an OpenAI key, a Claude API key or a gateway, then Test it.'));
  let start = null;
  if (t.id === 'claude') start = h('p.hint', 'New session on Home starts it.');
  else if (!missing && t.on && t.providers.length) {
    start = [
      folders.recent.length || folders.more.length ? startForm(t, folders) : h('p.hint', 'No folder this dashboard may open was found: Settings → Security and sign-in says which folders it opens.'),
      h('p.hint', 'Or in a terminal: ', h('code', t.command), '.'),
    ];
  }
  return panel({ icon: 'code', title: t.name, desc: t.about, tag },
    toggle('Offer it in the dashboard', t.on, async (on) => {
      try {
        redraw(await api(`/api/codetools/${t.id}`, { on }));
        return true;
      } catch (e) {
        toast(e.message, { kind: 'error' });
        redraw(null);
        return false;
      }
    }, t.id === 'claude' ? 'At least one coding tool stays on.' : null),
    missing
      ? h('div.savebar', h('span.hint', 'Installed by Hoprig into its own tools folder, at the version it is tested with.'),
        btn('primary', { icon: 'download', label: 'Install', onclick: async () => {
          try {
            await api('/api/updates/run', { id: t.id });
            location.hash = link('#/settings/updates'); // its output follows there
          } catch (e) {
            toast(e.message, { kind: 'error', ms: 7000 });
          }
        } }))
      : providers,
    start);
}

function codingToolsPage() {
  const body = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…')));
  let folders = { recent: [], more: [] };
  let view = null;
  const draw = (v) => {
    if (v) view = v;
    if (!view) return;
    // A keyboard user keeps their place when the panels are drawn again.
    const all = () => [...body.querySelectorAll('input, button, select, a[href]')];
    const at = all().indexOf(document.activeElement);
    fill(body, view.tools.map((t) => toolPanel(t, folders, draw)));
    if (at >= 0) all()[at]?.focus();
  };
  (async () => {
    try {
      // The folders a session was started in, then the folders of the dashboard's first root folder (a fresh
      // computer has no recent folder yet).
      const [v, r, b] = await Promise.all([api('/api/codetools'), api('/api/folders/recent').catch(() => ({ folders: [] })), api('/api/folders/browse').catch(() => null)]);
      const recent = (r.folders || []).slice(0, 30);
      const seen = new Set(recent.map((f) => f.path));
      const more = b ? [{ path: b.path, short: b.short }, ...(b.dirs || []).map((d) => ({ path: d.path, short: `${b.short.replace(/\/$/, '')}/${d.name}` }))].filter((f) => !seen.has(f.path)).slice(0, 60) : [];
      folders = { recent, more };
      draw(v);
    } catch (e) {
      fill(body, h('div.empty', icon('alert', { size: 32 }), h('p', e.message)));
    }
  })();
  return [h('p.hint.ct-scope', SCOPE), body];
}

registerSettingsPage({
  id: 'codingtools', title: 'Coding tools', icon: 'code', order: 62,
  desc: 'Claude Code, Codex and OpenCode: which ones the dashboard offers, and how to start a session with each.',
  summary: async () => summaryOf(await api('/api/codetools')),
  render: codingToolsPage,
});
