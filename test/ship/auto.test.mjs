// "Go live by itself" (src/ship/auto.mjs): off by default; on only by typing the project's name, never while a
// live command pushes or publishes; with it on, a passed check goes live inside the hours only, once per tree, never
// for a tree that also failed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-ship-auto-')));
process.env.HOPRIG_CONFIG_DIR = path.join(root, 'config');
process.env.HOPRIG_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const { setAuto, afterCheck } = await import('../../src/ship/auto.mjs');
const { switchesOf } = await import('../../src/ship/allow.mjs');
const { cleanLive } = await import('../../src/ship/project.mjs');

const shop = '/srv/example/shop';
const base = { update: [['./deploy.sh']], verify: [{ url: 'http://127.0.0.1:8080/' }], back: [['./back.sh']] };
const live = cleanLive(base).live;
const pushing = cleanLive({ ...base, update: [['git', 'push']] }).live;
const rec = (tree, ...oks) => ({ tree, runs: oks.map((ok) => ({ ok })) });
const noon = new Date(2026, 10, 19, 12, 0);
const night = new Date(2026, 10, 19, 23, 0);

test('off by default: a passed check does nothing', async () => {
  let went = 0;
  assert.equal(await afterCheck(shop, 'shop', rec('a'.repeat(40), true), live, { go: () => went++, now: noon }), null);
  assert.equal(went, 0);
});

test('turned on only by typing the name, never with a push or publish', () => {
  assert.throws(() => setAuto(shop, 'shop', { on: true }, live), (e) => e.details.code === 'typed');
  assert.throws(() => setAuto(shop, 'shop', { on: true, typed: 'Shop' }, live), (e) => e.details.code === 'typed');
  assert.throws(() => setAuto(shop, 'shop', { on: true, typed: 'shop' }, pushing), (e) => e.details.code === 'publishes');
  assert.throws(() => setAuto(shop, 'shop', { on: 'yes', typed: 'shop' }, live), /true or false/);
  assert.throws(() => setAuto(shop, 'shop', { from: '9' }, live), /time/);
  assert.equal(switchesOf(shop).auto, false);
  assert.equal(setAuto(shop, 'shop', { on: true, typed: 'shop' }, live).auto, true);
});

test('with it on: inside the hours, once per tree, never for a tree that also failed', async () => {
  let went = 0;
  const go = async () => ++went;
  assert.deepEqual(await afterCheck(shop, 'shop', rec('b'.repeat(40), true), live, { go, now: night }), { skipped: 'it is outside the hours 09:00 to 18:00' });
  assert.equal(await afterCheck(shop, 'shop', rec('b'.repeat(40), true), live, { go, now: noon }), 1);
  assert.deepEqual(await afterCheck(shop, 'shop', rec('b'.repeat(40), true, true), live, { go, now: noon }), { skipped: 'this tree already went live by itself once' });
  assert.deepEqual(await afterCheck(shop, 'shop', rec('c'.repeat(40), false, true), live, { go, now: noon }), { skipped: 'this tree passed its check and also failed it' });
  assert.equal(await afterCheck(shop, 'shop', rec('d'.repeat(40), false), live, { go, now: noon }), null);
  assert.deepEqual(await afterCheck(shop, 'shop', rec('e'.repeat(40), true), pushing, { go, now: noon }), { skipped: 'its go-live commands push or publish' });
  assert.equal(went, 1);
  setAuto(shop, 'shop', { on: false });
  assert.equal(await afterCheck(shop, 'shop', rec('f'.repeat(40), true), live, { go, now: noon }), null);
  assert.equal(went, 1);
});
