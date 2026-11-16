// A chat at a usage limit marks its provider the way a terminal session's limit does: with markLimited, the one mark
// the launcher and the watcher write (src/autoswitch.mjs), so Home, the provider lists, Tia and every default that
// picks a provider see it. The mark goes the same ways: its reset time passes, another Claude account signs in, or a
// turn on that provider goes well (here).
import { clearLimited, limitedProfiles, markLimited, parseResets } from '../autoswitch.mjs';

/**
 * After a turn of chat `c` (ev: how the turn ended). The reset time is the one Claude Code's message says, else the
 * latest reset of the plan's windows that refused (c.limits), else the cooldown of the settings. o: { auto (the name of
 * Auto mode: the router marks its own providers), poke() (the dashboard looks again) }.
 */
export function limitMark(c, ev, o = {}) {
  if (!c.profile || c.profile === o.auto) return;
  try {
    if (c.lastEnd === 'limit') {
      const text = (c.limit && c.limit.text) || '';
      const refused = Object.values(c.limits || {}).filter((w) => w && w.status === 'rejected' && Number.isFinite(w.resetsAt)).map((w) => w.resetsAt);
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
