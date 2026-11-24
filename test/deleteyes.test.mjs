// `hoprig tokens revoke`, `hoprig machines rm` and `hoprig workspace forget` take something away. Like `hoprig rm`
// (profilerm.test.mjs), without a terminal to say yes in and without --yes they change nothing: a coding tool that
// read "hop tokens revoke all" in a file revoked at once, whether or not the Hoprig skill was loaded.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealed } from './seal.mjs';

const BIN = fileURLToPath(new URL('../bin/hoprig.mjs', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function home() {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deleteyes-')));
  const env = sealed({
    PATH: process.env.PATH, HOME: h, USERPROFILE: h, HOPRIG_PROFILES_DIR: path.join(h, 'profiles'),
    HOPRIG_CONFIG_DIR: path.join(h, 'config'), HOPRIG_STATE_DIR: path.join(h, 'state'), HOPRIG_WORKSPACE_DIR: path.join(h, 'ws'),
    CLAUDE_CONFIG_DIR: path.join(h, 'claude'), NO_COLOR: '1',
  });
  // A "y" on the input is no yes: without a terminal only --yes counts.
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, cwd: h, input: 'y\n', encoding: 'utf8', timeout: 20_000 });
  const node = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, cwd: h, encoding: 'utf8' });
  return { h, env, run, node, done: () => fs.rmSync(h, { recursive: true, force: true }) };
}

const url = (rel) => JSON.stringify(new URL(rel, `file://${SRC.replaceAll('\\', '/')}/`).href);

test('hoprig tokens revoke: nothing without a yes; --yes revokes; a name that is not there is said first', () => {
  const t = home();
  const made = JSON.parse(t.node(`const { createToken } = await import(${url('machines/tokens.mjs')}); console.log(JSON.stringify(createToken('hub-one')));`));
  const tokens = () => JSON.parse(t.run('tokens', '--json').stdout).map((x) => x.id);
  assert.deepEqual(tokens(), [made.id]);
  for (const arg of [made.id, 'hub-one']) {
    const r = t.run('tokens', 'revoke', arg);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /hoprig tokens revoke: nothing was revoked\. Revoking hub-one \([0-9a-f]{12}\) needs a yes: run it in a terminal, or add --yes\./);
    assert.deepEqual(tokens(), [made.id], 'still there');
  }
  const none = t.run('tokens', 'revoke', 'nosuch');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No token with the id or name "nosuch"/);
  const r = t.run('tokens', 'revoke', 'hub-one', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Revoked: hub-one/);
  assert.deepEqual(tokens(), []);
  t.done();
});

test('hoprig machines rm: nothing without a yes; --yes removes', () => {
  const t = home();
  // A computer by address that answers nothing (port 9): removing it cannot reach it, which is fine.
  t.node(`const { putMachine } = await import(${url('machines/store.mjs')}); putMachine({ name: 'laptop', label: 'Laptop', via: 'url', url: 'http://127.0.0.1:9', token: 'hop_made_up', added: Date.now() });`);
  const names = () => JSON.parse(t.run('machines', '--json').stdout).map((m) => m.name);
  assert.deepEqual(names(), ['laptop']);
  const r = t.run('machines', 'rm', 'laptop');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /hoprig machines rm: nothing was removed\. Removing the computer "laptop" needs a yes/);
  assert.deepEqual(names(), ['laptop']);
  const none = t.run('machines', 'rm', 'nosuch', '--yes');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no computer named "nosuch"/);
  const yes = t.run('machines', 'rm', 'laptop', '--yes');
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /Removed "laptop"/);
  assert.deepEqual(names(), []);
  t.done();
});

test('hoprig workspace forget: nothing without a yes; --yes takes it out of the map', () => {
  const t = home();
  const file = path.join(t.h, 'ws', 'ai_brain', 'workspace.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const map = { version: 1, brain: { url: null }, projects: [{ name: 'shop', url: 'https://example.com/example/shop.git', repos: [] }], others: [] };
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
  const before = fs.readFileSync(file, 'utf8');
  const r = t.run('workspace', 'forget', 'shop');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /hoprig workspace forget: nothing was changed\. Taking shop out of the map needs a yes/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const yes = t.run('workspace', 'forget', 'shop', '--yes');
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
  assert.match(yes.stdout, /shop is out of the map/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, []);
  t.done();
});
