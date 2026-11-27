// What the owner changes in a running chat without a restart (model, effort, ultracode, permission mode) and what
// the chat asks of the running coding tool (context and plan usage). Where the engine cannot change a setting live
// (its capabilities, or the request fails), the coding tool starts again with the conversation resumed once idle.
import { setOwnName } from '../titles.mjs';
import { sdkMode } from './engines/claude-lines.mjs';
import { syncAllMark } from './asks.mjs';

/**
 * Change `chat`'s settings: in the running process where its engine can, else at its next start. → { restart }
 * An effort change always carries the ultracode value (without it Claude Code turns ultracode off).
 */
export async function applySettings(chat, { model, effort, ultracode, mode, lead, others }) {
  const caps = chat.engine.capabilities;
  const live = () => !!(chat.session && chat.session.alive);
  const tryLive = async (can, fn) => {
    if (!live()) return true; // the next start has it
    if (!can) return false;
    try {
      await fn(chat.session);
      chat.knowSize(); // what it wrote for it (a mode line) is the session's own, not someone else's (growth.mjs)
      return true;
    } catch {
      return false;
    }
  };
  let restart = false;
  if (model !== undefined && model !== chat.model) {
    chat.model = model;
    chat.autoSeen = false; // auto mode needs a model that has it: learned again from the process's next report
    if (!(await tryLive(caps.liveModel, (s) => s.setModel(model)))) restart = true;
  }
  const effortChanged = effort !== undefined && effort !== chat.effort;
  const ultraChanged = ultracode !== undefined && ultracode !== chat.ultracode;
  if (effortChanged || ultraChanged) {
    if (effortChanged) chat.effort = effort;
    if (ultraChanged) chat.ultracode = ultracode;
    if (!(await tryLive(caps.liveEffort && (!ultraChanged || caps.ultracode), (s) => s.setEffort({ effort: chat.effort, ultracode: chat.ultracode })))) restart = true;
    // A process started without the Workflow tool (chip off) cannot get it back live: it starts again with it.
    if (ultraChanged && chat.ultracode && live() && chat.session.noWorkflow) restart = true;
  }
  if (mode !== undefined && mode !== chat.permissionMode) {
    chat.permissionMode = mode;
    syncAllMark(chat);
    if (!(await tryLive(caps.liveMode, (s) => s.setMode(mode)))) {
      restart = true;
      // The process keeps its mode until it ends (a process started before Settings allowed bypass refuses it): the
      // page shows the mode chosen, with its note, and Shift+Tab goes on from it.
      if (live()) chat.modeLater = mode;
    } else if (live()) {
      chat.modeLater = null;
      chat.bypass = sdkMode(mode) === 'bypassPermissions';
      chat.liveMode = sdkMode(mode);
      if (chat.bypass) chat.allowPending();
    }
  }
  // Lead's helpers are given at the start only: a change takes effect when the process starts again.
  if (typeof lead === 'boolean' && lead !== chat.lead) {
    chat.lead = lead;
    if (chat.session) restart = true;
  }
  // The ticks are named to the lead at its start: a change is told with the next start.
  if (Array.isArray(others) && JSON.stringify(others) !== JSON.stringify(chat.others)) {
    chat.others = others;
    if (chat.session && chat.lead) restart = true;
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
  if (context && Number.isFinite(context.totalTokens)) {
    Object.assign(chat.usage, { contextUsed: context.totalTokens, contextWindow: context.maxTokens, contextPercent: context.percentage });
    // What fills it, as Claude Code's /context counts it (the session rail's Context card, when opened).
    const cats = Array.isArray(context.categories) ? context.categories : [];
    chat.usage.contextCategories = cats.filter((x) => x && typeof x.name === 'string' && Number.isFinite(x.tokens) && x.tokens > 0)
      .slice(0, 20).map((x) => ({ name: x.name.slice(0, 60), tokens: Math.round(x.tokens) }));
  }
  if (usage && usage.rate_limits && typeof usage.rate_limits === 'object') {
    for (const [w, r] of Object.entries(usage.rate_limits)) if (r && typeof r === 'object') mergeLimit(chat.limits, w, { status: r.status, percent: r.utilization, resetsAt: r.resets_at ?? r.resetsAt });
  }
  chat.emit('state');
  return { usage: chat.usage, limits: chat.limits, subscription: usage ? usage.subscription_type || null : null, limitsKnown: !!(usage && usage.rate_limits_available) };
}

/**
 * The owner names `chat` in the dashboard. The running coding tool is told too where it can (then a terminal that
 * resumes the conversation shows the same name); the name is kept with the chat either way.
 */
export async function renameChat(chat, title) {
  chat.title = title;
  chat.named = true;
  // Kept per conversation in the state folder (titles.mjs), before the coding tool is told: the person's newest rename
  // wins, wherever it was typed; a generated title never wins over it, also after a restart, in every list.
  setOwnName(chat.conversationId, title, chat.file());
  chat.emit('record');
  chat.emit('state');
  if (chat.session && chat.session.alive && chat.engine.capabilities.rename) {
    await chat.session.rename(title).then(() => chat.knowSize(), () => {}); // its custom-title line is the session's own
  }
}
