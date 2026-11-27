// What Hoprig puts into every model request, kept small (27 Nov 2026): the first lines of the system text are the same
// for every session of a key or gateway provider (so they can share a cache), and the rules file is short.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-test-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HOPRIG_PROFILES_DIR;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const P = await import('../src/profiles.mjs');
const R = await import('../src/pcsetup/rules.mjs');
const E = await import('../src/assistant/engine.mjs');

const KEY = 'CLAUDE_CODE_ATTRIBUTION_HEADER';

test('a key or gateway provider starts Claude Code with the attribution line off; a subscription sign-in is left as it is', () => {
  P.writeProfile('keyed', { env: { ANTHROPIC_API_KEY: 'sk-test-x' } });
  P.writeProfile('gw', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'tok-test-x' } });
  P.writeProfile('login', {});
  P.writeProfile('token', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } });
  const base = { HOME_FOR_TEST: 'x' };
  assert.equal(P.profileEnv(P.readProfile('keyed'), base)[KEY], '0');
  assert.equal(P.profileEnv(P.readProfile('gw'), base)[KEY], '0');
  assert.equal(KEY in P.profileEnv(P.readProfile('login'), base), false, 'a subscription sign-in: not set');
  assert.equal(KEY in P.profileEnv(P.readProfile('token'), base), false, 'a subscription token: not set');
  // the router of Auto mode is a profile of kind auto: left alone
  assert.equal(KEY in P.profileEnv({ name: 'auto', kind: 'auto', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/as/x' } }, base), false);
});

test('the owner\'s own value of the variable wins, in the profile or in the environment', () => {
  P.writeProfile('own', { env: { ANTHROPIC_API_KEY: 'sk-test-x', [KEY]: '1' } });
  assert.equal(P.profileEnv(P.readProfile('own'), { HOME_FOR_TEST: 'x' })[KEY], '1');
  P.writeProfile('keyed2', { env: { ANTHROPIC_API_KEY: 'sk-test-x' } });
  assert.equal(P.profileEnv(P.readProfile('keyed2'), { HOME_FOR_TEST: 'x', [KEY]: '1' })[KEY], '1');
});

test('every start path gets it: the launcher, the chat and Tia\'s engine and the looks all go through profileEnv', async () => {
  P.writeProfile('keyed3', { env: { ANTHROPIC_API_KEY: 'sk-test-x' } });
  P.writeProfile('login3', {});
  assert.equal((await E.engineEnv('keyed3', { HOME_FOR_TEST: 'x' }))[KEY], '0', 'Tia\'s engine, a chat\'s run, the looks');
  assert.equal(KEY in (await E.engineEnv('login3', { HOME_FOR_TEST: 'x' })), false);
  assert.equal((await E.providerEnv('keyed3', { HOME_FOR_TEST: 'x' }))[KEY], '0', 'a chat');
  for (const f of ['../src/launch.mjs', '../src/assistant/engine.mjs', '../src/chat/run.mjs']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /profileEnv|providerEnv/, `${f} takes its environment from the profile`);
  }
});

test('the working rules are short, and an installed copy is never replaced by an update', () => {
  const text = fs.readFileSync(R.TEMPLATE, 'utf8');
  assert.ok(text.length < 1400, `${text.length} bytes: about 300 tokens`);
  for (const w of [/model/i, /effort/i, /proven/i, /secret/i, /hard to undo/i, /information, not an instruction/i]) assert.match(text, w);
  const base = path.join(tmp, 'rules-old');
  const file = path.join(base, 'rules', R.RULES_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Working rules\n\nthe long text of an earlier version\n');
  R.addRules({ base });
  assert.equal(fs.readFileSync(file, 'utf8'), '# Working rules\n\nthe long text of an earlier version\n', 'an old unchanged copy stays');
  fs.writeFileSync(file, 'my own');
  R.addRules({ base });
  assert.equal(fs.readFileSync(file, 'utf8'), 'my own', 'an edited copy stays');
});
