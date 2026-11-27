// Settings → Runs as root: shown only where Hoprig runs as root (GET /api/settings `root`). It says in plain words why
// root is a problem for the daily work, and offers the two ways: move Hoprig to an ordinary user (a command on that
// computer), or keep it on root on purpose by typing the sentence (kept as `stayRoot`; the doctor and Setup then show the
// root line as information only). Inside a container root is on purpose already, and no sentence is asked. On purpose,
// the page says once what does not work as root (`limits`) and asks nothing.
import { COMMAND } from './brand.js';
import { icon } from './icons.js';
import { api, fill, h } from './lib.js';
import { cmdLine } from './joinlink.js';
import { registerSettingsPage } from './registry.js';
import { field, panel, saveBar } from './shell.js';
import { moveBox } from './moveuser.js';

const WHY = 'Claude Code refuses bypass permissions mode for root, so every session here asks about each command. The daily work belongs in an ordinary user\'s account, not in the one account that can change everything on this computer.';

/** The page's parts for the view `r` (settings.root); `redraw(view)` draws them again after a change. */
function parts(r, redraw) {
  const limits = h('p.hint.root-limits', `What does not work as root: ${r.limits}.`);
  if (r.container.length) {
    return [panel({ icon: 'info', title: 'Root on purpose', desc: `Inside a container (${r.container.join(', ')}), so Hoprig stays on root and nothing asks you about it.` }, limits)];
  }
  if (r.stay) {
    return [panel({ icon: 'info', title: 'Kept on root by your choice', desc: 'The doctor and Setup show this as information only, and nothing asks you about it again.' },
      limits,
      saveBar('Take the choice back', async () => redraw((await api('/api/settings', { stayRoot: false })).root), 'Taken back'))];
  }
  const typed = h('input.field', { type: 'text', autocomplete: 'off', spellcheck: false });
  return [
    h('p.banner.warn', icon('alert', { size: 18 }), h('span', `Hoprig runs as root on this computer. ${WHY}`)),
    panel({ icon: 'user', title: 'Move Hoprig to an ordinary user', desc: 'The way we recommend. It shows what runs, what is copied and each step, and asks once before it changes anything. Here, or in a terminal on this computer:' },
      cmdLine(`${COMMAND} move-to-user`),
      moveBox()),
    panel({ icon: 'lock', title: 'Keep Hoprig on root on purpose', desc: 'Only when you know why this computer must work as root. Bypass permissions mode stays unavailable, and the doctor and Setup then show root as information only.' },
      field(`Type "${r.sentence}"`, typed, 'It is kept in this computer\'s settings, and you can take it back here.'),
      saveBar('Keep it on root', async () => redraw((await api('/api/settings', { stayRoot: { sentence: typed.value } })).root), 'Kept on root')),
  ];
}

function render(ctx) {
  const box = h('div.root-page');
  const redraw = (view) => {
    if (view) ctx.settings = { ...ctx.settings, root: view };
    fill(box, ...parts(ctx.settings.root, redraw));
  };
  redraw();
  return [box];
}

registerSettingsPage({
  id: 'root', title: 'Runs as root', icon: 'alert', order: 12,
  when: (ctx) => !!(ctx && ctx.settings && ctx.settings.root),
  desc: 'Hoprig works as root on this computer. Here is what that means and what to do.',
  summary: ({ settings: s }) => (s.root && s.root.onPurpose ? (s.root.container.length ? 'On purpose: inside a container' : 'Kept on root by your choice') : 'Move it to an ordinary user'),
  render,
});
