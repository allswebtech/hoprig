// The AI brain note says "does not read" for one coding tool and "do not read" for more.
import assert from 'node:assert/strict';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.location ||= { hash: '#/brain', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {} });
const B = await import('../../web/brainlink.js');

test('one coding tool: "does not read"; two: "do not read"', () => {
  assert.equal(typeof B.noteWords, 'function');
  const one = B.noteWords([{ id: 'opencode:rules', tool: 'opencode', tools: ['opencode'], what: 'the rules' }]);
  assert.match(one, /OpenCode does not read all of the AI brain\.$/);
  const two = B.noteWords([{ id: 'opencode:rules', tool: 'opencode', tools: ['opencode'], what: 'the rules' }, { id: 'codex:rules', tool: 'codex', tools: ['codex'], what: 'the rules' }]);
  assert.match(two, / and .* do not read all of the AI brain\.$/);
  assert.match(B.noteWords([{ id: 'rules', tool: 'claude', tools: ['claude'], what: 'your rules' }]), /^Claude Code does not read your rules from the AI brain yet\.$/);
});
