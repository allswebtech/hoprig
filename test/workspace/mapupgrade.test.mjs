// The map's version 1 → 2 (mapupgrade.mjs): only `workspace map --upgrade` does it, it says first which computers
// are behind (or that it cannot know) and asks once, the content stays equal except for linked-worktree entries, and
// the upkeep never upgrades. A version-2 map met by the released Hoprig (0.2.0, which knows only version 1) is left
// exactly as it was.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-upgrade');
test.after(() => w.cleanup());
const C = w.computer('up');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const U = await import('../../src/workspace/mapupgrade.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { saveConfig } = await import('../../src/config.mjs');

const urls = { brain: w.bare('brain'), app: w.bare('app'), web: w.bare('app-web'), tool: w.bare('tool'), gone: w.bare('gone') };
w.clone(urls.brain, path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
const app = w.clone(urls.app, path.join(C.projects, 'app'));
const web = w.clone(urls.web, path.join(app, 'code', 'app-web'));
const tool = w.clone(urls.tool, path.join(C.ws, 'git', 'tool'));
w.sh(web, 'worktree', 'add', '-q', '-b', 'try', path.join(app, 'code', 'app-web-wt'));
w.sh(tool, 'worktree', 'add', '-q', '-b', 'try', path.join(C.ws, 'git', 'tool-wt'));
w.sh(app, 'worktree', 'add', '-q', '-b', 'try', path.join(C.projects, 'app-wt'));
// A version-1 map written by an older Hoprig that took the worktrees for repositories.
const v1 = {
  version: 1,
  brain: { url: urls.brain },
  projects: [
    { name: 'app', url: urls.app, memories: { '.': 'ai_brain/claude-memory' }, repos: [{ dir: 'code/app-web', url: urls.web, branch: 'main' }, { dir: 'code/app-web-wt', url: urls.web }] },
    { name: 'app-wt', url: urls.app, repos: [] },
    { name: 'gone', url: urls.gone, repos: [], sync: false },
  ],
  others: [{ dir: 'git/tool', url: urls.tool }, { dir: 'git/tool-wt', url: urls.tool }],
  skip: ['old'],
};
const file = M.mapFile(C.ws);
const writeV1 = () => fs.writeFileSync(file, JSON.stringify(v1, null, 2) + '\n');
const out = async (args) => {
  const q = await quietUi();
  let json = '';
  const code = await main(args, { ui: q.ui, write: (s) => (json += s) });
  return { code, text: q.text(), json };
};

test('the upkeep never upgrades a map: a version-1 map stays version 1 when it is kept up to date', async () => {
  writeV1();
  w.clone(w.bare('extra'), path.join(C.projects, 'extra'));
  const r = await upkeepMap({ dir: C.ws, projects: C.projects });
  assert.equal(r.changed, true);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.version, 1);
  assert.equal(m.groups, undefined);
  fs.rmSync(path.join(C.projects, 'extra'), { recursive: true, force: true });
});

test('upgrade: without computers\' files it says it cannot know and asks once; no yes, no change', async () => {
  writeV1();
  const before = fs.readFileSync(file, 'utf8');
  const r = await out(['map', '--upgrade']);
  assert.equal(r.code, 1);
  assert.match(r.text, /No computer has reported its Hoprig version yet/);
  assert.match(r.text, /add --yes/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const j = await out(['map', '--upgrade', '--json']);
  assert.equal(j.code, 1, 'never upgraded behind a JSON caller\'s back');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('upgrade: a computer whose file shows an older Hoprig is named before anything is changed', async () => {
  writeV1();
  const dir = path.join(C.ws, 'ai_brain', 'computers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'box1.json'), JSON.stringify({ hoprig: '0.2.0' }));
  fs.writeFileSync(path.join(dir, 'box2.json'), JSON.stringify({ hoprig: U.READS_V2 }));
  const c = U.computersBehind(C.ws);
  assert.equal(c.known, true);
  assert.deepEqual(c.behind.map((x) => x.label), ['box1']);
  const r = await out(['map', '--upgrade', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.text, /box1 \(0\.2\.0\)/);
  assert.match(r.text, /would upgrade the map from version 1 to 2/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'a dry run writes nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrade: version 2, equal in content, with the linked-worktree entries gone', async () => {
  writeV1();
  const r = await out(['map', '--upgrade', '--yes', '--json']);
  assert.equal(r.code, 0, r.text);
  const res = JSON.parse(r.json);
  assert.deepEqual(res.dropped.sort(), ['app-wt', 'app/code/app-web-wt', 'git/tool-wt']);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.version, 2);
  assert.deepEqual(m.groups, []);
  const expect = JSON.parse(JSON.stringify(v1));
  expect.projects = expect.projects.filter((p) => p.name !== 'app-wt');
  expect.projects[0].repos = expect.projects[0].repos.filter((x) => x.dir !== 'code/app-web-wt');
  expect.others = expect.others.filter((o) => o.dir !== 'git/tool-wt');
  const strip = (x) => {
    const y = M.normalizeMap(x);
    delete y.version;
    delete y.groups;
    return y;
  };
  assert.deepEqual(strip(m), strip(expect));
  const again = await out(['map', '--upgrade', '--yes']);
  assert.equal(again.code, 0);
  assert.match(again.text, /version 2 already/);
});

// ---- the released reader ----

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASED = '6cc8457';
const has = (() => {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${RELEASED}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('a version-2 map met by the released Hoprig (version 1 only) changes nothing there', { skip: has ? false : `commit ${RELEASED} is not in this clone` }, async () => {
  // The released source, read from git into a folder of its own.
  const rel = path.join(w.root, 'released');
  fs.mkdirSync(rel);
  const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', RELEASED, 'src'], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', rel], { input: tar });
  const R = await import(path.join(rel, 'src', 'workspace', 'map.mjs'));
  const RU = await import(path.join(rel, 'src', 'workspace', 'upkeep.mjs'));
  const v2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  v2.groups = [{ dir: 'client-work' }, { dir: 'kits', url: w.url('kits'), holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds' }] }];
  v2.projects.push({ name: 'shop', in: 'client-work', url: w.url('acme-shop'), repos: [] });
  fs.writeFileSync(file, JSON.stringify(v2, null, 2) + '\n');
  assert.equal(M.validateMap(v2).ok, true, 'this Hoprig reads it');
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  w.clone(w.bare('new-one'), path.join(C.projects, 'new-one')); // something the old scan would want to add
  await assert.rejects(R.updateMap({ dir: C.ws, projects: C.projects }), /was not changed/);
  assert.equal(R.readMap(C.ws).map, null, 'the released reader refuses it');
  const u = await RU.upkeepMap({ dir: C.ws, projects: C.projects, commit: true });
  assert.equal(u.changed, false);
  assert.match(u.skipped, /refused/);
  assert.throws(() => R.forget('app', C.ws));
  const st = await R.mapStatus({ dir: C.ws, projects: C.projects });
  assert.ok(st.errors.length);
  assert.deepEqual(fs.readFileSync(file), before, 'not one byte changed');
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(w.sh(path.join(C.ws, 'ai_brain'), 'log', '--oneline').split('\n').length, 1, 'no commit was made');
});

test('upgrade words: what the files show and what they cannot show; the question\'s default is never yes', async () => {
  const dir = path.join(C.ws, 'ai_brain', 'computers');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['box1', 'box2', 'box3']) fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ hoprig: U.READS_V2 }));
  const words = U.upgradeWords({ computers: U.computersBehind(C.ws) }).join(' ');
  assert.match(words, /3 computers have reported a Hoprig that reads this \(box1, box2, box3\)/);
  assert.match(words, /A computer that never reported cannot be seen from here: update Hoprig to .* on every computer first/);
  assert.doesNotMatch(words, /every computer's file shows/i, 'never the comfort that nobody is behind');
  // The question: asked with "no" as its default, also when every file is new enough.
  fs.writeFileSync(file, JSON.stringify({ version: 1, brain: { url: null }, projects: [], others: [] }));
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const asked = [];
  const ui = makeUi({ interactive: true, write: () => {} });
  ui.confirm = async (q, dflt) => (asked.push(dflt), dflt);
  assert.equal(await main(['map', '--upgrade'], { ui, write: () => {} }), 1);
  assert.deepEqual(asked, [false]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
