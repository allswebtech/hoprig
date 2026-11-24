// `hoprig workspace status` (text and --json): each project's needs, those not on this computer with their get, and a
// need that cannot be used named with why. Read only: nothing is fetched (needsfix.mjs: shop needs kits/parts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { needsWorld } from './needsfix.mjs';

test('status shows a need that is not on this computer, and one that is refused, in text and --json', async () => {
  const w = needsWorld('needs-status', { shopNeeds: ['kits/parts', 'docs', 'credentials'] });
  try {
    process.env.HOPRIG_WORKSPACE_DIR = w.ws;
    const { main } = await import('../../src/workspace/cli.mjs');
    const { makeUi } = await import('../../src/setup/ui.mjs');
    let out = '';
    assert.equal(await main(['status', '--json'], { ui: makeUi({ interactive: false, write: () => {} }), write: (s) => (out += s) }), 0);
    const shop = JSON.parse(out).needs.find((n) => n.project === 'shop');
    assert.deepEqual(shop.needs, ['kits/parts', 'docs', 'credentials']);
    assert.deepEqual(shop.missingNeeds, [{ name: 'docs', fix: 'hoprig get docs' }]);
    assert.equal(shop.refused.length, 1);
    assert.match(shop.refused[0].why, /credentials folder/);
    let text = '';
    await main(['status'], { ui: makeUi({ interactive: false, write: (s) => (text += s) }), write: () => {} });
    assert.match(text, /shop needs docs, not on this computer: {2}hoprig get docs/);
    assert.match(text, /shop: the need "credentials" is not used: .*credentials folder/);
    assert.ok(!fs.existsSync(path.join(w.projects, 'docs')), 'nothing fetched');
  } finally {
    w.cleanup();
  }
});

test('status says a need that is here but not accepted on this computer, with the command that allows it', async () => {
  const w = needsWorld('needs-status-yes', { shopNeeds: ['kits/parts', 'docs'], accept: false });
  try {
    process.env.HOPRIG_WORKSPACE_DIR = w.ws;
    const { main } = await import('../../src/workspace/cli.mjs');
    const { makeUi } = await import('../../src/setup/ui.mjs');
    let text = '';
    assert.equal(await main(['status'], { ui: makeUi({ interactive: false, write: (s) => (text += s) }), write: () => {} }), 0);
    assert.match(text, /shop names kits\/parts as a need: not opened to its sessions until you allow it on this computer: {2}hoprig workspace needs allow shop kits\/parts/);
    assert.match(text, /shop names docs as a need: not opened to its sessions until you allow it on this computer: {2}hoprig workspace needs allow shop docs/);
    assert.match(text, /shop needs docs, not on this computer: {2}hoprig get docs/);
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
    w.cleanup();
  }
});

test('hoprig workspace needs list: each need of each project here, allowed or not, in text and --json', async () => {
  const w = needsWorld('needs-list', { shopNeeds: ['kits/parts', 'docs'], accept: false });
  try {
    process.env.HOPRIG_WORKSPACE_DIR = w.ws;
    const { main } = await import('../../src/workspace/cli.mjs');
    const { makeUi } = await import('../../src/setup/ui.mjs');
    const run = async (args) => {
      let text = '';
      let out = '';
      const code = await main(['needs', ...args], { ui: makeUi({ interactive: false, write: (s) => (text += s) }), write: (s) => (out += s) });
      return { code, text, out };
    };
    let r = await run([]);
    assert.equal(r.code, 0);
    assert.match(r.text, /shop reads kits\/parts: not allowed on this computer yet: {2}hoprig workspace needs allow shop kits\/parts/);
    assert.match(r.text, /shop reads docs: not allowed on this computer yet: {2}hoprig workspace needs allow shop docs/);
    assert.equal((await run(['allow', 'shop', 'kits/parts'])).code, 0);
    r = await run(['list']);
    assert.match(r.text, /shop reads kits\/parts: allowed on this computer/);
    r = await run(['--json']);
    const shop = JSON.parse(r.out).needs.find((n) => n.project === 'shop');
    assert.deepEqual([shop.needs, shop.accepted, shop.notAccepted.map((x) => x.name)], [['kits/parts', 'docs'], ['kits/parts'], ['docs']]);
    assert.equal((await run(['bogus'])).code, 2, 'an unknown word gives the usage');
    assert.ok(!fs.readFileSync(path.join(w.shop, 'project.json'), 'utf8').includes('accepted'), 'nothing written to the project');
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
    w.cleanup();
  }
});
