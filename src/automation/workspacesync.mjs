// Keep the workspace in step (off by default): every few hours, every repository of the workspace map is fetched and
// a clean branch that is only behind is fast-forwarded, with the same engine as `hoprig workspace sync`. It pushes
// only when the owner turned pushing on separately. It never merges, rebases, forces or stashes: what needs a
// decision is told once (the same list is not told again until it changes).
//
// Stored: { lastAt, told } (a fingerprint of the last list told to the owner).

/** state: { data, now, settings: { sync, push, everyHours } }. Returns { actions, data }. Action: { type: 'sync', push }. */
export function decide({ data, now, settings }) {
  const d = { lastAt: 0, told: '', ...(data || {}) };
  if (!settings.sync) return { actions: [], data: d };
  if (now - d.lastAt < settings.everyHours * 3600_000) return { actions: [], data: d };
  return { actions: [{ type: 'sync', push: settings.push === true }], data: { ...d, lastAt: now } };
}

/** ctx: { record, notify, data, save, workspaceSync({ push }) → syncAll's result }. */
export async function apply(actions, ctx) {
  const a = actions.find((x) => x.type === 'sync');
  if (!a) return;
  const r = await ctx.workspaceSync({ push: a.push }).catch((e) => ({ error: e.message }));
  if (r.error) {
    ctx.record({ automation: 'workspace', did: 'could not keep the workspace in step', outcome: `failed: ${r.error}` });
    return;
  }
  const did = r.repos.flatMap((x) => x.did.map((d) => `${x.label}: ${d}`));
  const todo = r.repos.flatMap((x) => x.todo.map((t) => `${x.label}: ${t.why}`));
  ctx.record({ automation: 'workspace', did: `kept the workspace in step${did.length ? ` (${did.join('; ')})` : ''}`, outcome: todo.length ? `${todo.length} to decide` : 'ok' });
  const print = todo.join('\n');
  if (todo.length && print !== (ctx.data && ctx.data.told)) {
    ctx.notify({ title: `Workspace: ${todo.length} thing${todo.length > 1 ? 's' : ''} to decide`, message: todo.slice(0, 5).join('\n'), session: '' });
  }
  ctx.save({ ...(ctx.data || {}), told: print });
}

/** The real engine, loaded only when the rule is on. */
export async function realWorkspaceSync({ push }) {
  return (await import('../workspace/sync.mjs')).syncAll({ push });
}
