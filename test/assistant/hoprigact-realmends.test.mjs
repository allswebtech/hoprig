// The three acts of hers on a gateway run for real in the server: no stand-in for the mends is given, so the act goes to
// the functions of src/operator/mends.mjs, against a small program of this test that answers on a port of its own (never a
// real gateway, never the default port). Restart and stop are a card he taps; probe is free.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { sandbox } from '../server/helpers.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const POSIX = { skip: process.platform === 'win32' && 'a gateway program is ended as one process group, which Windows does not have' };
const box = sandbox('realmends');
const BUILTIN = fileURLToPath(new URL('../../skills', import.meta.url));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const closed = (port) => new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(false); }); c.on('error', () => r(true)); });
const pidsFile = path.join(box.root, 'server-pids.txt');
const server = path.join(box.root, 'server.mjs');
fs.writeFileSync(server, `import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
http.createServer((q, s) => s.end('relay')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`);
const pids = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number) : []);
test.after(() => {
  for (const pid of pids()) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  box.cleanup();
});

const { saveConfig } = await import('../../src/config.mjs');
const G = await import('../../src/addons/gateways.mjs');
const { findAddon } = await import('../../src/addons/index.mjs');
const { stoppedAt } = await import('../../src/addons/stopmark.mjs');
saveConfig({ server: { port: 7433 } });

function setup() {
  const s = baseState();
  s.assistant = { enabled: true, level: 'work', actAlone: true };
  const ops = new FakeOps(s);
  delete ops.mends; // the real functions of the server, not the stand-in
  const core = createAssistantCore({ ops, cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [{ dir: BUILTIN, source: 'built-in' }] }) });
  return { core, ops, call: (args) => core.call('hoprig_act', args, { conversation: 'c1' }) };
}

test('probe, restart and stop reach the real functions of the server', POSIX, async () => {
  const prog = path.join(box.root, 'relay');
  fs.writeFileSync(prog, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
  const port = await freePort();
  const added = await G.addDefinition({ id: 'relay', title: 'Relay', bin: prog, port });
  assert.equal(added.ok, true, added.error);
  try {
    const a = findAddon('relay');
    assert.equal((await a.start()).ok, true);
    const t = setup();

    const probe = await t.call({ act: 'probe-provider', item: 'relay' });
    assert.equal(probe.isError, false, probe.text);
    assert.match(probe.text, /answers/);

    const before = pids().length;
    const c = await t.call({ act: 'restart-gateway', item: 'relay' });
    assert.ok(c.card, 'a card, also with her switch on');
    assert.equal(pids().length, before, 'nothing ran before the tap');
    const done = await t.core.confirm(c.card.id);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(pids().length, before + 1, 'the program was started again by the real restart');
    assert.equal(await closed(port), false, 'it answers again');

    const s = await t.call({ act: 'stop-gateway', item: 'relay' });
    assert.ok(s.card);
    assert.equal(await closed(port), false, 'still running before the tap');
    assert.equal((await t.core.confirm(s.card.id)).ok, true);
    assert.equal(await closed(port), true, 'the real stop closed the port');
    assert.ok(stoppedAt('relay') != null, 'noted as his own stop');
    assert.deepEqual(t.ops.calls.filter((x) => /gatewayhost/.test(x.path || '')), [], 'no route of a gateway was dispatched');

    const again = await t.call({ act: 'restart-gateway', item: 'relay' });
    assert.equal(again.isError, true, 'a gateway the owner stopped is not started again by her');
  } finally {
    G.removeDefinition('relay');
  }
});
