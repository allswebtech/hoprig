// `hoprig tools`: the words, turning tools on and off, and the refusals. (Install and update are tested on the
// descriptors with stand-ins for npm: codetools.test.mjs; status would ask the registry, so it is not run here.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../../src/codetools/cli.mjs';

function io(cfg = {}) {
  const lines = [];
  const errs = [];
  let config = cfg;
  return { lines, errs, cfg: () => config, io: { out: (s) => lines.push(s), err: (s) => errs.push(s), config: () => config, save: (p) => (config = { ...config, ...p }) } };
}

test('on and off change which coding tools are offered; never none', async () => {
  const t = io();
  assert.equal(await main(['on', 'codex'], t.io), 0);
  assert.deepEqual(t.cfg().codingTools, ['claude', 'codex']);
  assert.match(t.lines.at(-1), /^On: Claude Code, Codex\. Install it with: hoprig tools install codex$/);
  assert.equal(await main(['off', 'claude'], t.io), 0);
  assert.deepEqual(t.cfg().codingTools, ['codex']);
  assert.equal(await main(['off', 'codex'], t.io), 1);
  assert.match(t.errs.at(-1), /at least one/);
  assert.deepEqual(t.cfg().codingTools, ['codex'], 'unchanged');
});

test('unknown words and tools are refused with the usage', async () => {
  const t = io();
  assert.equal(await main(['frobnicate'], t.io), 2);
  assert.match(t.errs.at(-1), /hoprig tools install <tool> \[version\]/);
  assert.equal(await main(['install', 'gemini'], t.io), 2);
  assert.match(t.errs.at(-1), /"gemini" is not a coding tool: claude, codex, opencode/);
  assert.equal(await main(['on'], t.io), 2);
  assert.equal(t.cfg().codingTools, undefined, 'nothing saved');
});
