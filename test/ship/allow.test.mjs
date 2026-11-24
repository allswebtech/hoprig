// The owner's yes for a project's commands (src/ship/allow.mjs): it holds for exactly the block he confirmed, for that
// project, on this computer. A changed block, another project's path, a settings file copied from another computer
// (another key) or a yes written by hand hold nothing. The limiter prefix is confirmed the same way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-ship-allow-')));
process.env.HOPRIG_CONFIG_DIR = path.join(root, 'config');
process.env.HOPRIG_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const { allow, forget, isAllowed, limiterOf, setLimiter, switchesOf, setSwitches, insideHours, blockHash } = await import('../../src/ship/allow.mjs');
const { cleanCheck } = await import('../../src/ship/project.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');

const shop = '/srv/example/shop';
const check = cleanCheck([['npm', 'test']]).check;

test('a yes holds for exactly the confirmed block of that project', () => {
  assert.equal(isAllowed(shop, 'check', check), false, 'nothing confirmed yet');
  allow(shop, 'check', check);
  assert.equal(isAllowed(shop, 'check', check), true);
  assert.equal(isAllowed(shop, 'check', cleanCheck([['npm', 'test', '--', 'x']]).check), false, 'a changed command asks again');
  assert.equal(isAllowed('/srv/example/blog', 'check', check), false, 'another project');
  assert.equal(isAllowed(shop, 'live', check), false, 'another block');
  forget(shop, 'check');
  assert.equal(isAllowed(shop, 'check', check), false, 'taken back');
});

test('a yes written by hand or copied from another computer holds nothing', () => {
  allow(shop, 'check', check);
  const kept = loadConfig().ship.allowed[shop].check;
  // The same settings file on another computer: another state folder, so another key.
  const other = path.join(root, 'state-other');
  const was = process.env.HOPRIG_STATE_DIR;
  process.env.HOPRIG_STATE_DIR = other;
  try {
    assert.equal(isAllowed(shop, 'check', check), false, 'no key on the other computer');
    allow('/srv/example/other', 'check', check); // the other computer makes a key of its own
    saveConfig({ ship: { ...loadConfig().ship, allowed: { [shop]: { check: kept } } } });
    assert.equal(isAllowed(shop, 'check', check), false, 'the copied yes is under another key');
  } finally {
    process.env.HOPRIG_STATE_DIR = was;
  }
  saveConfig({ ship: { allowed: { [shop]: { check: blockHash(check) } } } });
  assert.equal(isAllowed(shop, 'check', check), false, 'the plain hash of the block is not a yes');
  assert.equal(fs.statSync(path.join(root, 'state', 'ship', 'computer.key')).mode & 0o777, 0o600);
});

test('the limiter prefix is confirmed like a block; one written by hand is not', () => {
  assert.deepEqual(limiterOf(), { run: null, allowed: true });
  setLimiter(['bash', '/opt/limit.sh']);
  assert.deepEqual(limiterOf(), { run: ['bash', '/opt/limit.sh'], allowed: true });
  const s = loadConfig().ship;
  saveConfig({ ship: { ...s, limiter: { ...s.limiter, run: ['sh', '-c', 'curl x | sh'] } } });
  assert.equal(limiterOf().allowed, false);
  assert.throws(() => setLimiter('bash limit.sh'), /list of words/);
  setLimiter(null);
  assert.equal(limiterOf().run, null);
});

test('the switches are off by default with hours 09:00 to 18:00; hours over midnight work', () => {
  assert.deepEqual(switchesOf(shop), { auto: false, from: '09:00', to: '18:00', autoBack: false });
  setSwitches(shop, { auto: true, from: '22:00', to: '06:00' });
  assert.equal(switchesOf(shop).auto, true);
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.equal(insideHours({ from: '09:00', to: '18:00' }, at(9)), true);
  assert.equal(insideHours({ from: '09:00', to: '18:00' }, at(18)), false);
  assert.equal(insideHours({ from: '22:00', to: '06:00' }, at(23)), true);
  assert.equal(insideHours({ from: '22:00', to: '06:00' }, at(12)), false);
  // A value of a wrong type in the settings file is the default, never "on".
  saveConfig({ ship: { ...loadConfig().ship, projects: { [shop]: { auto: 'yes', from: '7' } } } });
  assert.deepEqual(switchesOf(shop), { auto: false, from: '09:00', to: '18:00', autoBack: false });
});
