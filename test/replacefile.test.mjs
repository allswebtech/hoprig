// A file replaced the safe way (src/replacefile.mjs): written beside its name, then renamed over it. On Windows a rename
// over a file another process is reading at that moment answers EPERM (measured on a Windows runner: every time), so
// there it is tried again for up to a second; elsewhere it runs once, as before. Windows' answers are given here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { replaceFile } from '../src/replacefile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-replacefile-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A rename that answers `code` for its first `n` calls (a reader holds the name), then renames.
const refused = (n, code = 'EPERM') => {
  const calls = { n: 0 };
  const rename = (a, b) => {
    if (calls.n++ < n) throw Object.assign(new Error(`${code}: operation not permitted, rename '${a}' -> '${b}'`), { code });
    fs.renameSync(a, b);
  };
  return Object.assign(rename, { calls });
};
// The name with its old text, and its new text written beside it.
function written(name) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, 'old\n');
  const t = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(t, 'new\n');
  return [t, file];
}
const left = (name) => fs.readdirSync(tmp).filter((f) => f.startsWith(`${name}.`));

test('Windows: a rename refused while a reader holds the name is tried again, and the file is replaced', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const [t, file] = written(`held-${code}.json`);
    const rename = refused(3, code);
    replaceFile(t, file, { platform: 'win32', rename });
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n', code);
    assert.equal(rename.calls.n, 4, code);
    assert.deepEqual(left(`held-${code}.json`), [], `${code}: no temporary file is left`);
  }
});

test('Windows: a name held for longer than a second gives the error, and no temporary file is left', () => {
  const [t, file] = written('held-long.json');
  const at = Date.now();
  assert.throws(() => replaceFile(t, file, { platform: 'win32', rename: refused(Infinity) }), { code: 'EPERM' });
  const took = Date.now() - at;
  assert.ok(took >= 900 && took < 3000, `tried for about a second (${took} ms)`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', 'the old file stands');
  assert.deepEqual(left('held-long.json'), []);
});

test('Windows: an error that is no busy moment is not tried again', () => {
  const [t, file] = written('gone.json');
  const rename = refused(Infinity, 'ENOENT');
  assert.throws(() => replaceFile(t, file, { platform: 'win32', rename }), { code: 'ENOENT' });
  assert.equal(rename.calls.n, 1);
  assert.deepEqual(left('gone.json'), []);
});

test('elsewhere the rename runs once, as before: an EPERM is thrown at once', () => {
  for (const platform of ['linux', 'darwin']) {
    const [t, file] = written(`once-${platform}.json`);
    const rename = refused(1);
    const at = Date.now();
    assert.throws(() => replaceFile(t, file, { platform, rename }), { code: 'EPERM' }, platform);
    assert.equal(rename.calls.n, 1, platform);
    assert.ok(Date.now() - at < 500, platform);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', platform);
  }
  const [t, file] = written('plain.json');
  replaceFile(t, file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n', 'the real rename, on this system');
  assert.deepEqual(left('plain.json'), []);
});
