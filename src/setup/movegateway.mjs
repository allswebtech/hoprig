// A gateway add-on is part of `hoprig move-to-user`: one that ran as root keeps its data (accounts, keys, logs) in a
// folder under root's home, and the provider files' start line (PRERUN) names root's Hoprig. After the move the user
// would have an EMPTY gateway. So, for each gateway whose definition names its data folder (`dataDir`, gateways.mjs)
// and whose port is held by a process of root:
//   root's gateway stopped by the pid of its own listening socket's process (never by a name); its data folder copied
//   to the user and checked (the same count of entries); started as the user with the user's Hoprig, which keeps a
//   gateway on a server to this computer only (localgateway.mjs listenRule); its listener checked to be the user's;
//   each provider's PRERUN in the user's copy pointed at the user's Hoprig. If the user's does not come up, root's is
//   started again as it was. The lines say where it listened before and where it listens now. No gateway is named
//   here: everything comes from the definitions. Every program is reached through `sys` (tests hand in stand-ins).
import { replaceIn } from './movesafe.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { prerunAddonId } from '../addons/gateways.mjs';

/** "every address (0.0.0.0), open to the network" or "this computer only (127.0.0.1)", from a listening address. */
export function whereListens(addr) {
  const host = String(addr || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return `this computer only (${host})`;
  if (host === '0.0.0.0' || host === '::' || host === '*') return `every address (${host}), open to the network`;
  return host ? `${host}, open to the network` : 'unknown';
}

/** The PRERUN line that starts gateway `id` with the user's Hoprig: `<node> <bin> addons start <id>`. */
export const userPrerun = (node, bin, id) => `${[node, bin].filter(Boolean).join(' ')} addons start ${id}`;

/** A provider file with its PRERUN for gateway `id` pointed at `line`; other lines as they were. → { text, changed }. */
export function pointPrerun(text, id, line) {
  let changed = 0;
  const out = String(text).split('\n').map((l) => {
    const m = /^PRERUN=(["']?)(.*)\1\s*$/.exec(l);
    if (!m || prerunAddonId(m[2]) !== id) return l;
    changed += 1;
    return `PRERUN="${line}"`;
  });
  return { text: out.join('\n'), changed };
}

/**
 * Move each gateway of `gateways` ([{ id, title, port, dataDir }]). `sys`: listener(port) → { pid, uid, addr } | null,
 * stop(pid), copyData(from, to) → { ok, entries: [a, b] }, startAsUser(id), startAsRoot(id), userHoprig() → { node,
 * bin }, profilesDir (the user's copy), sleep. → { moved: [..], lines }.
 */
export async function moveGateways(plan, gateways, { sys, say = () => {} } = {}) {
  const { user, oldHome } = plan;
  const moved = [];
  for (const g of gateways) {
    if (!g.dataDir) continue;
    const before = await sys.listener(g.port);
    if (!before) continue;
    if (before.uid !== 0) {
      say(`${g.title}: it does not run as root here: left as it is.`);
      continue;
    }
    const from = path.posix.join(oldHome, g.dataDir);
    const to = path.posix.join(user.home, g.dataDir);
    say(`${g.title} listens on ${whereListens(before.addr)} as root. Stopping it by its own listening process (pid ${before.pid})…`);
    await sys.stop(before.pid);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i += 1) {
      gone = !(await sys.listener(g.port));
      if (!gone) await sys.sleep(500);
    }
    const back = async (why) => {
      say(`${g.title}: ${why}. Starting root's again as it was.`);
      await sys.startAsRoot(g.id);
      moved.push({ id: g.id, ok: false, why });
    };
    if (!gone) {
      say(`${g.title}: root's did not stop: it is left running as root.`);
      moved.push({ id: g.id, ok: false, why: 'did not stop' });
      continue;
    }
    const c = await sys.copyData(from, to);
    if (!c.ok || c.entries[0] !== c.entries[1]) {
      await back(c.ok ? `its data copy has ${c.entries[1]} entries, root's ${c.entries[0]}` : `its data could not be copied (${c.error})`);
      continue;
    }
    say(`${g.title}: its data copied to ${to} (${c.entries[1]} entries, the same as root's).`);
    await sys.startAsUser(g.id);
    let now = null;
    for (let i = 0; i < 30 && !now; i += 1) {
      now = await sys.listener(g.port);
      if (!now) await sys.sleep(500);
    }
    if (!now || now.uid !== user.uid) {
      await back(now ? `what listens on its port runs as user id ${now.uid}, not as ${user.name}` : `it did not come up as ${user.name}`);
      continue;
    }
    // Each provider of the user's copy that starts this gateway names the user's Hoprig.
    const hop = await sys.userHoprig();
    let pointed = 0;
    let names = [];
    try {
      names = fs.readdirSync(sys.profilesDir).filter((n) => n.endsWith('.env'));
    } catch {
      /* none */
    }
    for (const n of names) {
      const f = path.join(sys.profilesDir, n);
      const r = pointPrerun(fs.readFileSync(f, 'utf8'), g.id, userPrerun(hop.node, hop.bin, g.id));
      if (r.changed) {
        try {
          // The user's home, while the user's dashboard runs: never written through a link (movesafe.mjs).
          replaceIn(user.home, f, r.text, { mode: fs.lstatSync(f).mode & 0o777, own: (p) => sys.own?.(p) });
          pointed += 1;
        } catch (e) {
          say(`! ${f} was not changed (${e.message}): point its PRERUN at ${user.name}'s Hoprig by hand.`);
        }
      }
    }
    say(`${g.title} runs as ${user.name}. Before it listened on ${whereListens(before.addr)}; now on ${whereListens(now.addr)}.`);
    if (pointed) say(`${pointed} provider file(s) now start it with ${user.name}'s Hoprig.`);
    moved.push({ id: g.id, ok: true, before: before.addr, now: now.addr, pointed });
  }
  return { moved };
}
