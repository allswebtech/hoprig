// A computer added by SSH before tokens carried the hub mark: its token there is plain, so it refuses the hub's push. It
// says so with a code of its own; the hub mends the mark ONCE per start over the same ssh it adds a computer by (the
// token on standard input), tells it in Activity, and pushes again. Never for a computer the owner says is not his own,
// never again in the same run, and a refusal that stays is a state the page can read, not silence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import { call, machineEntry } from './helpers.mjs';

const box = sandbox('hubprov-markmend');
test.after(() => {
  A.close();
  app.close();
  box.cleanup();
});
const { putMachine } = await import('../../src/machines/store.mjs');
const { createToken, markHub, markHubByToken, listTokens } = await import('../../src/machines/tokens.mjs');
const { hubprovFeature } = await import('../../src/hubprov/feature.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hoprig.mjs');

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const old = createToken('Hub A'); // made by an early build: no hub mark
const own = createToken('Hub A again');
const noSsh = () => {
  throw new Error('no ssh in this test');
};
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false, machines: { hub: { ssh: { spawnImpl: noSsh } } } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

// The hub (A): its way over ssh is a stand-in that does what the computer's own command does with the token on its input.
const marked = [];
let sshWorks = true;
const hubFake = {
  tunnels: { peek: () => ({ reversePort: null }) },
  hubLabel: () => 'Hub A',
  endpoint: async () => ({ protocol: 'http:', hostname: '127.0.0.1', port, basePath: '' }),
  remove: async (name) => ({ removed: true, name }),
  markHubOverSsh: async (m) => {
    marked.push(m.name);
    if (!sshWorks) return { ok: false, code: 'failed', message: 'no' };
    return markHubByToken(m.token) ? { ok: true } : { ok: false, code: 'failed', message: 'no token matches' };
  },
};
const aCtx = { HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, caller: () => 'page', readJson: async () => ({}), listening: () => null };
const A = hubprovFeature(aCtx, { machines: { links: null, hub: hubFake }, pushMs: 1e9 });
const state = async () => A.routes.find((r) => r[0] === 'GET' && r[1].test('/api/hubprov/state'))[2]({});
const activity = () => {
  try {
    return fs.readFileSync(path.join(box.state, 'automation.log'), 'utf8');
  } catch {
    return '';
  }
};
const isMarked = (id) => listTokens().find((t) => t.id === id).hub === true;

test('the route refuses a token without the hub mark with a code of its own, and nothing is stored', async () => {
  const r = await call(base, '/api/hubprov/push', { method: 'POST', headers: { authorization: `Bearer ${old.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ providers: [] }) });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).code, 'hub-mark-missing');
  assert.equal(isMarked(old.id), false);
});

test('the command marks the stored token that matches the one on its input; a wrong one is refused; nothing is printed', () => {
  const run = (input) => spawnSync(process.execPath, [BIN, 'tokens', 'mark-main'], { input, env: process.env, encoding: 'utf8' });
  const wrong = run(`hop_${'A'.repeat(43)}\n`);
  assert.notEqual(wrong.status, 0, 'a token that matches nothing is refused');
  assert.equal(isMarked(own.id), false);
  const empty = run('');
  assert.notEqual(empty.status, 0);
  const ok = run(`${own.token}\n`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(isMarked(own.id), true);
  for (const out of [ok.stdout, ok.stderr, wrong.stdout, wrong.stderr]) assert.equal(out.includes(own.token) || out.includes('A'.repeat(43)), false, 'never printed');
  assert.equal(activity().includes(own.token), false, 'never logged');
  markHub(own.id, false);
  const viaArg = spawnSync(process.execPath, [BIN, 'tokens', 'mark-main', own.token], { env: process.env, encoding: 'utf8' });
  assert.notEqual(viaArg.status, 0, 'a token on the command line is not taken');
  assert.equal(isMarked(own.id), false);
});

test('the hub mends the mark once: the push is refused, the mark is brought up to date over ssh, the push goes through, Activity says so', async () => {
  putMachine({ ...machineEntry('bee', { via: 'ssh', target: 'u@bee.example.com', remoteHost: '127.0.0.1', remotePort: port }), token: old.token, tokenId: old.id });
  assert.equal(isMarked(old.id), false);
  await A.pushAll(true);
  assert.deepEqual(marked, ['bee']);
  assert.equal(isMarked(old.id), true, 'the stored token there now carries the mark');
  assert.match(activity(), /The link to BEE was brought up to date/);
  assert.deepEqual((await state()).blocked, [], 'nothing is held back');
});

test('only once per start: the mark lost again is not mended again, and the refusal is a state the page can read', async () => {
  markHub(old.id, false);
  await A.pushAll(true);
  await A.pushAll(true);
  assert.deepEqual(marked, ['bee'], 'not tried a second time in this run');
  const s = await state();
  assert.deepEqual(s.blocked.map((b) => [b.name, b.code]), [['bee', 'hub-mark-missing']]);
  assert.equal(JSON.stringify(s).includes(old.token), false);
});

test('a computer the owner says is not his own is never upgraded', async () => {
  const other = createToken('Hub A third');
  putMachine({ ...machineEntry('cee', { via: 'ssh', target: 'u@cee.example.com', remoteHost: '127.0.0.1', remotePort: port, own: false }), token: other.token, tokenId: other.id });
  await A.pushAll(true);
  assert.ok(!marked.includes('cee'));
  assert.equal(isMarked(other.id), false);
});

test('an ssh that cannot mend it leaves the refusal in the state, with the code, and tries nothing more in this run', async () => {
  const late = createToken('Hub A fourth');
  sshWorks = false;
  putMachine({ ...machineEntry('dee', { via: 'ssh', target: 'u@dee.example.com', remoteHost: '127.0.0.1', remotePort: port }), token: late.token, tokenId: late.id });
  await A.pushAll(true);
  await A.pushAll(true);
  assert.equal(marked.filter((n) => n === 'dee').length, 1);
  assert.ok((await state()).blocked.some((b) => b.name === 'dee' && b.code === 'hub-mark-missing'));
});
