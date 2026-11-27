// "Git and GitHub": one step of `hoprig setup` and `hoprig pc setup`, and `hoprig workspace git` on its own. The
// dashboard does the same in the page (workspace/feature.mjs: the sign-in by gh's device flow, ghsignin.mjs).
//   1. (after 2) git's name and e-mail when they are missing: signed in, GitHub's name and no-reply address are taken and
//      said, not asked; asked only when GitHub is not signed in (an address is never made up)
//   2. the GitHub sign-in: `gh auth login` in the terminal (the person does it in the browser), then
//      `gh auth setup-git`, so plain git uses that sign-in too. Only the account name is ever kept or shown.
//   3. one path for the workspace, asked once in plain words: set-up looks for the owner's brain on GitHub (a
//      repository of his whose name has "brain" in it and that holds a workspace map). Found: it is restored (the
//      brain, the credentials and groups' repositories and the others; no project, restore.mjs). Not found: the
//      workspace, its brain and the first map are made and the brain goes into a new PRIVATE repository at once.
//   4. this computer's label in the workspace (computer.mjs), asked once: the host name is only a suggestion.
//   5. "keep the map on your git server by itself": the upkeep's commitMap and push switches as one choice.
// Questions are asked only at a terminal; with --yes or without a terminal nothing is created on GitHub, nothing is
// restored and no label is stored: the step says the command instead.
// Other git servers (GitLab, a plain SSH server) work for map, restore and sync through plain git; only this
// sign-in help and creating a repository are GitHub's.
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { parseGhAuth } from '../pcsetup/detect.mjs';
import { createGithubRepo, githubOwners, initRepo, repoInfo } from '../pcsetup/workspace.mjs';
import { gitIn } from './inside.mjs';
import { capture, showCommand, stream, which } from '../setup/system.mjs';
import { bold, dim, yours } from '../setup/ui.mjs';
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

/** What a failed gh call said, in one short line (never more than its last line). */
const ghWhy = (r) => ((r.stderr || r.stdout || '').trim().split('\n').pop() || 'gh failed').slice(0, 160);

/**
 * Repositories of the signed-in account and its organisations that look like an AI brain. → { list: [{ owner, name,
 * url, private, hasMap }], failed: '' | why }. `failed`: GitHub could not be asked all of it (no network, a rate
 * limit, a timeout): the list may lack the owner's real brain, so nobody may take an empty list for "no workspace".
 */
