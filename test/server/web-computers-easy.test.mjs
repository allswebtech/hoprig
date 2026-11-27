// The Computers pages made easy: the list is rows and one Add door, a computer has three parts (Overview, Setup,
// Advanced), the old Health address lands on Setup, red checks come first, and what is rare sits behind a press.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, children: [] });
  }
  setAttribute() {}
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => t,
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const pc = await import('../../web/pc.js');

test('a computer has three parts: Overview, Setup, Advanced', () => {
  assert.deepEqual(pc.PARTS.map((p) => [p.id, p.title]), [['', 'Overview'], ['setup', 'Setup'], ['advanced', 'Advanced']]);
});

test('the old Health address lands on Setup, every other part stays', () => {
  assert.equal(pc.partFor('health').id, 'setup');
  assert.equal(pc.partFor('setup').id, 'setup');
  assert.equal(pc.partFor('advanced').id, 'advanced');
  assert.equal(pc.partFor('').id, '');
  assert.equal(pc.partFor('nothing'), null);
  assert.match(src('pc.js'), /location\.replace\(link\('#\/computer\/setup'\)\)/, 'the redirect is made on the page');
});

test('Overview: one status line says ready, or how many things to fix', () => {
  assert.equal(pc.readyWords(0), 'Ready for coding');
  assert.equal(pc.readyWords(1), '1 thing to fix');
  assert.equal(pc.readyWords(4), '4 things to fix');
  assert.equal(pc.readyWords(null), '');
});

test('Overview: the main disk is a card, the others and the boot disks go in a fold', () => {
  const d = (mount) => ({ mount, size: 10, used: 1, avail: 9 });
  const r = pc.splitDisks([d('/boot'), d('/'), d('/mnt/data'), d('/boot/efi')]);
  assert.equal(r.main.mount, '/');
  assert.deepEqual(r.others.map((x) => x.mount), ['/boot', '/mnt/data', '/boot/efi']);
  assert.equal(pc.splitDisks([]).main, null);
});

test('Overview: the swap card shows only when swap is in use, and sessions are rows not a card', () => {
  const s = src('pc.js');
  assert.match(s, /swapUsed > 0 \? tile\('Swap'/);
  assert.doesNotMatch(s, /tile\('Sessions'/);
});

test('a computer page: no intro line, no Open desktop in the head; Open desktop and Before you format are in Advanced', () => {
  const s = src('pc.js');
  assert.doesNotMatch(s, /intro: 'One computer/);
  assert.doesNotMatch(s, /actions: notAllowed\(entry\(\)\) \? \[\] : \[desktop\]/);
  const adv = s.slice(s.indexOf('function advanced(ctx)'), s.indexOf('export function advancedActs'));
  assert.match(adv, /Open desktop/);
  assert.match(adv, /#\/leave/);
  assert.match(adv, /Before you format this computer/);
});

test('Advanced: programs, ports, service, name and power are folds closed at first, Stop is inside Programs', () => {
  const s = src('pc.js');
  const adv = s.slice(s.indexOf('function advanced(ctx)'), s.indexOf('export function advancedActs'));
  for (const w of ['Programs', 'Listening ports', 'Service', 'Name and power']) assert.ok(adv.includes(`'${w}'`) || adv.includes(`\`${w}`), w);
  assert.match(adv, /fold\('computer-programs'/);
  assert.match(adv, /fold\('computer-ports'/);
});

test('Setup: the red ones first and nothing else open; Git and GitHub is one row, the rest is folded', () => {
  const s = src('pcsetup.js');
  assert.match(s, /fold\('computer-git', 'Git and GitHub'/);
  // the folder link and the recipe are inside Advanced, not on the first screen
  const root = s.slice(s.indexOf("fill(root,"));
  assert.ok(root.indexOf("fold('computer-recipe'") < root.indexOf('Workspace folders and the map'), 'the folder link is inside the closed recipe fold');
});

test('Setup also shows the checks the doctor found that Setup does not list, with their Fix', () => {
  const h = src('health.js');
  assert.match(h, /export function healthFixes\(/);
  assert.match(h, /export function healthAdvanced\(/);
  assert.match(src('pcsetup.js'), /healthFixes\(/);
});

test('the list: rows and one Add door; no Health button, no intro, no format row; Link to main is in the Add page', () => {
  const s = src('computers.js');
  const list = s.slice(s.indexOf('function computerRow'), s.indexOf('// ======================= Add a computer'));
  assert.doesNotMatch(list, /cp-health/);
  assert.doesNotMatch(list, /'#\/leave'|\/leave'/);
  assert.doesNotMatch(list, /intro:/);
  assert.doesNotMatch(list, /mainLinkCard/);
  const add = s.slice(s.indexOf('function viewAdd'), s.indexOf('/** The result of an add'));
  assert.match(add, /mainLinkCard/);
  assert.match(add, /fold\('computers-add', 'Advanced'/);
});

test('the Computers page keeps its address and the old per-computer Health address is not a menu entry', () => {
  assert.match(src('computers.js'), /id: 'computers'/);
  assert.doesNotMatch(src('pc.js'), /id: 'health'/);
});

test('a gateway error that used to name Health leads to Advanced, Service, and that part is on the page', () => {
  assert.match(src('errorways.js'), /'gateway-service': \{ label: 'Service', button: 'Open its service', href: '#\/computer\/advanced\?show=service' \}/);
  assert.match(src('health.js'), /id: 'service'/);
});
