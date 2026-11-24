// A sentence that names another place of the dashboard has a link that opens it (the switch itself through ?show=
// where it names one): Workspace, Computers, Settings → Workspace / Appearance / New-session defaults, Skills →
// Learned, Providers. Each sentence is looked up in its file and must have its link right beside it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
// [file, the words of the sentence as the source has them, the link's target beside them]
const PLACES = [
  ['web/workspace.js', '. Get one on ', "link('#/workspace')"],
  ['web/workspace.js', 'I can reach it by SSH', "link('#/computers/add')"],
  ['web/workspace.js', 'does that when you ask', "link('#/workspace')"],
  ['web/gateways.js', 'Link it again on the Computers page', "link('#/computers')"],
  ['web/editor/index.js', ': the code button (</>) on its row', "link('#/workspace')"],
  ['web/editor/index.js', 'The colours follow the page', "link('#/settings/appearance?show=page-theme')"],
  ['web/desktop/index.js', 'the home folder unless changed in', "link('#/settings/new-sessions?show=folders')"],
  ['web/field.js', 'A draft waits in Skills → Learned', "link('#/skills/learned')"],
  ['web/wscomputer.js', 'has the others', "link('#/settings/workspace')"],
  ['web/skilllearned.js', 'until you press Install or Discard', "link('#/skills/learned')"],
  ['web/gatewaydefine.js', 'make it a provider here', "link('#/providers')"],
];

test('each sentence that names a place has the link that opens it beside it', () => {
  for (const [file, words, target] of PLACES) {
    const src = read(file);
    const at = src.indexOf(words);
    assert.ok(at >= 0, `${file}: "${words}" is there`);
    const line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
    assert.ok(line.includes(target), `${file}: "${words}" has ${target} on its line`);
  }
});

test('Lead model\'s line opens the bypass switch itself where it says "allow it in Settings"', async () => {
  class N {}
  class E extends N {
    constructor(tag) {
      super();
      Object.assign(this, { tag, attrs: {}, children: [], dataset: {}, style: {}, className: '' });
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    addEventListener() {}
    append(...n) {
      this.children.push(...n);
    }
  }
  globalThis.Node ??= N;
  globalThis.document ??= { createElement: (t) => new E(t), createTextNode: (t) => t, getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
  const { partModeHint, partModeLine } = await import('../../web/leadswitch.js');
  const parts = partModeHint(null);
  assert.ok(Array.isArray(parts), 'nodes, not a plain sentence');
  const a = parts.find((p) => p && p.tag === 'a');
  assert.equal(a.attrs.href, '#/settings/new-sessions?show=bypass');
  const words = parts.map((p) => (typeof p === 'string' ? p : p.children.join(''))).join('');
  assert.equal(words, partModeLine(null), 'the same words as before');
  assert.equal(typeof partModeHint('acceptEdits'), 'string', 'a line that names no place stays a sentence');
});
