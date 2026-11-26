// Windows: the logged-in browsers' file (state/web-sessions.json) is replaced while a second dashboard reads it. A rename
// over a file another process reads answers EPERM there (measured on a Windows runner), and two dashboards on one
// computer once answered a request with a 500 for it. The store's write now tries again for up to a second there
// (src/replacefile.mjs); elsewhere it runs once, as before. Windows' answers are given here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { SessionStore } from '../../src/server/auth.mjs';

const box = sandbox();
test.after(() => box.cleanup());

// A rename that a reader refuses `n` times, then lets through.
const refused = (n) => {
  const calls = { n: 0 };
  const rename = (a, b) => {
    if (calls.n++ < n) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${a}' -> '${b}'`), { code: 'EPERM' });
    fs.renameSync(a, b);
  };
  return Object.assign(rename, { calls });
};

test('Windows: a new login is written although a second dashboard holds the file for two tries', () => {
  const file = path.join(box.root, 'win', 'web-sessions.json');
  const rename = refused(2);
  const s = new SessionStore(file, { platform: 'win32', rename });
  const token = s.create('tag');
  assert.equal(rename.calls.n, 3);
  assert.equal(new SessionStore(file).valid(token, 'tag'), true, 'the login is on disk');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file is left');
});

test('elsewhere the write runs once, as before: a refused rename is the error', () => {
  const file = path.join(box.root, 'linux', 'web-sessions.json');
  const rename = refused(2);
  const s = new SessionStore(file, { platform: 'linux', rename });
  assert.throws(() => s.create('tag'), { code: 'EPERM' });
  assert.equal(rename.calls.n, 1);
});
