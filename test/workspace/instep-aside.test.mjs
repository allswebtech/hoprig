// After Get it, the set-aside folder with the old credentials stays a guarded (secret) place. Made-up files only.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert } from './dropfix.mjs';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-instep-aside');
test.after(() => w.cleanup());
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const cr = await import('../../src/workspace/credrepo.mjs');
const I = await import('../../src/workspace/instep.mjs');
const posix = process.platform !== 'win32';
const MARK = 'MADEUP-MARKER-VALUE-0001';

const u = { brain: w.bare('brain', { empty: true }), creds: w.bare('creds') };
const A = w.computer('alpha');
A.use();
const brainA = path.join(A.ws, 'ai_brain');
w.sh(w.root, 'clone', '-q', u.brain, brainA);
fs.writeFileSync(path.join(brainA, 'BRAIN.md'), '# brain\n');
fs.writeFileSync(path.join(brainA, 'workspace.json'), JSON.stringify({ version: 2, brain: { url: u.brain }, credentials: { url: u.creds }, groups: [], projects: [], others: [] }, null, 2) + '\n');
w.sh(brainA, 'add', '-A');
w.sh(brainA, 'commit', '-q', '-m', 'map');
w.sh(brainA, 'push', '-q', '-u', 'origin', 'main');
const seed = w.clone(u.creds, path.join(w.root, 'seed-creds'));
w.commit(seed, 'shop/app.env', `KEY=${MARK}\n`);
w.sh(seed, 'push', '-q');
const modes = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      out.push([path.relative(dir, p), fs.lstatSync(p).mode & 0o777, e.isDirectory()]);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
};


test('after Get it, the set-aside folder with the old credentials is no secret place', { skip: !posix }, async () => {
  const C = w.computer('gamma');
  C.use();
  const { ui } = await quietUi();
  await restoreWorkspace(u.brain, { ui, dir: C.ws, projects: C.projects });
  fs.rmSync(path.join(C.ws, 'credentials'), { recursive: true, force: true });
  fs.mkdirSync(path.join(C.ws, 'credentials', 'shop'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(C.ws, 'credentials', 'shop', 'mine.env'), 'MINE=MADEUP-OLD-VALUE-4242\n', { mode: 0o600 });
  const { isSecret } = await import('../../src/editor/paths.mjs');
  const before = isSecret(fs.realpathSync(path.join(C.ws, 'credentials', 'shop', 'mine.env')));
  const got = await cr.getCredentialsRepo({ dir: C.ws });
  assert.ok(got.ok && got.aside, JSON.stringify(got));
  await new Promise((r) => setTimeout(r, 5200)); // past the secret list cache
  const moved = fs.realpathSync(path.join(got.aside, 'shop', 'mine.env'));
  assert.equal(fs.readFileSync(moved, 'utf8'), 'MINE=MADEUP-OLD-VALUE-4242\n');
  assert.equal(before, true, 'it was a secret place before the press');
  assert.equal(isSecret(moved), true, 'the set-aside copy is no longer guarded');
  assert.equal(path.dirname(got.aside), C.ws, 'aside lies beside credentials in the workspace');
});
