// The workspace's upkeep, every few hours and right after the dashboard starts:
//   map   (on by default) the map keeps building itself: written only when something would change, never the first
//         one (src/workspace/upkeep.mjs), and this computer's own file in the brain when it has a label. With
//         "commitMap" both are committed in the brain, those two files only; with "memory" the brain's and the
//         groups' memory folders too; with "push" the brain is uploaded, and a brain that moved on the git server too
//         is brought in step by the map's own rule (src/workspace/mapkeep.mjs) when only the map differs here.
//   sync  (off by default) the brain, each group's own repository and the other repositories of the map are fetched
//         and a clean branch that is only behind is fast-forwarded, with the same engine as `hoprig workspace sync`
//         (tools, "sync": false in the map, are left alone). A project is not moved by it but by the look below (`hoprig
//         workspace sync` and the page's Sync do the rest when the owner asks). It pushes only when the owner turned pushing on. It never merges, rebases,
//         forces or stashes.
//   look  (on for the projects folder, off for every group of the owner's own: "ffProjects", one switch per place) every
//         30 minutes and right after start the projects are fetched and a clean branch that is only behind is
//         fast-forwarded (src/workspace/instep.mjs); never a merge, reset, rebase, stash or push. What is left is
//         kept as one row each for the page.
//   branches (off by default, one switch per place: "pushBranches") committed work on a branch that is not the
//         default branch is pushed in the projects of that place (src/workspace/branchpush.mjs); a default branch
//         never is.
//   credentials (off by default) a change in the credentials repository the map names is committed ("Update
//         credentials", the folder's own git identity) and pushed to that address only, a GitHub one only while gh
//         says it is private in that round (src/workspace/credrepo.mjs). What is said is counts, never a name in it.
//   onlyHere (off by default) once a day the check of "Before you format this computer" runs in its cheap form (no
//         git server is asked) and its counts are kept; servers (off by default) once a week each repository of
//         the map is asked on its git server, a read only (src/workspace/onlyherelook.mjs). Neither changes,
//         fetches or uploads anything.
// Sync runs first, so the map is written on top of a brain that is up to date. One activity line per real change;
// a notification only when something needs the owner, and the same list is not told again until it changes.
// While a save of the Work list holds the brain's lock (src/work/lock.mjs), a part skips its round with the reason and
// comes again at the next tick.
//
// Stored: { lastAt, lastMapAt, lastBranchesAt, told, toldMap, toldBranches } (fingerprints of the last lists told), and
// saidOnDemand (the one note that projects are no longer kept in step by it was given).

/** state: { data, now, boot, settings: { map, commitMap, memory, sync, push, pushBranches, everyHours } }. Returns { actions, data }. */
export function decide({ data, now, boot = false, settings }) {
  const d = { lastAt: 0, lastMapAt: 0, lastBranchesAt: 0, lastCredsAt: 0, lastOnlyHereAt: 0, lastServersAt: 0, told: '', toldMap: '', toldBranches: '', toldCreds: '', toldOnlyHere: null, toldServers: null, ...(data || {}) };
  const every = settings.everyHours * 3600_000;
  const actions = [];
  const next = { ...d };
  const syncDue = settings.sync && now - d.lastAt >= every;
  if (syncDue) {
    // The map part runs the map's rule this round: the brain it settles is left to it (sync.mjs mapRule). With the
    // "push" switch off too: the rule then uploads Hoprig's own map commits and nothing else (mapkeep.mjs ownOnly).
    const mapRule = settings.map === true && settings.commitMap === true;
    actions.push({ type: 'sync', push: settings.push === true, ...(mapRule ? { mapRule } : {}) });
    next.lastAt = now;
  }
  if (settings.map && (boot || syncDue || now - d.lastMapAt >= every)) {
    actions.push({ type: 'map', commit: settings.commitMap === true, push: settings.push === true, memory: settings.memory === true });
    next.lastMapAt = now;
  }
  if (settings.credentials === true && (boot || now - d.lastCredsAt >= every)) {
    actions.push({ type: 'credentials' });
    next.lastCredsAt = now;
  }
  // The light look at the projects: every 30 minutes and right after start, while any place's switch is on.
  const ff = settings.ffProjects || {};
  if (Object.values(ff).some((v) => v === true) && (boot || now - (d.lastLookAt || 0) >= LOOK_EVERY_MS)) {
    actions.push({ type: 'look', ff });
    next.lastLookAt = now;
  }
  const places = Object.keys(settings.pushBranches || {}).filter((k) => settings.pushBranches[k] === true);
  if (places.length && now - d.lastBranchesAt >= every) {
    actions.push({ type: 'branches', places });
    next.lastBranchesAt = now;
  }
  // The two looks have their own rhythm, whatever "every how many hours" says: a day, and a week.
  if (settings.onlyHere === true && now - d.lastOnlyHereAt >= DAY_MS) {
    actions.push({ type: 'onlyHere' });
    next.lastOnlyHereAt = now;
  }
  if (settings.servers === true && now - d.lastServersAt >= 7 * DAY_MS) {
    actions.push({ type: 'servers' });
    next.lastServersAt = now;
  }
  return { actions, data: next };
}
const DAY_MS = 86_400_000;
const LOOK_EVERY_MS = 30 * 60_000;