export async function brainCandidates(run = capture) {
  const out = [];
  let failed = '';
  const owners = await githubOwners(run);
  if (!owners.length) return { list: [], failed: 'GitHub could not be asked who you are' };
  for (const owner of owners) {
    const r = await run(['gh', 'repo', 'list', owner, '--json', 'name,url,isPrivate', '--limit', '1000'], { timeout: 60_000 });
    if (!r.ok) {
      failed = failed || `the repositories of ${owner} could not be listed (${ghWhy(r)})`;
      continue;
    }
    let list = [];
    try {
      list = JSON.parse(r.stdout);
    } catch {
      failed = failed || `GitHub's list of the repositories of ${owner} could not be read`;
      continue;
    }
    for (const x of list) {
      if (!x || typeof x.name !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(x.name) || !/brain/i.test(x.name)) continue;
      const m = await run(['gh', 'api', `repos/${owner}/${x.name}/contents/${MAP_FILE}`, '--jq', '.name'], { timeout: 20_000 });
      // No map there is GitHub's "Not Found"; any other failure means it could not be asked.
      if (!m.ok && !/not found|HTTP 404/i.test(`${m.stderr || ''}${m.stdout || ''}`)) failed = failed || `${owner}/${x.name} could not be looked into (${ghWhy(m)})`;
      out.push({ owner, name: x.name, url: `https://github.com/${owner}/${x.name}.git`, private: x.isPrivate === true, hasMap: m.ok && m.stdout.trim() === MAP_FILE });
    }
  }
  // A brain with a map first: that is the one restore can use.
  return { list: out.sort((a, b) => Number(b.hasMap) - Number(a.hasMap) || (a.name === 'ai_brain' ? -1 : b.name === 'ai_brain' ? 1 : 0)), failed };
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
      if (r.ok) ui.line('ok', 'signed in to GitHub');
      else yours(ui, 'warn', 'the GitHub sign-in did not finish', 'github');
      st = await gitState({ run, has, dir });
      changed = changed || st.gh.signedIn;
    } else yours(ui, 'info', 'GitHub: not signed in', 'github', { alone: `GitHub: not signed in. Later: ${bold('hoprig workspace git')} in a terminal, or the dashboard's Setup` });
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
    // Signed in: the name and GitHub's no-reply address are taken, said once, never asked. Asked only without GitHub.
    const name = st.identity.name || (gh && (gh.name || gh.login)) || '';
    const email = st.identity.email || (gh && gh.email) || '';
    if (gh && live && NAME_OK.test(name) && EMAIL_OK.test(email)) {
      if (!st.identity.name) await run(['git', 'config', '--global', 'user.name', name]);
      if (!st.identity.email) await run(['git', 'config', '--global', 'user.email', email]);
      ui.line('ok', `commits as ${name} <${email}>${st.identity.email ? '' : " (GitHub's no-reply address, keeps yours private)"}; change: git config --global user.name / user.email`);
      changed = true;
    } else if (live) {
      const n = ((await ui.ask(`  Your name for commits${name ? ` (${name})` : ''}: `)) || '').trim() || name;
      const e = ((await ui.ask(`  Your e-mail for commits${email ? ` (${email})` : ''}: `)) || '').trim() || email;
      if (NAME_OK.test(n) && EMAIL_OK.test(e)) {
        await run(['git', 'config', '--global', 'user.name', n]);
        await run(['git', 'config', '--global', 'user.email', e]);
        ui.line('ok', 'commit name and e-mail set');
        changed = true;
      } else yours(ui, 'warn', 'commit name and e-mail not set', 'identity');
    } else yours(ui, 'warn', 'commits need your name and e-mail', 'identity', { step: `git config --global user.name "Your Name" && git config --global user.email ${gh ? gh.email : 'you@example.com'}` });
  } else ui.line('ok', `commits as ${st.identity.name} <${st.identity.email}>`);

  // 3. The workspace on GitHub: one path, asked once.
  st = await gitState({ run, has, dir });
  if (st.brain.remote) {
    ui.line('ok', `your AI brain is on ${st.brain.remote}`);
    await afterBrain(ui, { live, dir });
    return { ok: true, changed, state: st };
  }
  if (!st.gh.signedIn) {
    ui.note(`Your workspace from another computer: ${bold('hoprig workspace restore <address of your AI brain>')} (any git server)`);
    return { ok: true, changed, state: st };
  }
  // The untouched starting brain of `workspace setup` counts as none: restore keeps it aside.
  const own = st.brain.exists && !(await untouchedScaffold(path.join(dir, 'ai_brain'), run));
  const found = own ? { list: [], failed: '' } : await brainCandidates(run);
  const cands = found.list.filter((c) => c.hasMap);
  // GitHub could not be asked (no network, a rate limit): never "no workspace yet", never a new one started.
  if (!own && !cands.length && found.failed) {
    ui.line('warn', `GitHub could not be asked about your workspace: ${found.failed}. Nothing was started.`);
    return later(ui, changed, st);
  }
  if (!live && own && ui.todo) {
    ui.line('info', 'Your AI brain is not on a git server yet');
    ui.todo('brain');
    return { ok: true, changed, state: st };
  }
  if (!live) {
    ui.note(own ? `Your AI brain is not on a git server yet: ${bold('hoprig workspace git')} in a terminal puts it into a private GitHub repository` : cands.length ? `Your workspace is on GitHub (${cands[0].owner}/${cands[0].name}): ${bold(`hoprig workspace restore ${cands[0].owner}/${cands[0].name}`)}` : `No workspace of yours on GitHub yet: ${bold('hoprig workspace git')} in a terminal starts one`);
    return { ok: true, changed, state: st };
  }
  let pick = null;
  if (own) {
    if (!(await ui.confirm('Your AI brain is not on a git server yet. Keep it in a new private GitHub repository now?', true))) return later(ui, changed, st);
    pick = 'new';
  } else if (cands.length) {
    // Two repositories that both look like a brain with a map: which one, asked; one: yes or no.
    let c = cands[0];
    if (cands.length > 1) {
      const k = await ui.choose('More than one repository of yours looks like the AI brain of a workspace. Which is yours?', [...cands.slice(0, 9).map((x, i) => ({ key: String(i + 1), label: `${x.owner}/${x.name}` })), { key: 'l', label: 'later' }], 'l');
      if (!k || k === 'l') return later(ui, changed, st);
      c = cands[Number(k) - 1];
    } else if (!(await ui.confirm(`Your workspace is on GitHub (${c.owner}/${c.name}). Get it on this computer now? (the AI brain with the map, your credentials and groups' repositories; projects come when you ask for one)`, true))) return later(ui, changed, st);
    const r = await restoreWorkspace(c.url, { ui, dir }).catch((e) => ({ ok: false, error: e.message }));
    if (r.error) ui.line('fail', r.error);
    else {
      for (const e of r.plan.filter((x) => x.action !== 'notHere')) ui.line(String(e.result).startsWith('failed') ? 'fail' : 'ok', `${e.label}: ${e.result}`);
      if (r.notHere) ui.note(`in your map, not on this computer: ${r.notHere.join(', ')} (hoprig get <name> fetches one)`);
    }
    if (!r.error) await afterBrain(ui, { live, dir });
    return { ok: r.ok, changed: true, state: await gitState({ run, has, dir }) };
  } else {
    if (!(await ui.confirm('No workspace of yours on GitHub yet. Start it here: the workspace, its AI brain and the first map, kept in a new private GitHub repository?', true))) return later(ui, changed, st);
    pick = 'new';
  }
  const made = pick === 'new' ? await startNew(ui, { st, run, term, dir, ask: false }) : false;
  if (made) await afterBrain(ui, { live, dir });
  return { ok: made, changed: true, state: await gitState({ run, has, dir }) };
}

