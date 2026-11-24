// Who may use Go live (src/ship/feature.mjs): only the owner's own page. Every route, called as a request through the
// assistant's door (ctx.caller 'self') or over a computer link (ctx.caller 'computer'), is refused before it reads a
// project or runs anything. And two dashboards (two processes) on one repository: one goes live, the other is refused
// and says which process holds it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golive-child.mjs');
const t = tempShip('ship-callers');
test.after(() => t.cleanup());
const { shipFeature } = await import('../../src/ship/feature.mjs');
const { putTogether, readTogether } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { goLive, finishCut, readJournal } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');
const idle = () => ({ over: false, why: null });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const marks = path.join(t.root, 'ran.log');
const mark = (tag) => `require('node:fs').appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify(tag)} + '\\n')`;
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'project.json': JSON.stringify({ check: [['node', '-e', mark('check')]], live: { update: [['node', '-e', mark('update')]], verify: [['node', '-e', '0']], back: [['node', '-e', mark('back')]] } }) });
t.branch(shop, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');

// A path each route answers to.
const SAMPLES = ['/api/ship', '/api/ship/limiter', '/api/ship/p/shop', ...['together', 'goon', 'handoff', 'allow', 'check', 'live', 'back', 'auto', 'drop'].map((a) => `/api/ship/p/shop/${a}`)];

for (const who of ['self', 'computer']) {
  test(`every route refuses a request from ${who === 'self' ? 'the assistant\'s door' : 'a computer link'}`, async () => {
    let bodies = 0;
    const ctx = {
      config: () => ({}),
      caller: () => who,
      readJson: async () => (bodies++, { name: 'x', branches: ['work/menu'], kind: 'check', seen: 'x', id: '0'.repeat(20) }),
      backend: { list: async () => [] },
    };
    const f = shipFeature(ctx, { projectsDir: () => t.projects, busy: idle });
    let covered = 0;
    for (const [method, re, handler] of f.routes) {
      const url = SAMPLES.find((p) => re.test(p));
      assert.ok(url, `a sample path for ${re}`);
      const req = { method, url, headers: { host: '127.0.0.1' } };
      await assert.rejects(handler(req, re.exec(url)), (e) => e.status === 403, `${method} ${url}`);
      covered++;
    }
    assert.equal(covered, f.routes.length);
    assert.equal(bodies, 0, 'refused before its body is read');
    assert.equal(fs.existsSync(marks), false, 'nothing ran');
    assert.equal(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship')), false, 'nothing written');
  });
}

test('two dashboards on one repository: one goes live, the other is refused and names who holds it', async () => {
  const slow = path.join(t.projects, 'cafe');
  const started = path.join(t.root, 'cafe-started');
  t.repo(slow, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live: { update: [['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(started)}, '1'); setTimeout(() => {}, 3000)`]], verify: [['node', '-e', '0']], back: [['node', '-e', '0']] } }) });
  t.branch(slow, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');
  const r = await putTogether(slow, { name: 'cafe', branches: ['work/menu'] });
  allow(slow, 'check', readCheck(r.dir).check);
  await runCheck(slow, r.dir, { busy: idle });
  allow(slow, 'live', readLive(r.dir).live);
  const other = spawn(process.execPath, [CHILD, slow, r.id], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 300 && !fs.existsSync(started); i++) await sleep(25);
    assert.ok(fs.existsSync(started), 'the other dashboard is in its update');
    await assert.rejects(goLive(slow, readTogether(r.id)), (e) => e.details?.code === 'busy' && e.message.includes(`process ${other.pid}`) && /go live/.test(e.message), 'refused, naming the other process');
    const look = await finishCut(slow);
    assert.equal(look.runningElsewhere, true, 'the look leaves the other\'s step alone');
    assert.equal(readJournal(await gitFolder(slow)).owner, other.pid, 'the journal is the other\'s');
  } finally {
    await new Promise((res) => other.on('exit', res));
  }
  assert.equal(readJournal(await gitFolder(slow)), null, 'the other finished its step');
  assert.deepEqual(t.trapped(), []);
});
