// "Git and GitHub": one step of `hoprig setup` and `hoprig pc setup`, and `hoprig workspace git` on its own. The
// dashboard does the same in the page (workspace/feature.mjs: the sign-in by gh's device flow, ghsignin.mjs).
//   1. git's name and e-mail when they are missing (once signed in, GitHub's no-reply address is suggested; an
//      address is never made up)
//   2. the GitHub sign-in: `gh auth login` in the terminal (the person does it in the browser), then
//      `gh auth setup-git`, so plain git uses that sign-in too. Only the account name is ever kept or shown.
//   3. the question that makes a fresh computer useful: is there a workspace of yours on GitHub already? Restore it,
//      start a new one (a PRIVATE repository for the brain, never public), or later.
// Other git servers (GitLab, a plain SSH server) work for map, restore and sync through plain git; only this
// sign-in help and creating a repository are GitHub's.
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { parseGhAuth } from '../pcsetup/detect.mjs';
import { createGithubRepo, git, githubOwners, initRepo, repoInfo } from '../pcsetup/workspace.mjs';
import { capture, stream, which } from '../setup/system.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { isDir, isGitRepo, workspaceDir } from './layout.mjs';
import { MAP_FILE, updateMap } from './map.mjs';
import { restoreWorkspace, untouchedScaffold } from './restore.mjs';
import { workspaceSetup } from './setup.mjs';