const later = (ui, changed, st) => {
  ui.note(`Later: ${bold('hoprig workspace git')}`);
  return { ok: true, changed, state: st };
};

/**
 * Once the brain is here: this computer's label (asked once; the host name is only a suggestion and is stored only
 * when the owner takes it), then "keep the map on your git server by itself" when that was never chosen.
 */
export async function afterBrain(ui, { live, dir }) {
  if (!live) return;
  const c = await import('./computer.mjs');
  if (!c.thisComputer().label) {
    ui.out('  A short name for this computer in your workspace: your other computers see what is here under it.');
    for (let i = 0; i < 3; i++) {
      const typed = ((await ui.ask(`  This computer's name (${c.suggestLabel()}; empty: later): `)) || '').trim();
      if (!typed) {
        ui.note(`Later: ${bold('hoprig workspace label <name>')}`);
        break;
      }
      try {
        const r = await c.setLabel(typed, { dir });
        ui.line('ok', `this computer is ${r.label} in the workspace`);
        break;
      } catch (e) {
        if (e.code !== 'ETAKEN') {
          ui.line('warn', e.message);
          continue;
        }
        const name = c.cleanLabel(typed);
        if (await ui.confirm(`${name} is the name of another computer of yours. Is this computer ${name}, set up again (after a format, for example)?`, false)) {
          const r = await c.setLabel(name, { dir, again: true });
          ui.line('ok', `this computer is ${r.label} again: its list of what is here starts empty`);
          break;
        }
        ui.line('info', 'then pick another name');
      }
    }
  }
  const { loadConfig, saveConfig } = await import('../config.mjs');
  const { readSettings, cleanSettingsPatch } = await import('../automation/settings.mjs');
  const cur = readSettings(loadConfig().automation);
  if (typeof cur.workspace.commitMap === 'boolean') return;
  // The answer turns on "push" too, the switch that also uploads the groups' own and the other repositories while
  // keeping in step is on: then the question says so, and Enter keeps everything as it is.
  const wider = cur.workspace.sync === true && cur.workspace.push !== true;
  const yes = await ui.confirm(`Keep the map on your git server by itself? (when something changes, the map and this computer's file are saved in the AI brain and uploaded${wider ? '; with keeping the workspace in step on, this also uploads your groups\' own repositories and the other repositories when they are only ahead' : ''})`, !wider);
  saveConfig({ automation: cleanSettingsPatch({ workspace: yes ? { commitMap: true, push: true } : { commitMap: false } }, cur) });
  ui.line('ok', yes ? 'the map is kept on your git server by itself' : `the map is not saved by itself (${bold('hoprig workspace auto --commit on --push on')} turns it on)`);
}

/**
 * A new private repository for the brain (made first when there is none), the map in it, pushed. With `owner` and
 * `name` (the dashboard, where the owner already said yes) nothing is asked.
 */
export async function startNew(ui, { st, run, term, dir, owner: wantOwner = null, name: wantName = null, ask = true }) {
  const brain = path.join(dir, 'ai_brain');
  if (!st.brain.exists) {
    const r = await workspaceSetup({ cfg: { workspaceDir: dir } });
    for (const d of r.did) ui.line('ok', `created ${d.path}`);
  }
  if (!isGitRepo(brain)) {
    const i = await initRepo(brain, 'Start the AI brain', run, { root: brain, dir });
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
  const name = wantName || ((ask && ui.interactive && !ui.yes ? await ui.ask('  Its name on GitHub (ai_brain): ') : '') || '').trim() || 'ai_brain';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return ui.line('fail', 'a repository name is letters, digits, ".", "_" and "-"') ?? false;
  // Asked once already (set-up's one path): no second question.
  if (ask && !wantName && !(await ui.confirm(`Create the PRIVATE repository ${owner}/${name} and push your AI brain to it?`, true))) return false;
  const lines = [];
  const r = await createGithubRepo(brain, owner, name, { onLine: (l) => lines.push(l), run: term, at: { dir } });
  if (!r.ok) return ui.line('fail', `gh repo create failed: ${lines.filter(Boolean).pop() || ''} — retry: ${showCommand(['gh', 'repo', 'create', `${owner}/${name}`, '--private', '--source', brain, '--remote', 'origin', '--push'])}`) ?? false;
  ui.line('ok', `private repository ${owner}/${name} created and pushed`);
  // The map now knows the brain's address: write it, commit only that file, push.
  await updateMap({ dir });
  const at = { root: brain, dir };
  await gitIn(at, brain, ['add', '--', MAP_FILE], run);
  const c = await gitIn(at, brain, ['commit', '--quiet', '-m', 'Add the workspace map', '--', MAP_FILE], run);
  if (c.ok) {
    const p = await gitIn(at, brain, ['push', '--quiet'], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    ui.line(p.ok ? 'ok' : 'warn', p.ok ? 'the workspace map is in the brain and pushed' : `the map is committed; push it: ${showCommand(['git', '-C', brain, 'push'])}`);
  }
  ui.note(`On your next computer: ${bold(`hoprig workspace restore ${owner}/${name}`)}`);
  return true;
}
