// One computer's page: a broken public link leads to its switch, an offline computer says "It does not answer."
// with the raw error under a closed Details, and #/computer/setup?show=git lands on the Git and GitHub panel.
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
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
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const src = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const { reachOf, rawError } = await import('../../web/pc.js');

test('a public link that is on but broken: no "Settings → Public link" in words, the row opens the switch', () => {
  const s = { network: { host: '127.0.0.1', port: 7433 }, server: {} };
  for (const state of ['blocked', 'error', 'retrying']) {
    const r = reachOf(s, { on: true, kind: 'temporary', state, url: null });
    assert.doesNotMatch(r.text, /Settings →/, state);
    assert.equal(r.href, '#/settings/public-link?show=public-link-switch', state);
  }
  // A link that works, or none: the row keeps the page's top.
  assert.equal(reachOf(s).href, undefined);
  assert.match(src('pc.js'), /href: link\(reach\.href \|\| '#\/settings\/public-link'\)/);
});

test('offline: "It does not answer." and the raw error only under a closed Details', () => {
  assert.match(src('pc.js'), /h\('p\.panel-desc', 'It does not answer\.'\)/);
  const d = rawError('connect ECONNREFUSED 127.0.0.1:43171');
  assert.equal(d.tag, 'details');
  assert.ok(!('open' in d.attrs) && !d.open, 'closed');
  assert.equal(texts(d.children[0]).join(''), 'Details');
  assert.match(texts(d).join(''), /ECONNREFUSED/);
  assert.equal(rawError(''), null);
});

test('#/computer/setup?show=git: the page reads show, Setup gives the Git panel its id, the sign-in link lands there', () => {
  assert.match(src('pc.js'), /function viewPc\(\{ frame, connectionBanner, sub, query \}\)/);
  assert.match(src('pc.js'), /const shown = partOf\(query\);/);
  assert.match(src('pc.js'), /if \(shown\) showPart\(shown, \{ alive: \(\) => alive \}\);/);
  assert.match(src('pcsetup.js'), /git\.id = 'git';/);
  assert.match(src('projects.js'), /h\('a', \{ href: link\('#\/computer\/setup\?show=git'\)/);
});

test('Claude Code not installed: on this computer the row has the one press Get started has; on another, Setup', () => {
  // This computer: the install runs in the page (getstarted.js installClaude, POST /api/onboarding/install-claude).
  assert.match(src('pc.js'), /if \(!machine\.current\) \{\n\s*return h\('div\.row\.static\.cp-press'/);
  assert.match(src('pc.js'), /btn\('small primary', \{ icon: 'download', label: 'Install Claude Code', onclick: \(\) => import\('\.\/getstarted\.js'\)\.then\(\(m\) => m\.runAction\(\{ kind: 'install-claude' \}, ctx\.reload\)\) \}\)/);
  assert.match(src('getstarted.js'), /\} else if \(a\.kind === 'install-claude'\) installClaude\(after\);/);
  // On a phone its title and sentence wrap whole and the button goes under them, never cut to "Claude Code n…".
  assert.match(src('pc.js'), /return h\('div\.row\.static\.cp-press', h\('span\.row-icon', icon\('sparkle'\)\),\n\s*h\('span\.row-main\.cp-wrap', h\('span\.row-title', 'Claude Code not installed'\)/);
  assert.match(src('page-computers.css'), /@media \(max-width: 640px\) \{ \.cp-press \{ flex-wrap: wrap; \} \.cp-press > \.row-main \{ flex: 1 1 200px; \} \.cp-press > button\.btn \{ margin-left: 44px; \} \}/);
  // Another computer:
  assert.match(src('pc.js'), /h\('span\.row-title', 'Claude Code not installed'\), h\('span\.row-sub', 'Setup shows the command that installs it, to type in a terminal on that computer\.'\)/);
  assert.doesNotMatch(src('pc.js'), /Install it under Setup/);
  // Setup's row for it: no Fix or Install button, its command as a line of text (the check has no fixKit or action).
  const checks = fs.readFileSync(new URL('../../src/setup/checks.mjs', import.meta.url), 'utf8');
  assert.match(checks, /return result\('claude', 'Claude Code', 'fail', 'not installed', `\$\{APP\} setup {3}\(or: \$\{APP\} claude install latest\)`\);/);
  assert.match(src('pcsetup.js'), /c\.fix && !c\.fixKit && !c\.setupKit && c\.action !== 'claude-login' \? h\('span\.row-sub\.mono', c\.fix\)/);
});
