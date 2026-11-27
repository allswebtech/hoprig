// Files copy and move of a LINK that points into the credentials folder (the link a project's credential links make:
// <project>/.env.local -> credentials/shop/shop.env.local): refused, in both. A copy of it lands as a link that leads
// nowhere (a relative link) in a folder where git does not ignore it, and a copy is a second way to lay a credentials
// file where the project's files are. An ordinary link, and an ordinary file, copy and move as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('copy-secret-link');
test.after(() => box.cleanup());

const top = fs.realpathSync(box.root);
const roots = [top];
const creds = path.join(fs.realpathSync(box.workspace), 'credentials');
fs.mkdirSync(path.join(creds, 'shop'), { recursive: true });
fs.writeFileSync(path.join(creds, 'shop', 'shop.env.local'), 'SHOP_KEY=made-up-marker-value-0001\n', { mode: 0o600 });
const proj = path.join(top, 'projects', 'shop');
fs.mkdirSync(path.join(proj, 'code'), { recursive: true });
for (const d of ['other-copy', 'other-move', 'other']) fs.mkdirSync(path.join(top, d), { recursive: true });
fs.writeFileSync(path.join(proj, 'plain.txt'), 'plain\n');
fs.symlinkSync(path.relative(path.join(proj, 'code'), path.join(creds, 'shop', 'shop.env.local')), path.join(proj, 'code', '.env.local')); // relative, as the product makes it
fs.symlinkSync(path.join(creds, 'shop', 'shop.env.local'), path.join(proj, 'code', 'abs.env')); // absolute
fs.symlinkSync(path.join(proj, 'plain.txt'), path.join(proj, 'code', 'ordinary-link'));

const { transfer } = await import('../../src/editor/manage.mjs');

for (const copy of [true, false]) {
  const how = copy ? 'copy' : 'move';
  test(`${how} of a link into the credentials folder is refused, relative or absolute`, async () => {
    for (const name of ['.env.local', 'abs.env']) {
      const into = path.join(top, `other-${how}`);
      const r = await transfer([path.join(proj, 'code', name)], into, roots, { copy });
      assert.deepEqual(r.done, [], `${name}: nothing was ${how}d`);
      assert.equal(r.failed.length, 1, name);
      assert.match(r.failed[0].error, /credential|sign-in/i, `${name}: ${r.failed[0].error}`);
      assert.equal(fs.lstatSync(path.join(into, name), { throwIfNoEntry: false }), undefined, `${name}: nothing laid there`);
      assert.ok(fs.lstatSync(path.join(proj, 'code', name)).isSymbolicLink(), `${name}: the link stays where it was`);
    }
  });
}

test('a link that points at an ordinary file still copies as a link', async () => {
  const r = await transfer([path.join(proj, 'code', 'ordinary-link')], path.join(top, 'other'), roots, { copy: true });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.ok(fs.lstatSync(path.join(top, 'other', 'ordinary-link')).isSymbolicLink());
});
