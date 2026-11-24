// Nothing of the last slice of "Tia as the operator" runs by itself after an update: with "Tia acts by herself" and Tia
// on, a failed run on the board that a look would take, and the switches of this slice ABSENT (operator.decide.missions,
// operator.look, operator.corrections), a real server start and three ticks of its watcher start no coding tool and
// write nothing of a look, a decision about a mission or a correction. A beside test of byitself.test.mjs.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';
import { closedGateways } from '../seal.mjs';
import { shippedGateways } from '../../tools/seal-net.mjs';

const posix = process.platform !== 'win32';

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

test('the switches of a mission\'s choices, the looks and the corrections absent: a start and three ticks start no session and write nothing of them', { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const PATH = process.env.PATH;
  // No folder of PATH that holds a shipped gateway's program: the look at a gateway finds none installed.
  const gateways = shippedGateways().map((g) => g.id);
  process.env.PATH = PATH.split(path.delimiter).filter((d) => !gateways.some((id) => fs.existsSync(path.join(d, id)))).join(path.delimiter);
  t.after(() => { process.env.PATH = PATH; });
  const w = tempWork('operator-byitself-switches');
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root));
  const shop = path.join(w.projects, 'shop');
  w.repo(shop, { 'README.md': '# shop\n' });
  w.repo(path.join(w.projects, 'plans'), { 'README.md': '# plans\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { resolvePlace } = await import('../../src/work/place.mjs');
  const { writeRun } = await import('../../src/work/runs.mjs');
  const cfg = {
    claudeBin: path.join(w.root, 'no-claude'), usage: false, addons: closedGateways(),
    assistant: { enabled: true }, operator: { acts: true, decide: { on: true } },
    work: { place: 'project', project: 'plans', path: 'docs/plans', ownerId: 'alex' },
    server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') },
  };
  saveConfig(cfg);
  // A run that failed a few minutes ago for a reason no check knows: an item a look would take if it were on.
  const at = new Date(Date.now() - 3 * 60_000).toISOString();
  writeRun(resolvePlace(cfg), {
    v: 1, id: '20261119-120000-a1b2c3d4', item: 'fix-cart', title: 'Fix the cart', writer: 'ffffffffffffffff', by: 'owner', startedAt: at, endedAt: at,
    project: 'shop', folder: '.', tool: 'claude', provider: 'key', model: null, effort: null, session: null, conversation: null, message: null,
    brief: 'Fix the cart', state: 'failed', reason: 'The run ended in an error: TypeError: total is not a function', answer: '', commits: [], changed: [], more: 0,
    was: 'open', statusError: null, branch: 'work/fix-cart', schedule: null,
  });
  const spawned = [];
  const orig = {};
  for (const k of ['spawn', 'execFile', 'fork']) {
    orig[k] = childProcess[k];
    childProcess[k] = function (file, args, ...rest) {
      spawned.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' '));
      return orig[k].call(this, file, args, ...rest);
    };
  }
  syncBuiltinESMExports();
  let offset = 0;
  const now = () => Date.now() + offset;
  let app = null;
  t.after(async () => {
    Object.assign(childProcess, orig);
    syncBuiltinESMExports();
    if (app) await app.close().catch(() => {});
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  const before = snapshot(w.root);
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `op-switches-${process.pid}`, operator: { now } });
  await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const op = app.features.find((f) => f.name === 'operator');
  // The item is there: the look would have something to take.
  const list = await op.list();
  assert.ok(list.items.some((i) => i.kind === 'unknown'), JSON.stringify(list.items.map((i) => i.kind)));
  for (let i = 0; i < 3; i++) {
    await app.watcher.tick();
    await op.looking?.();
    await op.deciding?.();
    offset += 5 * 60_000 + 1000;
  }
  const after = snapshot(w.root);
  const written = changes(before, after);
  assert.ok(!spawned.some((p) => /no-claude|claude\b/.test(p)), `no coding tool was started: ${spawned.filter((p) => /claude/.test(p))}`);
  for (const re of [/look-record|look\.lock|findings\/|look-facts/, /corrections\.jsonl|evidence\.jsonl/, /work-trees\//, /docs\/plans\/runs\/(?!20261119-120000-a1b2c3d4)/]) {
    assert.deepEqual(written.filter((f) => re.test(f)), [], `nothing like ${re} was written`);
  }
  const dec = path.join(w.root, 'state', 'operator', 'decisions.json');
  if (fs.existsSync(dec)) assert.ok(!JSON.parse(fs.readFileSync(dec, 'utf8')).calls.some((c) => c.mission), 'no decision about a mission');
  const v = op.reflex && (await (op.routes.find(([m, re]) => m === 'GET' && re.test('/api/operator/settings'))[2])());
  assert.equal(v.look.on, false);
  assert.equal(v.decide.missions, false);
  assert.equal(v.corrections.on, false);
});
