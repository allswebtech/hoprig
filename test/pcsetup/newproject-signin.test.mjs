// "Sign in to GitHub" on the new project's Check step and on Add a repository is a link to the Setup page that does
// it, not a path in brackets (Computers, this computer, Setup) he has to follow by hand.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Just enough of a browser for the page's modules to load (nothing is drawn here).
globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const src = fs.readFileSync(new URL('../../web/projects.js', import.meta.url), 'utf8');

test('GitHub: a link that opens the Setup page with the sign-in, never the path in brackets', () => {
  assert.doesNotMatch(src, /sign in to GitHub first \(Computers → this computer → Setup\)/);
  assert.match(src, /export const signInLink = \(after, \{ onPress = null \} = \{\}\) => h\('a', \{ href: link\('#\/computer\/setup\?show=git'\), onclick: async \(e\) => \{/);
  assert.match(src, /'It stays on this computer\. To also put it on GitHub, ', signInLink\(async \(\) => \{/, 'the new project');
  assert.match(src, /'To also put it on GitHub, ', signInLink\(null, \{ onPress: /, 'a new repository of a project');
});
