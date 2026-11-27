// The folder picker shows nothing inside the credentials folder (or any other secret place): its subfolder names are
// the names of the owner's projects' keys, and Tia's list of projects reads them through this picker. The folder
// itself may still be named in its parent's list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('folders-secret');
test.after(() => box.cleanup());

const top = fs.realpathSync(box.root);
const creds = path.join(fs.realpathSync(box.workspace), 'credentials');
fs.mkdirSync(path.join(creds, 'shop-keys'), { recursive: true });
fs.mkdirSync(path.join(creds, 'deploy'), { recursive: true });
fs.mkdirSync(path.join(box.workspace, 'projects', 'shop'), { recursive: true });
fs.mkdirSync(path.join(box.profiles, 'folder-inside'), { recursive: true });
const { browse, recentFolders, resolveRoots } = await import('../../src/server/folders.mjs');
const roots = resolveRoots([top]);

test('browsing the credentials folder, or a folder inside it, lists nothing', () => {
  const b = browse(creds, roots);
  assert.ok(b, 'the folder itself can still be reached');
  assert.deepEqual(b.dirs, [], 'no subfolder names of it');
  const inner = browse(path.join(creds, 'shop-keys'), roots);
  assert.deepEqual(inner && inner.dirs, [], 'nor one level down');
  assert.deepEqual(browse(box.profiles, roots).dirs, [], 'the providers folder is a secret place too');
});

test('the folder above still lists the credentials folder by its name, and its other folders', () => {
  const names = browse(box.workspace, roots).dirs.map((d) => d.name);
  assert.ok(names.includes('credentials') && names.includes('projects'), names.join(','));
});

test('recent folders never offer a folder inside the credentials folder', () => {
  const rec = recentFolders([path.join(creds, 'deploy'), creds, path.join(box.workspace, 'projects', 'shop')], roots);
  assert.deepEqual(rec.map((f) => path.basename(f.path)), ['shop']);
});
