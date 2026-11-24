// Settings → Notifications → "Work": what Work tells the owner by itself (tell.mjs), kept in its own key,
// server.notify.work, and NOT among server.notify.events: a push address with no events list gets every event of that
// list, so a new name there would be switched on by an update. Every item is off until he turns it on.
//
//   finished      something finished and waits for his look                     default off
//   live          a task a session did here is marked done                        default off
//   failed        something failed or stopped (why, in the tool's words)          default off
//   waits         a session has waited for his answer longer than waitsMinutes    default off, 15 minutes
//   digest        every digestHours while work runs: what finished, runs, waits   default off, 4 hours
//   gapMinutes    at most one message in this many minutes ("waits" excepted)     default 10
//   quietFrom/To  quiet hours "HH:MM" (both or neither): held, told as one after  default none
//   tiaWords      Tia words the digest in the language he writes to her in       default off
// No imports: notify.mjs checks it as part of server.notify.

export const TELL_DEFAULTS = Object.freeze({ finished: false, live: false, failed: false, waits: false, waitsMinutes: 15, digest: false, digestHours: 4, gapMinutes: 10, quietFrom: '', quietTo: '', tiaWords: false });
export const TELL_ITEMS = ['finished', 'live', 'failed', 'waits', 'digest'];
const BOOLS = [...TELL_ITEMS, 'tiaWords'];
const NUMS = { waitsMinutes: [1, 1440], digestHours: [1, 24], gapMinutes: [0, 240] };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Check server.notify.work as it comes from the browser. → the clean object (only what differs is kept); throws a plain Error. */
export function cleanTell(v) {
  if (v === null || v === undefined) return undefined;
  if (!isObj(v)) throw new Error('the Work notifications must be an object');
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (BOOLS.includes(k)) {
      if (typeof x !== 'boolean') throw new Error(`${k} is on or off (true or false)`);
      out[k] = x;
    } else if (NUMS[k]) {
      const [lo, hi] = NUMS[k];
      if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`${k} is a whole number from ${lo} to ${hi}`);
      out[k] = x;
    } else if (k === 'quietFrom' || k === 'quietTo') {
      if (x !== '' && (typeof x !== 'string' || !HHMM.test(x))) throw new Error('quiet hours are times like 22:30');
      out[k] = x;
    } else throw new Error(`"${String(k).slice(0, 30)}" is not a Work notification setting`);
  }
  if (!!out.quietFrom !== !!out.quietTo || (out.quietFrom && out.quietFrom === out.quietTo)) throw new Error('quiet hours need a start and a different end, or neither');
  return out;
}

/** The Work notification settings of a config, the defaults filled in. Read tolerantly: a bad value is its default. */
export function tellSettings(cfg) {
  const n = cfg && cfg.server && isObj(cfg.server.notify) ? cfg.server.notify : null;
  let w = {};
  try {
    w = (n && cleanTell(n.work)) || {};
  } catch {
    w = {};
  }
  return { ...TELL_DEFAULTS, ...w, push: !!(n && typeof n.url === 'string' && n.url) };
}

/** True when anything of it is on and can go somewhere: else Work tells nothing, reads nothing and writes nothing. */
export const tellOn = (s) => s.push && TELL_ITEMS.some((k) => s[k]);
