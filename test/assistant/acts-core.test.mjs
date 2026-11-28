// The shared core's own checker (bin/check-acts.mjs) run on the acts file: it checks the whole contract, the file's shape
// against acts/act.schema.json, the strict input schemas, the picks, the undo acts, with the census of the code. The core is
// another repository: name its folder in TIA_CORE to run it here; without it the test says so and checks the rules this
// product holds itself (test/assistant/acts-census.test.mjs, acts-levels.test.mjs). Nothing of the core is copied into
// the product except the data it exports (acts/, tia-core.lock.json).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = process.env.TIA_CORE || '';
const box = sandbox('actscore');
test.after(() => box.cleanup());

test('the lock names the data of the core that was taken, and the files are the ones it names', async () => {
  const crypto = await import('node:crypto');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'tia-core.lock.json'), 'utf8'));
  assert.equal(lock.core, 'tia-core');
  assert.match(lock.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(lock.files.map((f) => f.path), ['acts/CONTRACT.md', 'acts/act.schema.json', 'acts/level-table.json']);
  for (const f of lock.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f.path))).digest('hex'), f.sha256, `${f.path} was changed here: change it in the core and take it again`);
});

test('the core\'s check-acts finds nothing in the acts file, with the census of the code', { skip: CORE ? false : 'TIA_CORE names no core checkout here' }, async () => {
  const A = await import('../../src/assistant/acts.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false });
  try {
    const doc = A.loadActs();
    const sources = A.codeSources({ commands: A.commandsIn(fs.readFileSync(path.join(ROOT, 'bin', 'hoprig.mjs'), 'utf8')), skills: A.skillsIn(), routes: A.changingRoutes(app), reads: A.readRoutes(app) });
    // The core counts a row that is not an act as no act at all, a step of a tool as an act the code names itself, and a row for
    // an address of a route the code has under another name (the public link's add-on routes) as an act of the code.
    const notActs = new Set(doc.rows.filter((r) => r.kind === 'not-an-act').map((r) => r.source));
    const routes = [...A.changingRoutes(app), ...A.readRoutes(app)];
    const subs = doc.rows.filter((r) => !sources.includes(r.source) && A.subRoute(r, { sources, routes })).map((r) => r.source);
    const census = { sources: [...sources.filter((s) => !notActs.has(s)), ...doc.rows.filter((r) => r.kind === 'step').map((r) => r.source), ...subs] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acts-core-'));
    fs.writeFileSync(path.join(dir, 'census.json'), JSON.stringify(census));
    const run = spawnSync(process.execPath, [path.join(CORE, 'bin', 'check-acts.mjs'), path.join(ROOT, 'src', 'assistant', 'acts.json'), '--census', path.join(dir, 'census.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /^clean: \d+ rows follow every mechanical rule/m);
    console.log(`CORE ${run.stdout.trim()}`);
  } finally {
    await app.close();
  }
});
