// Git and GitHub (GET /api/workspace/git): the name and e-mail on commits, the GitHub sign-in, the AI brain on a git
// server. Shown on a computer's Setup tab and as a step of Get started. Everything is done in the page
// (src/workspace/feature.mjs): the name and e-mail are a small form; the sign-in is gh's device flow, so the page
// shows a one-time code and the owner confirms it on GitHub's own page (no password is typed into this dashboard,
// and only the account name is kept); the brain goes into a new private repository as a job.
import { icon } from './icons.js';
import { add, api, btn, copyText, fill, h, openSheet, toast } from './lib.js';
import { errorBox, okBox, panel } from './shell.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The name and e-mail on commits: a small form. Resolves true when saved. */
export function identitySheet(g) {
  return openSheet({ title: 'The name and e-mail on your commits', subtitle: 'git puts them on every commit you make.' }, (close) => {
    const name = h('input.field', { value: (g.identity && g.identity.name) || '', autofocus: true, autocomplete: 'name', 'aria-label': 'Name' });
    const email = h('input.field', { type: 'email', value: (g.identity && g.identity.email) || '', autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'E-mail' });
    const err = h('p.form-error', { role: 'alert' });
    return h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/workspace/git/identity', { name: name.value, email: email.value });
          toast('Saved');
          close(true);
        } catch (x) {
          err.textContent = x.message;
        }
      },
    },
    h('label.fieldrow', h('span.field-label', 'Name'), name),
    h('label.fieldrow', h('span.field-label', 'E-mail'), email,
      h('span.hint', 'GitHub shows it on your commits. GitHub\'s no-reply address (in GitHub\'s e-mail settings) keeps yours private.')),
    err,
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'),
      h('button.btn.primary', { type: 'submit' }, 'Save')));
  }).then((v) => v === true);
}

/**
 * The GitHub sign-in: a one-time code from gh (POST /api/workspace/git/signin), confirmed by the owner on
 * github.com/login/device in this browser; gh finishes by itself. Resolves true when signed in.
 */
export function signinSheet() {
  let alive = true;
  return openSheet({ title: 'Sign in to GitHub', subtitle: 'On GitHub\'s own page: no password is typed into this dashboard.' }, (close) => {
    const body = h('div', h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Asking GitHub for a code…')));
    const wait = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));
    const showCode = (s) => {
      // A link the owner clicks (not window.open), so no browser takes it for a pop-up.
      const open = h('a.btn.primary', { href: s.url, target: '_blank', rel: 'noopener' }, icon('external', { size: 18 }), h('span', 'Open GitHub'));
      fill(body,
        h('p.sheet-text', 'Copy this code, open GitHub and type it there. Then come back: this page notices by itself.'),
        h('div.sj-code', h('code', { 'aria-label': 'One-time code' }, s.code),
          btn('icon ghost', { icon: 'copy', title: 'Copy the code', onclick: async () => toast((await copyText(s.code)) ? 'Copied' : 'Select the code and copy it', { kind: 'info' }) })),
        h('div.savebar.start', open, h('span.hint', s.url)),
        h('div.sj-state', wait('Waiting until you confirm it on GitHub…')));
    };
    (async () => {
      let s;
      try {
        s = await api('/api/workspace/git/signin', {});
      } catch (e) {
        return fill(body, errorBox(e.message));
      }
      if (s.state === 'code') {
        showCode(s);
        // Copy it for the owner when the browser lets us (the click that opened this sheet allows it).
        copyText(s.code).catch(() => {});
      }
      for (;;) {
        if (!alive) return;
        if (s.state === 'done') {
          fill(body, okBox(`Signed in to GitHub as ${s.account}.`, s.error ? ` ${s.error}` : ' git uses this sign-in too.'),
            h('div.sheet-actions', btn('primary', { label: 'Done', onclick: () => close(true) })));
          return;
        }
        if (s.state !== 'code' && s.state !== 'starting') {
          const why = s.state === 'expired' ? 'The code ran out before it was confirmed. Start again for a new one.' : s.state === 'cancelled' ? 'Stopped.' : `The sign-in did not finish: ${s.error || 'gh stopped'}.`;
          fill(body, errorBox(why), h('div.sheet-actions', btn('secondary', { label: 'Close', onclick: () => close(false) })));
          return;
        }
        await sleep(2000);
        try {
          s = await api('/api/workspace/git/signin');
        } catch {
          /* try again */
        }
      }
    })();
    return [body, h('div.sheet-actions', btn('ghost', { label: 'Stop', onclick: () => close(false) }))];
  }).then(async (v) => {
    alive = false;
    if (v !== true) await api('/api/workspace/git/signin/cancel', {}).catch(() => {});
    return v === true;
  });
}

