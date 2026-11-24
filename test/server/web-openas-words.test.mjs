// New session's closed line (web/newsession-choice.js choiceLine) names the way to open with the name of the tile the
// fold opens to ("App", "Terminal"), the name every Home card's pill carries too: one choice, one name on one sheet.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = { createElement: () => ({}), createElementNS: () => ({}), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const { OPEN_AS, choiceLine } = await import('../../web/newsession-choice.js');

test('the line says the App with the tile\'s own name, never "as a chat"', () => {
  const app = OPEN_AS.find((x) => x.id === 'app').name;
  const line = choiceLine({ computer: 'Workstation', openAs: 'app', tool: 'Claude Code' });
  assert.equal(line, `On Workstation · in the ${app} · with Claude Code`);
  assert.doesNotMatch(line, /as a chat/);
  assert.match(choiceLine({ openAs: 'terminal', tool: 'OpenCode' }), new RegExp(`^In a ${OPEN_AS.find((x) => x.id === 'terminal').name.toLowerCase()} · `));
});
