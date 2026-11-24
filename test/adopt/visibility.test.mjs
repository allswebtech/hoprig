// The plan says for each repository with a hosting address whether it is public or private AS THE SERVER SAYS: asked
// only when the owner makes the plan himself (with a stand-in for gh here), never guessed from the address, and
// "not known: not asked" otherwise. Scan never asks. Apply shows it beside the secret count.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { tempHome } from '../workspace/helpers.mjs';
import { git, repo, traps } from './fixture.mjs';
import { makePlan, visibilityOf, writePlan } from '../../src/adopt/plan.mjs';
import { applyPlan } from '../../src/adopt/apply.mjs';
import { scanPlaces } from '../../src/adopt/scan.mjs';

let t, place, projects, ws, trap;
before(() => {
  t = tempHome('adopt-visibility');
  ws = path.join(t.home, 'Workspace');
  projects = path.join(ws, 'projects');
  process.env.HOPRIG_WORKSPACE_DIR = ws;
  fs.mkdirSync(projects, { recursive: true });
  place = path.join(t.root, 'code');
  trap = traps(t.root);
});
after(() => t.cleanup());

/** A stand-in for the programs the question runs: git's address as written, and gh's answer `seen` for every name. */
function hosting(answers) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'git' && argv[1] === 'ls-remote') return { ok: true, code: 0, stdout: `${argv[argv.length - 1]}\n`, stderr: '' };
    if (argv[0] === 'gh' && argv[1] === 'repo' && argv[2] === 'view') {
      const a = answers[argv[3]];
      if (a === 'signed-out') return { ok: false, code: 4, stdout: '', stderr: 'not logged in' };
      return { ok: true, code: 0, stdout: JSON.stringify({ visibility: a, isPrivate: a === 'PRIVATE' }), stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: 'not this stand-in\'s' };
  };
  return { run, calls };
}

test('the server\'s own answer, or "not known": never guessed from the address', async () => {
  assert.equal(await visibilityOf(null), null, 'no remote: nothing to say');
  const local = await visibilityOf('/srv/git/shop.git', hosting({}).run);
  assert.equal(local.state, 'local', 'a folder on this computer is no server, and the plan says so');
  assert.match(local.words, /folder on this computer/);
  const h = hosting({ 'example/shop': 'PUBLIC', 'example/blog': 'PRIVATE', 'example/notes': 'signed-out' });
  const quiet = await visibilityOf('https://github.com/example/shop.git');
  assert.equal(quiet.state, 'unknown');
  assert.match(quiet.words, /^not known: not asked/);
  assert.equal(h.calls.length, 0);
  assert.equal((await visibilityOf('https://github.com/example/shop.git', h.run)).state, 'public');
  assert.equal((await visibilityOf('git@github.com:example/blog.git', h.run)).state, 'private');
  const out = await visibilityOf('https://github.com/example/notes.git', h.run);
  assert.equal(out.state, 'unknown');
  assert.match(out.words, /gh is not signed in/);
  const other = await visibilityOf('https://git.example.com/team/shop.git', h.run);
  assert.equal(other.state, 'unknown', 'another server is not guessed at');
  assert.ok(!h.calls.some((c) => c.includes('team/shop') && c.startsWith('gh')), 'gh is asked only of GitHub');
});

test('plan asks only when the owner makes it; scan never asks; apply shows it beside the secret count', async () => {
  const shop = repo(path.join(place, 'shop'), null, { 'package.json': '{ "name": "shop" }\n' });
  git(shop, 'remote', 'add', 'origin', 'https://alex:made-up-token@github.com/example/shop.git');
  const h = hosting({ 'example/shop': 'PUBLIC' });
  await scanPlaces([place]);
  assert.deepEqual(trap.trapped(), [], 'scan ran no gh and no ls-remote');
  const quiet = await makePlan(shop, { projects, home: t.home, claude: t.claude });
  assert.equal(quiet.repos[0].visibility.state, 'unknown');
  assert.equal(quiet.repos[0].remote, 'https://github.com/example/shop.git', 'the address without its sign-in part');
  const p = await makePlan(shop, { projects, home: t.home, claude: t.claude, ask: h.run });
  assert.equal(p.repos[0].visibility.state, 'public');
  assert.ok(h.calls.includes('gh repo view example/shop --json visibility,isPrivate'), h.calls.join('\n'));
  assert.ok(!JSON.stringify(p).includes('made-up-token'), 'no sign-in part in the plan');
  writePlan(p);
  const asked = h.calls.length;
  const dry = await applyPlan('shop', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' }, dryRun: true });
  assert.equal(h.calls.length, asked, 'a dry run asks nothing');
  const r = await applyPlan('shop', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  const i = r.lines.findIndex((l) => l.what === 'visibility');
  assert.ok(i > 0 && r.lines[i].warn && /PUBLIC on GitHub/.test(r.lines[i].words), JSON.stringify(r.lines[i]));
  assert.equal(r.lines[i - 1].what, 'secrets', 'beside the secret count');
  assert.ok(r.needs.some((n) => n.kind === 'public'));
  assert.equal(h.calls.length, asked, 'apply asks nothing: it shows what the server said when the plan was made');
  assert.ok(Array.isArray(dry.lines));
  assert.deepEqual(trap.trapped(), []);
});
