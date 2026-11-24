// Doctor's line about a gateway on a server that listens wider than this computer. A gateway Hoprig starts on a server
// gets its "this computer only" words (localgateway.mjs hostArgs), but one an earlier version started keeps listening
// where it started until it is started again: on a server that is the internet, over plain http, with the providers'
// keys behind it. Only a gateway Hoprig started is looked at (its pid file in Hoprig's state folder): a program the
// owner runs himself is his own. Where it listens is read from the kernel's table of sockets (/proc/net/tcp and tcp6,
// Linux): no connection is made and no program is started.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { filedProcess } from '../procid.mjs';

/** The listening sockets in /proc/net/tcp text: [{ port, wide }], wide when the address is not a loopback one. */
export function listeners(text) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3] !== '0A') continue; // 0A: LISTEN
    const [addr, portHex] = f[1].split(':');
    if (!portHex) continue;
    // IPv4 is written as one little-endian word ("0100007F" is 127.0.0.1); IPv6 as four, ::1 is "…01000000", and an
    // IPv4-mapped address ends in the IPv4 word.
    const loop = addr.length === 8 ? addr.endsWith('7F') : addr === '00000000000000000000000001000000' || (/^0{16}FFFF0000/i.test(addr) && addr.endsWith('7F'));
    out.push({ port: parseInt(portHex, 16), wide: !loop });
  }
  return out;
}

const readNet = () => ['/proc/net/tcp', '/proc/net/tcp6'].map((f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}).join('\n');

/**
 * Does the gateway `id` that Hoprig started still run: its pid file names a process that is shown to be that one (the
 * add-on's own rule, procid.mjs filedProcess)? A file a crash or a restart of the computer left behind is not: the port
 * may now be another program's, the owner's own.
 */
function startedByHoprig(id) {
  const file = path.join(stateDir(), 'addons', `${id}.pid`);
  let rec;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    rec = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
  } catch {
    return false;
  }
  return Number.isInteger(rec?.pid) && rec.pid > 0 && filedProcess(file, rec) === true;
}

/**
 * The doctor results for gateways on a server: one failing line for each gateway Hoprig started whose port listens on
 * an address beyond this computer. `gateways`: the add-ons (gateways.mjs gatewayAddons); `net`: the text of
 * /proc/net/tcp(6), for tests.
 */
export function gatewayChecks(gateways, { reason, platform = process.platform, net = null, started = startedByHoprig } = {}) {
  if (!reason || platform !== 'linux') return [];
  const out = [];
  let socks = null;
  for (const g of gateways) {
    if (!g.gateway || !started(g.id)) continue;
    const port = Number(g.gateway.port());
    socks ??= listeners(net ?? readNet());
    if (!socks.some((s) => s.port === port && s.wide)) continue;
    const kept = g.keptLocal ? g.keptLocal() : null;
    const fix = kept === false
      ? `add "localOnly": ["--host", "127.0.0.1"] (the words its program takes) to its definition in config.json, then: hoprig addons stop ${g.id} && hoprig addons start ${g.id}`
      : `hoprig addons stop ${g.id} && hoprig addons start ${g.id}   (started again, it listens on this computer only)`;
    out.push({ id: `gateway-${g.id}`, label: g.title, status: 'fail', detail: `listens on port ${port} beyond this computer, and this computer is a server: anyone who reaches it can use your providers through it (plain http)`, fix });
  }
  return out;
}