/** The AI brain into a new private GitHub repository, as a job with its output. Resolves true when it worked. */
export function brainSheet(g) {
  let alive = true;
  return openSheet({ title: 'Keep the AI brain on GitHub', subtitle: `In a new PRIVATE repository of ${g.gh.account}, with your workspace map.` }, (close) => {
    const out = h('pre.output', { hidden: true });
    const state = h('div');
    const go = btn('primary', { icon: 'git', label: 'Create it', onclick: async () => {
      go.disabled = true;
      out.hidden = false;
      fill(state, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Creating and pushing…')));
      try {
        await api('/api/workspace/git/brain', {});
      } catch (e) {
        go.disabled = false;
        return fill(state, errorBox(e.message));
      }
      let from = 0;
      for (;;) {
        const j = await api(`/api/workspace/job?from=${from}`).catch(() => null);
        if (!alive) return;
        if (j) {
          if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
          from = j.next;
          if (!j.running) {
            const ok = j.result && j.result.ok;
            return fill(state, ok ? okBox(`Done: ${g.gh.account}/ai_brain is private on GitHub. On your next computer: Bring my workspace from git.`) : errorBox((j.result && j.result.error) || 'It did not work: see the output.'),
              h('div.sheet-actions', btn('primary', { label: 'Close', onclick: () => close(ok) })));
          }
        }
        await sleep(800);
      }
    } });
    return [h('p.sheet-text', 'Its name on GitHub is ai_brain. Only you can see it.'), out, state, h('div.sheet-actions', btn('secondary', { label: 'Cancel', onclick: () => close(false) }), go)];
  }).then((v) => {
    alive = false;
    return v === true;
  });
}

/** The next thing to do for git and GitHub on the open computer, in the page. Resolves true when something changed. */
export async function openGitSetup(g = null) {
  try {
    g = g || (await api('/api/workspace/git'));
  } catch (e) {
    toast(e.message, { kind: 'error', ms: 7000 });
    return false;
  }
  if (!g.git) return toast('git is not installed: Set up this computer installs it.', { kind: 'error', ms: 7000 }), false;
  if (g.gh && g.gh.installed && !g.gh.signedIn) return signinSheet();
  if (!(g.identity && g.identity.set)) return identitySheet(g);
  if (g.gh && !g.gh.installed) return toast('GitHub\'s command (gh) is not installed: Set up this computer installs it (GitHub).', { kind: 'error', ms: 7000 }), false;
  if (g.gh.signedIn && g.brain && g.brain.exists && !g.brain.remote) return brainSheet(g);
  toast('Git and GitHub are set up.');
  return false;
}

/** The panel for a computer's Setup tab: the three rows, each with its own button where something is to do. */
export function gitPanel() {
  const body = h('div.rows', h('div.row.static', h('span.row-sub', 'Looking at git and GitHub…')));
  const load = () => api('/api/workspace/git').then((g) => {
    const rows = gitRows(g);
    const again = (ok) => ok && load();
    const actionOf = (r) => {
      if (r.ok && r.id !== 'identity') return null;
      if (r.id === 'identity' && g.git) return btn('small secondary', { icon: 'pencil', label: r.ok ? 'Change' : 'Set', onclick: async () => again(await identitySheet(g)) });
      if (r.id === 'github' && g.gh && g.gh.installed) return btn('small primary', { icon: 'git', label: 'Sign in', onclick: async () => again(await signinSheet()) });
      if (r.id === 'brain' && g.gh && g.gh.signedIn && g.brain && g.brain.exists && g.brain.git !== false && !g.brain.remote) return btn('small secondary', { icon: 'git', label: 'Keep on GitHub', onclick: async () => again(await brainSheet(g)) });
      return null;
    };
    fill(body, rows.map((r) => h(`div.row.static.git-row${r.ok ? '.ok' : ''}`,
      h(`span.row-icon.pj-mark${r.ok ? '.ok' : '.warn'}`, icon(r.ok ? 'check' : 'alert')),
      h('span.row-main', h('span.row-title', r.title), h('span.row-sub', r.text)),
      actionOf(r))));
  }, (e) => fill(body, h('div.row.static', h('span.row-sub', `Could not look: ${e.message}`))));
  load();
  return panel({ icon: 'git', title: 'Git and GitHub', desc: 'So your projects and the AI brain are kept on a git server and come back on any computer.' }, body);
}
