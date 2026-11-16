// Settings → Coding tools (#/settings/codingtools): which coding tools the dashboard offers (the ones this version
// has: src/codetools/index.mjs), whether each is installed, the providers that serve it, and how to start a session
// with it. A session of another tool starts from New session (the coding tool chosen there: a chat, or a terminal)
// and from a terminal (`hoprig opencode <provider>`). The server side: src/codetools/feature.mjs (GET /api/codetools,
// POST /api/codetools/<id>); an install through Settings → Updates (POST /api/updates/run).
import { icon } from './icons.js';
import { api, btn, fill, h, link, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { panel, toggle } from './shell.js';

const SCOPE = 'Claude Code can do everything here. OpenCode: a chat or a session in a terminal, the providers that fit it, the shared AI brain and updates. Auto mode, plan usage and Tia work with Claude Code only.';

/** The one line in the Settings list. */
export const summaryOf = (v) => `On: ${v.tools.filter((t) => t.on).map((t) => t.name).join(', ')}`;

/** The providers of a coding tool as the owner named them (an older computer sends the short names only). */
export const labelsOf = (t) => (Array.isArray(t.providerLabels) && t.providerLabels.length === t.providers.length ? t.providerLabels : t.providers);

function toolPanel(t, redraw) {
  const missing = t.managed && !t.installed;
  const tag = missing ? 'Not installed' : t.on ? 'On' : 'Off';
  const providers = t.providers.length
    ? h('p.hint', `Providers for it: ${labelsOf(t).join(', ')}.`)
    : h('p.banner.warn', icon('alert', { size: 18 }), h('span', `No provider serves ${t.name} yet. `,
      h('a', { href: link('#/providers') }, 'Providers'), t.id === 'codex' // only once Codex is offered again
        ? ': add an OpenAI key or a gateway (then Test it), or a Codex sign-in.'
        : ': add an OpenAI key, a Claude API key or a gateway, then Test it.'));
  let start = null;
  if (t.id === 'claude') start = h('p.hint', 'New session on Home starts it.');
  else if (!missing && t.on && t.providers.length) {
    // One way to start it: New session, with this coding tool chosen there (a chat, or "Open in" a terminal).
    start = [
      h('p.hint', `New session on Home starts it: choose ${t.name} there as the coding tool, for a chat or a terminal.`),
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
  let view = null;
  const draw = (v) => {
    if (v) view = v;
    if (!view) return;
    // A keyboard user keeps their place when the panels are drawn again.
    const all = () => [...body.querySelectorAll('input, button, select, a[href]')];
    const at = all().indexOf(document.activeElement);
    fill(body, view.tools.map((t) => toolPanel(t, draw)));
    if (at >= 0) all()[at]?.focus();
  };
  (async () => {
    try {
      draw(await api('/api/codetools'));
    } catch (e) {
      fill(body, h('div.empty', icon('alert', { size: 32 }), h('p', e.message)));
    }
  })();
  return [h('p.hint.ct-scope', SCOPE), body];
}

registerSettingsPage({
  id: 'codingtools', title: 'Coding tools', icon: 'code', order: 62,
  desc: 'Claude Code and OpenCode: which ones the dashboard offers, and how to start a session with each.',
  summary: async () => summaryOf(await api('/api/codetools')),
  render: codingToolsPage,
});
