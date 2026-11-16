// Which provider a new session starts on when nobody chooses one.
//
// Auto mode on: "auto". Off: what a person expects is the provider used last in that folder (a project worked on a
// team plan stays on it), else the first one not at its limit in the order the Providers page shows them: the Auto
// order, then the rest, subscriptions and gateways before API keys (web/accounts.js inOrder). Pay-per-use keys are
// passed over there unless the owner allows them ("Also use pay-per-use API keys"), as Auto does: a default never
// spends money by itself while another provider can work. Only when nothing else can work is a limited one or a
// paid key the default.
//
// The same rule for every coding tool: only the providers that serve it are candidates, and Auto mode is Claude
// Code's alone. The folder's provider is kept per coding tool when a new conversation starts there by choice
// (Claude Code: launch.mjs, from the dashboard, a terminal or a schedule; not a resume, a move or a restore, nor a
// run the launcher made after a limit. Another tool: its launcher's new conversation and the owner's new chat), in
// <state>/folder-providers.json: { [folder]: { profile, at, tools?: { [tool]: profile } } } (`profile`: Claude
// Code's), the newest MAX folders. It is a convenience: a file that cannot be read or written changes nothing else.
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

/**
 * The provider coding tool `tool` used last in `dir` (kept under the folder's real path: a launcher's working
 * folder), or null.
 */
export function lastProviderIn(dir, all = folderProviders(), tool = 'claude') {
  if (typeof dir !== 'string' || !dir) return null;
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* gone: only the name as given */
  }
  const e = all[dir] || all[real];
  const name = !e ? null : tool === 'claude' ? e.profile : e.tools && typeof e.tools === 'object' ? e.tools[tool] : null;
  return typeof name === 'string' ? name : null;
}

export function rememberFolderProvider(cwd, profile, tool = 'claude') {
  if (typeof cwd !== 'string' || !cwd || typeof profile !== 'string' || !profile || typeof tool !== 'string') return;
  try {
    const all = folderProviders();
    const old = all[cwd] && typeof all[cwd] === 'object' ? all[cwd] : {};
    delete all[cwd];
    const tools = { ...(old.tools && typeof old.tools === 'object' ? old.tools : {}), ...(tool === 'claude' ? {} : { [tool]: profile }) };
    all[cwd] = {
      ...(tool === 'claude' ? { profile } : typeof old.profile === 'string' ? { profile: old.profile } : {}),
      at: Date.now(), ...(Object.keys(tools).length ? { tools } : {}),
    };
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
 * The default provider's name for a session or chat of coding tool `tool` (or null when there is none). `profiles`:
 * the server's provider states ({ name, kind, paid, limited, virtual, tools? }); `auto`: { enabled, order, payPerUse
 * }; `last`: the provider `tool` used last in the folder. Only a provider that serves `tool` is a candidate (`tools`;
 * a state without it is an older one of Claude Code's).
 */
export function chooseDefault({ profiles = [], auto = {}, autoName = 'auto', last = null, tool = 'claude' }) {
  if (auto.enabled && tool === 'claude') return autoName;
  const serves = (p) => (Array.isArray(p.tools) ? p.tools.includes(tool) : tool === 'claude');
  // `unusable`: no coding tool of this version can use it (profiles.mjs publicProfile); never a default.
  const real = profiles.filter((p) => p && !p.virtual && !p.unusable && serves(p));
  const free = (p) => !p.limited;
  // The folder's own provider goes first, under the same two tests as every other: not at its limit, and not a
  // pay-per-use key while that is not allowed and another provider can work.
  const order = (auto.order || []).filter((n) => real.some((p) => p.name === n));
  const rank = (p) => (p.name === last ? -1 : order.includes(p.name) ? order.indexOf(p.name) : order.length + (p.kind === 'api' ? 1 : 0));
  const shown = real.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
  const pick = shown.find((p) => free(p) && (auto.payPerUse || !p.paid)) || shown.find(free) || shown[0];
  return pick ? pick.name : null;
}
