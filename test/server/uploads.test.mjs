import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { saveUpload } from '../../src/server/uploads.mjs';

const box = sandbox();
test.after(() => box.cleanup());

const req = (buf, headers = {}) => Object.assign(Readable.from([buf]), { headers });

test('a file lands in <cwd>/<uploads dir> under a clean, unique name', async () => {
  const cwd = path.join(box.root, 'proj');
  fs.mkdirSync(cwd);
  const r = await saveUpload(req(Buffer.from('PNGDATA')), { cwd, dirName: '.uploads', fileName: '../../My Shot.png', maxBytes: 100 });
  assert.equal(path.dirname(r.path), path.join(fs.realpathSync(cwd), '.uploads'));
  assert.match(r.name, /^\d{8}-\d{6}-[0-9a-f]{4}-My_Shot\.png$/);
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'PNGDATA');
  assert.equal((fs.statSync(r.path).mode & 0o777).toString(8), '600');
});

test('too large is refused and nothing is left behind', async () => {
  const cwd = path.join(box.root, 'proj2');
  fs.mkdirSync(cwd);
  await assert.rejects(saveUpload(req(Buffer.alloc(200)), { cwd, dirName: 'up', fileName: 'a.bin', maxBytes: 100 }), (e) => e.status === 413);
  await assert.rejects(
    saveUpload(req(Buffer.alloc(10), { 'content-length': '500' }), { cwd, dirName: 'up', fileName: 'a.bin', maxBytes: 100 }),
    (e) => e.status === 413,
  );
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'up')), ['.gitignore'], 'only the ignore file that keeps uploads out of git');
  assert.equal(fs.readFileSync(path.join(cwd, 'up', '.gitignore'), 'utf8'), '*\n');
  await assert.rejects(saveUpload(req(Buffer.alloc(0)), { cwd, dirName: 'up', fileName: 'a', maxBytes: 100 }), (e) => e.status === 400);
});

test('an uploads folder that is a symlink out of the session folder is refused', async () => {
  const cwd = path.join(box.root, 'proj3');
  const elsewhere = path.join(box.root, 'elsewhere');
  fs.mkdirSync(cwd);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(cwd, '.uploads'));
  await assert.rejects(saveUpload(req(Buffer.from('x')), { cwd, dirName: '.uploads', fileName: 'a', maxBytes: 100 }), (e) => e.status === 400);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
