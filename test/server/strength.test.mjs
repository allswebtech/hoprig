// Is the dashboard password strong enough for a public link (src/server/strength.mjs): the plain reason for a weak
// one, and what is kept of it (only the result, tied to its hash; never the password).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('strength');
test.after(() => box.cleanup());

const { MIN_STRONG, hashTag, notePassword, passwordProblem, passwordState } = await import('../../src/server/strength.mjs');
const { generatePassword, hashPassword } = await import('../../src/server/auth.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');

test('weak passwords get a plain reason; long and varied ones pass', () => {
  assert.equal(MIN_STRONG, 12);
  assert.equal(passwordProblem(''), 'there is no password');
  assert.equal(passwordProblem('Tr0ub4dor&3'), 'it has fewer than 12 characters');
  assert.equal(passwordProblem('Password2026!'), 'it is one of the passwords people try first');
  assert.equal(passwordProblem('qwertyuiop12'), 'it is one of the passwords people try first');
  assert.equal(passwordProblem('aaaaaaaaaaaaaaaa'), 'it repeats a few characters');
  assert.equal(passwordProblem('abababababab'), 'it repeats a few characters');
  assert.equal(passwordProblem('abcdefghijklmn'), 'it is a simple sequence');
  assert.equal(passwordProblem('123456789012'), 'it is one of the passwords people try first');
  assert.equal(passwordProblem('0123456789012'), 'it is a simple sequence');
  assert.equal(passwordProblem('correct horse battery'), null);
  assert.equal(passwordProblem('right-password'), null);
  for (let i = 0; i < 20; i++) assert.equal(passwordProblem(generatePassword()), null, 'a generated one is always strong');
});

test('what is kept: the result for this hash only, written once; a new password is unknown until it is seen', async () => {
  assert.equal(passwordState({}).state, 'none');
  const hash = await hashPassword('correct horse battery');
  saveConfig({ server: { passwordHash: hash } });
  assert.equal(passwordState().state, 'unknown');
  assert.deepEqual(notePassword('correct horse battery', hash), { tag: hashTag(hash), strong: true });
  assert.deepEqual(passwordState(), { state: 'strong', why: null });
  const file = `${process.env.HOPRIG_CONFIG_DIR}/config.json`;
  const at = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  notePassword('correct horse battery', hash);
  assert.equal(fs.statSync(file).mtimeMs, at, 'not written again when nothing changed');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('correct horse'), 'the password itself is never kept');
  const weak = await hashPassword('short');
  saveConfig({ server: { passwordHash: weak } });
  assert.equal(passwordState().state, 'unknown', 'the check of the old password does not count for the new one');
  notePassword('short', weak);
  assert.deepEqual(passwordState(), { state: 'weak', why: 'it has fewer than 12 characters' });
  assert.equal(loadConfig().server.passwordCheck.tag.length, 16);
});
