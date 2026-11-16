// What the owner changes in a running chat without a restart (model, effort, ultracode, permission mode) and what
// the chat asks of the running coding tool (context and plan usage). Where the engine cannot change a setting live
// (its capabilities, or the request fails), the coding tool starts again with the conversation resumed once idle.

/**
 * Change `chat`'s settings: in the running process where its engine can, else at its next start. → { restart }
 * An effort change always carries the ultracode value (without it Claude Code turns ultracode off).
 */
export async function applySettings(chat, { model, effort, ultracode, mode }) {
  const caps = chat.engine.capabilities;
  const live = () => !!(chat.session && chat.session.alive);
  const tryLive = async (can, fn) => {
    if (!live()) return true; // the next start has it
    if (!can) return false;
    try {
      await fn(chat.session);
      return true;
    } catch {
      return false;
    }
  };
  let restart = false;
  if (model !== undefined && model !== chat.model) {
    chat.model = model;
    if (!(await tryLive(caps.liveModel, (s) => s.setModel(model)))) restart = true;
  }
  const effortChanged = effort !== undefined && effort !== chat.effort;
  const ultraChanged = ultracode !== undefined && ultracode !== chat.ultracode;
  if (effortChanged || ultraChanged) {
    if (effortChanged) chat.effort = effort;
    if (ultraChanged) chat.ultracode = ultracode;
    if (!(await tryLive(caps.liveEffort && (!ultraChanged || caps.ultracode), (s) => s.setEffort({ effort: chat.effort, ultracode: chat.ultracode })))) restart = true;
  }
  if (mode !== undefined && mode !== chat.permissionMode) {
    chat.permissionMode = mode;
    if (!(await tryLive(caps.liveMode, (s) => s.setMode(mode)))) restart = true;
    else if (live()) {
      chat.bypass = mode === 'bypassPermissions';
      chat.liveMode = mode === 'manual' ? 'default' : mode;
      if (chat.bypass) chat.allowPending();
    }
  }
  if (restart && chat.session) {
    if (chat.busy()) chat.restart = true;
    else chat.stop();
  }
  chat.emit('record');
  chat.emit('state');
  return { restart };
}

/**
 * One window of the plan's limits (five_hour, seven_day, …) into `limits`: { status, percent used, resetsAt (ms) }.
 * Two sources say it differently (both seen on a subscription sign-in): the live limit line (utilization 0…1, reset
 * in seconds) and the usage request (percent, a date). What one does not say keeps what the other said; a window
 * neither says anything about is left out.
 */
export function mergeLimit(limits, window, { status, percent, resetsAt }) {
  const at = typeof resetsAt === 'string' ? Date.parse(resetsAt) || null : Number.isFinite(resetsAt) ? (resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : null;
  const now = { status: typeof status === 'string' ? status : null, percent: Number.isFinite(percent) ? percent : null, resetsAt: at };
  const old = limits[window];
  if (!old && now.status === null && now.percent === null && now.resetsAt === null) return;
  limits[window] = { ...old, ...Object.fromEntries(Object.entries(now).filter(([, x]) => x !== null)), at: Date.now() };
}

/** Context and plan usage, asked of `chat`'s running process (null when it does not run). */
export async function usageNow(chat) {
  if (!chat.session || !chat.engine.capabilities.usage) return null;
  const [context, usage] = await Promise.all([chat.session.contextUsage().catch(() => null), chat.session.usage().catch(() => null)]);
  if (context && Number.isFinite(context.totalTokens)) Object.assign(chat.usage, { contextUsed: context.totalTokens, contextWindow: context.maxTokens, contextPercent: context.percentage });
  if (usage && usage.rate_limits && typeof usage.rate_limits === 'object') {
    for (const [w, r] of Object.entries(usage.rate_limits)) if (r && typeof r === 'object') mergeLimit(chat.limits, w, { status: r.status, percent: r.utilization, resetsAt: r.resets_at ?? r.resetsAt });
  }
  chat.emit('state');
  return { usage: chat.usage, limits: chat.limits, subscription: usage ? usage.subscription_type || null : null, limitsKnown: !!(usage && usage.rate_limits_available) };
}
