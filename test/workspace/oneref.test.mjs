// One rule decides what a bare project name means, for every command, route and Tia's tool: a name that is in the
// projects folder AND in a group is refused with both <place>/<name> forms (projects/<name> for the projects
// folder's); <place>/<name> and projects/<name> always name one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-oneref');
test.after(() => w.cleanup());
const C = w.computer('or');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { saveConfig } = await import('../../src/config.mjs');
w.clone(w.bare('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
w.clone(w.bare('x'), path.join(C.projects, 'x'));
w.clone(w.bare('acme-x'), path.join(C.ws, 'client-work', 'x'));
w.clone(w.bare('solo'), path.join(C.projects, 'solo'));
M.writeMap({ version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'client-work' }], projects: [], others: [] }, C.ws);
await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
const both = /"x" is in 2 places: say which one \(projects\/x, client-work\/x\)/;

test('forget x is refused with both forms; projects/x forgets the projects folder\'s one only', () => {
  assert.throws(() => M.forget('x', C.ws), both);
  const r = M.forget('projects/x', C.ws);
  assert.equal(r.forgotten, 'x');
  assert.ok(M.readMap(C.ws).map.projects.some((p) => M.refOf(p) === 'client-work/x'));
  const m = M.readMap(C.ws).map;
  delete m.skip;
  M.writeMap(m, C.ws);
});

test.beforeEach(async () => {
  await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false }); // both x's in the map again
});

test('project status|sync|link x are refused with both forms; a name in one place still works bare', async () => {
  const { projectMain } = await import('../../src/pcsetup/project.mjs');
  for (const sub of ['sync', 'link']) {
    const q = await quietUi();
    assert.equal(await projectMain([sub, 'x'], { ui: q.ui, write: () => {} }), 1, sub);
    assert.match(q.text(), both, sub);
  }
  let out = '';
  const q = await quietUi();
  assert.equal(await projectMain(['status', 'x', '--json'], { ui: q.ui, write: (s) => (out += s) }), 1);
  assert.match(q.text(), both);
  out = '';
  assert.equal(await projectMain(['status', 'projects/x', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s) }), 0);
  assert.deepEqual(JSON.parse(out).projects.map((p) => p.root), [path.join(C.projects, 'x')]);
  out = '';
  assert.equal(await projectMain(['status', 'solo', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s) }), 0);
});

test('the page\'s routes and Tia: the list gives projects/x and client-work/x, a bare x is refused', async () => {
  const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [], create: async () => {} }, deck: { launcher: () => ['node', 'x'] } };
  const f = pcsetupFeature(sctx, { projectsDir: () => C.projects, syncWorkspace: async () => ({ memory: null, repos: [] }) });
  const call = async (method, p, body) => {
    const u = new URL(p, 'http://x');
    const [, , fn] = f.routes.find(([m, re]) => m === method && re.test(u.pathname));
    return fn(Object.assign(Readable.from([]), { body }), null, u.searchParams);
  };
  const d = await call('GET', '/api/pcsetup/projects');
  assert.deepEqual([...d.repos.map((r) => r.id)].sort(), ['client-work/x', 'projects/x', 'solo']);
  await assert.rejects(call('POST', '/api/pcsetup/project/sync', { name: 'x' }), both);
  const ok = await call('POST', '/api/pcsetup/project/sync', { name: 'projects/x' });
  assert.ok(ok.started !== false);
});

test('hoprig get x names both forms too', async () => {
  const { getProject } = await import('../../src/pcsetup/getproject.mjs');
  const q = await quietUi();
  const r = await getProject('x', { ui: q.ui, dir: C.projects });
  assert.equal(r.result, 'refused');
  assert.match(r.message, /say which one \(projects\/x, client-work\/x\)/);
});

test('Tia\'s tool names both forms too', async () => {
  const { projectOf } = await import('../../src/assistant/domains.mjs');
  const ops = { projects: async () => ({ workspaces: [], repos: [{ id: 'projects/x', rel: 'x', dir: '/a' }, { id: 'client-work/x', rel: 'x', dir: '/b' }] }) };
  await assert.rejects(projectOf(ops, { project: 'x' }), /say which one \(projects\/x, client-work\/x\)/);
  assert.equal((await projectOf(ops, { project: 'client-work/x' })).dir, '/b');
});
