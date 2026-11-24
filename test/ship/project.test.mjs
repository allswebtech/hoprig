// A project's "check" and "live" blocks (src/ship/project.mjs): a command is a list of words (a string is refused),
// each with a time limit; a verify entry may be an address; keep paths stay inside the project or the home folder;
// the canonical form does not depend on how the keys were written; a placeholder without a value is refused; a live
// block that pushes or publishes is known, also behind `sh -c`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { blocksDir, canonical, cleanCheck, cleanKeep, cleanLive, publishes, readCheck, readLive, resolveWords } from '../../src/ship/project.mjs';

const LIVE = {
  update: [['git', '-C', 'code/shop', 'checkout', '--detach', '{commit}'], ['./restart.sh']],
  verify: [{ url: 'http://127.0.0.1:8080/', status: 200, seconds: 10 }],
  back: [['git', '-C', 'code/shop', 'checkout', '--detach', '{before}'], ['./restart.sh']],
  keep: ['data', '~/.config/shop'],
};

test('a check command is a list of words with a time limit; a string is refused', () => {
  assert.deepEqual(cleanCheck([{ run: ['npm', 'test'], minutes: 3 }, ['node', 'x.mjs']]).check, [
    { run: ['npm', 'test'], minutes: 3 },
    { run: ['node', 'x.mjs'], minutes: 10 },
  ]);
  const s = cleanCheck(['npm test']);
  assert.equal(s.check, null);
  assert.match(s.errors[0], /one string/);
  assert.equal(cleanCheck([{ run: 'npm test' }]).check, null);
  assert.equal(cleanCheck([{ run: ['npm'], minutes: 0 }]).check, null);
  assert.equal(cleanCheck([{ run: ['npm'], minutes: 241 }]).check, null);
  assert.equal(cleanCheck([{ run: ['npm'], shell: true }]).check, null);
  assert.equal(cleanCheck([['a\nb']]).check, null);
  assert.equal(cleanCheck([]).check, null);
});

test('a live block needs update, verify and back; keep paths stay inside the project or the home folder', () => {
  const { live, errors } = cleanLive(LIVE);
  assert.deepEqual(errors, []);
  assert.equal(live.update.length, 2);
  assert.deepEqual(live.verify[0], { url: 'http://127.0.0.1:8080/', status: 200, seconds: 10 });
  assert.deepEqual(live.keep, ['data', '~/.config/shop']);
  assert.equal(live.restarts, false);
  for (const k of ['update', 'verify', 'back']) {
    const v = { ...LIVE };
    delete v[k];
    assert.equal(cleanLive(v).live, null, `without ${k}`);
  }
  assert.equal(cleanLive({ ...LIVE, verify: [{ url: 'file:///etc/passwd' }] }).live, null);
  assert.equal(cleanLive({ ...LIVE, verify: [{ url: 'http://a:b@127.0.0.1/' }] }).live, null);
  assert.equal(cleanLive({ ...LIVE, restarts: 'other' }).live, null);
  assert.equal(cleanLive({ ...LIVE, restarts: 'hoprig' }).live.restarts, true);
  assert.equal(cleanLive({ ...LIVE, extra: 1 }).live, null);
  for (const bad of ['.', '~/', '..', '../x', 'a/../b', '/etc', 'C:/x', 'a\\b', 'a//b', './a', '']) assert.equal(cleanKeep(bad), null, bad);
  for (const ok of ['data', 'data/db.json', '~/.config/shop']) assert.equal(cleanKeep(ok), ok);
});

test('the canonical form is the same for the same commands written in another key order', () => {
  const a = cleanLive(LIVE).live;
  const b = cleanLive({ keep: LIVE.keep, back: LIVE.back, verify: [{ seconds: 10, status: 200, url: 'http://127.0.0.1:8080/' }], update: LIVE.update }).live;
  assert.equal(canonical(a), canonical(b));
  const c = cleanLive({ ...LIVE, update: [['./restart.sh', '--fast']] }).live;
  assert.notEqual(canonical(a), canonical(c));
});

test('a placeholder is replaced, and one without a value is refused', () => {
  assert.deepEqual(resolveWords(['git', 'checkout', '{commit}', 'x{tree}y'], { commit: 'abc', tree: 't1' }), ['git', 'checkout', 'abc', 'xt1y']);
  assert.throws(() => resolveWords(['git', 'checkout', '{before}'], { commit: 'abc' }), /\{before\}/);
});

test('a live block that pushes or publishes is known, also inside a shell line', () => {
  const live = (update) => cleanLive({ ...LIVE, update }).live;
  assert.equal(publishes(cleanLive(LIVE).live), false);
  assert.equal(publishes(live([['git', 'push']])), true);
  assert.equal(publishes(live([['/usr/bin/git', '-C', 'x', 'push', 'origin']])), true);
  assert.equal(publishes(live([['gh', 'release', 'create']])), true);
  assert.equal(publishes(live([['npm', 'publish']])), true);
  assert.equal(publishes(live([['pnpm', '--filter', 'x', 'publish']])), true);
  assert.equal(publishes(live([['sh', '-c', 'make && git push']])), true);
  assert.equal(publishes(live([['npm', 'test']])), false);
  assert.equal(publishes(live([['git', 'status']])), false);
});

test('project.json is read as a regular file only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-ship-project-'));
  try {
    assert.deepEqual(readCheck(dir), { check: null, errors: [] });
    fs.writeFileSync(path.join(dir, 'real.json'), JSON.stringify({ check: [['npm', 'test']] }));
    fs.symlinkSync('real.json', path.join(dir, 'project.json'));
    assert.equal(readCheck(dir).check, null);
    assert.match(readCheck(dir).errors[0], /link/);
    fs.rmSync(path.join(dir, 'project.json'));
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ check: [['npm', 'test']], live: LIVE }));
    assert.deepEqual(readCheck(dir).check, [{ run: ['npm', 'test'], minutes: 10 }]);
    assert.equal(readLive(dir).live.back.length, 2);
    fs.writeFileSync(path.join(dir, 'project.json'), '{ not json');
    assert.match(readLive(dir).errors[0], /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the blocks are read from the merged tree when it has a project.json, else from the project folder', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-ship-blocks-'));
  const tree = path.join(real, 'tree');
  try {
    fs.mkdirSync(tree);
    assert.equal(blocksDir(real, tree), real);
    fs.writeFileSync(path.join(tree, 'project.json'), '{}');
    assert.equal(blocksDir(real, tree), tree);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});
