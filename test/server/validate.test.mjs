import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import * as v from '../../src/server/validate.mjs';
import { cleanFileName, uploadsDirName } from '../../src/server/uploads.mjs';
import { TmuxBackend } from '../../src/server/backends/tmux.mjs';

const box = sandbox();
test.after(() => box.cleanup());

test('session names', () => {
  for (const ok of ['a', 'my-proj_2', 'x.y', 'A'.repeat(40)]) assert.equal(v.sessionName(ok), ok);
  for (const bad of ['', 'a b', 'a;b', '$(x)', '-t', '.x', 'A'.repeat(41), 'é', null, 5, 'a:b', '=a']) {
    assert.equal(v.sessionName(bad), null, String(bad));
  }
  const b = new TmuxBackend();
  assert.equal(b.validName('a.b'), false, 'tmux would rewrite "."');
  assert.equal(b.validName('ok_name-1'), true);
  assert.equal(b.validName('-t'), false);
});

test('session ids, pids, messages, paths', () => {
  assert.equal(v.sessionId('0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b'), '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b');
  assert.equal(v.sessionId('../../etc/passwd'), null);
  assert.equal(v.pid(1), null);
  assert.equal(v.pid(0), null);
  assert.equal(v.pid(-1), null);
  assert.equal(v.pid('12'), null);
  assert.equal(v.pid(1234), 1234);
  assert.equal(v.message(''), null);
  assert.equal(v.message('a\0b'), null);
  assert.equal(v.message('x'.repeat(v.MESSAGE_MAX + 1)), null);
  assert.equal(v.message('hello\nworld'), 'hello\nworld');
  assert.equal(v.absPath('relative/x'), null);
  assert.equal(v.absPath('/a/\0b'), null);
  assert.equal(v.absPath('/tmp'), '/tmp');
});

test('profiles must exist', () => {
  const list = [{ name: 'work', label: 'W', kind: 'login', env: { SECRET: 'x' } }];
  assert.equal(v.profile('work', list).name, 'work');
  assert.equal(v.profile('nope', list), null);
  assert.equal(v.profile({ name: 'work' }, list), null);
});

test('generated session names', () => {
  assert.equal(v.safeSessionName('my project.v2'), 'my-project-v2');
  assert.equal(v.safeSessionName('...'), 'session');
  assert.equal(v.safeSessionName('a:b;c$(d)'), 'a-b-c-d');
  assert.equal(v.uniqueName('a', ['a', 'a-2']), 'a-3');
  assert.equal(v.uniqueName('b', ['a']), 'b');
});

test('upload names and folder', () => {
  assert.equal(cleanFileName('Screenshot 2026-11-14 at 10.00.png'), 'Screenshot_2026-11-14_at_10.00.png');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('..\\..\\x.exe'), 'x.exe');
  assert.equal(cleanFileName('.bashrc'), 'bashrc');
  assert.equal(cleanFileName(''), 'upload');
  assert.equal(cleanFileName('😀😀.jpg'), 'upload.jpg');
  assert.ok(cleanFileName('a'.repeat(300) + '.png').length <= 80);
  assert.equal(uploadsDirName(undefined), '.uploads');
  assert.equal(uploadsDirName('inbox'), 'inbox');
  assert.equal(uploadsDirName('a/b'), path.join('a', 'b'));
  assert.equal(uploadsDirName('/etc'), null);
  assert.equal(uploadsDirName('../out'), null);
  assert.equal(uploadsDirName('a/../../b'), null);
});
