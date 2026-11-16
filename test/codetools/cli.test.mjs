// `hoprig tools`: the words, turning tools on and off, and the refusals. (Install and update are tested on the
// descriptors with stand-ins for npm: codetools.test.mjs; status would ask the registry, so it is not run here.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// An empty tools folder of its own: whether OpenCode is installed never depends on this computer.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-toolscli-'));
process.env.HOPRIG_TOOLS_DIR = path.join(tmp, 'tools');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { main } = await import('../../src/codetools/cli.mjs');

function io(cfg = {}) {
  const lines = [];
  const errs = [];
  let config = cfg;
  return { lines, errs, cfg: () => config, io: { out: (s) => lines.push(s), err: (s) => errs.push(s), config: () => config, save: (p) => (config = { ...config, ...p }) } };
}

test('on and off change which coding tools are offered; never none', async () => {
  const t = io();
  assert.equal(await main(['on', 'opencode'], t.io), 0);
  assert.deepEqual(t.cfg().codingTools, ['claude', 'opencode']);
  assert.match(t.lines.at(-1), /^On: Claude Code, OpenCode\. Install it with: hoprig tools install opencode$/);
  assert.equal(await main(['off', 'claude'], t.io), 0);
  assert.deepEqual(t.cfg().codingTools, ['opencode']);
  assert.equal(await main(['off', 'opencode'], t.io), 1);
  assert.match(t.errs.at(-1), /at least one/);
  assert.deepEqual(t.cfg().codingTools, ['opencode'], 'unchanged');
});

test('unknown words and tools are refused with the usage', async () => {
  const t = io();
  assert.equal(await main(['frobnicate'], t.io), 2);
  assert.match(t.errs.at(-1), /hoprig tools install <tool> \[version\]/);
  assert.match(t.errs.at(-1), /install one \(claude, opencode\)/, 'the usage names the offered tools only');
  assert.doesNotMatch(t.errs.at(-1), /codex/i);
  assert.equal(await main(['install', 'gemini'], t.io), 2);
  assert.match(t.errs.at(-1), /"gemini" is not a coding tool: claude, opencode/);
  assert.equal(await main(['on'], t.io), 2);
  assert.equal(t.cfg().codingTools, undefined, 'nothing saved');
});

test('Codex is not part of this version: install, update, on and off are refused with one plain sentence', async () => {
  const t = io({ codingTools: ['claude'] });
  for (const words of [['install', 'codex'], ['update', 'codex'], ['on', 'codex'], ['off', 'codex']]) {
    assert.equal(await main(words, t.io), 2, words.join(' '));
    assert.equal(t.errs.at(-1), 'Codex is not part of this version of Hoprig.', words.join(' '));
  }
  assert.deepEqual(t.cfg().codingTools, ['claude'], 'nothing changed');
  assert.deepEqual(t.lines, [], 'nothing started');
});
