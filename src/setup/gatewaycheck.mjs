// Doctor's line about a gateway on a server that listens wider than this computer. A gateway Hoprig starts on a server
// gets its "this computer only" words (localgateway.mjs hostArgs), but one an earlier version started keeps listening
// where it started until it is started again: on a server that is the internet, over plain http, with the providers'
// keys behind it. Only a gateway Hoprig started is looked at (its pid file in Hoprig's state folder): a program the
// owner runs himself is his own. Where it listens is read from the kernel's table of sockets (/proc/net/tcp and tcp6,
// Linux): no connection is made and no program is started.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { filedProcess, freshAfter } from '../procid.mjs';

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
  return Number.isInteger(rec?.pid) && rec.pid > 0 && filedProcess(file, rec, { after: freshAfter() }) === true; // a fresh identity (procid.mjs freshAfter)
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

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Doctor's lines about a gateway with a copy of its own in Hoprig's folder (an add-on with `folders()`): which copy runs
 * (and that this user can change the own one), that its data folder and the files in it are this user's, and that it
 * answers its health route when it runs, each with its next step. Nothing is said for one that is not installed and
 * not running. A folder of root's is named as root's. `uid`, `owner` (stat → a name or null): for tests.
 */
export async function ownGatewayChecks(gateways, { uid = process.getuid?.(), owner = null } = {}) {
  const out = [];
  const who = (st) => owner?.(st) || (st.uid === 0 ? 'root' : `another user (user id ${st.uid})`);
  const theirs = (st) => uid !== undefined && st.uid !== uid;
  for (const g of gateways) {
    if (typeof g.folders !== 'function') continue;
    // The copy is read from files: a computer with no copy of it is not asked anything (nothing is knocked on).
    const info = g.copyInfo();
    if (!info) continue;
    const run = await g.answering();
    const st = { ...info, running: run.mine, foreign: run.up && !run.mine, note: run.otherUser ? `its port is held by a program of another user: ${g.title} leaves it alone and sends it no key` : null };
    const { copy, data, global } = g.folders();
    const id = `gateway-${g.id}`;
    const add = (part, label, status, detail, fix = '') => out.push({ id: `${id}-${part}`, label: `${g.title}: ${label}`, status, detail, fix });
    // Which copy, and may this user change it.
    if (st.problem) add('copy', 'its program', 'fail', st.problem, `hoprig addons install ${g.id}`);
    else if (st.copy === 'own') {
      let s1 = null;
      try {
        s1 = fs.statSync(copy);
        fs.accessSync(copy, fs.constants.W_OK);
      } catch {
        /* judged below */
      }
      if (s1 && !theirs(s1)) add('copy', 'its program', 'ok', `${st.version || 'a version'} is installed in Hoprig's own folder (${copy})`);
      else add('copy', 'its program', 'fail', `its copy in ${copy} ${s1 && theirs(s1) ? `belongs to ${who(s1)}` : 'cannot be changed by this user'}, so it cannot be updated or removed from here`, `sudo chown -R "$USER" ${copy}   (or: hoprig addons remove ${g.id} as its owner, then hoprig addons install ${g.id} as this user)`);
    } else if (st.copy === 'global') {
      let rootOwned = false;
      try {
        const s2 = fs.statSync(fs.realpathSync(global));
        rootOwned = theirs(s2) && s2.uid === 0;
      } catch {
        /* not looked at */
      }
      add('copy', 'its program', rootOwned ? 'warn' : 'ok',
        `it runs from a global copy${st.version ? ` (${st.version})` : ''} that npm installed${rootOwned ? ', which belongs to root' : ''}: it is used until you press Install, which puts a copy of its own into Hoprig's folder`,
        `hoprig addons install ${g.id}`);
    }
    // Its data folder and the files in it.
    try {
      const d = fs.statSync(data);
      const entries = fs.readdirSync(data).map((n) => fs.lstatSync(path.join(data, n))).filter(theirs);
      if (theirs(d) || entries.length) {
        const first = theirs(d) ? d : entries[0];
        add('data', 'its data folder', 'fail', `${data} ${theirs(d) ? 'belongs' : `holds ${plural(entries.length, 'file', 'files')} that belong`} to ${who(first)}: ${g.title} cannot write them when it runs as this user`, `sudo chown -R "$USER" ${data}`);
      } else add('data', 'its data folder', 'ok', `${data} belongs to this user`);
    } catch {
      /* none yet: it is made at the first start */
    }
    // Is it up, when it runs.
    if (st.foreign) add('health', 'its port', 'warn', st.note || 'another program answers on its port', `give ${g.title} another port (addons.${g.id}.port in config.json), or stop that program as its own user`);
    else if (st.running) {
      if (typeof g.ready !== 'function' || (await g.ready())) add('health', 'its health route', 'ok', 'answers its health route');
      else add('health', 'its health route', 'warn', 'its port answers but its health route does not say it is ready', `wait a moment, or: hoprig addons stop ${g.id} && hoprig addons start ${g.id}`);
    }
  }
  return out;
}
