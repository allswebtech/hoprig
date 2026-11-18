// A gateway the owner defines is often a wrapper script: one that runs node without exec (so the server on the port is
// its grandchild), or one that starts the server in the background and ends. Hoprig started it, so it is reported as
// running and a stop ends all of it; another program on the port is still left alone (gateways.test.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewayproc');
const POSIX = { skip: process.platform === 'win32' }; // wrappers are sh scripts; Windows has no process groups
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const closed = (port) => new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(false); }); c.on('error', () => r(true)); });
const pidsFile = path.join(box.root, 'server-pids.txt');
const server = path.join(box.root, 'server.mjs');
fs.writeFileSync(server, `import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
http.createServer((q, s) => s.end('relay')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`);
const servers = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const seen = [];
test.after(() => {
  for (const pid of [...seen, ...servers()]) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  box.cleanup();
});

const { saveConfig } = await import('../../src/config.mjs');
const G = await import('../../src/addons/gateways.mjs');
const { findAddon } = await import('../../src/addons/index.mjs');
saveConfig({ server: { port: 7433 } });

const WRAPPERS = {
  // sh -c with a command after node does not exec: wrapper → sh → node, the node on the port.
  grandchild: `sh -c '"${process.execPath}" "${server}" "$@"; true' sh "$@"`,
  // The server in the background, the wrapper ends: its parent is gone, its process group is the one Hoprig started.
  background: `"${process.execPath}" "${server}" "$@" > /dev/null 2>&1 &`,
};

for (const [kind, line] of Object.entries(WRAPPERS)) {
  test(`a wrapper whose server is its ${kind === 'grandchild' ? 'grandchild' : 'background child'}: it runs as the gateway, and a stop ends it`, POSIX, async () => {
    const prog = path.join(box.root, `relay-${kind}`);
    fs.writeFileSync(prog, `#!/bin/sh\n${line}\n`, { mode: 0o755 });
    fs.rmSync(pidsFile, { force: true });
    const port = await freePort();
    const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: prog, port });
    assert.equal(r.ok, true, r.error);
    try {
      const a = findAddon('relay');
      const s = await a.start();
      assert.equal(s.ok, true, s.error);
      const [pid] = servers();
      seen.push(pid);
      assert.ok(pid && alive(pid), 'the server runs');
      const st = await a.status();
      assert.deepEqual([st.running, st.foreign], [true, undefined], 'Hoprig started it: running, not another program');
      assert.deepEqual(await a.start(), { ok: true, url: `http://localhost:${port}`, already: true }, 'a second start finds it');
      assert.deepEqual(await a.stop(), { ok: true });
      assert.equal(await closed(port), true, 'the port is closed');
      assert.equal(alive(pid), false, 'the server ended');
      assert.equal((await a.status()).running, false);
    } finally {
      G.removeDefinition('relay');
    }
  });
}

test('a process Hoprig started that still runs does not make another program on the port the gateway', POSIX, async () => {
  const { spawn } = await import('node:child_process');
  const { system } = await import('../../src/procid.mjs');
  const port = await freePort();
  const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: path.join(box.root, 'relay-grandchild'), port });
  assert.equal(r.ok, true, r.error);
  // Ours: spawned detached as start() spawns, and written down with its identity; it does not listen.
  const ours = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
  // Another program on the gateway's port.
  const other = spawn(process.execPath, [server, '--port', String(port)], { stdio: 'ignore' });
  seen.push(ours.pid, other.pid);
  try {
    for (let i = 0; i < 100 && (await closed(port)); i++) await new Promise((res) => setTimeout(res, 50));
    fs.mkdirSync(path.join(box.state, 'addons'), { recursive: true });
    fs.writeFileSync(path.join(box.state, 'addons', 'relay.pid'), JSON.stringify({ pid: ours.pid, proc: system.of([ours.pid]).get(ours.pid) }));
    const a = findAddon('relay');
    const st = await a.status();
    assert.deepEqual([st.running, st.foreign], [false, true], 'what answers is not ours');
    assert.equal((await a.start()).ok, false, 'not used as the gateway');
    const s = await a.stop();
    assert.deepEqual([s.ok, s.foreign], [true, true]);
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(alive(other.pid), 'the other program got no signal');
    assert.equal(await closed(port), false);
    for (let i = 0; i < 40 && alive(ours.pid); i++) await new Promise((res) => setTimeout(res, 50)); // this test reaps it
    assert.equal(alive(ours.pid), false, 'the process Hoprig started is ended');
  } finally {
    other.kill('SIGKILL');
    ours.kill('SIGKILL');
    G.removeDefinition('relay');
  }
});

