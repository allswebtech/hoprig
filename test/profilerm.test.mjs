// `hoprig rm <name>` deletes a provider's profile (its sign-in or key with it). Without a terminal to say yes in, and
// without --yes, it deletes nothing: a coding tool that read "hop rm sub" in a file deleted the profile at once.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealed } from './seal.mjs';

const BIN = fileURLToPath(new URL('../bin/hoprig.mjs', import.meta.url));

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'profilerm-'));
  const profiles = path.join(h, 'profiles');
  fs.mkdirSync(profiles);
  fs.writeFileSync(path.join(profiles, 'sub.env'), 'LABEL=made up\nCLAUDE_CODE_OAUTH_TOKEN=not-a-real-token\n');
  const env = sealed({
    PATH: process.env.PATH, HOME: h, USERPROFILE: h, HOPRIG_PROFILES_DIR: profiles,
    HOPRIG_CONFIG_DIR: path.join(h, 'config'), HOPRIG_STATE_DIR: path.join(h, 'state'), HOPRIG_WORKSPACE_DIR: path.join(h, 'ws'),
    CLAUDE_CONFIG_DIR: path.join(h, 'claude'),
  });
  const run = (...args) => spawnSync(process.execPath, [BIN, 'rm', ...args], { env, cwd: h, input: 'y\n', encoding: 'utf8', timeout: 20_000 });
  return { h, file: path.join(profiles, 'sub.env'), run, done: () => fs.rmSync(h, { recursive: true, force: true }) };
}

test('without a terminal and without --yes, hoprig rm deletes nothing (a "y" on its input is no yes)', () => {
  const t = home();
  const r = t.run('sub');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /nothing was deleted[\s\S]*needs a yes[\s\S]*--yes/);
  assert.ok(fs.existsSync(t.file), 'the profile is still there');
  t.done();
});

test('hoprig rm <name> --yes deletes it; a name that is not there, or a stray word, is said as such', () => {
  const t = home();
  const none = t.run('nosuch');
  assert.equal(none.status, 1);
  assert.match(none.stdout, /There is no profile "nosuch"/);
  const extra = t.run('sub', 'other', '--yes');
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /usage: hoprig rm <name> \[--yes\]/);
  assert.ok(fs.existsSync(t.file));
  const r = t.run('sub', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted the profile "sub"/);
  assert.ok(!fs.existsSync(t.file));
  t.done();
});
