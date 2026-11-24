// SAFETY: gh takes a token from the environment before it asks anything it has stored, and when no token variable
// is set it falls back to its stored sign-in, which `gh auth login` keeps in the system's keyring by default where
// the system has one. The blank sign-in a session of Tia's gets when her chosen file cannot be read must not leave
// gh that way to the owner's own sign-in: each token variable gh reads holds a value that is not a token, so gh uses
// it, fails with a sign-in error, and never gets as far as the keyring. (herBlankSignin, src/assistant/hersignin.mjs.)
//
// The gh here is a stand-in of this test's own, first on PATH in the test's temporary folder (never the real gh). It
// follows gh's documented order: for github.com GH_TOKEN then GITHUB_TOKEN, for another host GH_ENTERPRISE_TOKEN then
// GITHUB_ENTERPRISE_TOKEN; with none of them set it "finds" a made-up keyring sign-in of the owner and prints it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { herSignedEnv } from '../../src/assistant/hersignin.mjs';

const VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const KEYRING_SECRET = 'ghp_OWNER_keyring_madeup_0001';
const HER_TOKEN = 'ghp_her_madeup_0002';

const STANDIN_GH = [
  '#!/bin/sh',
  'host="${GH_HOST:-github.com}"',
  'if [ "$host" = github.com ]; then tok="${GH_TOKEN:-$GITHUB_TOKEN}"; else tok="${GH_ENTERPRISE_TOKEN:-$GITHUB_ENTERPRISE_TOKEN}"; fi',
  'if [ -z "$tok" ]; then echo "keyring sign-in: $KEYRING_SECRET"; exit 0; fi',
  'if [ "$tok" = "$HER_TOKEN" ]; then echo "signed in with her token"; exit 0; fi',
  'if [ "$tok" = "$HIS_TOKEN" ]; then echo "signed in with his token"; exit 0; fi',
  'echo "HTTP 401: Bad credentials (https://api.github.com/user)" >&2',
  'exit 1',
  '',
].join('\n');

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hersignin-keyring-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), STANDIN_GH, { mode: 0o755 });
  const credsDir = path.join(root, 'credentials');
  fs.mkdirSync(path.join(credsDir, 'github'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(credsDir, 'github', 'her.token'), `${HER_TOKEN}\n`);
  const his = {
    HOME: root,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, // seal: the stand-in gh comes first; the runner's PATH and its traps follow it
    GH_TOKEN: 'ghp_HIS_own_madeup',
    GITHUB_TOKEN: 'ghp_HIS_own_madeup',
    GH_ENTERPRISE_TOKEN: 'his-ent-madeup',
    GITHUB_ENTERPRISE_TOKEN: 'his-ent-madeup',
  };
  return { root, credsDir, his, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// The stand-in gh, found by name through the environment's own PATH (its folder comes first there).
const gh = (env, extra = {}) => {
  const r = spawnSync('gh', ['auth', 'status'], { env: { ...env, ...extra, KEYRING_SECRET, HER_TOKEN, HIS_TOKEN: 'ghp_HIS_own_madeup' }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error };
};

const unreadable = { server: { herGitSignin: { file: 'github/missing.token' } } };
const readable = { server: { herGitSignin: { file: 'github/her.token' } } };

test('the blank sign-in gives each token variable gh reads the same value, one that is plainly not a token', () => {
  const c = setup();
  try {
    const out = herSignedEnv(c.his, { byTia: true, cfg: unreadable, credsDir: c.credsDir, onProblem: () => {} });
    for (const k of VARS) assert.equal(out[k], 'none', `${k} holds the placeholder`);
    assert.ok(!JSON.stringify(out).includes('HIS_own') && !JSON.stringify(out).includes('his-ent'), 'none of his tokens is left');
  } finally {
    c.cleanup();
  }
});

test('gh in her blank session fails with a sign-in error and never gets as far as the keyring', () => {
  const c = setup();
  try {
    // Baseline: with no token variable at all (his taken out and nothing in their place), the stand-in reaches the
    // keyring, as the real gh does. This is the way the placeholder shuts.
    const bare = { ...c.his };
    for (const k of VARS) delete bare[k];
    const leak = gh(bare);
    assert.equal(leak.error, undefined, 'the stand-in gh ran');
    assert.match(leak.out, new RegExp(KEYRING_SECRET), 'baseline: with no token variable gh finds the keyring sign-in');

    const out = herSignedEnv(c.his, { byTia: true, cfg: unreadable, credsDir: c.credsDir, onProblem: () => {} });
    for (const extra of [{}, { GH_HOST: 'github.com' }, { GH_HOST: 'git.example.com' }]) {
      const r = gh(out, extra);
      assert.equal(r.error, undefined, 'the stand-in gh ran');
      assert.doesNotMatch(r.out, new RegExp(KEYRING_SECRET), `no keyring sign-in (${JSON.stringify(extra)})`);
      assert.doesNotMatch(r.out, /signed in with/, `no sign-in of anybody (${JSON.stringify(extra)})`);
      assert.notEqual(r.status, 0, 'gh fails');
      assert.match(r.out, /Bad credentials/, 'with a sign-in error');
    }
  } finally {
    c.cleanup();
  }
});

test('the owner\'s own session is unchanged and its gh signs in with his own token', () => {
  const c = setup();
  try {
    for (const cfg of [{}, readable, unreadable]) {
      const out = herSignedEnv(c.his, { byTia: false, cfg, credsDir: c.credsDir, onProblem: () => { throw new Error('not his'); } });
      assert.equal(out, c.his, 'his own environment itself is returned');
      assert.match(gh(out).out, /signed in with his token/);
    }
    assert.equal(c.his.GH_TOKEN, 'ghp_HIS_own_madeup', 'his environment is not changed');
  } finally {
    c.cleanup();
  }
});

test('her session with a readable file still signs gh in with HER token, not a placeholder', () => {
  const c = setup();
  try {
    const out = herSignedEnv(c.his, { byTia: true, cfg: readable, credsDir: c.credsDir, onProblem: () => { throw new Error('the file reads'); } });
    assert.equal(out.GH_TOKEN, HER_TOKEN);
    assert.equal(out.GITHUB_TOKEN, HER_TOKEN);
    const r = gh(out);
    assert.equal(r.status, 0);
    assert.match(r.out, /signed in with her token/);
  } finally {
    c.cleanup();
  }
});
