// SSH tunnels to the machines added by SSH: one `ssh -N -L 127.0.0.1:<free port>:<host>:<port> <target>` each,
// kept alive with backoff. The other computer's dashboard can stay bound to 127.0.0.1 and nothing has to be opened
// in a firewall: the hub talks to the local end of the tunnel.
//
// A tunnel starts the first time it is needed and then stays up until the hub stops (close()). When ssh exits it is
// started again after 1 s, 2 s, 4 s ... up to a minute; the wait starts over once a tunnel stayed up for a while.
// A request for a machine whose tunnel waits to retry starts the next try at once.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { tunnelArgs } from './ssh.mjs';

/** A port nobody listens on right now (ssh then binds it; ExitOnForwardFailure covers the rare race). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Does something accept connections on 127.0.0.1:port? */
export function tcpProbe(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export class TunnelError extends Error {
  constructor(message, code = 'offline') {
    super(message);
    this.code = code;
  }
}

export class Tunnel extends EventEmitter {
  /**
   * @param {object} o
   * @param {{target:string, remoteHost:string, remotePort:number}} o.machine
   * buildArgs(port): the ssh arguments for one try (default: a forward tunnel to the machine; join.mjs passes a
   * reverse one). Test seams: spawnImpl, sshBin, env, freePort, probe, minDelayMs, maxDelayMs, stableMs, probeEveryMs, startTimeoutMs, now.
   */
  constructor({ machine, buildArgs = null, sshBin = 'ssh', spawnImpl = spawn, env = process.env, freePort: fp = freePort, probe = (port) => tcpProbe(port), minDelayMs = 1000, maxDelayMs = 60_000, stableMs = 30_000, probeEveryMs = 200, startTimeoutMs = 25_000, now = Date.now } = {}) {
    super();
    this.setMaxListeners(100);
    Object.assign(this, { machine, buildArgs, sshBin, spawnImpl, env, freePortFn: fp, probe, minDelayMs, maxDelayMs, stableMs, probeEveryMs, startTimeoutMs, now });
    this.state = 'idle'; // idle | starting | up | waiting | closed
    this.localPort = null;
    this.lastError = '';
    this.failures = 0;
    this.attempts = 0;
    this.child = null;
    this.retryTimer = null;
    this.lastAttemptAt = 0;
    this.upSince = null;
    this.reversePort = null; // the port sshd gave the relay's forward on the other computer (src/hubprov), once it said so
    this.reverseOff = false; // the other computer refused that forward: from then on the tunnel is made without it
  }

  /** Resolves the local port once the tunnel is up; rejects with a TunnelError when it cannot come up in time. */
  ensure(timeoutMs = 15_000) {
    if (this.state === 'closed') return Promise.reject(new TunnelError('the dashboard is stopping'));
    if (this.state === 'up') return Promise.resolve(this.localPort);
    if (this.state === 'idle') this.#attempt();
    else if (this.state === 'waiting' && this.now() - this.lastAttemptAt >= this.minDelayMs) {
      // Someone needs this machine now: do not sit out the rest of the backoff.
      clearTimeout(this.retryTimer);
      this.#attempt();
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('up', onUp);
        this.off('fail', onFail);
      };
      const onUp = (port) => {
        cleanup();
        resolve(port);
      };
      const onFail = (msg) => {
        cleanup();
        reject(new TunnelError(msg));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new TunnelError(this.lastError || 'the SSH tunnel did not come up in time', 'timeout'));
      }, timeoutMs);
      this.on('up', onUp);
      this.on('fail', onFail);
    });
  }

  async #attempt() {
    this.state = 'starting';
    this.attempts++;
    this.lastAttemptAt = this.now();
    let port;
    try {
      port = await this.freePortFn();
    } catch (e) {
      return this.#failed(`no free local port: ${e.message}`);
    }
    if (this.state === 'closed') return;
    const { target, remoteHost, remotePort, extra, reverse } = this.machine;
    let child;
    this.reversePort = null;
    try {
      const args = this.buildArgs ? this.buildArgs(port) : tunnelArgs({ target, localPort: port, remoteHost, remotePort, extra, reverse: this.reverseOff ? null : reverse });
      child = this.spawnImpl(this.sshBin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.env });
    } catch (e) {
      return this.#failed(`cannot start ssh: ${e.message}`);
    }
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (c) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000);
      const got = /Allocated port (\d+) for remote forward/.exec(stderr);
      if (got && this.child === child) {
        this.reversePort = Number(got[1]);
        this.emit('reverse', this.reversePort);
      }
    });
    let upAt = null;
    let exited = false;
    child.on('error', (e) => (stderr += `\n${e.message}`));
    child.on('exit', (code, signal) => {
      exited = true;
      if (this.child === child) this.child = null;
      if (this.state === 'closed') return;
      if (upAt !== null && this.now() - upAt >= this.stableMs) this.failures = 0;
      const why = stderr.trim().split(/\r?\n/).filter((l) => !/^Warning: Permanently added/.test(l)).pop() || `ssh ended (${signal || `exit ${code}`})`;
      // A refused remote forward must never cost the link itself: the next try is made without it.
      if (this.machine.reverse && /remote port forwarding failed|forwarding.*(refused|not allowed|administratively)/i.test(stderr)) this.reverseOff = true;
      this.#failed(why.slice(0, 300));
    });
    // ssh prints nothing when the forward is ready, so watch for the local port to accept connections. With
    // ExitOnForwardFailure it only listens after the login worked.
    const started = this.now();
    while (!exited && this.state === 'starting') {
      // A probe that throws counts as "not up yet": a tunnel must never take the dashboard down.
      if (await Promise.resolve().then(() => this.probe(port, { startedAt: started })).catch(() => false)) {
        if (exited || this.state !== 'starting') return;
        upAt = this.now();
        this.localPort = port;
        this.upSince = this.now();
        this.state = 'up';
        this.lastError = '';
        this.emit('up', port);
        return;
      }
      if (this.now() - started > this.startTimeoutMs) {
        stderr += '\nthe SSH tunnel did not come up in time';
        child.kill('SIGTERM');
        return;
      }
      await new Promise((r) => setTimeout(r, this.probeEveryMs));
    }
  }

  #failed(msg) {
    if (this.state === 'closed') return;
    this.failures++;
    this.lastError = msg;
    this.localPort = null;
    this.reversePort = null;
    this.upSince = null;
    this.state = 'waiting';
    this.emit('fail', msg);
    const delay = Math.min(this.maxDelayMs, this.minDelayMs * 2 ** Math.min(this.failures - 1, 16));
    this.retryTimer = setTimeout(() => this.#attempt(), delay);
    this.retryTimer.unref?.();
  }

  close() {
    this.state = 'closed';
    clearTimeout(this.retryTimer);
    if (this.child) this.child.kill('SIGTERM');
    this.child = null;
    this.removeAllListeners('up');
  }

  /** For the machine list: what the tunnel does now. */
  status() {
    return { state: this.state, localPort: this.localPort, reversePort: this.reversePort, upSince: this.upSince, error: this.lastError || null, failures: this.failures };
  }
}

