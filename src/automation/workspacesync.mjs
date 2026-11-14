// The workspace's upkeep, every few hours and right after the dashboard starts:
//   map   (on by default) the map keeps building itself: written only when something would change, never the first
//         one (src/workspace/upkeep.mjs). With "commitMap" (off by default) the change is committed in the brain,
//         that one file only; with "push" it is uploaded when the brain is purely ahead.
//   sync  (off by default) every repository of the map is fetched and a clean branch that is only behind is
//         fast-forwarded, with the same engine as `hoprig workspace sync` (tools, "sync": false in the map, are left
//         alone). It pushes only when the owner turned pushing on separately. It never merges, rebases, forces or
//         stashes.
// Sync runs first, so the map is written on top of a brain that is up to date. One activity line per real change;
// a notification only when something needs the owner, and the same list is not told again until it changes.
//
// Stored: { lastAt, lastMapAt, told, toldMap } (fingerprints of the last lists told to the owner).

/** state: { data, now, boot, settings: { map, commitMap, sync, push, everyHours } }. Returns { actions, data }. */
export function decide({ data, now, boot = false, settings }) {
  const d = { lastAt: 0, lastMapAt: 0, told: '', toldMap: '', ...(data || {}) };
  const every = settings.everyHours * 3600_000;
  const actions = [];
  const next = { ...d };
  if (settings.sync && now - d.lastAt >= every) {
    actions.push({ type: 'sync', push: settings.push === true });
    next.lastAt = now;
  }
  if (settings.map && (boot || now - d.lastMapAt >= every)) {
    actions.push({ type: 'map', commit: settings.commitMap === true, push: settings.push === true });
    next.lastMapAt = now;
  }
  return { actions, data: next };
}

/** ctx: { record, notify, data, save, workspaceSync({ push }) → syncAll's result, workspaceMap({ commit, push }) → upkeepMap's result }. */
export async function apply(actions, ctx) {
  let data = { ...(ctx.data || {}) };
  const sync = actions.find((x) => x.type === 'sync');
  if (sync) {
    const r = await ctx.workspaceSync({ push: sync.push }).catch((e) => ({ error: e.message }));
    if (r.error) ctx.record({ automation: 'workspace', did: 'could not keep the workspace in step', outcome: `failed: ${r.error}` });
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
    const r = await ctx.workspaceMap({ commit: map.commit, push: map.push }).catch((e) => ({ error: e.message, lines: [], needs: [] }));
    if (r.error) ctx.record({ automation: 'workspace', did: 'could not look at the workspace map', outcome: `failed: ${r.error}` });
    // Nothing changed: no line, no noise.
    for (const l of r.lines || []) {
      const saved = r.commit ? (r.commit.done ? `saved in the brain${r.pushed ? (r.pushed.done ? ' and uploaded' : `; not uploaded: ${r.pushed.why}`) : ''}` : `not saved: ${r.commit.why}`) : 'written (not saved in the brain\'s history: the commitMap switch is off)';
      ctx.record({ automation: 'workspace', did: l, outcome: saved });
    }
    const print = (r.needs || []).join('\n');
    if (print && print !== data.toldMap) ctx.notify({ title: 'Workspace map: something needs you', message: r.needs.slice(0, 5).join('\n'), session: '' });
    data = { ...data, toldMap: print };
  }
  ctx.save(data);
}

/** The real engines, loaded only when used. */
export async function realWorkspaceSync({ push }) {
  return (await import('../workspace/sync.mjs')).syncAll({ push });
}
export async function realWorkspaceMap({ commit, push }) {
  return (await import('../workspace/upkeep.mjs')).upkeepMap({ commit, push });
}
