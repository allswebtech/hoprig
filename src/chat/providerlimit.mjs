// A chat at a usage limit marks its provider the way a terminal session's limit does: with markLimited, the one mark
// the launcher and the watcher write (src/autoswitch.mjs), so Home, the provider lists, Tia and every default that
// picks a provider see it. The mark goes the same ways: its reset time passes, another Claude account signs in, or a
// turn on that provider goes well (here).
import { clearLimited, limitedProfiles, markLimited, parseResets } from '../autoswitch.mjs';
import { detectLimit } from '../server/limits.mjs';

/**
 * A turn that ended on the provider's usage limit, not on another error a chat also shows as a limit (a full context,
 * a per-minute 429): the plan's windows refused, or the message is one the terminal watcher reads as a limit
 * (src/server/limits.mjs), or one of Claude Code's -p forms ("Claude AI usage limit reached|<time>", "5-hour limit
 * reached ∙ resets 2am", "Weekly limit reached ∙ …").
 */
export const usageLimitText = (text) => !!detectLimit(text) || /\b(?:usage|5-hour|weekly|opus|sonnet) limit reached\b/i.test(text);

/**
 * After a turn of chat `c` (ev: how the turn ended). The reset time is the one Claude Code's message says, else the
 * latest reset of the plan's windows that refused (c.limits), else the cooldown of the settings. o: { auto (the name of
 * Auto mode: the router marks its own providers), poke() (the dashboard looks again) }.
 */
export function limitMark(c, ev, o = {}) {
  if (!c.profile || c.profile === o.auto) return;
  try {
    const text = (c.limit && c.limit.text) || '';
    const refused = Object.values(c.limits || {}).filter((w) => w && w.status === 'rejected' && Number.isFinite(w.resetsAt)).map((w) => w.resetsAt);
    if (c.lastEnd === 'limit' && (refused.length || usageLimitText(text))) {
      markLimited(c.profile, { until: parseResets(text) || (refused.length ? Math.max(...refused) : null), reason: 'chat', text });
      o.poke?.();
    } else if (ev && ev.ok && limitedProfiles()[c.profile]) {
      clearLimited(c.profile);
      o.poke?.();
    }
  } catch {
    /* a state folder that cannot be written does not break the chat */
  }
}
