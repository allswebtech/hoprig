// Get an existing project (web/projects.js): a repository picked from the signed-in list goes to "Get it" in one
// press (no Next); a typed name still asks Next first, because its check must run. Count of presses, stand-in DOM.
import assert from 'node:assert/strict';
import test from 'node:test';
import { texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
globalThis.window.dispatchEvent ||= () => true;
globalThis.fetch = async (u) => {
  const data = String(u).includes('/api/pcsetup/github') ? { signedIn: true, account: 'me', repos: [{ name: 'me/shop', private: true }] } : { projectsDir: '/p', home: '/h' };
  return { status: 200, ok: true, json: async () => data };
};
await import('../../web/projects.js');
const { pageById } = await import('../../web/registry.js');
const all = (n, ok) => (n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};
const open = async () => {
  let body = null;
  pageById('get-project').render({ frame: (o) => (body = o.body[0]), sub: '' });
  await settle();
  return body;
};
const buttons = (n) => all(n, (x) => x.tag === 'button' || (x.tag === 'a' && /btn/.test(x.className)));
const named = (n, re) => buttons(n).filter((b) => re.test(texts(b).join('')));

test('a repository picked from the signed-in list shows Get it at once, without Next', async () => {
  const box = await open();
  assert.equal(named(box, /^Next$/).length, 1, 'the typed way keeps its Next');
  const pick = named(box, /me\/shop/);
  assert.equal(pick.length, 1);
  pick[0].listeners.click({});
  await settle();
  assert.equal(named(box, /^Get it$/).length, 1, 'one press on the repository, and Get it is there');
  assert.equal(named(box, /^Next$/).length, 0);
  assert.match(texts(box).join(' '), /me\/shop/);
});

test('a typed name still goes through Next to its check', async () => {
  const box = await open();
  const input = all(box, (x) => x.tag === 'input' && x.attrs.placeholder === 'owner/project')[0];
  input.value = 'me/shop';
  const form = all(box, (x) => x.tag === 'form')[0];
  form.listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(named(box, /^Get it$/).length, 1);
});

test('each row on Computers is one link to that computer, with no second button beside it', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/computers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /#\/computer\/health/);
  assert.match(src, /h\('a\.cp-rowlink', \{ href: link\('#\/computer', s\.machine\) \}/);
  assert.ok(!/h\(`a\.row\.cp-row/.test(src), 'no link nested in a link');
});