// Programs that detach themselves from what Hoprig started: the server in a session of its own whose parent has ended
// (what `setsid server &` or a daemon mode makes). "ends": the wrapper ends at once; "stays": a daemon's double fork,
// whose wrapper stays (it is what Hoprig started, and it is ended).
const DETACH = {
  ends: (args) => `require('node:child_process').spawn(process.execPath, ${args}, { detached: true, stdio: 'ignore' }).unref();`,
  stays: (args) => `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:child_process').spawn(process.execPath, JSON.parse(process.argv[1]), { detached: true, stdio: 'ignore' }).unref()`)}, JSON.stringify(${args})], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(path.join(box.root, 'wrapper.pid'))}, String(process.pid));
setInterval(() => {}, 1 << 30);`,
};
for (const [kind, body] of Object.entries(DETACH)) {
  test(`a program that detaches itself (setsid, a daemon mode; its wrapper ${kind === 'ends' ? 'ends' : 'stays'}) is not reported started: it could never be stopped`, POSIX, async () => {
    const prog = path.join(box.root, `relay-detach-${kind}`);
    fs.writeFileSync(prog, `#!${process.execPath}\n${body(`[${JSON.stringify(server)}, ...process.argv.slice(2)]`)}\n`, { mode: 0o755 });
    fs.rmSync(pidsFile, { force: true });
    fs.rmSync(path.join(box.root, 'wrapper.pid'), { force: true });
    const port = await freePort();
    assert.equal((await G.addDefinition({ id: 'relay', title: 'Relay', bin: prog, port })).ok, true);
    try {
      const a = findAddon('relay');
      const s = await a.start();
      const [pid] = servers();
      seen.push(pid);
      assert.equal(s.ok, false, 'not ok: Hoprig could not stop it later');
      assert.match(s.error, /Relay answered on port \d+, but its program detached itself from Hoprig \(setsid, a daemon mode\), so Hoprig could not stop it: run it in the foreground .* so that Hoprig can stop it\. What Hoprig started of it was ended; the program now on port \d+ is not Hoprig's and is left alone/);
      assert.equal(fs.existsSync(path.join(box.state, 'addons', 'relay.pid')), false, 'what Hoprig started is not kept as the gateway');
      if (kind === 'stays') {
        const wrapper = Number(fs.readFileSync(path.join(box.root, 'wrapper.pid'), 'utf8'));
        seen.push(wrapper);
        for (let i = 0; i < 40 && alive(wrapper); i++) await new Promise((res) => setTimeout(res, 50));
        assert.equal(alive(wrapper), false, 'the wrapper Hoprig started is ended');
      }
      assert.ok(alive(pid), 'the detached program is not Hoprig\'s: left alone');
      const st = await a.status();
      assert.deepEqual([st.running, st.foreign], [false, true]);
    } finally {
      const wrapperFile = path.join(box.root, 'wrapper.pid');
      for (const p of [...servers(), ...(fs.existsSync(wrapperFile) ? [Number(fs.readFileSync(wrapperFile, 'utf8'))] : [])]) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
      G.removeDefinition('relay');
    }
  });
}
