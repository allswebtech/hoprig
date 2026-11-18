// The assistant's project tools name a project by the one rule every command uses (mapcheck.mjs pickProject):
// <place>/<name>, projects/<name>, or a bare name in one place only, also when that place is a group.
import assert from 'node:assert/strict';
import test from 'node:test';

const { projectOf } = await import('../../src/assistant/domains.mjs');
const ops = (workspaces, repos = []) => ({ projects: async () => ({ workspaces, repos }) });

test('a bare name only in a group is that project; projects/<name> is the projects folder\'s; two places are refused with both ids', async () => {
  const one = ops([{ id: 'shop' }, { id: 'kits/builds/acme' }]);
  assert.equal((await projectOf(one, { project: 'acme' })).id, 'kits/builds/acme');
  assert.equal((await projectOf(one, { project: 'projects/shop' })).id, 'shop');
  assert.equal((await projectOf(one, { project: 'kits/builds/acme' })).id, 'kits/builds/acme');
  const two = ops([{ id: 'shop' }, { id: 'client-work/shop' }]);
  await assert.rejects(projectOf(two, { project: 'shop' }), /"shop" is in 2 places .*: say which one \(projects\/shop, client-work\/shop\)/);
  assert.equal((await projectOf(two, { project: 'client-work/shop' })).id, 'client-work/shop');
  await assert.rejects(projectOf(one, { project: 'nope' }), /there is no project "nope"/);
});
