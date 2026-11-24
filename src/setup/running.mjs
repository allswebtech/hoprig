// What the dashboard running now says about itself (GET /api/local/facts, src/server/server.mjs): its version, where
// it really listens, its pid and the sessions of its built-in terminals. Set-up and doctor ask it instead of guessing
// from a probe of 127.0.0.1, which a dashboard listening on every address answers too.
import { runningDashboard, runningKey } from '../server/dashboardfile.mjs';
import { openHost } from './server.mjs';

/**
 * → { version, pid, host, port, backend, terminals } or null (none runs). A dashboard that does not answer the route
 * is described by its dashboard.json, which every version writes when it listens: { version: null, unknown: true,
 * earlier, pid, host, port, backend: null, terminals: null }. `earlier`: its file has no key, so it is a version from
 * before the route (one with a key that did not answer in time is only not known). It runs: never mistaken for none.
 */
export async function runningFacts({ timeout = 2000 } = {}) {
  const d = runningDashboard();
  if (!d) return null;
  const key = runningKey();
  if (key) {
    const host = ['0.0.0.0', '::', ''].includes(d.host) ? '127.0.0.1' : d.host;
    try {
      const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${d.port}/api/local/facts`, { headers: { 'x-hoprig-local-key': key }, signal: AbortSignal.timeout(timeout) });
      if (r.ok) return await r.json();
    } catch {
      /* below: what its file says */
    }
  }
  return { version: null, unknown: true, earlier: !key, pid: d.pid, host: d.host, port: d.port, backend: null, terminals: null };
}

/** Does a dashboard listening on `now` reach other computers differently from the settings' `want`? */
export function listensOtherwise(now, want) {
  if (!now) return false;
  const a = openHost(now);
  const b = openHost(want || '127.0.0.1');
  return a !== b || (a && b && now !== want);
}

/** "on every address", "on this computer only", or "on <address>": where a dashboard listening on `host` answers. */
export const whereWords = (host) => (host === '0.0.0.0' || host === '::' ? 'on every address (open to the network)' : openHost(host) ? `on ${host} (open to the network)` : 'on this computer only');
