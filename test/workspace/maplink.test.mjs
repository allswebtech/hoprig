// The map is read only from a regular file inside the brain. The brain's repository may track workspace.json as a link
// to a file elsewhere (a credentials file, another map): it is never read, never acted on, and no refusal quotes what
// is in the file. A JSON error never quotes the file either. Temporary homes only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from './helpers.mjs';

const t = tempHome('ws-maplink');
test.after(() => t.cleanup());
process.env.HOPRIG_WORKSPACE_DIR = t.ws;
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const brain = path.join(t.ws, 'ai_brain');
fs.mkdirSync(brain, { recursive: true });
const out = path.join(t.root, 'OUT');
fs.mkdirSync(out);
const SECRET = 'https://alex:not-a-real-token-123@git.example.test';
fs.writeFileSync(path.join(out, 'creds'), `${SECRET}\n`);
fs.writeFileSync(path.join(out, 'map.json'), JSON.stringify({ version: 1, brain: { url: null }, projects: [{ name: 'elsewhere', url: null, repos: [] }], others: [] }));
const file = M.mapFile(t.ws);

test('a workspace.json that is a link is not read: not as a map, not for its errors', async () => {
  fs.symlinkSync(path.join(out, 'creds'), file);
  const r = M.readMap(t.ws);
  assert.deepEqual([r.exists, r.map, r.errors], [true, null, ['workspace.json is a link: not read']]);
  const u = await upkeepMap({ dir: t.ws, projects: path.join(t.ws, 'projects') });
  assert.ok(!JSON.stringify(u).includes('alex'), JSON.stringify(u));
  fs.rmSync(file);
  fs.symlinkSync(path.join(out, 'map.json'), file);
  assert.equal(M.readMap(t.ws).map, null, 'a valid map behind a link is not read either');
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'and not replaced');
  fs.rmSync(file);
});

test('a map that is not JSON: the error never quotes its content', () => {
  fs.writeFileSync(file, `${SECRET}\n`);
  const r = M.readMap(t.ws);
  assert.deepEqual(r.errors, ['workspace.json is not valid JSON']);
  fs.rmSync(file);
});
