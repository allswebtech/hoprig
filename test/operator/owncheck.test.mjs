// What the minute's checks ask: the left-over check knows this dashboard's own tmux socket from the backend that runs
// (an option of the server can differ from the settings file), and the gateway check asks only whether a gateway is
// installed and runs, never its version (that starts the gateway's program, and the Operator never shows it).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-owncheck');
test.after(() => box.cleanup());
const { defaultSources } = await import('../../src/operator/sources.mjs');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('the running backend\'s own tmux socket is never a left-over, though the settings file names none', { skip: (!hasTmux || process.platform !== 'linux') && 'tmux on Linux only' }, async () => {
  const sock = `op2-own-${process.pid}`;
  execFileSync('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', 'sh']);
  try {
    const of = (backend) => defaultSources({ backend, state: async () => ({ sessions: [] }), config: () => ({ server: {} }) }, { port: () => null });
    const src = of({ kind: 'tmux', socket: sock });
    await src.tick();
    assert.deepEqual(src.sources.leftovers().filter((p) => p.socket === sock), [], 'the backend\'s own server');
    const other = of({ kind: 'pty' });
    await other.tick();
    assert.equal(other.sources.leftovers().filter((p) => p.socket === sock).length, 1, 'for a dashboard that does not use it, it is one');
  } finally {
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* ended already */ }
  }
});

test('the gateway check asks a gateway only whether it is installed and runs, never its version', async () => {
  const asked = [];
  const gate = { id: 'gate', status: async (o) => { asked.push(o); return { installed: true, running: false, url: 'http://127.0.0.1:8119' }; } };
  const src = defaultSources({ state: async () => ({ sessions: [] }), config: () => ({ server: {} }) }, { port: () => null, gateways: () => [gate], usersOf: () => [] });
  await src.tick();
  assert.deepEqual(asked, [{ version: false }]);
});

test('a clock set back does not stop the minute\'s checks: a last look later than now is looked at again', async () => {
  const clock = { t: Date.parse('2026-03-10T14:00:00Z') };
  let asked = 0;
  const gate = { id: 'gate', status: async () => { asked++; return { installed: true, running: false, url: 'http://127.0.0.1:8119' }; } };
  const src = defaultSources({ state: async () => ({ sessions: [] }), config: () => ({ server: {} }) }, { port: () => null, now: () => clock.t, gateways: () => [gate], usersOf: () => [] });
  await src.tick();
  assert.equal(asked, 1);
  await src.tick();
  assert.equal(asked, 1, 'not again within the minute');
  clock.t -= 3600_000;
  await src.tick();
  assert.equal(asked, 2, 'set back an hour: looked at again');
});

test('a gateway asked with version false does not start its program; asked plainly, it does', { skip: process.platform === 'win32' && 'a POSIX stand-in' }, async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { localGateway } = await import('../../src/addons/localgateway.mjs');
  const marker = path.join(box.root, 'started');
  const bin = path.join(box.root, 'gate-stand-in');
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> '${marker}'\necho 1.2.3\n`, { mode: 0o755 });
  const g = localGateway({ id: 'gate', title: 'Gate', bin, port: 8119, args: [], version: ['--version'], dashboard: null });
  const st = await g.status({ version: false });
  assert.equal(st.installed, true);
  assert.equal(st.version, null);
  assert.equal(fs.existsSync(marker), false, 'its program was not started');
  assert.equal((await g.status()).version, '1.2.3', 'the add-ons page still reads it');
  assert.equal(fs.existsSync(marker), true);
});
