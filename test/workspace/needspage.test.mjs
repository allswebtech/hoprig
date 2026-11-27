// The project page's "Needs" block (web/projectneeds.js): a row per need its project.json names, with the owner's yes
// on this computer. A need accepted and here is read by its sessions (Take back); one here and not accepted is not
// opened (Allow); one only in the map names its get (Allow, "allowed once it is here" after the yes). Allow and Take
// back call POST /api/folders/extras/accept and the row changes. Nothing is shown for a project without needs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byClass, texts } from '../chat/fakedom.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// The server, as the route answers: the needs of shop, and the owner's yes kept here.
const accepted = new Set(['kits/parts']);
const posts = [];
let needsOfShop = ['kits/parts', 'kits/tools', 'docs'];
globalThis.fetch = async (u, o = {}) => {
  const p = String(u);
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
  if (p.startsWith('/api/folders/extras?')) {
    const here = { 'kits/parts': true, 'kits/tools': true, docs: false };
    return reply(200, { project: 'shop', choices: [], needs: needsOfShop.map((name) => ({ name, here: here[name], accepted: accepted.has(name), ...(here[name] ? {} : { fix: `hoprig get ${name}` }) })) });
  }
  if (p === '/api/folders/extras/accept' && o.method === 'POST') {
    const b = JSON.parse(o.body);
    posts.push(b);
    if (b.allow) accepted.add(b.need);
    else accepted.delete(b.need);
    return reply(200, { project: 'shop', need: b.need, accepted: b.allow });
  }
  return reply(404, { error: 'no such route' });
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const { needsBlock } = await import('../../web/projectneeds.js');
const { h } = await import('../../web/lib.js');
const rows = (box) => byClass(box, 'ns-also-list')[0].children.map((li) => ({ text: texts(li).join(''), button: byClass(li, 'ns-also-allow')[0] || null }));

test('the Needs block: a row per need, Allow and Take back call the route and the row changes', async () => {
  const box = h('div');
  await needsBlock(box, '/w/projects/shop');
  const words = texts(box).join(' | ');
  assert.match(words, /Needs/);
  assert.match(words, /Its sessions get one only after you allow it on this computer/);
  let r = rows(box);
  assert.equal(r.length, 3);
  assert.equal(r[0].text, 'kits/parts: its sessions read itTake back');
  assert.equal(r[1].text, 'kits/tools: not allowed on this computer yet, so it is not openedAllow');
  assert.equal(r[2].text, 'docs: not on this computer (hoprig get docs)Allow');
  assert.equal(r[1].button.attrs['aria-label'], 'Allow: shop reads kits/tools');

  // Allow the one that is here: the route is called, and the row now reads it.
  await r[1].button.listeners.click({ currentTarget: r[1].button });
  await settle();
  assert.deepEqual(posts.at(-1), { path: '/w/projects/shop', need: 'kits/tools', allow: true });
  r = rows(box);
  assert.equal(r[1].text, 'kits/tools: its sessions read itTake back');

  // Allow the one only in the map: allowed once it is here.
  await r[2].button.listeners.click({ currentTarget: r[2].button });
  await settle();
  assert.equal(rows(box)[2].text, 'docs: not on this computer (hoprig get docs); allowed once it is hereTake back');

  // Take back: closed again.
  r = rows(box);
  await r[0].button.listeners.click({ currentTarget: r[0].button });
  await settle();
  assert.deepEqual(posts.at(-1), { path: '/w/projects/shop', need: 'kits/parts', allow: false });
  assert.equal(rows(box)[0].text, 'kits/parts: not allowed on this computer yet, so it is not openedAllow');

  // A project without needs: the block shows nothing.
  needsOfShop = [];
  await needsBlock(box, '/w/projects/shop');
  assert.equal(box.children.length, 0);
});

test('the project page puts the Needs block between its repositories and its skills', () => {
  const src = fs.readFileSync(path.join(WEB, 'projects.js'), 'utf8');
  assert.match(src, /import \{ needsBlock \} from '\.\/projectneeds\.js';/);
  assert.match(src, /reposFold, needsBox, skillsBox/);
  assert.match(src, /needsBlock\(needsBox, p\.dir\);/);
});