const NAME_OK = /^[^\0-\x1f\x7f"\\<>]{1,100}$/;
const EMAIL_OK = /^[^\s@<>"\\]{1,64}@[A-Za-z0-9.-]{1,190}$/;

/** What is set up: { git, identity: { name, email }, gh: { installed, signedIn, account }, helper, brain: { exists, git, remote, ahead, behind, upstream } } */
export async function gitState({ run = capture, has = (c) => !!which(c), dir = workspaceDir() } = {}) {
  const out = { git: has('git'), identity: { name: '', email: '' }, gh: { installed: has('gh'), signedIn: false, account: null }, helper: false, brain: { exists: false, git: false, remote: null } };
  if (out.git) {
    const [n, e, h] = await Promise.all([
      run(['git', 'config', '--global', 'user.name']), run(['git', 'config', '--global', 'user.email']),
      run(['git', 'config', '--global', '--get-regexp', '^credential\\..*helper$']),
    ]);
    out.identity = { name: n.ok ? n.stdout.trim() : '', email: e.ok ? e.stdout.trim() : '' };
    out.helper = h.ok && /gh(\.exe)? auth git-credential/.test(h.stdout);
  }
  if (out.gh.installed) {
    const a = parseGhAuth(await run(['gh', 'auth', 'status', '--hostname', 'github.com']));
    out.gh.signedIn = a.signedIn;
    out.gh.account = a.signedIn ? a.account : null;
  }
  const brain = path.join(dir, 'ai_brain');
  out.brain.exists = isDir(brain);
  out.brain.git = isGitRepo(brain);
  if (out.brain.git) {
    const r = await gitRead(brain, ['config', '--get', 'remote.origin.url'], { run });
    out.brain.remote = r.ok ? r.stdout.trim().replace(/^(https?:\/\/)[^/@]*@/, '$1') : null;
    const s = await repoInfo(brain, run);
    if (s.ok) Object.assign(out.brain, { branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changes: s.changes });
  }
  return out;
}

/** GitHub's no-reply address of the signed-in account ("<id>+<login>@users.noreply.github.com"), or null. */
export async function noreplyEmail(run = capture) {
  const r = await run(['gh', 'api', 'user', '--jq', '[.id, .login, (.name // "")] | @tsv'], { timeout: 20_000 });
  if (!r.ok) return null;
  const [id, login, name] = r.stdout.trim().split('\t');
  if (!/^\d+$/.test(id || '') || !/^[A-Za-z0-9-]{1,39}$/.test(login || '')) return null;
  return { email: `${id}+${login}@users.noreply.github.com`, login, name: name && NAME_OK.test(name) ? name : '' };
}

/** Repositories of the signed-in account and its organisations that look like an AI brain. [{ owner, name, url, private, hasMap }] */
export async function brainCandidates(run = capture) {
  const out = [];
  for (const owner of await githubOwners(run)) {
    const r = await run(['gh', 'repo', 'list', owner, '--json', 'name,url,isPrivate', '--limit', '1000'], { timeout: 60_000 });
    if (!r.ok) continue;
    let list = [];
    try {
      list = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    for (const x of list) {
      if (!x || typeof x.name !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(x.name) || !/brain/i.test(x.name)) continue;
      const m = await run(['gh', 'api', `repos/${owner}/${x.name}/contents/${MAP_FILE}`, '--jq', '.name'], { timeout: 20_000 });
      out.push({ owner, name: x.name, url: `https://github.com/${owner}/${x.name}.git`, private: x.isPrivate === true, hasMap: m.ok && m.stdout.trim() === MAP_FILE });
    }
  }
  // A brain with a map first: that is the one restore can use.
  return out.sort((a, b) => Number(b.hasMap) - Number(a.hasMap) || (a.name === 'ai_brain' ? -1 : b.name === 'ai_brain' ? 1 : 0));
}

/**
 * The step. `ui`: setup ui. `run`: capture-like (for reading), `term`: stream-like (sign-in, creating the
 * repository). → { ok, changed, state }
 */
export async function runGitStep({ ui, run = capture, term = stream, has = (c) => !!which(c), dir = workspaceDir() } = {}) {
  ui.out(`\n${bold('Git and GitHub')}`);
  let st = await gitState({ run, has, dir });
  let changed = false;
  if (!st.git) {
    ui.line('fail', 'git is not installed: hoprig pc setup --kits basics');
    return { ok: false, changed, state: st };
  }
  const live = ui.interactive && !ui.dryRun && !ui.yes;

  // 1. Signing in first: GitHub's no-reply address can then be offered for the commits.
  if (!st.gh.installed) ui.line('warn', `GitHub: gh is not installed (${bold('hoprig pc setup --kits github')}); git works without it, with any git server`);
  else if (!st.gh.signedIn) {
    if (live && (await ui.confirm('Sign in to GitHub now? (a code appears here; you confirm it in the browser)', true))) {
      const r = await term(['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { interactive: true });
      ui.line(r.ok ? 'ok' : 'warn', r.ok ? 'signed in to GitHub' : 'the sign-in did not finish: run gh auth login');
      st = await gitState({ run, has, dir });
      changed = changed || st.gh.signedIn;
    } else ui.line('info', `GitHub: not signed in. Later: ${bold('hoprig workspace git')} in a terminal, or the dashboard's Setup`);
  } else ui.line('ok', `GitHub: signed in as ${st.gh.account}`);
  if (st.gh.signedIn && !st.helper) {
    if (ui.dryRun) ui.note('(dry run) would run: gh auth setup-git');
    else {
      const r = await run(['gh', 'auth', 'setup-git', '--hostname', 'github.com'], { timeout: 30_000 });
      ui.line(r.ok ? 'ok' : 'warn', r.ok ? 'git uses the GitHub sign-in (gh auth setup-git)' : `gh auth setup-git did not work: ${(r.stderr || '').trim().split('\n').pop()}`);
      changed = changed || r.ok;
    }
  }

  // 2. Who the commits are from.
  if (!st.identity.name || !st.identity.email) {
    const gh = st.gh.signedIn ? await noreplyEmail(run) : null;
    if (live) {
      const name = ((await ui.ask(`  Your name for commits${st.identity.name || gh?.name || gh?.login ? ` (${st.identity.name || gh.name || gh.login})` : ''}: `)) || '').trim() || st.identity.name || gh?.name || gh?.login || '';
      const email = ((await ui.ask(`  Your e-mail for commits${st.identity.email || gh ? ` (${st.identity.email || gh.email}${gh && !st.identity.email ? ': GitHub\'s no-reply address, keeps yours private' : ''})` : ''}: `)) || '').trim() || st.identity.email || gh?.email || '';
      if (NAME_OK.test(name) && EMAIL_OK.test(email)) {
        await run(['git', 'config', '--global', 'user.name', name]);
        await run(['git', 'config', '--global', 'user.email', email]);
        ui.line('ok', 'commit name and e-mail set');
        changed = true;
      } else ui.line('warn', 'commit name and e-mail not set: git config --global user.name "Your Name" && git config --global user.email you@example.com');
    } else ui.line('warn', `commits need your name and e-mail: git config --global user.name "Your Name" && git config --global user.email ${gh ? gh.email : 'you@example.com'}`);
  } else ui.line('ok', `commits as ${st.identity.name} <${st.identity.email}>`);

  // 3. The workspace on GitHub.
  st = await gitState({ run, has, dir });
  if (st.brain.remote) {
    ui.line('ok', `your AI brain is on ${st.brain.remote}`);
    return { ok: true, changed, state: st };
  }
  if (!st.gh.signedIn) {
    ui.note(`Your workspace from another computer: ${bold('hoprig workspace restore <address of your AI brain>')} (any git server)`);
    return { ok: true, changed, state: st };
  }
  // The untouched starting brain of `workspace setup` counts as none: restore keeps it aside.
  const own = st.brain.exists && !(await untouchedScaffold(path.join(dir, 'ai_brain'), run));
  const cands = own ? [] : await brainCandidates(run);
  const options = [
    ...cands.slice(0, 9).map((c, i) => ({ key: String(i + 1), label: `restore ${c.owner}/${c.name}${c.hasMap ? '' : dim('  (no workspace map in it)')}`, cand: c })),
    { key: 'n', label: own || st.brain.exists ? 'put this AI brain in a new private GitHub repository' : 'start a new workspace: its AI brain in a new private GitHub repository' },
    { key: 'l', label: 'later' },
  ];
  ui.out(own ? '  Your AI brain is not on a git server yet.' : cands.length ? '  Is one of these the AI brain of your workspace?' : '  No AI brain of yours on GitHub yet.');
  const pick = await ui.choose(own ? 'What now?' : 'Is there a workspace of yours on GitHub already?', options, 'l');
  if (!pick || pick === 'l') {
    ui.note(`Later: ${bold('hoprig workspace git')}`);
    return { ok: true, changed, state: st };
  }
  if (pick === 'n') return { ok: await startNew(ui, { st, run, term, dir }), changed: true, state: await gitState({ run, has, dir }) };
  const c = options.find((o) => o.key === pick).cand;
  const r = await restoreWorkspace(c.url, { ui, dir }).catch((e) => ({ ok: false, error: e.message }));
  if (r.error) ui.line('fail', r.error);
  else for (const e of r.plan) ui.line(String(e.result).startsWith('failed') ? 'fail' : 'ok', `${e.label}: ${e.result}`);
  return { ok: r.ok, changed: true, state: await gitState({ run, has, dir }) };
}

/**
 * A new private repository for the brain (made first when there is none), the map in it, pushed. With `owner` and
 * `name` (the dashboard, where the owner already said yes) nothing is asked.
 */
export async function startNew(ui, { st, run, term, dir, owner: wantOwner = null, name: wantName = null }) {
  const brain = path.join(dir, 'ai_brain');
  if (!st.brain.exists) {
    const r = await workspaceSetup({ cfg: { workspaceDir: dir } });
    for (const d of r.did) ui.line('ok', `created ${d.path}`);
  }
  if (!isGitRepo(brain)) {
    const i = await initRepo(brain, 'Start the AI brain', run);
    if (!i.ok) return ui.line('fail', `git could not make the first commit: ${i.error}`) ?? false;
  }
  const owners = await githubOwners(run);
  let owner = owners[0];
  if (wantOwner) {
    if (!owners.includes(wantOwner)) return ui.line('fail', `${wantOwner} is not your GitHub account or one of its organisations`) ?? false;
    owner = wantOwner;
  } else if (owners.length > 1) {
    const k = await ui.choose('Which GitHub account keeps it?', owners.map((o, i) => ({ key: String(i + 1), label: o })), '1');
    owner = k ? owners[Number(k) - 1] : null;
  }
  if (!owner) return false;
  const name = wantName || ((ui.interactive && !ui.yes ? await ui.ask('  Its name on GitHub (ai_brain): ') : '') || '').trim() || 'ai_brain';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return ui.line('fail', 'a repository name is letters, digits, ".", "_" and "-"') ?? false;
  if (!wantName && !(await ui.confirm(`Create the PRIVATE repository ${owner}/${name} and push your AI brain to it?`, true))) return false;
  const lines = [];
  const r = await createGithubRepo(brain, owner, name, { onLine: (l) => lines.push(l), run: term });
  if (!r.ok) return ui.line('fail', `gh repo create failed: ${lines.filter(Boolean).pop() || ''} — retry: gh repo create ${owner}/${name} --private --source "${brain}" --remote origin --push`) ?? false;
  ui.line('ok', `private repository ${owner}/${name} created and pushed`);
  // The map now knows the brain's address: write it, commit only that file, push.
  await updateMap({ dir });
  await git(brain, ['add', '--', MAP_FILE], run);
  const c = await git(brain, ['commit', '--quiet', '-m', 'Add the workspace map', '--', MAP_FILE], run);
  if (c.ok) {
    const p = await git(brain, ['push', '--quiet'], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    ui.line(p.ok ? 'ok' : 'warn', p.ok ? 'the workspace map is in the brain and pushed' : `the map is committed; push it: git -C "${brain}" push`);
  }
  ui.note(`On your next computer: ${bold(`hoprig workspace restore ${owner}/${name}`)}`);
  return true;
}
