// Why is it slow (design 2.1 example 2), for the providers of this dashboard: a verdict made by code, with no model and no
// request of its own, from what Hoprig already keeps: the router's measure of each provider (the median time to the first
// byte and the refusals of the last five minutes: routerstate.mjs speedVerdict) and the limit state. Unknown stays unknown.

const SLOW_SECONDS = 5; // routerstate.mjs SLOW_MS
const secs = (n) => `${n} s`;

/**
 * `accounts`: { profiles, autoSwitch, recommended } as ops.accounts gives them. -> { cause, say, answering, limited, next }.
 * cause: 'refusing' (a provider that answered "too many requests" or "overloaded" 3 times in 5 minutes), 'limit' (a
 * provider is at its usage limit), 'slow' (first byte over 5 s), 'fine' (measured and fast), 'unknown' (too few answers).
 */
export function slowCause(accounts) {
  const profiles = ((accounts && accounts.profiles) || []).filter((p) => p && !p.virtual && typeof p.name === 'string');
  const name = (p) => String(p.label || p.name).slice(0, 40);
  const answering = profiles.filter((p) => p.speed).map((p) => ({ provider: p.name, label: name(p), verdict: p.speed.verdict, ...(p.speed.seconds !== undefined ? { first_byte_seconds: p.speed.seconds } : {}), sessions: p.inUse || 0 }))
    .sort((a, b) => b.sessions - a.sessions);
  const limited = profiles.filter((p) => p.limited).map((p) => ({ provider: p.name, label: name(p), until: p.limited.until || null, reason: String(p.limited.reason || '').slice(0, 40) }));
  const refusing = answering.filter((x) => x.verdict === 'refusing');
  const slow = answering.filter((x) => x.verdict === 'slow');
  let cause = 'unknown';
  let say = 'Nothing is measured yet: fewer than 3 answers came in the last 5 minutes, so the cause is not known.';
  let next = null;
  if (refusing.length) {
    cause = 'refusing';
    say = `${refusing.map((x) => x.label).join(', ')} refused 3 or more requests in the last 5 minutes ("too many requests" or "overloaded").`;
    next = 'switch the sessions on it to another provider (switch_account), or wait.';
  } else if (limited.length && (slow.length || !answering.length)) {
    cause = 'limit';
    say = `${limited.map((x) => x.label).join(', ')} is at its usage limit${slow.length ? `, and ${slow.map((x) => x.label).join(', ')} is slow` : ''}.`;
    next = 'move the sessions to a provider that is not at its limit (Auto mode does it by itself when it is on).';
  } else if (slow.length) {
    cause = 'slow';
    say = `${slow.map((x) => `${x.label} (the first byte takes ${secs(x.first_byte_seconds)}, over ${SLOW_SECONDS} s)`).join(', ')}.`;
    next = 'start new work on another provider (the router already prefers a faster one when Auto mode is on).';
  } else if (answering.length) {
    cause = 'fine';
    say = `Every measured provider answers within ${SLOW_SECONDS} s: ${answering.map((x) => `${x.label} ${secs(x.first_byte_seconds)}`).join(', ')}. The slowness is not at these providers; it may be the model or the task.`;
  } else if (limited.length) {
    cause = 'limit';
    say = `${limited.map((x) => x.label).join(', ')} is at its usage limit.`;
  }
  return { cause, say, answering: answering.slice(0, 10), limited: limited.slice(0, 10), next, auto: !!(accounts && accounts.autoSwitch && accounts.autoSwitch.enabled), faster_start: (accounts && accounts.recommended) || null };
}
