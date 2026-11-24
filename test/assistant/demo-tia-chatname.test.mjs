// The demo's stand-in for Tia names a session the way the owner sees it: an untitled chat by its folder, never by
// the inner id (chat:<id>) that only the tools use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'demo', 'tia.mjs'), 'utf8');

function nameOf() {
  const m = /^const nameOf = (.+);$/m.exec(SRC);
  assert.ok(m, 'the demo has one function that names a session');
  return new Function(`return (${m[1]});`)();
}

test('demo Tia: an untitled chat is "a chat in <folder>", never chat:<id>', () => {
  const name = nameOf();
  assert.equal(name({ session: 'chat:0f3c9a2e-1111-4222-8333-944445555666', chat: true, folder: '/home/alex/Workspace/shop', title: '' }), 'a chat in shop');
  assert.equal(name({ session: 'chat:0f3c9a2e-1111-4222-8333-944445555666', folder: 'C:\\Users\\alex\\alpha\\', title: '' }), 'a chat in alpha');
  assert.doesNotMatch(name({ session: 'chat:abc', chat: true, folder: '', title: '' }), /chat:/);
  assert.equal(name({ session: 'chat:abc', chat: true, folder: '/x/shop', title: 'Fix the cart' }), 'Fix the cart');
  assert.equal(name({ session: 'shop-2', folder: '/x/shop', title: '' }), 'shop-2', 'a terminal session keeps its name');
});

test('demo Tia: the "what needs me" reply names sessions through that function', () => {
  assert.doesNotMatch(SRC, /x\.title \|\| x\.session/);
  assert.match(SRC, /\.map\(\(x\) => `\*\*\$\{nameOf\(x\)\}\*\*`\)/);
});
