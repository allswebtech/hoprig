// A Codex or OpenCode session Tia starts gets no hook from Hoprig, so her administrator-rights level cannot hold an
// administrator command in it. assertHerToolBound refuses such a start below Full (where her administrator commands
// would otherwise run with no card, more than her level allows); Claude Code, a session that is not hers, and Full
// all pass. Both start paths that know a session is hers consult it: the terminal route (server.mjs) and the one
// openChat (chat/feature.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertHerToolBound } from '../../src/codetools/start.mjs';
import { hoprigVersion } from '../../src/handsoff.mjs';

const V = hoprigVersion();
const levelCfg = (level) => (level ? { server: { herRights: { level, version: V } } } : {});
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('Claude Code is bound by its own hook, so a chat or terminal of hers on it always passes', () => {
  for (const level of [undefined, 'off', 'ask', 'full']) {
    assert.doesNotThrow(() => assertHerToolBound('claude', { hers: true, cfg: levelCfg(level) }));
  }
});

test('a session that is not hers (the owner started it himself) is never refused for the level', () => {
  for (const level of [undefined, 'off', 'ask']) {
    for (const tool of ['opencode', 'codex']) assert.doesNotThrow(() => assertHerToolBound(tool, { hers: false, cfg: levelCfg(level) }));
  }
});

test('below Full a Codex or OpenCode session she starts is refused, naming the tool and Full', () => {
  for (const level of [undefined, 'off', 'ask']) {
    for (const tool of ['opencode', 'codex']) {
      assert.throws(() => assertHerToolBound(tool, { hers: true, cfg: levelCfg(level) }), (e) => {
        assert.match(e.message, /no card/, 'it says the command would run with no card');
        assert.match(e.message, /Full/, 'it names Full as where it may start');
        assert.equal(e.status, 400, 'a plain refusal');
        return true;
      }, `refused at level ${level ?? 'default'} for ${tool}`);
    }
  }
});

test('at Full her administrator commands run with no card anyway, so a Codex or OpenCode session she starts is allowed', () => {
  for (const tool of ['opencode', 'codex']) assert.doesNotThrow(() => assertHerToolBound(tool, { hers: true, cfg: levelCfg('full') }));
});

test('a Full chosen under another Hoprig version reads as Ask, so a session she starts on another tool is still refused', () => {
  const stale = { server: { herRights: { level: 'full', version: 'another-version' } } };
  assert.throws(() => assertHerToolBound('opencode', { hers: true, cfg: stale }));
});

test('both start paths that know a session is hers consult assertHerToolBound', () => {
  assert.match(read('server/server.mjs'), /assertHerToolBound\(tool, \{ hers, cfg: cfg\(\) \}\)/, 'the terminal route (POST /api/sessions)');
  // openChat guards on the value it marks a chat hers by: hers or byTia (test/chat/openchat-hers.test.mjs runs it).
  const chat = read('chat/feature.mjs');
  assert.match(chat, /const hers = b\.hers === true \|\| b\.byTia === true;\n\s*assertHerToolBound\(tool, \{ hers, cfg: cfg\(\) \}\)/, 'the one openChat');
  assert.match(chat, /\.\.\.\(hers \? \{ hers: true \} : \{\}\)/, 'openChat marks on the same value');
});
