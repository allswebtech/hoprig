// A reader of process identities as the dashboard has it (src/procid.mjs askInBackground: of() never waits), with the
// answers of macOS (ps lstart, whole seconds) or Windows (creation times) played from a table that a test changes:
// pid → the start the system gives now. Its answers are stamped 3 s in the past, as an answer is by the next look.
import { makeIdentity } from '../src/procid.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
const lstart = (ms) => {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
};
/** A start as `kind`'s system gives it (macOS: whole seconds). */
export const startAs = (kind, ms) => (kind === 'darwin' ? Math.floor(ms / 1000) * 1000 : ms);
export const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * → { id (the reader, in the background), table, asked (the calls made) }. `lag`: how far in the past an answer is
 * stamped; `gate(n)`: a promise the n-th question waits for (the test lets it through).
 */
export function playedReader(kind, table = new Map(), { lag = 3000, gate = null } = {}) {
  const own = startAs(kind, Date.now() - 5000);
  table.set(process.pid, own);
  const asked = [];
  const out = () => [...table].map(([p, s]) => (kind === 'darwin' ? `${p} ${lstart(s)}` : `${p} ${s}`)).join(kind === 'darwin' ? '\n' : '\r\n');
  const id = makeIdentity({
    platform: kind, pid: process.pid, ownStart: own, now: () => Date.now() - lag,
    run: () => {
      throw new Error('the dashboard never waits for the system');
    },
    runLater: async (cmd, args) => {
      asked.push(args);
      const n = asked.length;
      await (gate ? gate(n) : new Promise((r) => setImmediate(r)));
      return out();
    },
  });
  id.askInBackground();
  return { id, table, asked };
}

/** Put `id` in place of the shared reader (src/procid.mjs system) while `fn` runs. */
export async function asSystem(system, id, fn) {
  const names = ['self', 'of', 'refresh', 'askInBackground', 'inBackground', 'bootAt'];
  const was = Object.fromEntries(names.map((n) => [n, system[n]]));
  Object.assign(system, Object.fromEntries(names.map((n) => [n, id[n]])));
  try {
    return await fn();
  } finally {
    Object.assign(system, was);
  }
}
