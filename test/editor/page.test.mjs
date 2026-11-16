// The editor page's own logic, without a browser: its addresses, the leave guard's reading of an address, quick open's
// matching, the search highlight, the worker per language, git's letters, and what it registers (the page, Settings →
// Editor, a session's "Open code"). The page itself is proven in a real browser on an isolated dashboard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// Just enough of a DOM for the modules to load.
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

const { codeHash } = await import('../../web/editor/workbench.js');
const { folderName } = await import('../../web/editor/places.js');
const { _codeTarget, editorButton } = await import('../../web/editor/index.js');
const { fuzzy, matchSpan } = await import('../../web/editor/search.js');
const { workerFor } = await import('../../web/editor/monaco.js');
const { inside, markClass, marksOf } = await import('../../web/editor/scm.js');
const { pageById, registeredSessionActions, registeredSettingsPages } = await import('../../web/registry.js');

test('addresses: #/code?dir=…&file=…&line=…&view=…, for this computer or another', () => {
  assert.equal(codeHash('/home/a/shop', {}, null), '#/code?dir=%2Fhome%2Fa%2Fshop');
  assert.equal(codeHash('/p', { file: 'src/a b.ts', line: 3, view: 'changes' }, null), '#/code?dir=%2Fp&file=src%2Fa+b.ts&line=3&view=changes');
  assert.equal(codeHash('/p', {}, 'laptop'), '#/m/laptop/code?dir=%2Fp');
  // The guard reads them back: which computer, which folder.
  const t = _codeTarget(codeHash('/p', { file: 'x.md' }, 'laptop'));
  assert.deepEqual([t.machine, t.query.get('dir'), t.query.get('file')], ['laptop', '/p', 'x.md']);
  assert.equal(_codeTarget('#/code').machine, null);
  for (const other of ['#/workspace', '#/codex?dir=%2Fp', '#/m/laptop/workspace', '#/s/code']) assert.equal(_codeTarget(other), null, other);
});

test('quick open: the name before the folders, every letter in order, nothing that does not fit', () => {
  const files = ['src/lib/cart.ts', 'src/cart/index.ts', 'docs/carton.md', 'README.md'];
  const best = (q) => files.map((p) => [fuzzy(q, p), p]).filter((x) => x[0] >= 0).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  assert.equal(best('cart.ts')[0], 'src/lib/cart.ts');
  assert.equal(best('cart')[0], 'src/lib/cart.ts', 'a name that starts with it first');
  assert.ok(best('cart').includes('src/cart/index.ts'), 'a folder that holds it still fits');
  assert.deepEqual(best('rdme'), ['README.md'], 'letters in order');
  assert.deepEqual(best('zzz'), []);
  assert.equal(fuzzy('', 'a'), 0);
});

test('search: the match is found again in the line for its highlight, with the same switches as the search', () => {
  assert.deepEqual(matchSpan('const Needle = 1;', 7, { q: 'needle' }), [6, 12]);
  assert.equal(matchSpan('const Needle = 1;', 7, { q: 'needle', caseSensitive: true }), null);
  assert.deepEqual(matchSpan('needles and needle', 1, { q: 'needle', word: true }), [12, 18], 'a whole word');
  assert.deepEqual(matchSpan('return total(prices);', 8, { q: 'tot[a-z]l\\(', regex: true }), [7, 13]);
  assert.deepEqual(matchSpan('a.b axb', 1, { q: 'a.b' }), [0, 3], 'a plain search takes the dot literally');
  assert.equal(matchSpan('x', 1, { q: '(', regex: true }), null, 'a bad expression marks nothing');
});

test('workers: each language gets the worker file Monaco ships for it', () => {
  assert.deepEqual(['typescript', 'javascript', 'json', 'css', 'scss', 'less', 'html', 'handlebars', 'razor', 'markdown', 'python'].map(workerFor),
    ['ts', 'ts', 'json', 'css', 'css', 'css', 'html', 'html', 'html', 'editor', 'editor']);
});

test('git\'s letters for the Explorer and the lists: conflicts first, then not staged, then staged; new files are U', () => {
  const m = marksOf({ repo: true, staged: [{ path: 'a', x: 'A' }, { path: 'b', x: 'M' }], changes: [{ path: 'b', y: 'D' }], untracked: [{ path: 'c' }], conflicts: [{ path: 'd' }] });
  assert.deepEqual([...m], [['a', 'A'], ['b', 'D'], ['c', 'U'], ['d', '!']]);
  assert.deepEqual(['M', 'A', 'U', 'D', '!', 'R'].map(markClass), ['mod', 'new', 'new', 'del', 'conflict', 'mod']);
  assert.equal(marksOf({ repo: false }).size, 0);
  assert.equal(marksOf(null).size, 0);
});

test('what it registers: the page (not in the navigation), Settings → Editor in VS Code\'s old place, "Open code" for a session', async () => {
  const p = pageById('code');
  assert.ok(p && p.group === null && p.navAs === 'workspace' && p.perComputer);
  const ids = registeredSettingsPages().map((x) => x.id);
  assert.ok(ids.includes('editor'));
  const s = registeredSettingsPages().find((x) => x.id === 'editor');
  assert.match(String(s.summary()), /^\d+ px · tab \d/);
  const a = registeredSessionActions().find((x) => x.id === 'editor');
  assert.ok(a && a.label === 'Open code');
  assert.equal(await a.describe({ name: 'nope', machine: null }), null, 'a session whose folder is not known: no row');
  assert.equal(editorButton(''), null);
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  assert.match(app, /'\/settings\/vscode': '\/settings\/editor'/, 'the old Settings → VS Code address lands on Settings → Editor');
  assert.match(app, /page\.render\(\{ frame, connectionBanner, sub: p\[2\] \|\| '', query \}\)/, 'the router hands the page its query');
  assert.match(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), /href="editor\/editor\.css"/);
});

test('the page loads Monaco only from this dashboard, and sets its workers after editor.main (which sets blob: ones)', () => {
  const src = fs.readFileSync(path.join(WEB, 'editor', 'monaco.js'), 'utf8');
  assert.match(src, /api\('~\/vendor\/monaco\.json'\)/, 'never through another computer');
  const load = src.indexOf("window.require(['vs/editor/editor.main']");
  const env = src.indexOf('self.MonacoEnvironment =');
  assert.ok(load > 0 && env > load, 'the environment is set after editor.main loaded');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /blob:|eval\(/, 'no blob: worker and no eval in the code');
});

test('folder names and folders inside one, on POSIX and Windows alike', () => {
  assert.equal(folderName('/home/a/shop/'), 'shop');
  assert.equal(folderName('C:\\work\\shop'), 'shop');
  assert.equal(folderName('/'), '/');
  assert.equal(inside('/home/a/shop', 'code/web'), '/home/a/shop/code/web');
  assert.equal(inside('C:\\work\\shop\\', 'code/web'), 'C:\\work\\shop\\code\\web');
});