/** One tunnel per machine name; a changed target or port replaces it. */
export class Tunnels {
  constructor(opts = {}) {
    this.opts = opts;
    this.map = new Map();
  }

  // A computer with a kept key gets its options from `extraOf` (hub.mjs): they are part of the key, so a key given or
  // taken away starts a new tunnel.
  static key = (m, extra = [], reverse = null) => `${m.target}|${m.remoteHost}|${m.remotePort}|${extra.join(' ')}|${reverse || ''}`;

  get(m) {
    const extra = this.opts.extraOf ? this.opts.extraOf(m) : [];
    // reverseOf(m): the port of the hub-provider relay on this computer when this computer is to reach it back over the same ssh.
    const reverse = this.opts.reverseOf ? this.opts.reverseOf(m) || null : null;
    const cur = this.map.get(m.name);
    if (cur && cur.key === Tunnels.key(m, extra, reverse)) return cur.tunnel;
    if (cur) cur.tunnel.close();
    const { extraOf, reverseOf, ...opts } = this.opts;
    const tunnel = new Tunnel({ ...opts, machine: { target: m.target, remoteHost: m.remoteHost, remotePort: m.remotePort, extra, reverse } });
    this.map.set(m.name, { key: Tunnels.key(m, extra, reverse), tunnel });
    return tunnel;
  }

  peek(name) {
    const cur = this.map.get(name);
    return cur ? cur.tunnel : null;
  }

  close(name) {
    const cur = this.map.get(name);
    if (cur) cur.tunnel.close();
    this.map.delete(name);
  }

  closeAll() {
    for (const { tunnel } of this.map.values()) tunnel.close();
    this.map.clear();
  }
}
