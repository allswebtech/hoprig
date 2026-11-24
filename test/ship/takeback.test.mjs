// Taking back (src/ship/live.mjs takeBack): the kept files are compared with the picture from before the go-live, also
// when the step had ended as live; the picture goes once it is taken back or at the next go-live.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempShip, write } from './helpers.mjs';

const t = tempShip('ship-takeback');
test.after(() => t.cleanup());
const { putTogether } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { goLive, takeBack } = await import('../../src/ship/live.mjs');

const cafe = path.join(t.projects, 'cafe');
const ok = ['node', '-e', '0'];
t.repo(cafe, { 'project.json': JSON.stringify({ check: [ok], live: { update: [ok], verify: [ok], back: [ok], keep: ['data'] } }), '.gitignore': 'data/\n' });
write(cafe, { 'data/db.json': '{"orders":3}\n' });
const idle = () => ({ over: false, why: null });
const pictures = () => fs.readdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'pictures'));

async function live(name) {
  t.branch(cafe, `work/${name}`, { [`${name}.txt`]: `${name}\n` }, name);
  const r = await putTogether(cafe, { name, branches: [`work/${name}`] });
  allow(cafe, 'check', readCheck(r.dir).check);
  await runCheck(cafe, r.dir, { busy: idle });
  allow(cafe, 'live', readLive(r.dir).live);
  return (await goLive(cafe, r)).done;
}

test('after "live", a take-back compares the kept files with the picture from before', async () => {
  const j = await live('one');
  assert.equal(j.outcome, 'live', j.why);
  assert.equal(fs.statSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'pictures', `${j.id}-1.json`)).mode & 0o777, 0o600, 'kept, for the owner only');
  write(cafe, { 'data/db.json': '{"orders":0}\n' });
  const b = await takeBack(cafe);
  assert.equal(b.outcome, 'taken-back', b.why);
  assert.equal(b.keptSame, false);
  assert.deepEqual(b.changed, [{ path: 'data/db.json', what: 'changed' }]);
  assert.deepEqual(pictures(), [], 'taken back: the picture goes');
});

test('the next go-live drops the picture of the one before', async () => {
  const a = await live('two');
  assert.equal(a.outcome, 'live', a.why);
  const b = await live('three');
  assert.equal(b.outcome, 'live', b.why);
  assert.deepEqual(pictures(), [`${b.id}-1.json`]);
  assert.deepEqual(t.trapped(), []);
});
