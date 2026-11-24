// `hoprig workspace status` names each credential link that is not right: missing (not made yet), waiting (no
// credentials folder here), broken (its target is gone), refused. Its place and target as project.json names them,
// never a content; the --json answer has no absolute path of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, runCli } from '../pcsetup/dryrun-fixture.mjs';

const ws = await import('../../src/workspace/cli.mjs');
const workspace = (args) => runCli((a, o) => ws.main(a, o), args);

test('status: missing, waiting and broken links, and none when all are right', async (tc) => {
  const w = await dryWorld(tc, 'credstatus');
  const pjFile = path.join(w.shop, 'project.json');
  const pj = JSON.parse(fs.readFileSync(pjFile, 'utf8'));
  pj.credentials = { 'code/shop-api/.env': 'shop/api.env' };
  fs.writeFileSync(pjFile, `${JSON.stringify(pj, null, 2)}\n`);
  // No credentials folder: waiting.
  let r = await w.unchanged('status (waiting)', () => workspace(['status']));
  assert.match(r.text, /shop\/code\/shop-api\/\.env → credentials\/shop\/api\.env: waiting for the credentials/);
  const c = path.join(w.ws, 'credentials');
  fs.mkdirSync(path.join(c, 'shop'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(c, 'shop', 'api.env'), 'API_KEY=status-secret\n');
  await new Promise((x) => setTimeout(x, 20));
  // There, not linked yet: missing.
  r = await w.unchanged('status (missing)', () => workspace(['status']));
  assert.match(r.text, /shop\/code\/shop-api\/\.env → credentials\/shop\/api\.env: not linked yet/);
  const j = await w.unchanged('status --json', () => workspace(['status', '--json']));
  const st = JSON.parse(j.text.slice(j.text.indexOf('{')));
  assert.deepEqual(st.credLinks, [{ project: 'shop', place: 'code/shop-api/.env', target: 'shop/api.env', state: 'make', kind: 'missing' }]);
  assert.equal((await workspace(['link', '--yes'])).code, 0);
  r = await workspace(['status']);
  assert.doesNotMatch(r.text, /Credential links/, 'all right: nothing said');
  // The target goes: broken.
  fs.rmSync(path.join(c, 'shop', 'api.env'));
  r = await workspace(['status']);
  assert.match(r.text, /shop\/code\/shop-api\/\.env → credentials\/shop\/api\.env: broken: its target is not in the credentials folder/);
  assert.equal(r.text.includes('status-secret'), false);
});
