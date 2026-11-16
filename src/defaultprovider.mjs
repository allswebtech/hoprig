// Which provider a new session starts on when nobody chooses one.
//
// Auto mode on: "auto". Off: what a person expects is the provider used last in that folder (a project worked on a
// team plan stays on it), else the first one not at its limit in the order the Providers page shows them: the Auto
// order, then the rest, subscriptions and gateways before API keys (web/accounts.js inOrder). Pay-per-use keys are
// passed over there unless the owner allows them ("Also use pay-per-use API keys"), as Auto does: a default never
// spends money by itself while another provider can work. Only when nothing else can work is a limited one or a
// paid key the default.
//
// The folder's provider is kept when Claude Code starts there (launch.mjs: every launch, from the dashboard, a
// terminal or a move to another provider), in <state>/folder-providers.json: { [folder]: { profile, at } }, the
// newest MAX folders. It is a convenience: a file that cannot be read or written changes nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';

const MAX = 100;
const file = () => path.join(stateDir(), 'folder-providers.json');

/** { [folder]: { profile, at } } */
export function folderProviders() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** The provider used last in `dir` (kept under the folder's real path: a launcher's working folder), or null. */
export function lastProviderIn(dir, all = folderProviders()) {
  if (typeof dir !== 'string' || !dir) return null;
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* gone: only the name as given */
  }
  const e = all[dir] || all[real];
  return e && typeof e.profile === 'string' ? e.profile : null;
}

export function rememberFolderProvider(cwd, profile) {
  if (typeof cwd !== 'string' || !cwd || typeof profile !== 'string' || !profile) return;
  try {
    const all = folderProviders();
    delete all[cwd];
    all[cwd] = { profile, at: Date.now() };
    const keep = Object.fromEntries(Object.entries(all).slice(-MAX)); // the newest last: a folder used again moved there
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keep) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    /* only a convenience */
  }
}

/**
 * The default provider's name (or null when there is none). `profiles`: the server's provider states ({ name, kind,
 * paid, limited, virtual, tools? }); `auto`: { enabled, order, payPerUse }; `last`: the provider used last in the
 * folder. Only a provider that serves Claude Code is a candidate (`tools`, where the states carry it).
 */
export function chooseDefault({ profiles = [], auto = {}, autoName = 'auto', last = null }) {
  if (auto.enabled) return autoName;
  const real = profiles.filter((p) => p && !p.virtual && (!Array.isArray(p.tools) || p.tools.includes('claude')));
  const free = (p) => !p.limited;
  const used = last && real.find((p) => p.name === last);
  if (used && free(used)) return used.name;
  const order = (auto.order || []).filter((n) => real.some((p) => p.name === n));
  const rank = (p) => (order.includes(p.name) ? order.indexOf(p.name) : order.length + (p.kind === 'api' ? 1 : 0));
  const shown = real.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
  const pick = shown.find((p) => free(p) && (auto.payPerUse || !p.paid)) || shown.find(free) || shown[0];
  return pick ? pick.name : null;
}
