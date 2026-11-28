// Asks Tia's door (src/assistant/door.mjs) one question for every route of the server: does it let the request through?
// The same question is asked of the door before and after it was derived from the acts file, and the answers must be
// the same (test/assistant/acts-door.test.mjs). A question is a route (its sample paths, variants of each: as it is,
// behind a computer's prefix, with a word more, with a letter more, with a word put as public-link; each with its own
// method and with the other of GET and POST), a body (BODIES) and a card (none, or one of CARDS that the owner
// confirmed). Only the answers that are yes somewhere are kept: the rest must be no, always.
import { runConfirmed } from '../../../src/assistant/confirmed.mjs';

export const BODIES = [
  {}, { confirm: 'box2' }, { text: 'x' }, { key: 'Enter' }, { on: true }, { on: false }, { dir: '/x', defaults: true, byTia: true },
  { at: 0, status: 'done' }, { at: 0 }, { name: 'n' }, { id: 'i' }, { dryRun: true }, { sessionDefaults: { model: 'm' } },
  { server: { roots: ['/y'] } }, { autoSwitch: { enabled: true } }, { paused: true }, { updates: { claude: 'auto' } }, { kits: ['basics'] },
  { request: 'r', allow: true }, { profile: 'p' }, { title: 't' }, { session: 's' }, { goal: 'g', dryRun: true }, { task: 't' },
  { hash: 'a'.repeat(32) }, { brief: 'b', at: 0 }, { text: 'x', byTia: true }, { title: 't', goal: 'g' }, { name: 'a', project: 'p' }, null,
];

/** Cards the owner confirmed: the acts whose route passes only as the act of such a card. */
export const CARDS = [
  { id: 'c1', tool: 'manage_computer', input: { action: 'setup_fix', check: 'i' } },
  { id: 'c2', tool: 'manage_computer', input: { action: 'addon', addon: 'alpha', addon_action: 'start' } },
  { id: 'c3', tool: 'manage_computer', input: { action: 'addon', addon: 'alpha', addon_action: 'stop' } },
  { id: 'c4', tool: 'manage_computer', input: { action: 'addon', addon: 'alpha', addon_action: 'install' } },
  { id: 'c5', tool: 'manage_computer', input: { action: 'addon', addon: 'alpha', addon_action: 'update' } },
  { id: 'c6', tool: 'manage_computer', input: { action: 'restart_dashboard' } },
  { id: 'c7', tool: 'hoprig_act', input: { act: 'restart-hoprig' } },
  { id: 'c8', tool: 'manage_computer', input: { action: 'addon', addon: 'alpha', addon_action: 'start', computer: 'alpha' } },
  { id: 'c9', tool: 'manage_computer', input: { action: 'setup_fix', check: 'i', computer: 'alpha' } },
  { id: 'c10', tool: 'manage_computer', input: { action: 'restart_dashboard', computer: 'alpha' } },
  { id: 'c11', tool: 'manage_project', input: { action: 'sync' } },
];

const ctx = () => ({
  config: () => ({ server: { roots: ['/x'] }, sessionDefaults: { permissionMode: 'default' }, assistant: { enabled: true, level: 'work', actAlone: true } }),
  settingsOf: () => ({ sessionDefaults: { permissionMode: 'default' } }),
  poke() {},
});

// Each address, behind a computer's prefix, with a word more, with a letter more, and with each of its words after the first
// two put as "public-link" (the add-on that opens this computer to the internet is an id of the routes of every add-on).
export const variantsOf = (p) => {
  const segs = p.split('/');
  const named = segs.flatMap((seg, i) => (i >= 3 && seg !== 'public-link' ? [segs.map((x, j) => (j === i ? 'public-link' : x)).join('/')] : []));
  return [p, `/m/alpha${p}`, `${p}/x`, `${p}x`, ...named];
};

/**
 * { passes: [[method, path, card, bits]], classes: [[path, class]] }: `bits` has one character per body, 1 for yes.
 * `routes`: [{ method, paths: [sample paths] }]. `neverClassOf`: the door's class of a path, or null. `ALLOW`: the door's list.
 */
export function probe({ checkRoute, neverClassOf, ALLOW }, routes) {
  // Only a route with an entry that asks for a confirmed card is asked with the cards (it is the only one that looks at one).
  const needsCard = (method, url) => ALLOW.some((e) => e.card && e.method === method && e.re.test(url.replace(/^\/m\/alpha/, '')));
  const passes = [];
  const classes = new Map();
  const seen = new Set();
  const ask = (method, url, body, card) => {
    const f = () => {
      checkRoute(method, url, body, ctx());
      return true;
    };
    try {
      return card ? runConfirmed(card, f) : f();
    } catch {
      return false;
    }
  };
  for (const r of routes) {
    for (const p of r.paths) {
      // Each address is asked with its own method and with the other one of GET and POST: a route that reads is not the one that writes.
      for (const method of [r.method, r.method === 'GET' ? 'POST' : 'GET']) {
        for (const url of variantsOf(p)) {
          const k = `${method} ${url}`;
          if (seen.has(k)) continue;
          seen.add(k);
          // A card is kept only where it changes the answer (a route that does not look at it answers the same).
          let none = '';
          [null, ...(needsCard(method, url) ? CARDS : [])].forEach((card, ci) => {
            const bits = BODIES.map((b) => (ask(method, url, b === null ? null : structuredClone(b), card) ? '1' : '0')).join('');
            if (ci === 0) none = bits;
            if (ci === 0 ? bits.includes('1') : bits !== none) passes.push([method, url, ci, bits]);
          });
        }
      }
      for (const url of [p, `${p}/x`, ...variantsOf(p).slice(4)]) if (!classes.has(url)) classes.set(url, neverClassOf(url) || '');
    }
  }
  return { passes, classes: [...classes].filter(([, c]) => c) };
}
