// The workspace's upkeep, every few hours and right after the dashboard starts:
//   map   (on by default) the map keeps building itself: written only when something would change, never the first
//         one (src/workspace/upkeep.mjs), and this computer's own file in the brain when it has a label. With
//         "commitMap" both are committed in the brain, those two files only; with "memory" the brain's and the
//         groups' memory folders too; with "push" the brain is uploaded, and a brain that moved on the git server too
//         is brought in step by the map's own rule (src/workspace/mapkeep.mjs) when only the map differs here.
//   sync  (off by default) the brain, each group's own repository and the other repositories of the map are fetched
//         and a clean branch that is only behind is fast-forwarded, with the same engine as `hoprig workspace sync`
//         (tools, "sync": false in the map, are left alone). It never touches a project: in the places that hold
//         projects nothing is fetched, fast-forwarded or pushed by itself (`hoprig workspace sync` and the page's Sync
//         do that when the owner asks). It pushes only when the owner turned pushing on. It never merges, rebases,
//         forces or stashes.
//   branches (off by default, one switch per place: "pushBranches") committed work on a branch that is not the
//         default branch is pushed in the projects of that place (src/workspace/branchpush.mjs); a default branch
//         never is.
//   credentials (off by default) a change in the credentials repository the map names is committed ("Update
//         credentials", the folder's own git identity) and pushed to that address only, a GitHub one only while gh
//         says it is private in that round (src/workspace/credrepo.mjs). What is said is counts, never a name in it.
// Sync runs first, so the map is written on top of a brain that is up to date. One activity line per real change;
// a notification only when something needs the owner, and the same list is not told again until it changes.
// While a save of the Work list holds the brain's lock (src/work/lock.mjs), a part skips its round with the reason and
// comes again at the next tick.
//
// Stored: { lastAt, lastMapAt, lastBranchesAt, told, toldMap, toldBranches } (fingerprints of the last lists told), and
// saidOnDemand (the one note that projects are no longer kept in step by it was given).

/** state: { data, now, boot, settings: { map, commitMap, memory, sync, push, pushBranches, everyHours } }. Returns { actions, data }. */
export function decide({ data, now, boot = false, settings }) {
  const d = { lastAt: 0, lastMapAt: 0, lastBranchesAt: 0, lastCredsAt: 0, told: '', toldMap: '', toldBranches: '', toldCreds: '', ...(data || {}) };
  const every = settings.everyHours * 3600_000;
  const actions = [];
  const next = { ...d };
  if (settings.sync && now - d.lastAt >= every) {
    // The map part runs the map's rule this round: the brain it settles is left to it (sync.mjs mapRule).
    const mapRule = settings.map === true && settings.commitMap === true && settings.push === true;
    actions.push({ type: 'sync', push: settings.push === true, ...(mapRule ? { mapRule } : {}) });
    next.lastAt = now;
  }
  if (settings.map && (boot || now - d.lastMapAt >= every)) {
    actions.push({ type: 'map', commit: settings.commitMap === true, push: settings.push === true, memory: settings.memory === true });
    next.lastMapAt = now;
  }
  if (settings.credentials === true && (boot || now - d.lastCredsAt >= every)) {
    actions.push({ type: 'credentials' });
    next.lastCredsAt = now;
  }
  const places = Object.keys(settings.pushBranches || {}).filter((k) => settings.pushBranches[k] === true);
  if (places.length && now - d.lastBranchesAt >= every) {
    actions.push({ type: 'branches', places });
    next.lastBranchesAt = now;
  }
  return { actions, data: next };
}

/** ctx: { record, notify, data, save, workspaceSync({ push, mapRule }) → syncAll's result, workspaceMap({ commit, push, memory }) → upkeepMap's result, workspaceBranches({ places }) → pushBranches' result }. */
export async function apply(actions, ctx) {
  let data = { ...(ctx.data || {}) };
  const sync = actions.find((x) => x.type === 'sync');
  // Said once to an owner who had keeping in step on: projects used to be fetched and pushed by it, and no longer are.
  if (sync && !data.saidOnDemand) {
    ctx.notify({ title: 'Workspace: a project is kept in step when you ask', message: 'Keeping the workspace in step now covers the AI brain, your groups\' own repositories and the other repositories, never a project: Sync on the Workspace page (or hoprig sync <name>) brings a project in step. A project with commits to push, or to pull as of its last fetch, is still told here. Committed work on branches other than the default one can go up by itself: Settings → Workspace → Push my other branches.', session: '' });
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
  ctx.save(data);
}

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
export async function realWorkspaceCredentials() {
  return (await import('../workspace/credrepo.mjs')).upkeepCredentials();
}
export async function realWorkspaceBranches({ places }) {
  return (await import('../workspace/branchpush.mjs')).pushBranches({ on: places });
}
