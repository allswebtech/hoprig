// The git sign-in Tia's sessions use (src/assistant/hersignin.mjs): the reader of the owner's choice, the name check
// that keeps the file inside the credentials folder, and the environment that hands git and gh the token WITHOUT the
// token ever reaching a config value, a command line or a log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanHerGitSigninFile, GIT_HOST, herGitEnv, herGitSigninFile, herSessionGitEnv, herSignedEnv, herTokenPath, readHerToken,
} from '../../src/assistant/hersignin.mjs';

function creds() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hersignin-test-')));
  return { dir: path.join(root, 'credentials'), root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('herGitSigninFile reads the owner\'s chosen file, null when he chose none', () => {
  assert.equal(herGitSigninFile(undefined), null);
  assert.equal(herGitSigninFile({}), null);
  assert.equal(herGitSigninFile({ server: {} }), null);
  assert.equal(herGitSigninFile({ server: { herGitSignin: { file: '' } } }), null);
  assert.equal(herGitSigninFile({ server: { herGitSignin: { file: 'shop/token' } } }), 'shop/token');
});

test('cleanHerGitSigninFile takes a plain name, clears on empty, refuses a path that could lead out', () => {
  assert.equal(cleanHerGitSigninFile('token'), 'token');
  assert.equal(cleanHerGitSigninFile('shop/shop.token'), 'shop/shop.token');
  assert.equal(cleanHerGitSigninFile('  token  '), 'token');
  assert.equal(cleanHerGitSigninFile(null), null);
  assert.equal(cleanHerGitSigninFile(''), null);
  assert.equal(cleanHerGitSigninFile('   '), null);
  for (const bad of ['/etc/passwd', '../token', 'a/../../token', 'a//b', '/token', 'token/', 'a\\b', 'C:/x']) {
    assert.throws(() => cleanHerGitSigninFile(bad), /credentials folder|full path|file name may not/, bad);
  }
  assert.throws(() => cleanHerGitSigninFile('a\u0000b'), /a file name may not/);
  assert.throws(() => cleanHerGitSigninFile(42), /name of one file/);
});

test('readHerToken reads the token, and reports a missing, empty or many-line file without its content', () => {
  const c = creds();
  try {
    fs.mkdirSync(path.join(c.dir, 'shop'), { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'shop', 'token'), 'ghp_madeUpToken1234\n');
    assert.equal(readHerToken(c.dir, 'shop/token'), 'ghp_madeUpToken1234');
    assert.throws(() => readHerToken(c.dir, 'missing'), /not in the credentials folder/);
    fs.writeFileSync(path.join(c.dir, 'empty'), '\n  \n');
    assert.throws(() => readHerToken(c.dir, 'empty'), /is empty/);
    fs.writeFileSync(path.join(c.dir, 'two'), 'a_token\nand a note\n');
    assert.throws(() => readHerToken(c.dir, 'two'), /only the token/);
  } finally {
    c.cleanup();
  }
});

test('herTokenPath refuses a link that leads out of the credentials folder', () => {
  const c = creds();
  try {
    fs.mkdirSync(c.dir, { recursive: true });
    const outside = path.join(c.root, 'his-real-token');
    fs.writeFileSync(outside, 'ghp_hisOwn\n');
    fs.symlinkSync(outside, path.join(c.dir, 'leak'));
    assert.throws(() => herTokenPath(c.dir, 'leak'), /leads out of the credentials folder/);
    assert.throws(() => readHerToken(c.dir, 'leak'), /leads out of the credentials folder/);
  } finally {
    c.cleanup();
  }
});

test('herGitEnv hands the token to git and gh, with the token in no config value and on no command line', () => {
  const token = 'ghp_madeUpSecretValue_0001';
  const env = herGitEnv(token, { base: { HOME: '/home/alex', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' } });
  // gh and git read the token from these two, the one place it lives.
  assert.equal(env.GH_TOKEN, token);
  assert.equal(env.GITHUB_TOKEN, token);
  // Nowhere else: no GIT_CONFIG value, no other variable, holds the literal token.
  for (const [k, v] of Object.entries(env)) {
    if (k === 'GH_TOKEN' || k === 'GITHUB_TOKEN') continue;
    assert.ok(!String(v).includes(token), `the token leaked into ${k}`);
  }
  // git gets a credential helper for the git server, reading the token from the environment ($GH_TOKEN), and the
  // existing GIT_CONFIG_* (the hooks-off entry) is kept.
  const keys = {};
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) keys[env[`GIT_CONFIG_KEY_${i}`]] = env[`GIT_CONFIG_VALUE_${i}`];
  assert.equal(keys['core.hooksPath'], '/dev/null');
  const helper = keys[`credential.https://${GIT_HOST}.helper`];
  assert.match(helper, /\$GH_TOKEN/);
  assert.ok(!helper.includes(token));
  assert.equal(keys[`credential.https://${GIT_HOST}.username`], 'x-access-token');
});

test('herSessionGitEnv: null with no file chosen, the sign-in with one, a plain reason when it cannot be read', () => {
  const c = creds();
  try {
    fs.mkdirSync(c.dir, { recursive: true });
    assert.equal(herSessionGitEnv({}, c.dir), null);
    assert.equal(herSessionGitEnv({ server: { herGitSignin: { file: '' } } }, c.dir), null);
    fs.writeFileSync(path.join(c.dir, 'token'), 'ghp_her_0002\n');
    const r = herSessionGitEnv({ server: { herGitSignin: { file: 'token' } } }, c.dir, { base: { HOME: '/home/alex' } });
    assert.equal(r.ok, true);
    assert.equal(r.env.GH_TOKEN, 'ghp_her_0002');
    const bad = herSessionGitEnv({ server: { herGitSignin: { file: 'gone' } } }, c.dir);
    assert.equal(bad.ok, false);
    assert.match(bad.why, /not in the credentials folder/);
  } finally {
    c.cleanup();
  }
});

test('herSignedEnv: a session Tia started gets the chosen sign-in and not his; a session of his own is untouched', () => {
  const c = creds();
  try {
    fs.mkdirSync(c.dir, { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'token'), 'ghp_her_0003\n');
    const his = { HOME: '/home/alex', GH_TOKEN: 'ghp_HIS_own', GITHUB_TOKEN: 'ghp_HIS_own' };
    const cfg = { server: { herGitSignin: { file: 'token' } } };
    // A session of his own: unchanged, even with a file chosen.
    assert.deepEqual(herSignedEnv(his, { byTia: false, cfg, credsDir: c.dir }), his);
    // Her session, no file chosen: unchanged (his own sign-in, as today).
    assert.deepEqual(herSignedEnv(his, { byTia: true, cfg: {}, credsDir: c.dir }), his);
    // Her session, file chosen and readable: her token in place of his.
    const hers = herSignedEnv(his, { byTia: true, cfg, credsDir: c.dir });
    assert.equal(hers.GH_TOKEN, 'ghp_her_0003');
    assert.equal(hers.GITHUB_TOKEN, 'ghp_her_0003');
    assert.ok(!JSON.stringify(hers).includes('ghp_HIS_own'), 'his own token is gone from her session');
    // Her session, file chosen but unreadable: his git tokens are taken out (no fall back to his full rights) and gh's
    // token variables hold a placeholder that is not a token, so gh fails rather than asking the keyring.
    let why = null;
    const broken = herSignedEnv(his, { byTia: true, cfg: { server: { herGitSignin: { file: 'gone' } } }, credsDir: c.dir, onProblem: (m) => { why = m; } });
    assert.equal(broken.GH_TOKEN, 'none');
    assert.equal(broken.GITHUB_TOKEN, 'none');
    assert.ok(!JSON.stringify(broken).includes('ghp_HIS_own'), 'his own token is gone from her session');
    assert.match(why, /not in the credentials folder/);
  } finally {
    c.cleanup();
  }
});

test('herGitEnv takes out every git token of his, the enterprise ones too, before it sets hers', () => {
  const base = { GH_TOKEN: 'his-dotcom', GITHUB_TOKEN: 'his-dotcom', GH_ENTERPRISE_TOKEN: 'his-ent', GITHUB_ENTERPRISE_TOKEN: 'his-ent', KEEP: 'x' };
  const out = herGitEnv('hers-reduced', { base });
  assert.equal(out.GH_TOKEN, 'hers-reduced');
  assert.equal(out.GITHUB_TOKEN, 'hers-reduced');
  assert.equal('GH_ENTERPRISE_TOKEN' in out, false, 'his enterprise token is gone');
  assert.equal('GITHUB_ENTERPRISE_TOKEN' in out, false, 'his enterprise token is gone');
  assert.equal(out.KEEP, 'x', 'the rest of the environment is kept');
  assert.equal(base.GH_ENTERPRISE_TOKEN, 'his-ent', 'the base is not changed');
});
