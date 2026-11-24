// A Work run on Auto mode whose order holds only a key billed by use while "Also use pay-per-use providers" is off
// (src/work/alone.mjs, with the real providerEnv): it does not start, its reason says truly why in the router's words,
// never "Auto mode has no order of providers yet", and the coding tool is never started. A temporary computer and a
// stand-in coding tool; no router is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempWork } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-alone.mjs');
const t = tempWork('work-auto-nothing');
const { saveConfig } = await import('../../src/config.mjs');
const P = await import('../../src/profiles.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
P.writeProfile('key', { label: 'Shop key', env: { ANTHROPIC_API_KEY: 'demo-not-a-key' } });
const argsFile = path.join(t.root, 'started.jsonl');
process.env.FAKE_ALONE_ARGS = argsFile;
const runner = aloneRunner({
  config: () => cfg, command: { command: process.execPath, args: [FAKE] }, record: () => {}, settings: () => ({ atOnce: 1 }),
  minuteMs: 300, killGraceMs: 200, defaultProvider: async () => 'key',
});
test.after(() => {
  runner.close();
  delete process.env.FAKE_ALONE_ARGS;
  t.cleanup();
});
const store = () => workStore(resolvePlace(cfg), { projects: projectNames() });

test('a Work run on Auto mode with nothing it may use does not start, and says why', async () => {
  saveConfig({ autoSwitch: { enabled: true, order: ['key'], payPerUse: false } });
  const { item } = await store().add({ title: 'Run alone on Auto', project: 'shop', note: 'DO:nothing' });
  const r = await runner.startAlone({ item: item.id, provider: 'auto' });
  assert.equal(r.run.state, 'failed');
  assert.equal(r.run.reason, 'The run did not start: Auto mode has nothing it may use, because Shop key in its order is billed by use and "Also use pay-per-use providers" is off: turn that switch on on the Providers page, or put a subscription into the order');
  assert.doesNotMatch(r.run.reason, /no order of providers/);
  assert.equal(fs.existsSync(argsFile), false, 'the coding tool was never started');
});
