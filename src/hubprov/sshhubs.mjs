// A hub that reaches this computer over SSH (or that this computer added a token for): it tells this computer where its
// relay is. That is ONE more forward on the very ssh connection the hub already holds (src/machines/tunnels.mjs): a port on
// this computer's own loopback that leads to the hub's relay, plus a relay secret made for this computer alone.
//
// Kept in <state>/hubprov-hubs.json (mode 600), one entry per machine token of the hub: its label, the last list it pushed
// and the relay. The address is always this computer's own loopback; only the port comes from the hub. The secret lets this
// computer USE the hub's providers; it can never read a key (the hub adds the key and the answer comes back without it).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { replaceFile } from '../replacefile.mjs';
import { RELAY_SECRET_RE } from './list.mjs';

const ID_RE = /^[0-9a-f]{12,64}$/;
export const sshHubsFile = () => path.join(stateDir(), 'hubprov-hubs.json');

/** { relay: {secret, port} } as pushed: null unless it is exactly a secret of the right shape and a port that is not a system port. */
export function cleanRelay(r) {
  if (!r || typeof r !== 'object') return null;
  const port = Number(r.port);
  if (!RELAY_SECRET_RE.test(String(r.secret)) || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return { secret: String(r.secret), port };
}

export function loadSshHubs() {
  try {
    const j = JSON.parse(fs.readFileSync(sshHubsFile(), 'utf8')).hubs || {};
    const out = {};
    for (const [id, h] of Object.entries(j)) if (ID_RE.test(id) && h && cleanRelay(h.relay)) out[id] = { hub: String(h.hub || '').slice(0, 40), relay: cleanRelay(h.relay), list: h.list || null, at: Number(h.at) || 0 };
    return out;
  } catch {
    return {};
  }
}
export function saveSshHubs(hubs) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const file = sshHubsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ hubs }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  replaceFile(tmp, file);
}
