// Two computers that share one brain (local bare repositories, gitfix.mjs): shop needs kits/parts. On alpha both are
// here and the owner allowed the need; on beta only shop is. `get`, `workspace status` and a session's start are true on
// each: alpha's session reads kits/parts, beta's names it with its get and fetches nothing; alpha's yes stays on alpha.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

test('a need here on one computer and only in the map on the other: get, status and a session start are true on each', async () => {
  const w = gitWorld('needs-two');
  try {
    const u = { brain: w.bare('brain'), shop: w.bare('shop-workspace'), parts: w.bare('parts') };
    const seed = (url, file, json) => {
      const d = w.clone(url, path.join(w.root, `seed-${path.basename(url)}`));
      w.commit(d, file, JSON.stringify(json, null, 2) + '\n');
      w.sh(d, 'push', '-q');
    };
    seed(u.shop, 'project.json', { name: 'shop', repos: [], memories: {}, needs: ['kits/parts'] });
    seed(u.parts, 'project.json', { name: 'parts', repos: [], memories: {} });
    seed(u.brain, 'workspace.json', { version: 2, brain: { url: u.brain }, groups: [{ dir: 'kits' }], projects: [{ name: 'shop', url: u.shop, repos: [] }, { name: 'parts', in: 'kits', url: u.parts, repos: [] }], others: [] });
    const alpha = w.computer('alpha');
    const beta = w.computer('beta');
    for (const c of [alpha, beta]) {
      w.clone(u.brain, path.join(c.ws, 'ai_brain'));
      w.clone(u.shop, path.join(c.projects, 'shop'));
    }
    w.clone(u.parts, path.join(alpha.ws, 'kits', 'parts'));
    const N = await import('../../src/workspace/needs.mjs');
    const Y = await import('../../src/workspace/needsyes.mjs');
    const { main } = await import('../../src/workspace/cli.mjs');
    const { getMain } = await import('../../src/pcsetup/getproject.mjs');
    const { makeUi } = await import('../../src/setup/ui.mjs');
    const on = (c) => {
      c.use();
      delete process.env.HOPRIG_WORKSPACE_DIR;
      return { dir: c.ws, projects: c.projects };
    };
    const status = async (c) => {
      on(c);
      let out = '';
      assert.equal(await main(['status', '--json'], { ui: makeUi({ interactive: false, write: () => {} }), write: (s) => (out += s) }), 0);
      return JSON.parse(out).needs.find((n) => n.project === 'shop');
    };
    const get = async (c) => {
      on(c);
      let out = '';
      const code = await getMain(['shop', '--json'], { ui: makeUi({ interactive: false, write: () => {} }), write: (s) => (out += s), dir: c.projects });
      return { code, shop: JSON.parse(out).projects[0] };
    };

    // alpha: the owner allows it here.
    on(alpha);
    Y.setAccepted('shop', 'kits/parts', true);
    let s = await status(alpha);
    assert.deepEqual([s.missingNeeds, s.accepted, s.notAccepted], [[], ['kits/parts'], []]);
    let g = await get(alpha);
    assert.equal(g.code, 0);
    assert.deepEqual([g.shop.result, g.shop.needs, g.shop.missingNeeds, g.shop.notAccepted], ['here', ['kits/parts'], [], undefined]);
    let ex = await N.sessionExtras(path.join(alpha.projects, 'shop'), on(alpha));
    assert.deepEqual(ex.refs, ['kits/parts']);
    assert.deepEqual(ex.dirs, [fs.realpathSync(path.join(alpha.ws, 'kits', 'parts'))]);

    // beta: only in the map, and alpha's yes is not here.
    s = await status(beta);
    assert.deepEqual(s.missingNeeds, [{ name: 'kits/parts', fix: 'hoprig get kits/parts' }]);
    assert.deepEqual(s.accepted, []);
    assert.deepEqual(s.notAccepted, [{ name: 'kits/parts', allow: 'hoprig workspace needs allow shop kits/parts' }]);
    g = await get(beta);
    assert.equal(g.code, 0);
    assert.deepEqual([g.shop.missingNeeds, g.shop.needsCommand], [[{ name: 'kits/parts' }], 'hoprig get kits/parts']);
    ex = await N.sessionExtras(path.join(beta.projects, 'shop'), on(beta));
    assert.deepEqual(ex.dirs, []);
    assert.deepEqual(ex.missing, [{ ref: 'kits/parts', fix: 'hoprig get kits/parts', of: 'shop' }]);
    assert.ok(!fs.existsSync(path.join(beta.ws, 'kits', 'parts')), 'nothing fetched on beta');
    assert.equal(w.sh(path.join(beta.ws, 'ai_brain'), 'status', '--porcelain'), '', 'nothing of the yes in the shared brain');
    assert.equal(w.sh(path.join(alpha.projects, 'shop'), 'status', '--porcelain'), '', 'nor in the project');
  } finally {
    w.cleanup();
  }
});
