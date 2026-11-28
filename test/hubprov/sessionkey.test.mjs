// A session key of a hub row ends with its session: when the launcher process that made it is gone, or when the launcher
// revokes the keys of the environment it gave the tool.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

sandbox('hubprov-sessionkey');
const { keyRow, mintKey, revokeSessionKeys } = await import('../../src/hubprov/localkeys.mjs');

test('a key made for a process stops working when that process is gone', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  const key = mintKey({ row: 'r1', pid: child.pid });
  assert.equal(keyRow(key), 'r1');
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  assert.equal(keyRow(key), null);
});

test('the launcher revokes the keys of the environment of an ended session', () => {
  const key = mintKey({ row: 'r2' });
  const other = mintKey({ row: 'r3' });
  assert.equal(keyRow(key), 'r2');
  revokeSessionKeys({ ANTHROPIC_AUTH_TOKEN: key, OTHER: 'x' });
  assert.equal(keyRow(key), null);
  assert.equal(keyRow(other), 'r3', 'another session key stays');
  revokeSessionKeys({ OPENAI_API_KEY: 'not-a-hub-key' });
});

test('the launcher calls it when the tool ends', () => {
  const src = fs.readFileSync(new URL('../../src/launch.mjs', import.meta.url), 'utf8');
  assert.match(src, /const done = \(code\) => \{\s*revokeSessionKeys\(env\)/);
});
