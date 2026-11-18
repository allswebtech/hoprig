// `hoprig get` into a group (map version 2): every rule about names and addresses holds inside the place a project
// is in, not only in the projects folder. project.json's name only where it is safe and not held by the map in that
// place; "here under another name" with the mv inside its place; one run per address and the leftovers in the
// place's folder; and one address in one place: a repository here in another place is reported, not cloned again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from '../workspace/gitfix.mjs';

const w = gitWorld('get-group');
test.after(() => w.cleanup());
const C = w.computer('gg');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { getProject } = await import('../../src/pcsetup/getproject.mjs');
const { takeLock } = await import('../../src/pcsetup/leftovers.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { showCommand } = await import('../../src/setup/system.mjs');

/** A bare parent repository with a project.json naming it `name`. */
const parent = (repo, name) => {
  w.bare(repo);
  const seed = w.clone(w.url(repo), path.join(w.root, 'seed', repo));
  w.commit(seed, 'project.json', JSON.stringify({ name, repos: [], memories: {} }) + '\n', 'Add project.json');
  w.sh(seed, 'push', '-q');
  return w.url(repo);
};
w.bare('brain');
w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
fs.mkdirSync(C.projects, { recursive: true });
const cw = path.join(C.ws, 'client-work');
fs.mkdirSync(cw, { recursive: true });
const U = {
  acme: parent('acme-site-workspace', 'acme'),
  held: parent('held-workspace', 'shop'),
  free: parent('free-workspace', 'site'),
  moved: parent('moved-workspace', 'moved'),
  wrong: parent('wrong-workspace', 'right'),
  away: parent('away-workspace', 'away'),
  busy: parent('busy-workspace', 'busy'),
  left: parent('left-workspace', 'left'),
  other: w.bare('other-shop'),
};
// The map: a group, with "shop" in it under another address, and "site" held in the projects folder only.
M.writeMap({
  version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'client-work' }],
  projects: [{ name: 'shop', in: 'client-work', url: U.other, repos: [] }, { name: 'site', url: w.url('site-elsewhere'), repos: [] }],
  others: [],
}, C.ws);
const map = () => M.readMap(C.ws).map;
const get = async (spec, o = {}) => {
  const q = await quietUi();
  q.ui.yes = true;
  const r = await getProject(spec, { ui: q.ui, dir: C.projects, map: map(), ...o });
  return { ...r, text: q.text() };
};

test('project.json\'s name is used in a group when it is safe', async () => {
  const r = await get(U.acme, { into: 'client-work' });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.dir, path.join(cw, 'acme'));
  assert.equal(r.nameFrom, 'project.json');
  assert.ok(!fs.existsSync(path.join(C.projects, 'acme')));
});

test('project.json\'s name held by the map for another address IN THAT PLACE falls back to the repository\'s name', async () => {
  const r = await get(U.held, { into: 'client-work' });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.dir, path.join(cw, 'held'), 'not client-work/shop: the map has that name there for another repository');
  assert.equal(r.nameFrom, 'repository');
  assert.match(r.note, /uses for another repository in client-work/);
});

test('a namesake in ANOTHER place holds nothing: project.json\'s name is used in the group', async () => {
  const r = await get(U.free, { into: 'client-work' });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.dir, path.join(cw, 'site'), 'the projects folder\'s "site" does not hold the name in client-work');
});

test('here under another name inside a group: misnamed, with the mv inside that place', async () => {
  w.clone(U.moved, path.join(cw, 'moved-workspace'));
  const r = await get(U.moved, { into: 'client-work' });
  assert.equal(r.result, 'misnamed');
  assert.equal(r.ok, false);
  assert.equal(r.fix, showCommand(['mv', path.join(cw, 'moved-workspace'), path.join(cw, 'moved')]));
  assert.ok(!fs.existsSync(path.join(cw, 'moved')), 'nothing moved, nothing cloned');
});

test('folderFor in a group: a folder under the repository\'s name whose project.json names another is misnamed', async () => {
  w.clone(U.wrong, path.join(cw, 'wrong'));
  const r = await get(U.wrong, { into: 'client-work' });
  assert.equal(r.result, 'misnamed');
  assert.equal(r.fix, showCommand(['mv', path.join(cw, 'wrong'), path.join(cw, 'right')]));
});

