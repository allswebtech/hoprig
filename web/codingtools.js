// The Coding tools card of Settings → New sessions: which coding tools the dashboard offers (the ones this version
// has: src/codetools/index.mjs), one switch each, whether each is installed, and under "More" the providers that serve
// it and how to start a session with it. A session of another tool starts from New session (the coding tool chosen
// there: a chat, or a terminal) and from a terminal (`hoprig opencode <provider>`). The server side:
// src/codetools/feature.mjs (GET /api/codetools, POST /api/codetools/<id>); an install through Settings → Version and updates
// (POST /api/updates/run). The old page #/settings/new-sessions?show=coding-tools opens New sessions (settings.js).
import { icon } from './icons.js';
import { api, btn, fill, h, link, toast } from './lib.js';
import { moreFold } from './helpline.js';
import { panel, toggle } from './shell.js';

const SCOPE = 'Claude Code can do everything here. OpenCode: a session in the App or in a Terminal, the providers that fit it, the shared AI brain, updates, and Tia (she starts its sessions in the App when you name it, and every OK of one comes to you). Auto mode and plan usage work with Claude Code only.';

/** The one line in the Settings list. */
export const summaryOf = (v) => `On: ${v.tools.filter((t) => t.on).map((t) => t.name).join(', ')}`;

/** The providers of a coding tool as the owner named them (an older computer sends the short names only). */
export const labelsOf = (t) => (Array.isArray(t.providerLabels) && t.providerLabels.length === t.providers.length ? t.providerLabels : t.providers);

function toolBlock(t, redraw) {
  const missing = t.managed && !t.installed;
  const providers = t.providers.length
    ? h('p.hint', `Providers for it: ${labelsOf(t).join(', ')}.`)
    : null;
  const noProvider = t.providers.length ? null
    : h('p.banner.warn', icon('alert', { size: 18 }), h('span', `No provider serves ${t.name} yet. `,
      h('a', { href: link('#/providers') }, 'Providers'), t.id === 'codex' // only once Codex is offered again
        ? ': add an OpenAI key or a gateway (then Test it), or a Codex sign-in.'
        : ': add an OpenAI key, a Claude API key or a gateway, then Test it.'));
  let start = null;
  if (t.id === 'claude') start = h('p.hint', 'New session starts it, in the App or in a Terminal.');
  else if (!missing && t.on && t.providers.length) {
    // One way to start it: New session, with this coding tool chosen there (in the App or in a Terminal).
    start = [
      h('p.hint', `New session starts it: choose App or Terminal there, then ${t.name}.`),
      h('p.hint', 'Or in a terminal: ', h('code', t.command), '.'),
    ];
  }
  const more = [providers, start].flat().filter(Boolean);
  return h('div.ct-tool', { 'data-tool': t.id },
    toggle(`Offer ${t.name} in New session`, t.on, async (on) => {
      try {
        redraw(await api(`/api/codetools/${t.id}`, { on }));
        return true;
      } catch (e) {
        toast(e, { kind: 'error' });
        redraw(null);
        return false;
      }
    }, { line: 'Off hides it from New session; at least one stays on.', more: more.length ? h('div', more) : null }, { tool: t.id }),
    noProvider,
    missing
      ? h('div.savebar', h('span.hint', 'Not installed. Hoprig installs it into its own tools folder, at the version it is tested with.'),
        btn('primary', { icon: 'download', label: `Install ${t.name}`, onclick: async () => {
          try {
            await api('/api/updates/run', { id: t.id });
            location.hash = link('#/settings/updates'); // its output follows there
          } catch (e) {
            toast(e, { kind: 'error', ms: 7000 });
          }
        } }))
      : null);
}

/** The card: one switch per coding tool, drawn when the list arrives. */
export function codingToolsPanel() {
  const body = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…')));
  let view = null;
  const draw = (v) => {
    if (v) view = v;
    if (!view) return;
    // A keyboard user keeps their place when the switches are drawn again.
    const all = () => [...body.querySelectorAll('input, button, select, a[href]')];
    const at = all().indexOf(document.activeElement);
    fill(body, view.tools.map((t) => toolBlock(t, draw)));
    if (at >= 0) all()[at]?.focus();
  };
  (async () => {
    try {
      draw(await api('/api/codetools'));
    } catch (e) {
      fill(body, h('div.empty', icon('alert', { size: 32 }), h('p', e.message)));
    }
  })();
  return panel({ id: 'coding-tools', icon: 'code', title: 'Coding tools', desc: 'Which coding tools New session offers.' }, body, moreFold(SCOPE));
}
