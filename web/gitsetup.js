// Git and GitHub (GET /api/workspace/git): the name and e-mail on commits, the GitHub sign-in, the AI brain on a git
// server. Shown on a computer's Setup tab and as a step of Get started. Everything is done in the page
// (src/workspace/feature.mjs): the name and e-mail are a small form; the sign-in is gh's device flow, so the page
// shows a one-time code and the owner confirms it on GitHub's own page (no password is typed into this dashboard,
// and only the account name is kept); the brain goes into a new private repository as a job.
import { icon } from './icons.js';
import { add, api, btn, copyText, fill, h, link, openSheet, toast } from './lib.js';
import { errorBox, okBox, panel } from './shell.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The brain's daily state once it is set up (on a git server, its branch followed): { kind, text }. kind: 'fine',
 * 'save' (files not saved yet, or saved and not uploaded: Save them), 'get' (only newer changes on the server: Get
 * them; the same sheet), 'both' (changed here and there: said, nothing is forced). Never Get started's business.
 */
export function brainDaily(b) {
  if (b.ahead && b.behind) return { kind: 'both', text: 'Changed here and on your git server since they were last the same. Nothing is saved over the other: Sync on the Workspace page says what to do.' };
  if (b.changes) return { kind: 'save', text: `${plural(b.changes, 'file is', 'files are')} not saved to your git server yet` };
  if (b.ahead) return { kind: 'save', text: `${plural(b.ahead, 'saved change is', 'saved changes are')} not uploaded to your git server yet` };
  if (b.behind) return { kind: 'get', text: `${plural(b.behind, 'newer change')} on your git server ${b.behind === 1 ? 'is' : 'are'} not here yet` };
  return { kind: 'fine', text: 'Everything is saved on your git server' };
}

/** The three rows from the git route's answer `g`: [{ id, title, ok, text, daily? }]. */
export function gitRows(g) {
  const b = g.brain || {};
  const daily = b.remote && b.upstream ? brainDaily(b) : null;
  const signedIn = !!(g.gh && g.gh.signedIn);
  const brainText = !b.exists ? 'No AI brain yet: Create what is missing makes it'
    // Not in git, with a name and e-mail set: Keep on GitHub puts it in git too, so it reads as not on a server yet.
    // Without them: what puts it there is said as it is (set-up has run already and does not come back to it).
    : !b.git && !(g.identity && g.identity.set) ? 'The AI brain is not in git yet: once your name and e-mail are set, Keep on GitHub puts it there (in a new private GitHub repository)'
      : !b.remote ? (signedIn ? 'Not on a git server yet' : 'Not on a git server yet: sign in to GitHub first')
        // A set-up gap is said before the daily state: that would hide it.
        : !b.upstream ? 'Your AI brain here is not linked to its copy on your git server yet'
          : daily.text;
  return [
    { id: 'identity', title: 'Your name and e-mail on what you save', ok: !!(g.identity && g.identity.set), text: g.identity && g.identity.set ? `${g.identity.name} · ${g.identity.email}` : !g.git ? 'git is not installed: Set up this computer installs it' : 'Not set yet' },
    { id: 'github', title: 'Signed in to GitHub', ok: !!(g.gh && g.gh.signedIn), text: g.gh && g.gh.signedIn ? `as ${g.gh.account}` : g.gh && !g.gh.installed ? 'GitHub\'s command (gh) is not installed: Set up this computer installs it' : 'Not signed in' },
    { id: 'brain', title: 'The AI brain on your git server', ok: !!(daily && daily.kind === 'fine'), text: brainText, ...(daily ? { daily: daily.kind } : {}) },
  ];
}

/**
 * Set up: the name and e-mail are set, GitHub is signed in and the AI brain is on a git server with its branch
 * followed. What is waiting to be saved, uploaded or got is daily work, said on the brain's row: it never opens
 * Get started's step again (a session writes a memory, and the finished list would open by itself).
 */
export const gitDone = (g) => !!g && !!(g.identity && g.identity.set) && !!(g.gh && g.gh.signedIn) && !!(g.brain && g.brain.remote && g.brain.upstream);