/** ctx: { record, notify, data, save, workspaceSync({ push, mapRule }) → syncAll's result, workspaceMap({ commit, push, memory }) → upkeepMap's result, workspaceBranches({ places }) → pushBranches' result }. */
export async function apply(actions, ctx) {
  let data = { ...(ctx.data || {}) };
  const sync = actions.find((x) => x.type === 'sync');
  // Said once to an owner who had keeping in step on: projects used to be fetched and pushed by it, and no longer are.
  if (sync && !data.saidOnDemand) {
    ctx.notify({ title: 'Workspace: a project is kept in step when you ask', message: 'This covers the AI brain, your groups\' own repositories and the other repositories. The projects are looked at every 30 minutes and before a session starts: a clean branch that is only behind is moved by itself, anything else is listed as Not in step on the Projects page; hoprig sync <name> brings one in step when you ask. Committed work on branches other than the default one can go up by itself: Settings → Workspace → Push my other branches.', session: '' });
    data = { ...data, saidOnDemand: true };
  }
  if (sync) {
    const r = await ctx.workspaceSync({ push: sync.push, mapRule: sync.mapRule === true }).catch((e) => ({ error: e.message }));
    if (r.busy) {
      ctx.record({ automation: 'workspace', did: 'skipped keeping the workspace in step this round', outcome: `skipped: ${r.busy}` });
      data = { ...data, lastAt: 0 };
    } else if (r.error) ctx.record({ automation: 'workspace', did: 'could not keep the workspace in step', outcome: `failed: ${r.error}` });
    else {
      const did = r.repos.flatMap((x) => x.did.map((d) => `${x.label}: ${d}`));
      const todo = r.repos.flatMap((x) => x.todo.map((t) => `${x.label}: ${t.why}`));
      const tools = (r.tools || []).length;
      ctx.record({ automation: 'workspace', did: `kept the workspace in step${did.length ? ` (${did.join('; ')})` : ''}${tools ? `; ${tools} tool${tools > 1 ? 's' : ''} left alone` : ''}`, outcome: todo.length ? `${todo.length} to decide` : 'ok' });
      const print = todo.join('\n');
      if (todo.length && print !== data.told) ctx.notify({ title: `Workspace: ${todo.length} thing${todo.length > 1 ? 's' : ''} to decide`, message: todo.slice(0, 5).join('\n'), session: '' });
      data = { ...data, told: print };
    }
  }
  const map = actions.find((x) => x.type === 'map');
  if (map) {
    const r = await ctx.workspaceMap({ commit: map.commit, push: map.push, memory: map.memory }).catch((e) => ({ error: e.message, lines: [], needs: [] }));
    if (r.busy) {
      ctx.record({ automation: 'workspace', did: 'skipped looking at the workspace map this round', outcome: `skipped: ${r.busy}` });
      data = { ...data, lastMapAt: 0 };
    }
    if (r.error) ctx.record({ automation: 'workspace', did: 'could not look at the workspace map', outcome: `failed: ${r.error}` });
    // Nothing changed: no line, no noise.
    for (const l of r.lines || []) {
      const saved = r.commit ? (r.commit.done ? `saved in the brain${r.pushed ? (r.pushed.done ? ' and uploaded' : `; not uploaded: ${r.pushed.why}`) : ''}` : `not saved: ${r.commit.why}`) : 'written, not saved in the AI brain\'s history (Settings → Workspace: "Save a change of the map" is off)';
      ctx.record({ automation: 'workspace', did: l, outcome: saved });
    }
    const print = (r.needs || []).join('\n');
    if (print && print !== data.toldMap) ctx.notify({ title: 'Workspace map: something needs you', message: r.needs.slice(0, 5).join('\n'), session: '' });
    data = { ...data, toldMap: print };
  }
  const look = actions.find((x) => x.type === 'look');
  if (look && ctx.workspaceLook) {
    const r = await ctx.workspaceLook({ ff: look.ff }).catch((e) => ({ error: e.message, moved: [] }));
    if (r.error) ctx.record({ automation: 'workspace', did: 'could not look at the projects', outcome: `failed: ${r.error}` });
    for (const m of r.moved || []) ctx.record({ automation: 'workspace', did: `${m.label}: pulled ${m.n}`, outcome: 'ok' });
  }
  const br = actions.find((x) => x.type === 'branches');
  if (br && ctx.workspaceBranches) {
    const r = await ctx.workspaceBranches({ places: br.places }).catch((e) => ({ error: e.message, repos: [] }));
    if (r.busy) data = { ...data, lastBranchesAt: 0 };
    else if (r.error) ctx.record({ automation: 'workspace', did: 'could not push the other branches of the projects', outcome: `failed: ${r.error}` });
    else {
      for (const x of r.repos.filter((y) => y.pushed.length)) ctx.record({ automation: 'workspace', did: `${x.label}: pushed ${x.pushed.join(', ')}`, outcome: 'ok' });
      const todo = r.repos.flatMap((x) => x.todo.map((t) => `${x.label}: ${t.why}`));
      const print = todo.join('\n');
      if (todo.length && print !== data.toldBranches) ctx.notify({ title: `Workspace: ${todo.length} branch${todo.length > 1 ? 'es' : ''} not pushed`, message: todo.slice(0, 5).join('\n'), session: '' });
      data = { ...data, toldBranches: print };
    }
  }
  const cr = actions.find((x) => x.type === 'credentials');
  if (cr && ctx.workspaceCredentials) {
    const r = await ctx.workspaceCredentials().catch((e) => ({ error: e.message, lines: [], needs: [] }));
    if (r.error) ctx.record({ automation: 'workspace', did: 'could not keep the credentials', outcome: `failed: ${r.error}` });
    for (const l of r.lines || []) ctx.record({ automation: 'workspace', did: l, outcome: 'ok' });
    // Said once: the same list is not told again until it changes (a public repository is not nagged about every round).
    const print = (r.needs || []).join('\n');
    if (print && print !== data.toldCreds) ctx.notify({ title: 'Workspace credentials: something needs you', message: r.needs.slice(0, 5).join('\n'), session: '' });
    data = { ...data, toldCreds: print };
  }
  // The two looks: a changed answer is one line of the activity; the owner is told only when something needs him,
  // and the same answer is not said or told again. A look that fails is said once, not every day.
  for (const look of [
    { type: 'onlyHere', run: ctx.workspaceOnlyHere, told: 'toldOnlyHere', line: (r) => r.did, none: 'looked: nothing is only on this computer', fail: 'could not look at what is only on this computer',
      title: 'Workspace: something is only on this computer', more: 'Computers → Before you format this computer shows what and where.' },
    { type: 'servers', run: ctx.workspaceServers, told: 'toldServers', line: (r) => r.did, none: 'looked at the git servers: each one asked has what this computer knows', fail: 'could not look at the git servers',
      title: 'Workspace: a git server no longer has what this computer knows', more: 'Nothing was changed here.' },
  ]) {
    if (!actions.some((x) => x.type === look.type) || !look.run) continue;
    let print;
    try {
      const r = await look.run();
      print = look.type === 'onlyHere' ? onlyHereWords(r) : serversWords(r);
    } catch (e) {
      print = `failed: ${e.message}`;
    }
    if (print === data[look.told]) continue;
    if (print.startsWith('failed: ')) ctx.record({ automation: 'workspace', did: look.fail, outcome: print });
    else {
      ctx.record({ automation: 'workspace', did: print || look.none, outcome: 'ok' });
      if (print) ctx.notify({ title: look.title, message: `${print}. ${look.more}`, session: '' });
    }
    data = { ...data, [look.told]: print };
  }
  ctx.save(data);
}

