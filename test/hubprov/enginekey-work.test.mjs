// A Work run: the key of a hub row in its environment works while the run's tool process runs and is refused when it has ended.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { missionHome } from '../mission/helpers.mjs';
import { until } from './helpers.mjs';

const t = missionHome('hubprov-enginekey-work');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { keyRow, mintKey } = await import('../../src/hubprov/localkeys.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
const store = workStore(resolvePlace(cfg), { projects: projectNames() });
const go = path.join(t.root, 'go');
const script = path.join(t.root, 'tool.mjs');
fs.writeFileSync(script, `import fs from 'node:fs';\nsetInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) process.exit(0); }, 50);\nprocess.stdin.resume();\n`);
const key = mintKey({ row: 'mykey' });
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [script] }, resolveEnv: async () => ({ ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/hub/p/mykey', ANTHROPIC_AUTH_TOKEN: key }), settings: () => ({ atOnce: 1 }), minuteMs: 5000, killGraceMs: 200 });
test.after(() => runner.close());

test('a Work run: the key works while the run\'s tool process runs and is refused when it has ended', async () => {
  const id = (await store.add({ title: 'Read the cart', project: 'shop', by: 'tester' })).item.id;
  const r = await runner.startAlone({ item: id, project: 'shop', by: 'tester', prompt: 'Read the cart.', provider: 'key', minutes: 1, mode: 'manual' });
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(keyRow(key), 'mykey', 'while it runs');
  fs.writeFileSync(go, '1');
  await r.done;
  await until('the key refused after the run ended', () => keyRow(key) === null);
});
