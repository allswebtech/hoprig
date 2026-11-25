// The page's Get, once the project is here (web/getneeds.js): the offer is the route's dry run, shown in the
// terminal's own lines with its question; "Get them too" sends exactly the `seen` of that offer and follows the job;
// "Not now" sends nothing and says the commands for later; a project that names no need shows nothing; an offer that
// a need brought in its turn is drawn as its own offer. The Get page hands the project's name to it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byClass, texts } from '../chat/fakedom.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const offer = {
  project: 'shop', needs: ['kits/parts'], missing: [{ name: 'kits/parts' }, { name: 'tools', of: 'kits/parts' }], allow: [],
  lines: ['shop also needs, to read: kits/parts; and kits/parts needs tools. They are not on this computer.'], ask: true,
  question: 'Get them too, and let the sessions read them?', later: 'hoprig get kits/parts tools  and  hoprig workspace needs allow shop kits/parts', seen: 'a'.repeat(64),
};
const posts = [];
let looks = 0;
let answer = offer;
let jobData = { project: 'shop', allowed: 'shop reads kits/parts', got: [{ name: 'kits/parts', ok: true, result: 'cloned' }, { name: 'tools', ok: true, result: 'cloned' }], more: [] };
globalThis.fetch = async (u, o = {}) => {
  const p = String(u);
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
  if (p === '/api/pcsetup/project/needs') {
    const b = JSON.parse(o.body);
    posts.push(b);
    if (b.dryRun) return (looks++, reply(200, answer));
    return reply(200, { started: true });
  }
  if (p.startsWith('/api/pcsetup/job')) return reply(200, { kind: 'get-needs', running: false, lines: ['✓ allowed on this computer: shop reads kits/parts'], next: 1, result: { ok: true, data: jobData } });
  return reply(404, { error: 'no such route' });
};
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => realTimeout(fn, Math.min(ms, 5));
const settle = () => new Promise((r) => realTimeout(r, 40));
const { needsAfterGet } = await import('../../web/getneeds.js');
const buttons = (n) => byClass(n, 'btn');
const label = (b) => texts(b).join('');

test('after Get: the terminal\'s lines and question; "Get them too" sends the seen of that offer', async () => {
  const box = needsAfterGet('shop');
  await settle();
  assert.deepEqual(posts.at(-1), { name: 'shop', dryRun: true });
  const words = texts(box).join(' | ');
  assert.match(words, /What shop needs/);
  assert.match(words, /shop also needs, to read: kits\/parts; and kits\/parts needs tools\. They are not on this computer\./);
  assert.match(words, /Get them too, and let the sessions read them\?/);
  const [no, yes] = buttons(box);
  assert.equal(label(no), 'Not now');
  assert.equal(label(yes), 'Get them too');
  await yes.listeners.click({ currentTarget: yes });
  await settle();
  assert.deepEqual(posts.at(-1), { name: 'shop', seen: offer.seen }, 'exactly what he saw, nothing more');
  assert.match(texts(box).join(' '), /Got kits\/parts, tools\. Its sessions read them\./);
});

test('"Not now" sends nothing and says the commands for later', async () => {
  const before = posts.length;
  const box = needsAfterGet('shop');
  await settle();
  const no = buttons(box)[0];
  await no.listeners.click({ currentTarget: no });
  await settle();
  assert.equal(posts.length, before + 1, 'only the look');
  assert.match(texts(box).join(' '), /Nothing more was got\. Later: {2}hoprig get kits\/parts tools/);
});

test('a need that a need names: drawn as its own offer, with its own press', async () => {
  jobData = { ...jobData, more: [{ project: 'tools', missing: [{ name: 'blog' }], allow: [], lines: ['tools also needs, to read: blog. It is not on this computer.'], ask: true, question: 'Get it too, and let the sessions read it?', later: 'hoprig get blog', seen: 'b'.repeat(64) }] };
  const box = needsAfterGet('shop');
  await settle();
  const yes = buttons(box)[1];
  await yes.listeners.click({ currentTarget: yes });
  await settle();
  assert.match(texts(box).join(' '), /What tools needs/);
  const second = buttons(box).filter((b) => label(b) === 'Get it too').at(-1);
  assert.ok(second, 'one need missing: the press says "Get it too", as its question does');
  await second.listeners.click({ currentTarget: second });
  await settle();
  assert.deepEqual(posts.at(-1), { name: 'tools', seen: 'b'.repeat(64) });
});

test('needs that are all here, only not allowed: the press is "Allow" and says what it allowed', async () => {
  const was = answer;
  answer = { ...offer, missing: [], allow: [{ name: 'kits/parts' }], lines: ['shop names, to read: kits/parts: not opened to its sessions until you allow it on this computer (a project.json can come from anyone).'], question: 'Let the sessions read it on this computer?', later: 'hoprig workspace needs allow shop kits/parts' };
  const dataWas = jobData;
  jobData = { project: 'shop', allowed: 'shop reads kits/parts', got: [], more: [] };
  try {
    const box = needsAfterGet('shop');
    await settle();
    const yes = buttons(box)[1];
    assert.equal(label(yes), 'Allow', 'nothing is got, so the press does not say Get');
    await yes.listeners.click({ currentTarget: yes });
    await settle();
    assert.match(texts(box).join(' '), /Allowed on this computer: shop reads kits\/parts\./);
  } finally {
    answer = was;
    jobData = dataWas;
  }
});

test('a project that names no need shows nothing; an older computer without the route neither', async () => {
  answer = { needs: [], missing: [], allow: [], lines: [], ask: false };
  const box = needsAfterGet('blog');
  await settle();
  assert.equal(box.children.length, 0);
  const n = looks;
  answer = offer;
  assert.ok(n > 0);
});

test('the Get page hands the project it got (with its place) to the offer', () => {
  const src = fs.readFileSync(path.join(WEB, 'projects.js'), 'utf8');
  assert.match(src, /import \{ needsAfterGet \} from '\.\/getneeds\.js';/);
  assert.match(src, /extra: \(r\) => \(r\.data && r\.data\.name \? needsAfterGet\(r\.data\.place \? `\$\{r\.data\.place\}\/\$\{r\.data\.name\}` : r\.data\.name/);
  assert.match(src, /extra \? extra\(r\) : null,/);
});
