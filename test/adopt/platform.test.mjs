// The path rules of a computer that already has projects, decided in the platform layer and tested with made-up
// paths of each system (no real Windows or Mac disk is needed for these; what only one can show is in WORKSPACE.md).
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathRules } from '../../src/server/platform/common.mjs';
import { projectSlug } from '../../src/sessions.mjs';

test('Windows: a drive letter and either slash name one folder, and a case-blind disk folds case', () => {
  const w = pathRules('win32');
  assert.ok(w.same('D:\\work\\shop', 'd:/Work/Shop/'));
  assert.ok(w.within('D:\\work\\shop\\code\\a', 'd:\\WORK'));
  assert.ok(!w.within('D:\\workshop', 'D:\\work'), 'a longer name is not inside');
  const f = w.forms('D:\\work\\shop');
  for (const s of ['D:\\work\\shop', 'D:/work/shop', 'd:/work/shop', 'D:\\\\work\\\\shop']) assert.ok(f.includes(s), s);
});

test('macOS folds case, Linux does not', () => {
  assert.ok(pathRules('darwin').same('/Users/alex/Code/Shop', '/users/alex/code/shop'));
  assert.ok(!pathRules('linux').same('/home/alex/Code', '/home/alex/code'));
  assert.deepEqual(pathRules('linux').forms('/home/alex/code/shop'), ['/home/alex/code/shop']);
});

test('the coding tool\'s session key of a Windows path and of a long path', () => {
  assert.equal(projectSlug('D:\\work\\shop'), 'D--work-shop');
  assert.equal(projectSlug('/home/alex/code/shop.v2'), '-home-alex-code-shop-v2');
  assert.equal(projectSlug('C:\\Users\\alex\\Workspace\\projects\\shop'), 'C--Users-alex-Workspace-projects-shop');
});