/**
 * The one button of a row (`r` of gitRows, `g` the route's answer), or null: { kind, label }. The panel draws it and a
 * test reads it, so a row that is not fine and has no button is seen. kind: 'identity', 'signin', 'keep' (into a new
 * GitHub repository), 'save' (the save sheet: link, save, get), 'create' (Create what is missing, as on Settings →
 * Workspace), 'workspace' (the Workspace page), 'install' (Set up this computer, on the Setup tab: no button there, its
 * own button is on the same page; Get started's step goes there).
 */
export function rowAction(r, g) {
  const b = g.brain || {};
  const install = { kind: 'install', label: 'Set up this computer' };
  if (r.id === 'identity') return g.git ? { kind: 'identity', label: r.ok ? 'Change' : 'Set' } : install;
  if (r.ok) return null;
  if (r.id === 'github') return g.gh && g.gh.installed ? { kind: 'signin', label: 'Sign in' } : install;
  if (r.id !== 'brain') return null;
  if (!b.exists) return { kind: 'create', label: 'Create what is missing' };
  // Not in git yet: the same press puts it there first (gitstep.mjs startNew), once a commit can carry his name.
  if (g.gh && g.gh.signedIn && !b.remote && (b.git !== false || (g.identity && g.identity.set))) return { kind: 'keep', label: 'Keep on GitHub' };
  if (b.remote && !b.upstream) return { kind: 'save', label: 'Link it' };
  if (r.daily === 'save' || r.daily === 'get') return { kind: 'save', label: r.daily === 'get' ? 'Get them' : 'Save them' };
  if (r.daily === 'both') return { kind: 'workspace', label: 'Open Workspace' };
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The name and e-mail on what he saves: a small form. Resolves true when saved. */
export function identitySheet(g) {
  return openSheet({ title: 'Your name and e-mail on what you save', subtitle: 'git puts them on every change you save in a project or the AI brain, so you can see who saved it.' }, (close) => {
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
      h('span.hint', 'GitHub shows it on what you save. GitHub\'s no-reply address (in GitHub\'s e-mail settings) keeps yours private.')),
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
        return fill(body, errorBox(e));
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
      fill(state, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Creating it and uploading…')));
      try {
        await api('/api/workspace/git/brain', {});
      } catch (e) {
        go.disabled = false;
        return fill(state, errorBox(e));
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

// Where a brain changed on both sides is sorted out: the sentence names the page and the button opens it.
const SYNC_WORDS = 'Nothing is saved over the other: Sync on the Workspace page says what to do.';
const toWorkspace = (close) => h('a.btn.secondary', { href: link('#/workspace'), onclick: () => close(false) }, 'Open Workspace');

/**
 * The save sheet's words for what the AI brain needs (`c`: GET /api/workspace/git/brain): { title, subtitle, lines,
 * list (name the files), hint, button (null: nothing to press), busy, done }. A brain that only gets newer changes is
 * never told it is saved or uploaded: the heading, the lines and the button name the one thing the press does.
 */
export function saveWords(c) {
  const where = c.repo || 'your git server';
  // A file deleted here is taken off the server by the save, and off the other computers when they next get it: said
  // apart, never as a file that goes there. An older Hoprig on another computer sends no `removed`: all go then.
  const gone = Array.isArray(c.removed) ? c.removed : [];
  const up = Math.max(0, (c.count || 0) - gone.length);
  const upLines = up ? [`${plural(up, 'file goes', 'files go')} to ${where}:`] : [];
  const removed = gone.length ? { text: `${plural(gone.length, 'file was', 'files were')} deleted here, so the save takes ${gone.length === 1 ? 'it' : 'them'} off ${where} too, and off your other computers when they next get the AI brain:`, files: gone } : null;
  const save = { title: 'Save the AI brain to your git server', subtitle: 'So your other computers get the same memory, rules and skills.' };
  // A file that looks like a key or a password: said before any press, and nothing to press (the save refuses it too).
  const secret = c.secret || [];
  if (secret.length) {
    // The server's advice knows which files git keeps already (a .gitignore does nothing for those); a dashboard of
    // an older Hoprig on another computer sends none.
    const way = c.secretAdvice || `Ask your coding tool in a session to move ${secret.length === 1 ? 'it' : 'them'} out of the AI brain.`;
    const large = (c.secretLarge || []).length ? ', or too large to check for a key' : '';
    const linked = c.brainIsLink ? [`Hoprig does not move ${secret.length === 1 ? 'it' : 'them'} for you: the AI brain folder here is a link to another place, which Hoprig leaves alone.`] : [];
    const head = `Nothing can be saved while ${plural(secret.length, 'file looks', 'files look')} like a key or a password${large}:`;
    // Move it out is the way through on the page, so it comes first; the coding tool's way (or .gitignore) after it.
    if (c.movedOut && c.moveSeen) {
      return { ...save, lines: [head], secret, button: null, moveOut: { ...moveOutWords(secret, c.secretTracked || [], c.movedOut, where), seen: c.moveSeen },
        other: `Another way, which also keeps ${secret.length === 1 ? 'it' : 'them'} out of the save for good: ${way[0].toLowerCase()}${way.slice(1)} Then open this again.` };
    }
    return { ...save, lines: [head, `${way} Then open this again.`, ...linked], secret, button: null };
  }
  // Not linked, and the server keeps the brain on another branch: the press would refuse, so it is said with no button.
  if (!c.upstream && c.elsewhere) {
    return { title: 'Link the AI brain to its copy on your git server', subtitle: save.subtitle, lines: [`It cannot be linked by a press: ${c.elsewhere}`], button: null };
  }
  if (!c.upstream) {
    // On a git server, not linked to its copy there: the press links them first (brainsave.mjs), then as below.
    return { title: 'Link the AI brain to its copy on your git server', subtitle: save.subtitle,
      lines: [`The AI brain here is not linked to its copy on ${where} yet. This links them and gets what is newer there; what is only here is saved and uploaded.`, ...upLines], list: !!up, removed,
      button: 'Link it', busy: 'Linking…', done: `Done: the AI brain here is linked to its copy on ${where}.` };
  }
  if (c.ahead && c.behind) return { title: 'The AI brain was changed in two places', subtitle: save.subtitle, lines: [`The AI brain was changed here and on ${where}. ${SYNC_WORDS}`], button: null, workspace: true };
  if (c.behind && !c.count && !c.ahead) {
    return { title: 'Get the newer AI brain from your git server', subtitle: 'So this computer has the newest memory, rules and skills.',
      lines: [`${plural(c.behind, 'newer change')} on ${where} ${c.behind === 1 ? 'comes' : 'come'} here.`], button: 'Get them', busy: 'Getting them…', done: 'Done: the AI brain here has the newer changes.' };
  }
  if (!c.count && !c.ahead) return { ...save, lines: [`Everything is saved on ${where} already.`], button: null };
  return { ...save,
    lines: c.count ? upLines : [`${plural(c.ahead, 'saved change goes', 'saved changes go')} to ${where}.`], list: !!up, removed,
    hint: 'Newer changes on the git server come here first. Then everything is saved in the AI brain\'s history (one save point you can go back to) and uploaded.',
    button: 'Save and upload', busy: 'Saving…', done: `Done: the AI brain is saved on ${where}.` };
}

/**
 * The key refusal's way through on the sheet itself (POST /api/workspace/git/brain/moveout): the files are moved, never
 * deleted, to the folder beside the brain (`folder`, named before the press); one git keeps already is also taken out
 * of git, so the next save takes it off the git server while its old versions stay in the history. → { text, notes,
 * files, button, busy }. Only a server that names the folder (movedOut) gets the button.
 */
export function moveOutWords(files, tracked, folder, where = 'your git server') {
  const it = files.length === 1 ? 'it' : 'them';
  const kept = files.filter((f) => tracked.includes(f));
  const notes = [`Nothing is deleted: ${files.length === 1 ? 'the file keeps' : 'each file keeps'} its place inside the AI brain there, and a file of the same name there is never replaced.`];
  if (kept.length) {
    const one = kept.length === 1;
    const who = kept.length === files.length ? (one ? 'It was' : 'They were') : `${kept.join(', ')} ${one ? 'was' : 'were'}`;
    notes.push(`${who} saved before, so ${one ? 'it is' : 'they are'} also taken out of git: the next save takes ${one ? 'it' : 'them'} off ${where}. ${one ? 'Its' : 'Their'} old versions stay in the AI brain's history there, so a real key or password in ${one ? 'it' : 'them'} must be changed.`);
  }
  return { text: `Move ${it} out of the AI brain now, to ${folder}`, notes, files, button: files.length === 1 ? 'Move it out' : `Move ${files.length} files out`, busy: 'Moving…' };
}

/**
 * The AI brain's files not saved to its git server yet: what they are is asked first, so the sheet opens with the
 * heading of what the press does (saveWords); it names the first few files and how many more, says where they go, and
 * only on his press saves and uploads them (POST /api/workspace/git/brain { save: true, seen }: the list it showed) as a job with its output.
 * Resolves true when it worked.
 */
export async function saveSheet() {
  let c;
  try {
    c = await api('/api/workspace/git/brain');
  } catch (e) {
    toast(e, { kind: 'error', ms: 7000 });
    return false;
  }
  const w = saveWords(c);
  let alive = true;
  return openSheet({ title: w.title, subtitle: w.subtitle }, (close) => {
    const out = h('pre.output', { hidden: true });
    const state = h('div');
    const actions = h('div.sheet-actions');
    const go = w.button ? btn('primary', { icon: 'git', label: w.button, onclick: async () => {
      go.disabled = true;
      out.hidden = false;
      fill(state, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', w.busy)));
      try {
        await api('/api/workspace/git/brain', { save: true, seen: c.seen });
      } catch (e) {
        go.disabled = false;
        return fill(state, errorBox(e));
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
            const why = (j.result && j.result.error) || 'It did not work: see the output.';
            fill(state, ok ? okBox(w.done) : errorBox(why));
            // A refusal that names Sync has the way there beside it.
            return fill(actions, !ok && /Workspace page/.test(why) ? toWorkspace(close) : null, btn('primary', { label: 'Close', onclick: () => close(ok) }));
          }
        }
        await sleep(800);
      }
    } }) : null;
    // The key refusal's own button: only the files the sheet names, only on his press; the server checks each again.
    const mv = w.moveOut ? btn('primary', { icon: 'folder', label: w.moveOut.button, onclick: async () => {
      mv.disabled = true;
      fill(state, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', w.moveOut.busy)));
      try {
        const r = await api('/api/workspace/git/brain/moveout', { files: w.moveOut.files, seen: w.moveOut.seen });
        if (!alive) return;
        fill(state, okBox(`Moved to ${r.folder}: ${r.moved.map((m) => m.from).join(', ')}.`));
        // The next step in the same sheet: the save opened again, with what is left.
        fill(actions, btn('secondary', { label: 'Close', onclick: () => close(false) }),
          btn('primary', { icon: 'git', label: 'Save the rest', onclick: () => {
            close(false);
            saveSheet();
          } }));
      } catch (e) {
        mv.disabled = false;
        fill(state, errorBox(e));
      }
    } }) : null;
    fill(actions, w.workspace ? toWorkspace(close) : null, btn('secondary', { label: go ? 'Cancel' : 'Close', onclick: () => close(false) }), go, mv);
    return [
      w.lines[0] ? h('p.sheet-text', w.lines[0]) : null,
      w.secret ? h('ul.ws-setup-list', w.secret.map((f) => h('li', h('code', f)))) : null,
      ...w.lines.slice(1).map((t) => h('p.sheet-text', t)),
      w.moveOut ? h('p.sheet-text', h('strong', `${w.moveOut.text}.`)) : null,
      ...(w.moveOut ? w.moveOut.notes.map((t) => h('p.hint', t)) : []),
      w.other ? h('p.hint', w.other) : null,
      w.list ? h('ul.ws-setup-list', c.files.map((f) => h('li', h('code', f)))) : null,
      // Every file is one press away before the button: nothing goes there that he could not see named.
      w.list && c.more ? h('details.adv', h('summary', `and ${c.more} more: show all`), h('ul.ws-setup-list', (c.all || c.files).slice(c.files.length).map((f) => h('li', h('code', f))))) : null,
      w.removed ? h('p.sheet-text', w.removed.text) : null,
      w.removed ? h('ul.ws-setup-list', w.removed.files.map((f) => h('li', h('code', f)))) : null,
      w.hint ? h('p.hint', w.hint) : null,
      out, state, actions];
  }).then((v) => {
    alive = false;
    return v === true;
  });
}

/** What each kind of row button does (rowAction), in the page. Resolves true when something changed. */
const ACT = {
  identity: (g) => identitySheet(g),
  signin: () => signinSheet(),
  keep: (g) => brainSheet(g),
  save: () => saveSheet(),
  // Loaded on the press: the AI brain page's module is not needed until then.
  create: () => import('./brain.js').then((m) => m.setUpWorkspace()).then(() => true),
  workspace: () => ((location.hash = link('#/workspace')), false),
  install: (g) => {
    toast(!g.git ? 'git is not installed: Set up this computer installs it.' : 'GitHub\'s command (gh) is not installed: Set up this computer installs it (GitHub).', { kind: 'error', ms: 7000 });
    location.hash = link('#/computer/setup');
    return false;
  },
};

/**
 * The next thing to do for git and GitHub on the open computer, in the page (Get started's step): the button of the
 * first row that is not fine, the same one the Setup tab shows. Resolves true when something changed.
 */
export async function openGitSetup(g = null) {
  try {
    g = g || (await api('/api/workspace/git'));
  } catch (e) {
    toast(e, { kind: 'error', ms: 7000 });
    return false;
  }
  if (!g.git) return ACT.install(g);
  // The GitHub sign-in first (gh sets up git's sign-in too), then the name, then the brain; an install comes last.
  const rows = gitRows(g);
  const todo = ['github', 'identity', 'brain'].map((id) => rows.find((r) => r.id === id)).filter((r) => !r.ok).map((r) => rowAction(r, g)).filter(Boolean);
  const next = todo.find((a) => a.kind !== 'install') || todo[0];
  if (next) return ACT[next.kind](g);
  // Said only when it is true; else the first row that is not fine says what is left, in its own words.
  if (gitDone(g)) toast('Git and GitHub are set up.');
  else toast(rows.find((r) => !r.ok).text, { kind: 'error', ms: 7000 });
  return false;
}

/** The panel for a computer's Setup tab: the three rows, each with its own button where something is to do. */
export function gitPanel() {
  const body = h('div.rows', h('div.row.static', h('span.row-sub', 'Looking at git and GitHub…')));
  const load = () => api('/api/workspace/git').then((g) => {
    const rows = gitRows(g);
    const again = (ok) => ok && load();
    const actionOf = (r) => {
      const a = rowAction(r, g);
      if (!a || a.kind === 'install') return null; // Set up this computer is this page's own button
      // Set: a real button. Change (it is fine already): a quiet one, so a green row does not look like a to-do.
      if (a.kind === 'identity') return btn(r.ok ? 'small ghost' : 'small secondary', { icon: r.ok ? null : 'pencil', label: a.label, title: r.ok ? 'Change the name and e-mail on what you save' : null, onclick: async () => again(await identitySheet(g)) });
      if (a.kind === 'signin') return btn('small primary', { icon: 'git', label: a.label, onclick: async () => again(await signinSheet()) });
      if (a.kind === 'keep') return btn('small secondary', { icon: 'git', label: a.label, onclick: async () => again(await brainSheet(g)) });
      // The brain's state: one button that opens the save sheet; changed on both sides: the way to Sync.
      if (a.kind === 'save') return btn('small primary', { icon: 'git', label: a.label, onclick: async () => again(await saveSheet()) });
      if (a.kind === 'create') return btn('small primary', { icon: 'plus', label: a.label, onclick: async () => again(await ACT.create()) });
      return h('a.btn.small.secondary', { href: link('#/workspace') }, a.label);
    };
    fill(body, rows.map((r) => h(`div.row.static.git-row${r.ok ? '.ok' : ''}`,
      h(`span.row-icon.pj-mark${r.ok ? '.ok' : '.warn'}`, icon(r.ok ? 'check' : 'alert')),
      h('span.row-main', h('span.row-title', r.title), h('span.row-sub', r.text)),
      actionOf(r))));
  }, (e) => fill(body, h('div.row.static.git-row', h('span.row-sub', `Could not look: ${e.message}`)))); // wraps whole on a phone
  load();
  const el = panel({ icon: 'git', title: 'Git and GitHub', desc: 'So your projects and the AI brain are kept on a git server and come back on any computer.' }, body);
  el.refresh = load; // Setup's own rows change the same things
  return el;
}
