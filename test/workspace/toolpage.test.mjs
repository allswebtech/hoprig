// The Workspace page's part for a group's own command (web/workspacetool.js): it asks first (the dry run), its yes
// sends back exactly what the sheet showed (`seen`), its two buttons are "Allow on this computer" and "Not now", the
// undo is "Remove the command from this computer", and every state of toolsState is said in plain words. Nothing on
// the page starts the command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Just enough of a browser for the page's modules to load (nothing is drawn here).
globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const W = await import('../../web/workspacetool.js');
const src = fs.readFileSync(new URL('../../web/workspacetool.js', import.meta.url), 'utf8');

test('the sheet asks first and the yes is for what it showed; the buttons say what they do', () => {
  assert.match(src, /api\('\/api\/workspace\/tools\/allow', \{ group, dryRun: true \}\)/, 'what the yes makes is asked first');
  assert.match(src, /onclick: async \(\) => \{\n\s+yes\.disabled = true;\n\s+try \{\n\s+await api\('\/api\/workspace\/tools\/allow', \{ group, seen: plan\.seen \}\)/, 'made only on his press, for what the sheet showed');
  assert.match(src, /label: 'Allow on this computer'/);
  assert.match(src, /autofocus: true, onclick: \(\) => close\(false\) \}, 'Not now'\)/, '"Not now" has the focus');
  assert.match(src, /label: 'Remove the command from this computer'/);
  assert.match(src, /api\('\/api\/workspace\/tools\/remove', \{ group, dryRun: true \}\)/, 'what the undo removes is asked first');
  assert.doesNotMatch(src, /tool run|\/run'/, 'nothing on the page starts the command');
  const projects = fs.readFileSync(new URL('../../web/projects.js', import.meta.url), 'utf8');
  assert.match(projects, /\n {4}groups\.length \? groupTools\(\) : null,\n/, 'shown under the groups of the Workspace page');
});

test('what the command is, what this computer lacks, and every state in plain words', () => {
  const t = { group: 'kits', name: 'kit', run: 'kit.sh', state: 'waits', missing: [{ program: 'jq', kit: 'extras' }, { program: 'no-such' }] };
  assert.deepEqual(W.toolLines(t), [
    'Starts kit.sh in the group\'s folder, with every argument passed on unchanged. Hoprig never runs it by itself.',
    'Needs jq, which this computer does not have: Terminal extras in Set up this computer installs it.',
    'Needs no-such, which this computer does not have.',
    'It is made on this computer only after your yes.',
  ]);
  assert.deepEqual(W.stateWords({ state: 'waits', changed: true, why: 'the map changed it, it was kit → kit.sh' }), ['Asks again', 'The map changed it since your yes (it was kit → kit.sh): it is made again only after a new yes.']);
  assert.deepEqual(W.stateWords({ state: 'made' }), ['Allowed here', null]);
  assert.equal(W.stateWords({ state: 'blocked', why: 'kit.sh is a link: a tool is started only from a real file inside the group' })[1], 'It would not start now: kit.sh is a link: a tool is started only from a real file inside the group.');
  for (const s of ['waits', 'made', 'blocked', 'stale', 'gone', 'absent']) assert.notEqual(W.stateWords({ state: s, why: 'x' })[0], s, `${s} has words`);
});

test('the docs and the changelog name the page\'s own buttons and its refusal, as the page and the route say them', async () => {
  const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\n\s*/g, ' ');
  const { CHANGED } = await import('../../src/workspace/toolweb.mjs');
  const docs = read('docs/WORKSPACE.md');
  const log = read('site/content/changelog.md');
  for (const words of ['Commands of your groups', 'Allow on this computer', 'Remove the command from this computer']) {
    assert.ok(src.includes(`'${words}'`), `the page says ${words}`);
    assert.ok(docs.includes(`**${words}**`), `the docs name ${words}`);
    assert.ok(log.includes(`"${words}"`), `the changelog names ${words}`);
  }
  assert.ok(src.includes("'Not now'") && docs.includes('**Not now** makes nothing'));
  assert.ok(docs.includes(`"${CHANGED}"`) && log.includes(`"${CHANGED}"`), 'the refusal in the route\'s own words');
  assert.match(docs, /The page calls the same functions as `hoprig workspace tool allow` and `remove`\./);
});

test('the sheet names the group, its address, the file, the launcher and that it never runs by itself', () => {
  const lines = W.allowWords({ group: 'kits', name: 'kit', url: 'https://git.example.com/team/kits.git', file: '~/Workspace/kits/kit.sh', launcher: '~/.local/bin/kit', onPath: false });
  assert.equal(lines[0], 'The group kits (https://git.example.com/team/kits.git) names its own command kit. It starts ~/Workspace/kits/kit.sh.');
  assert.match(lines[1], /^Hoprig writes a small command kit at ~\/\.local\/bin\/kit\. At every start Hoprig checks again/);
  assert.equal(lines[2], 'Hoprig never runs it by itself. You can remove it from this computer here at any time.');
  assert.match(lines[3], /^~\/\.local\/bin is not on your PATH: to run kit by its name, add that folder to your shell's start file \(Hoprig does not edit it\)\.$/); // seal: the page's sentence that names PATH is read; no PATH is written
  assert.equal(W.allowWords({ group: 'kits', name: 'kit', url: 'u', file: 'f', launcher: '~/.local/bin/kit', onPath: true }).length, 3);
});
