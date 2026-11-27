// The seams of the in-step block and of the credentials move into the pages: reachable, and nothing shown when all is well.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, appendChild() {} }), createTextNode: (t) => t, getElementById: () => null, addEventListener() {}, visibilityState: 'visible' };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const projects = read('projects.js');
const { gitWords, projectWords } = await import('../../web/projects.js');
const { instepBlock } = await import('../../web/instep.js');

test('the Projects page asks for the in-step list and draws the block on top, only when it is not null', () => {
  assert.match(projects, /import \{ instepBlock, instepList \} from '\.\/instep\.js'/);
  assert.match(projects, /data\.instep = await instepList\(\)/);
  assert.match(projects, /const off = instepBlock\(data\.instep, \{ reload: load \}\);\s*\n\s*if \(off\) body\.prepend\(off\);/);
  assert.equal(instepBlock({ at: 1, items: [] }), null, 'all in step: nothing drawn');
});

test('a repository that is in step says no counts of changes to upload or download', () => {
  const s = { ok: true, branch: 'main', changes: 0, ahead: 0, behind: 0, upstream: true };
  assert.equal(gitWords(s), 'branch main · up to date');
  assert.doesNotMatch(projectWords({ repos: [s, { ...s }] }), /to upload|to download/);
});

test('Settings, Workspace, By itself, More: one switch per place for moving projects that are only behind, on for Projects', () => {
  const ws = read('workspace.js');
  assert.match(ws, /ffToggles\(w, save\)/);
  assert.match(ws, /ffProjects: \{ projects: true \}/);
  assert.match(ws, /Move projects that are only behind in/);
  const more = ws.slice(ws.indexOf("fold('workspace-auto-more'"));
  assert.ok(more.indexOf('ffToggles') > 0 && more.indexOf('ffToggles') < more.indexOf('Every how many hours'), 'under More, not on the first screen');
});

test('the block has styles, and the move button is on the credentials row and hidden unless another computer exists', () => {
  const css = read('page-projects.css');
  for (const c of ['.instep ', '.instep-head', '.instep-list', '.instep-row', '.instep-text']) assert.ok(css.includes(c), c);
  assert.match(read('workspacecreds.js'), /credMoveButton\(\)/);
  assert.match(read('credmove.js'), /h\('div\.savebar\.start\.hidden'\)/);
  assert.match(read('credmove.js'), /if \(!\(d\.machines \|\| \[\]\)\.length && !machine\.current\) return;/);
});
