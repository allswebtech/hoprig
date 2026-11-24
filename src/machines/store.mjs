// The other computers this dashboard shows: <configDir>/machines.json, mode 600 because it holds their tokens.
//
//   { "machines": [ { name, label, via: "ssh" | "url" | "join", target, remoteHost, remotePort,   (via ssh)
//                                                    url,                                (via url)
//                                                    port, joinId     (via join: it connects by itself, join.mjs)
//                                                    port, linkId, linkHash   (via link: the direct link, link.mjs)
//                      token, tokenId, added, info: { hostname, platform, version },
//                      key: true   (via ssh, added with a key file: keys.mjs keeps it, never this file),
//                      seenAt       (when its health was last read: hub.mjs health) } ] }
//
// Read fresh on every use (it is small), so the CLI and the running dashboard always agree.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../paths.mjs';
import { dashboardUrl, label as cleanLabel, machineName, sshTarget } from './names.mjs';

export const machinesFile = () => path.join(configDir(), 'machines.json');

function valid(m) {
  if (!m || !machineName(m.name) || typeof m.token !== 'string') return false;
  if (m.via === 'ssh') return !!sshTarget(m.target) && Number.isInteger(m.remotePort) && typeof m.remoteHost === 'string';
  if (m.via === 'url') return !!dashboardUrl(m.url);
  if (m.via === 'join') return Number.isInteger(m.port) && m.port > 0 && m.port < 65536 && /^[0-9a-f]{12}$/.test(String(m.joinId));
  if (m.via === 'link') return Number.isInteger(m.port) && m.port > 0 && m.port < 65536 && /^[0-9a-f]{12}$/.test(String(m.linkId)) && /^[0-9a-f]{64}$/.test(String(m.linkHash));
  return false;
}

export function loadMachines() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(machinesFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`${machinesFile()}: ${e.message}`);
  }
  return (Array.isArray(data && data.machines) ? data.machines : []).filter(valid);
}

export function saveMachines(list) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${machinesFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ machines: list }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, machinesFile());
}

export const getMachine = (name) => loadMachines().find((m) => m.name === name) || null;

/** Add `m`, or replace the machine with the same name (pairing again after a token was revoked). */
export function putMachine(m) {
  if (!valid(m)) throw new Error('not a valid machine entry');
  const list = loadMachines().filter((x) => x.name !== m.name);
  list.push(m);
  saveMachines(list);
  return m;
}

export function removeMachine(name) {
  const list = loadMachines();
  const gone = list.find((m) => m.name === name) || null;
  if (gone) saveMachines(list.filter((m) => m !== gone));
  return gone;
}

/** Change the name and/or the label. Throws on a bad or taken name. */
export function renameMachine(name, { name: next, label } = {}) {
  const list = loadMachines();
  const m = list.find((x) => x.name === name);
  if (!m) throw Object.assign(new Error('no such computer'), { status: 404 });
  if (next !== undefined && next !== name) {
    if (!machineName(next)) throw Object.assign(new Error('use 1-32 lower-case letters, digits, - and _ (starting with a letter or digit)'), { status: 400 });
    if (list.some((x) => x.name === next)) throw Object.assign(new Error('that name is taken'), { status: 409 });
    m.name = next;
  }
  if (label !== undefined) {
    const l = cleanLabel(label);
    if (!l) throw Object.assign(new Error('the label must be 1 to 40 characters on one line'), { status: 400 });
    m.label = l;
  }
  saveMachines(list);
  return m;
}

/** What the page and the CLI may see: never the token. */
export const publicMachine = (m) => ({
  name: m.name,
  label: m.label || m.name,
  via: m.via,
  target: m.via === 'ssh' ? m.target : null,
  url: m.via === 'url' ? m.url : null,
  added: m.added || null,
  info: m.info || null,
  key: m.key === true, // added with a key file this dashboard keeps (keys.mjs); never the key itself
});
