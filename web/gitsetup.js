// Git and GitHub (GET /api/workspace/git): the name and e-mail on commits, the GitHub sign-in, the AI brain on a git
// server. Shown on a computer's Setup tab and as a step of Get started; its one action opens a terminal session
// running the guided step (`hoprig workspace git`), because signing in is the person's to do on GitHub's own page.
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, link, toast } from './lib.js';
import { panel } from './shell.js';

/** The three rows from the git route's answer `g`: [{ id, title, ok, text }]. */
export function gitRows(g) {
  const b = g.brain || {};
  const brainText = !b.exists ? 'No AI brain yet'
    : !b.git ? 'The AI brain is not in git yet'
      : !b.remote ? 'Not on a git server yet'
        : b.ahead || b.behind || b.changes
          ? [b.ahead ? `${b.ahead} to upload` : '', b.behind ? `${b.behind} to get` : '', b.changes ? `${b.changes} changed file${b.changes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
          : b.upstream ? 'On its git server, in step' : 'On a git server, not followed by its branch yet';
  return [
    { id: 'identity', title: 'The name and e-mail on your commits', ok: !!(g.identity && g.identity.set), text: g.identity && g.identity.set ? `${g.identity.name} · ${g.identity.email}` : !g.git ? 'git is not installed' : 'Not set yet' },
    { id: 'github', title: 'Signed in to GitHub', ok: !!(g.gh && g.gh.signedIn), text: g.gh && g.gh.signedIn ? `as ${g.gh.account}` : g.gh && !g.gh.installed ? 'GitHub\'s command (gh) is not installed' : 'Not signed in' },
    { id: 'brain', title: 'The AI brain is on a git server and in step', ok: !!(b.remote && b.upstream && !b.ahead && !b.behind && !b.changes), text: brainText },
  ];
}

/** Every row fine. */
export const gitDone = (g) => !!g && gitRows(g).every((r) => r.ok);

/** Say what happens, then open the terminal session of the guided step on the open computer. */
export async function openGitSetup() {
  const ok = await confirmSheet({
    title: 'Set up git and GitHub',
    text: 'It opens in a terminal session on this computer. You sign in on GitHub\'s own page; no password is typed into this dashboard, and only the account name is kept.',
    ok: 'Open it',
  });
  if (!ok) return;
  try {
    const { session } = await api('/api/workspace/git/terminal', {});
    location.hash = link(`#/s/${encodeURIComponent(session)}`);
  } catch (e) {
    toast(e.message, { kind: 'error', ms: 7000 });
  }
}

/** The panel for a computer's Setup tab: the three rows and the one action. */
export function gitPanel() {
  const body = h('div.rows', h('div.row.static', h('span.row-sub', 'Looking at git and GitHub…')));
  const action = h('div.savebar.start');
  api('/api/workspace/git').then((g) => {
    const rows = gitRows(g);
    fill(body, rows.map((r) => h(`div.row.static.git-row${r.ok ? '.ok' : ''}`,
      h(`span.row-icon.pj-mark${r.ok ? '.ok' : '.warn'}`, icon(r.ok ? 'check' : 'alert')),
      h('span.row-main', h('span.row-title', r.title), h('span.row-sub', r.text)))));
    fill(action, btn(gitDone(g) ? 'secondary' : 'primary', { icon: 'terminal', label: 'Set up git and GitHub', onclick: openGitSetup }));
  }, (e) => fill(body, h('div.row.static', h('span.row-sub', `Could not look: ${e.message}`))));
  return panel({ icon: 'git', title: 'Git and GitHub', desc: 'So your projects and the AI brain are kept on a git server and come back on any computer.' }, body, action);
}