// The looks' sentences (src/workspace/onlyherelook.mjs holds the words; given here so apply stays one synchronous read).
import { onlyHereLine as onlyHereWords, serversLine as serversWords } from '../workspace/onlyherelook.mjs';

/** Run `fn` holding the AI brain's lock, or → { busy: why, lines: [], needs: [] } while a save of the Work list has it. */
async function inBrain(fn) {
  const [{ tryRepoLock }, { workspaceDir }, path] = await Promise.all([import('../work/lock.mjs'), import('../workspace/layout.mjs'), import('node:path')]);
  const release = await tryRepoLock(path.join(workspaceDir(), 'ai_brain'), { who: 'upkeep' });
  if (!release) return { busy: 'a save of the Work list is using the AI brain right now', lines: [], needs: [] };
  try {
    return await fn();
  } finally {
    release();
  }
}

/** The real engines, loaded only when used. */
export async function realWorkspaceSync({ push, mapRule = false }) {
  return inBrain(async () => (await import('../workspace/sync.mjs')).syncAll({ push, upkeep: true, mapRule }));
}
export async function realWorkspaceMap({ commit, push, memory }) {
  return inBrain(async () => (await import('../workspace/upkeep.mjs')).upkeepMap({ commit, push, memory }));
}
export async function realWorkspaceOnlyHere() {
  return (await import('../workspace/onlyherelook.mjs')).lookOnlyHere();
}
export async function realWorkspaceServers() {
  return (await import('../workspace/onlyherelook.mjs')).lookServers();
}
export async function realWorkspaceCredentials() {
  return (await import('../workspace/credrepo.mjs')).upkeepCredentials();
}
export async function realWorkspaceLook({ ff }) {
  return (await import('../workspace/instep.mjs')).lookProjects({ ff });
}
export async function realWorkspaceBranches({ places }) {
  return (await import('../workspace/branchpush.mjs')).pushBranches({ on: places });
}
