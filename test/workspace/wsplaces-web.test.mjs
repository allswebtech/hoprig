// The Workspace page's sheets and panels (web/wsplaces.js), drawn with just enough of a browser: what the owner reads
// must say what the terminal says (the files of the work question) and what is so (which computer has what).
import assert from 'node:assert/strict';
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], classList: { add() {}, remove() {}, toggle() {} } });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  querySelector() {
    return null;
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
const texts = (n) => (n == null ? [] : n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const text = (n) => texts(n).join('');

const W = await import('../../web/wsplaces.js');

test('the work question names every file that goes to the wip/ branch, the first 20 and then how many more', () => {
  const q = { ask: 'work', words: 'Commit this work…', repos: [{ repo: 'projects/shop/code/shop-api', files: ['README.md', 'notes-only-here.txt'] }, { repo: 'projects/shop', files: Array.from({ length: 23 }, (_, i) => `f${i}.txt`) }] };
  const t = text(W.workQuestion(q, () => {}));
  assert.match(t, /README\.md/);
  assert.match(t, /notes-only-here\.txt/);
  assert.match(t, /f19\.txt/);
  assert.doesNotMatch(t, /f20\.txt/);
  assert.match(t, /… and 3 more/);
});

test('a drop card for another computer names that computer, never "this computer"', async () => {
  const { activityWords } = await import('../../web/tiaactivity.js');
  const p = { computer: (n) => (n === 'box2' ? 'Build box' : n), provider: (n) => n, chat: (n) => n, tools: 1 };
  for (const action of ['drop', 'drop_check']) {
    const there = activityWords({ tool: 'manage_project', input: { action, project: 'blog', computer: 'box2' } }, p).what;
    assert.match(there, /Build box/, there);
    assert.doesNotMatch(there, /this computer/, there);
    const here = activityWords({ tool: 'manage_project', input: { action, project: 'blog' } }, p).what;
    assert.match(here, /this computer/, here);
  }
});

test('a stopped drop is said without the terminal\'s mark', () => {
  assert.equal(W.stoppedWords({ lines: ['shop', '✗ stopped at the question about the work: the project stays here'] }), 'stopped at the question about the work: the project stays here');
});

test('this computer\'s row says "now" only when it is what its disk has', () => {
  assert.match(W.asOfWords({ mine: true, fromDisk: true, written: 0 }), /now/);
  const file = W.asOfWords({ mine: true, fromDisk: false, written: Date.parse('2026-11-02T08:00:00Z') });
  assert.doesNotMatch(file, /now/);
  assert.match(file, /as of/);
});

test('Your computers: a refused file and a label conflict are shown; a group\'s member stays, a group is named as one', () => {
  const who = {
    label: 'desk',
    computers: [{ label: 'desk', mine: true, fromDisk: true, here: ['blog', 'kits', 'kits/packs/tool', 'kits/packs/tool/code/tool-core', 'shop', 'shop/code/shop-api'], written: 0, old: false }],
    unknown: [],
    refused: [{ name: 'box4.json', why: 'it is not valid JSON' }],
    conflicts: [{ label: 'box3', why: 'ai_brain/computers/box3.json holds another computer\'s id' }],
    entries: [{ kind: 'project', name: 'blog' }, { kind: 'group', name: 'kits' }, { kind: 'project', name: 'kits/packs/tool' }, { kind: 'project', name: 'shop' }],
  };
  const t = text(W.computersPanel(who));
  assert.match(t, /box4/);
  assert.match(t, /refused \(it is not valid JSON\)/);
  assert.match(t, /box3/);
  assert.match(t, /kits\/packs\/tool/);
  assert.match(t, /kits \(group\)/);
  assert.doesNotMatch(t, /shop-api|tool-core/);
});

test('the drop sheet opened for another computer names it in its title', () => {
  assert.equal(W.dropTitle('blog', 'Build box'), 'Drop blog from Build box');
  assert.equal(W.dropTitle('shop'), 'Drop shop from this computer');
});

test('a sheet opened from the address clears its query when it closes and gives focus to the heading', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/projects.js', import.meta.url), 'utf8');
  assert.match(src, /dropSheet\(query\.get\('drop'\)[^\n]*\.then\(closed\)/);
  assert.match(src, /groupSheet\(\{ group: query\.get\('group'\)[^\n]*\.then\(closed\)/);
  assert.match(src, /history\.replaceState\(null, '', path\)/);
});

test('plain words on the sheets: no "it asks:" twice, no "(above)" with nothing above, a group in sentences', () => {
  const c = { lines: ['shop  ~/Workspace/projects/shop', '! it asks: commit the work not committed in projects/shop (1 file)', '✗ something of it exists only here (above)'], questions: [{ ask: 'work' }] };
  const t = text(W.checkView(c));
  assert.doesNotMatch(t, /it asks:/);
  assert.doesNotMatch(t, /\(above\)/);
  const g = W.groupWords({ dir: 'kits', url: 'https://example.com/kits.git', holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds' }] }).join(' ');
  assert.match(g, /The group kits/);
  assert.match(g, /packs, whose projects come with the group's repository/);
  assert.doesNotMatch(g, /[{}"]/);
});

test('a project on no computer that wrote its file: an unknown one may have it', async () => {
  const { missingCard } = await import('../../web/workspace.js');
  const t = text(missingCard({ label: 'notes', url: 'https://example.com/notes.git' }, [], { unknown: ['lab'] }));
  assert.match(t, /lab has written no file, so it may have it/);
});

test('the group sheet names what the scan adds in the group\'s folder and elsewhere, never the second as the folder\'s', () => {
  const t = W.mapAddedParts({ added: true, mapAdded: ['labs2/tool2', 'notes-app'], mapAddedHere: ['labs2/tool2'], mapAddedElsewhere: ['notes-app'] }).map(text);
  assert.match(t[0], /in its folder now/);
  assert.match(t[0], /labs2\/tool2/);
  assert.doesNotMatch(t[0], /notes-app/);
  assert.match(t[1], /elsewhere in your workspace/);
  assert.match(t[1], /notes-app/);
  // An older computer's answer, the whole list only: named as the scan's, not as the folder's.
  const old = W.mapAddedParts({ added: true, mapAdded: ['notes-app'] }).map(text).join(' ');
  assert.doesNotMatch(old, /in its folder/);
  assert.match(old, /scan of your workspace/);
});
