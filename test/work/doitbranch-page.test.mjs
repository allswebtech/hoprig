// The Do it sheet's words for a branch of its own (web/workdo.js placeLine, acceptWords), with a small stand-in for the
// browser DOM: the sheet says where a run works in one plain line, offers "In the project's folder itself" only when a
// branch could be made, and Accept says that the branch stays for Go live.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  querySelector() {
    return null;
  }
  remove() {}
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x)));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const { acceptWords, placeLine, runCard } = await import('../../web/workdo.js');
const src = fs.readFileSync(new URL('../../web/workdo.js', import.meta.url), 'utf8');
const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));

test('the sheet\'s line: a branch of its own by default, the folder itself when chosen or when no branch can be made', () => {
  const p = { branch: { name: 'work/fix-cart', again: false }, branchWhy: null };
  // The choice above it names the branch, and the info line below says nothing is merged: said once each.
  assert.equal(placeLine(p), 'Your folder is not changed. Accept leaves the branch for Go live.');
  assert.equal(placeLine({ ...p, branch: { name: 'work/fix-cart', again: true } }), 'Again where the last run left its branch. Your folder is not changed.');
  assert.equal(placeLine(p, true), 'In the project\'s folder itself, on the branch it stands on now.');
  assert.match(placeLine({ branch: null, branchWhy: 'not-git' }), /not a git repository, so there is no branch of its own/);
  // Settings' own name for the folders, and the way there.
  assert.match(placeLine({ branch: null, branchWhy: 'outside' }), /not among the folders where sessions can start \(Settings → New-session defaults → Advanced → Folders\)\.$/);
  assert.match(fs.readFileSync(new URL('../../web/sessiondefaults.js', import.meta.url), 'utf8'), /title: 'Folders', desc: 'Where new sessions can start\./);
  assert.match(fs.readFileSync(new URL('../../web/sessiondefaults.js', import.meta.url), 'utf8'), /fold\('settings-new-sessions', 'Advanced', foldersPanel/);
  // The choice is offered only with a branch to choose (the sheet sends inFolder only then).
  assert.match(src, /p\.branch \? select\('Where it works'/);
  assert.match(src, /\['folder', 'In the project\\'s folder itself'\]/);
  assert.match(src, /\.\.\.\(p\.branch && v\.inFolder \? \{ inFolder: true \} : \{\}\)/);
});

test('Accept says the branch stays for Go live, and what happened to its copy of the project', () => {
  assert.equal(acceptWords({ item: 'x' }), 'Accepted: the task is done');
  assert.match(acceptWords({ item: 'x', worktree: { removed: true } }), /Its branch stays for Go live; its copy of the project is removed/);
  assert.match(acceptWords({ item: 'x', worktree: { removed: false, why: 'files' } }), /its copy of the project stays too/);
});

test('a run card on a branch of its own: the tag, and Remove the branch only where the sheet offers it', () => {
  const r = { id: 'r1', item: 'fix-cart', title: 'Fix the cart', state: 'done', startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:05:00.000Z', project: 'shop', folder: '.', provider: 'sub', providerLabel: 'Main', model: null, session: 'c0ffee00-1111-4222-8333-444455556666', here: true, branch: 'work/fix-cart', schedule: null, reason: null, statusError: null, answer: 'Done.', commits: [], changed: [], more: 0 };
  const plain = texts(runCard(r)).join(' ');
  assert.match(plain, /on the branch work\/fix-cart/);
  assert.doesNotMatch(plain, /Remove the branch/);
  assert.match(texts(runCard(r, { onRemoveBranch: () => {} })).join(' '), /Remove the branch/);
});
