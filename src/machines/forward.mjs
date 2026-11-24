// "Open its page" for a gateway on another computer added by SSH: a forward on THIS computer, its loopback only, to
// that computer's gateway port and nothing else. Never under the dashboard's own address: a gateway is someone else's
// web program, and its scripts there could act as the signed-in owner. Not under the dashboard's own host name either:
// a browser keeps cookies per host name, not per port, so a link to 127.0.0.1:<forward> from a dashboard opened at
// 127.0.0.1 would carry its sign-in, and the two pages would be one site. So the forward listens on [::1] and links
// http://[::1]:<port>/, a host name a dashboard is rarely opened at; for a page that is on [::1] itself (or a computer
// without IPv6) it listens on 127.0.0.1 and links the loopback name the page is not on (otherLoopback).
//
// One forward is a small TCP server on that address (a port the system gives) in front of one ssh -N -L to the gateway's
// port there (the computer's own options: a kept key and host key). When nothing has moved through it for `idleMs`
// (15 minutes) it closes itself, its connections and its ssh: a browser keeps a connection open long after the page is
// read, so an open connection alone does not keep it. It also closes on Stop, when the computer is removed and when the
// dashboard stops. Only the owner's page on this computer itself may open one (index.mjs checks that).
import net from 'node:net';
import { Tunnel } from './tunnels.mjs';
import { tunnelArgs } from './ssh.mjs';

export const IDLE_MS = 15 * 60_000;

/**
 * The loopback host name for a link to a program on this computer's 127.0.0.1, for a dashboard page whose host name is
 * `pageHost` (its Host header or location.hostname): never that name, so the dashboard's cookie is not sent with it and
 * the two are different sites. web/health.js has the same rule for the plain link.
 */
export function otherLoopback(pageHost) {
  const h = hostOf(pageHost);
  return h === 'localhost' || h === '[::1]' || h === '::1' ? '127.0.0.1' : 'localhost';
}

const hostOf = (pageHost) => String(pageHost || '').toLowerCase().replace(/^(\[[^\]]*\]|[^:]*)(:\d+)?$/, '$1');
const onV6 = (pageHost) => !['[::1]', '::1'].includes(hostOf(pageHost));
const listenOn = (server, host) => new Promise((resolve, reject) => {
  const no = (e) => reject(e);
  server.once('error', no);
  server.listen(0, host, () => {
    server.off('error', no);
    resolve();
  });
});

function close(f) {
  clearInterval(f.timer);
  f.tunnel.close();
  f.server.close();
  for (const s of f.sockets) s.destroy();
}

export class Forwards {
  constructor({ ssh = {}, extraOf = () => [], idleMs = IDLE_MS, checkEveryMs = 30_000, now = Date.now } = {}) {
    Object.assign(this, { ssh, extraOf, idleMs, checkEveryMs, now });
    this.map = new Map(); // computer name -> { gateway, gwPort, host, port, server, tunnel, sockets, lastAt, timer }
    this.opening = new Map(); // computer name -> the open that runs now: a second one waits for it, never beside it
  }

  status(name) {
    const f = this.map.get(name);
    return f ? { gateway: f.gateway, url: `http://${f.host}:${f.port}/`, port: f.port, idleMinutes: Math.round(this.idleMs / 60_000) } : null;
  }

  /**
   * Open (or give back) the forward of computer `m` to its gateway `gateway` on port `gwPort` there, for a page on
   * `pageHost`. Opens of one computer run one after the other: two at once would both find none and leave one
   * forward outside the map, which Stop, the idle close and closeAll would never reach.
   */
  open(m, gateway, gwPort, { pageHost = '127.0.0.1' } = {}) {
    const before = this.opening.get(m.name) || Promise.resolve();
    const p = before.catch(() => {}).then(() => this.openNow(m, gateway, gwPort, pageHost));
    this.opening.set(m.name, p);
    const done = () => this.opening.get(m.name) === p && this.opening.delete(m.name);
    p.then(done, done);
    return p;
  }

  async openNow(m, gateway, gwPort, pageHost) {
    const cur = this.map.get(m.name);
    if (cur && cur.gateway === gateway && cur.gwPort === gwPort && cur.host !== hostOf(pageHost)) {
      cur.lastAt = this.now();
      return this.status(m.name);
    }
    if (cur) this.stop(m.name);
    const extra = this.extraOf(m);
    const tunnel = new Tunnel({
      ...this.ssh,
      machine: { target: m.target, remoteHost: '127.0.0.1', remotePort: gwPort },
      buildArgs: (port) => tunnelArgs({ target: m.target, localPort: port, remoteHost: '127.0.0.1', remotePort: gwPort, extra }),
    });
    const f = { gateway, gwPort, host: null, tunnel, sockets: new Set(), lastAt: this.now(), server: null, port: null, timer: null };
    const moved = () => (f.lastAt = this.now());
    // A 'data' listener puts a socket into flowing mode: added only once it is piped, so nothing is read and lost.
    const keep = (s) => {
      f.sockets.add(s);
      s.on('close', () => f.sockets.delete(s));
      s.on('error', () => {});
    };
    f.server = net.createServer((c) => {
      moved();
      keep(c);
      tunnel.ensure(20_000).then((p) => {
        const up = net.connect({ host: '127.0.0.1', port: p });
        keep(up);
        up.on('error', () => c.destroy());
        c.pipe(up).pipe(c);
        c.on('data', moved);
        up.on('data', moved);
        c.on('close', () => up.destroy());
        up.on('close', () => c.destroy());
      }, () => c.destroy());
    });
    try {
      if (onV6(pageHost)) {
        try {
          await listenOn(f.server, '::1');
          f.host = '[::1]';
        } catch {
          /* no IPv6 loopback here: the other IPv4 name below */
        }
      }
      if (!f.host) {
        await listenOn(f.server, '127.0.0.1');
        f.host = otherLoopback(pageHost);
      }
    } catch (e) {
      tunnel.close();
      throw Object.assign(new Error(`a forward could not listen on this computer (${e.code || e.message})`), { status: 409, code: 'no-forward' });
    }
    f.port = f.server.address().port;
    // This forward's own timer: it closes this forward, never another one that took its name since.
    f.timer = setInterval(() => {
      if (this.now() - f.lastAt < this.idleMs) return;
      if (this.map.get(m.name) === f) this.stop(m.name);
      else close(f);
    }, this.checkEveryMs);
    f.timer.unref?.();
    this.map.set(m.name, f);
    return this.status(m.name);
  }

  stop(name) {
    const f = this.map.get(name);
    if (!f) return false;
    this.map.delete(name);
    close(f);
    return true;
  }

  closeAll() {
    for (const name of [...this.map.keys()]) this.stop(name);
  }
}

/**
 * Is this request from a browser on this computer itself, at its own loopback address? Not one forwarded here by
 * the public link (its connection is local too, but its Host is the public name).
 */
export function fromThisComputer(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return ['127.0.0.1', '::1'].includes(peer) && ['127.0.0.1', 'localhost', '[::1]'].includes(host) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
}
