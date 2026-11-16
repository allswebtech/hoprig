// Small harness for the machines tests: a fake "remote user" for the fake ssh (a hoprig shim that is on PATH
// only in the login shell, as with nvm), and a mini dashboard that wires createMachines() in exactly the way the
// integration patch for src/server/server.mjs does, around stand-in routes.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_SSH = path.join(here, 'fixtures', 'fake-ssh.mjs');
export const REPO = path.resolve(here, '..', '..');

const exe = (file, text) => {
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
};

/**
 * Scratch bin folders in `root`:
 *   bin/ssh          the fake ssh
 *   shim/hoprig   runs `hoprig` with `script` (default: echo its arguments as JSON)
 *   loginsh          a "login shell": puts shim/ on PATH (like ~/.bashrc loading nvm), prints a greeting, runs -c
 * `plain`: the shim is also on the plain PATH. `env`: extra variables for the shim.
 */
export function fakeRemote(root, { plain = false, installed = true, script = null, env = {}, mode = '' } = {}) {
  const bin = path.join(root, 'bin');
  const shim = path.join(root, 'shim');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(shim, { recursive: true });
  const log = path.join(root, 'ssh.log');
  fs.writeFileSync(log, '');
  exe(path.join(bin, 'ssh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SSH}" "$@"\n`);
  const exports = Object.entries(env).map(([k, v]) => `export ${k}='${v}'\n`).join('');
  if (installed) {
    exe(path.join(shim, 'hoprig'), `#!/bin/sh\n${exports}${script || `exec "${process.execPath}" -e 'console.log(JSON.stringify({hoprig:"echo",args:process.argv.slice(1)}))' -- "$@"`}\n`);
  }
  const loginsh = exe(path.join(root, 'loginsh'), `#!/bin/sh\n# called as: loginsh -lic COMMAND\necho "Welcome to the fake remote"\nPATH="${shim}:$PATH" exec /bin/sh -c "$2"\n`);
  const PATH = [bin, plain ? shim : null, '/usr/bin', '/bin'].filter(Boolean).join(':');
  return {
    bin,
    shim,
    log,
    sshEnv: { ...process.env, PATH, FAKE_SSH_LOG: log, FAKE_SSH_SHELL: loginsh, FAKE_SSH_MODE: mode },
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

export const COOKIE = 'sid=good-cookie';

/**
 * A stand-in dashboard. Every /api/* request that gets through answers with what it saw:
 * { path, method, headers, body (text), viaToken }. /api/state answers { sessions: [...] }. /ws/term echoes.
 * The wiring is the proposed server.mjs integration, line for line.
 */
export function miniDashboard({ createMachines, opts = {}, sessions = [{ name: 'one' }], onRequest } = {}) {
  const originOk = (req) => {
    const o = req.headers.origin;
    return typeof o === 'string' && o === `http://${req.headers.host}`;
  };
  const authed = (req) => String(req.headers.cookie || '').includes(COOKIE);
  const machines = createMachines({ authed, originOk, localState: async () => ({ sessions }), ...opts });
  const server = http.createServer(async (req, res) => {
    try {
      if (await machines.handle(req, res)) return;
      const viaToken = machines.authedByToken(req);
      const url = new URL(req.url, 'http://x');
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=remote-cookie', 'X-Remote-Only': '1' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && !viaToken && !originOk(req)) return send(403, { error: 'cross-site request refused' });
      if (url.pathname.startsWith('/api/')) {
        if (!viaToken && !authed(req)) return send(401, { error: 'log in first' });
        onRequest?.(req);
        if (url.pathname === '/api/state') return send(200, { sessions });
        if (url.pathname === '/api/slow') return; // never answers
        if (url.pathname === '/api/code/git/commit') { // a commit whose hooks take a while
          await new Promise((r) => setTimeout(r, 1500));
          return send(200, { committed: true });
        }
        const chunks = [];
        let firstAt = 0;
        for await (const c of req) {
          if (!firstAt) firstAt = Date.now();
          chunks.push(c);
        }
        return send(200, { path: url.pathname + url.search, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks).length, firstAt, viaToken });
      }
      if (!authed(req)) return send(401, { error: 'log in first' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`STATIC ${url.pathname}`);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e.message));
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    if (await machines.upgrade(req, socket, head)) return;
    const viaToken = machines.authedByToken(req);
    const url = new URL(req.url, 'http://x');
    const reject = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (url.pathname !== '/ws/term') return reject(404, 'Not Found');
    if (!viaToken && !originOk(req)) return reject(403, 'Forbidden');
    if (!viaToken && !authed(req)) return reject(401, 'Unauthorized');
    if (url.searchParams.get('name') === 'missing') return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(`hello ${url.searchParams.get('name')} cookie=${req.headers.cookie ? 'yes' : 'no'} origin=${req.headers.origin ? 'yes' : 'no'}`);
      ws.on('message', (d) => {
        const t = d.toString();
        if (t === 'end') ws.close(4000, 'session ended');
        else ws.send(`echo ${t}`);
      });
    });
  });
  return {
    machines,
    server,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.port = server.address().port;
      this.base = `http://127.0.0.1:${this.port}`;
      return this;
    },
    async close() {
      machines.close();
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** fetch with the hub's login and Origin. */
export const asBrowser = (base) => async (p, { body, method, headers = {}, raw } = {}) => {
  const r = await fetch(base + p, {
    method: method || (body !== undefined || raw !== undefined ? 'POST' : 'GET'),
    redirect: 'manual',
    headers: { Origin: base, Cookie: COOKIE, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    duplex: 'half',
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text, headers: r.headers };
};