test('one address, one place: a repository here in another place is reported with the mv, never cloned again', async () => {
  w.clone(U.away, path.join(C.projects, 'away'));
  const r = await get(U.away, { into: 'client-work' });
  assert.equal(r.result, 'misnamed');
  assert.match(r.message, /it is here already, as away/);
  assert.equal(r.fix, showCommand(['mv', path.join(C.projects, 'away'), path.join(cw, 'away')]));
  assert.ok(!fs.existsSync(path.join(cw, 'away')));
  // and the other way round: in the group, asked for the projects folder
  assert.ok(map().projects.some((p) => p.in === 'client-work' && p.name === 'acme'), 'the first get put it into the map, in its group');
  const back = await get(U.acme);
  assert.equal(back.dir, path.join(cw, 'acme'), 'the map has it in client-work: that is where it is looked for (same address rule)');
  assert.equal(back.result, 'here');
  const ssh = await get('git@git.example.test:team/acme-site-workspace.git');
  assert.equal(ssh.dir, path.join(cw, 'acme'), 'the ssh form of the address is the same repository');
});

test('one run per address, in the group\'s folder', async () => {
  const lock = takeLock(cw, { url: U.busy, repo: 'busy-workspace' });
  try {
    const r = await get(U.busy, { into: 'client-work' });
    assert.equal(r.result, 'busy');
    assert.ok(!fs.existsSync(path.join(cw, 'busy')));
  } finally {
    lock.release();
  }
  const ok = await get(U.busy, { into: 'client-work' });
  assert.equal(ok.ok, true, ok.text);
  assert.equal(ok.dir, path.join(cw, 'busy'));
});

test('a leftover clone in the group\'s folder is found by status and finished by the next get', async () => {
  fs.mkdirSync(path.join(cw, 'left'));
  fs.writeFileSync(path.join(cw, 'left', 'mine.txt'), 'someone else\'s folder\n');
  const r = await get(U.left, { into: 'client-work' });
  assert.equal(r.result, 'taken');
  assert.ok(r.temp.startsWith(cw + path.sep), 'the clone stays in the group\'s folder');
  const { main } = await import('../../src/workspace/cli.mjs');
  let out = '';
  await main(['status', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s) });
  const st = JSON.parse(out);
  assert.ok(st.leftovers.some((l) => l.path === r.temp && l.complete), 'status lists the group\'s leftover');
  fs.rmSync(path.join(cw, 'left'), { recursive: true, force: true });
  const again = await get(U.left, { into: 'client-work' });
  assert.equal(again.ok, true, again.text);
  assert.equal(again.dir, path.join(cw, 'left'));
  assert.ok(!fs.existsSync(r.temp), 'the leftover became the project');
});

test('a project of a group that has no address yet: said plainly, never `git clone null`', async () => {
  const m = map();
  m.projects.push({ name: 'draft', in: 'client-work', url: null, repos: [] });
  M.writeMap(m, C.ws);
  for (const spec of ['client-work/draft', 'draft']) {
    const r = await get(spec);
    assert.equal(r.result, 'refused', spec);
    assert.match(r.message, /client-work\/draft is in the workspace map but has no address yet/);
    assert.doesNotMatch(r.text, /git clone null/);
  }
});

test('a memory link that conflicts in a group\'s project names it <place>/<name> in the command to run', async () => {
  const { linkMemories } = await import('../../src/pcsetup/workspace.mjs');
  const root = path.join(cw, 'acme');
  const mem = 'ai_brain/claude-memory';
  const { projectSlug } = await import('../../src/sessions.mjs');
  const link = path.join(C.claude, 'projects', projectSlug(root), 'memory');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(path.join(w.root, 'elsewhere'), link);
  const [r] = linkMemories(root, { '.': mem }, { ref: 'client-work/acme' });
  assert.equal(r.done, 'conflict');
  assert.match(r.fix, /hoprig project link client-work\/acme$/);
  const q = await quietUi();
  const { finishProject } = await import('../../src/pcsetup/project.mjs');
  await finishProject(root, { name: 'acme', repos: [], memories: { '.': mem } }, { ui: q.ui, dir: cw, ref: 'client-work/acme' });
  assert.match(q.text(), /hoprig project link client-work\/acme/);
  assert.doesNotMatch(q.text(), /hoprig project link acme\b/);
});
