// A project's "Fits its technology" on the Skills page (web/skillhub.js fitPart), without a browser
// (test/chat/fakedom.mjs): the switch with its words, the three lists, Undo on a skill added by itself, Review on one
// that waits, and the switch's press reaching its route.
import assert from 'node:assert/strict';
import test from 'node:test';
import { texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
globalThis.history ||= { replaceState() {} };
globalThis.window ||= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
const { fitPart } = await import('../../web/skillhub.js');
const all = (n, ok) => (n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);
const tick = () => new Promise((r) => setTimeout(r, 0));

const LISTS = {
  project: '/p/shop', fit: true, firstCode: true, at: '2026-11-24T00:00:00.000Z', code: true,
  mine: [{ name: 'next-patterns', why: ['package.json has next 16.0.1'] }],
  added: [{ id: 'next-tips', name: 'next-tips', for: 'Tips for Next.js.', why: ['package.json has next 16.0.1'], here: true }],
  waiting: [{ id: 'next-script', name: 'next-script', for: 'A skill with a script.', why: ['package.json has next 16.0.1'], reasons: ['run.sh is not a text file (.md or .txt)'], here: false }],
};

test('the switch, the three lists, Undo on what went in by itself, Review on what waits', async () => {
  const asked = [];
  const reviewed = [];
  let reloaded = 0;
  const call = async (p, body) => {
    asked.push([p, body]);
    if (p.startsWith('/api/skillhub/fit?')) return LISTS;
    if (p === '/api/skillhub/fit/choice') return { ...LISTS, fit: body.fit };
    return { ok: true };
  };
  const el = fitPart('/p/shop', { review: (b) => reviewed.push(b), reload: async () => reloaded++, call });
  await tick();
  const said = texts(el).join(' ');
  assert.deepEqual(asked[0], ['/api/skillhub/fit?project=%2Fp%2Fshop', undefined]);
  for (const w of ['Fits its technology', 'Add skills that fit this project\'s technology', 'Already yours (1)', 'Added by itself (1)', 'Waiting for you (1)', 'nothing was copied', 'Not added by itself: run.sh is not a text file']) assert.ok(said.includes(w), w);
  const buttons = all(el, (n) => n.tag === 'button');
  const undo = buttons.find((b) => texts(b).join('').includes('Undo'));
  const review = buttons.find((b) => texts(b).join('').includes('Review'));
  assert.ok(undo && review, 'Undo and Review');
  await undo.listeners.click({ currentTarget: undo });
  assert.deepEqual(asked.at(-1), ['/api/skillhub/remove', { name: 'next-tips', project: '/p/shop' }], 'Undo takes it out (kept for undo)');
  assert.equal(reloaded, 1);
  review.listeners.click({ currentTarget: review });
  assert.deepEqual(reviewed, [{ spec: 'next-script', project: '/p/shop', scope: 'project' }], 'Review opens the review sheet: every file before Install');
  const sw = all(el, (n) => n.tag === 'input' && n.attrs.role === 'switch')[0];
  await sw.listeners.change({ target: { checked: false } });
  assert.deepEqual(asked.at(-1), ['/api/skillhub/fit/choice', { project: '/p/shop', fit: false }], 'the switch reaches its route');
});

test('a skill added by itself and taken out offers Put back; nothing looked for yet says why', async () => {
  const out = { ...LISTS, added: [{ ...LISTS.added[0], here: false }] };
  const el = fitPart('/p/shop', { review: () => {}, reload: async () => {}, call: async () => out });
  await tick();
  assert.match(texts(el).join(' '), /Put back/);
  const empty = fitPart('/p/new', { review: () => {}, reload: async () => {}, call: async () => ({ project: '/p/new', fit: true, at: null, mine: [], added: [], waiting: [] }) });
  await tick();
  assert.match(texts(empty).join(' '), /Nothing looked for yet: Hoprig looks once the project has code\./);
  const off = fitPart('/p/new', { review: () => {}, reload: async () => {}, call: async () => ({ project: '/p/new', fit: false, at: null, mine: [], added: [], waiting: [] }) });
  await tick();
  assert.match(texts(off).join(' '), /the switch is off/);
});
