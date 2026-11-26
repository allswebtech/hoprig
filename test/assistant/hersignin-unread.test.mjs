// SAFETY: when Tia's chosen git sign-in file cannot be read, her session must sign in as NOBODY, not fall back to the
// owner's own sign-in (docs/OPERATOR.md: "If the file cannot be read, her sessions get no token at all, not yours").
// Taking out his four token variables is not enough: gh still finds his stored sign-in in ~/.config/gh, and git still
// asks his credential helper for github.com. So the blank sign-in also points gh at an empty folder of her own and
// clears git's helper for the host. (herSignedEnv, src/assistant/hersignin.mjs.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { herSignedEnv } from '../../src/assistant/hersignin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a chosen sign-in file that cannot be read cuts off every sign-in of the owner, not only his token variables', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hersignin-unread-')));
  try {
    const credsDir = path.join(root, 'credentials');
    // The chosen file's folder exists (with its own private rights) but the file itself does not: readHerToken throws.
    fs.mkdirSync(path.join(credsDir, 'github'), { recursive: true, mode: 0o700 });
    const cfg = { server: { herGitSignin: { file: 'github/missing.token' } } };
    const his = { GH_TOKEN: 'his-own', GITHUB_TOKEN: 'his-own', GH_ENTERPRISE_TOKEN: 'his-ent', GITHUB_ENTERPRISE_TOKEN: 'his-ent', PATH: '/usr/bin' }; // seal: input to herSignedEnv, a pure function that starts no program
    let problem = null;
    const out = herSignedEnv(his, { byTia: true, cfg, credsDir, onProblem: (w) => (problem = w) });

    assert.ok(problem, 'onProblem was told the file could not be read');
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) assert.equal(out[k], 'none', `his ${k} is taken out, a placeholder in its place`);
    assert.ok(!JSON.stringify(out).includes('his-own') && !JSON.stringify(out).includes('his-ent'), 'none of his token is left in her environment');

    // gh is pointed at an EMPTY folder of her own, never his ~/.config/gh.
    assert.ok('GH_CONFIG_DIR' in out, 'gh is pointed away from his own stored sign-in');
    assert.notEqual(out.GH_CONFIG_DIR, path.join(os.homedir(), '.config', 'gh'), 'not his own gh folder');
    assert.ok(fs.statSync(out.GH_CONFIG_DIR).isDirectory(), 'the folder gh is pointed at exists');
    assert.equal(fs.readdirSync(out.GH_CONFIG_DIR).length, 0, 'and it is empty: no stored sign-in there');
    if (process.platform !== 'win32') assert.equal(fs.statSync(out.GH_CONFIG_DIR).mode & 0o777, fs.statSync(path.join(credsDir, 'github')).mode & 0o777, 'made no more open than the folder the token lives in');

    // git's credential helper for github.com is cleared with an empty value (which resets the host's helper list).
    const keys = Object.keys(out).filter((k) => /^GIT_CONFIG_KEY_\d+$/.test(k));
    const cleared = keys.some((k) => out[k] === 'credential.https://github.com.helper' && out[`GIT_CONFIG_VALUE_${k.slice('GIT_CONFIG_KEY_'.length)}`] === '');
    assert.ok(cleared, "git's credential helper for github.com is cleared");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// gh looks for a token in GH_TOKEN/GITHUB_TOKEN (GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN for another host) before
// anything it has stored, and only with none set asks its stored sign-in, which `gh auth login` keeps in the system's
// keyring by default. The blank sign-in puts a placeholder that is not a token in all four, so gh in her session fails
// with a sign-in error and never reaches the keyring (a stand-in gh shows it: hersignin-keyring.test.mjs). The page
// says that, and no longer names a keyring limit; were the placeholder taken out, the page would be wrong again.
test('the blank sign-in gives gh a placeholder, and the page says gh in her session fails and never uses his sign-in', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hersignin-keyring-')));
  try {
    const credsDir = path.join(root, 'credentials');
    fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
    const cfg = { server: { herGitSignin: { file: 'missing.token' } } };
    const out = herSignedEnv({ GH_TOKEN: 'his-own', PATH: '/usr/bin' }, { byTia: true, cfg, credsDir, onProblem: () => {} }); // seal: input to herSignedEnv, a pure function that starts no program
    const page = fs.readFileSync(path.join(ROOT, 'docs', 'OPERATOR.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(page, /If the file cannot be read, her sessions get no token at all, not yours\./);
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) assert.equal(out[k], 'none', `${k} is a placeholder, never his token`);
    assert.match(page, /There `gh` in her session gets a value that is not a token, so it fails with a sign-in error and never uses yours, also where `gh auth login` kept your own sign-in in the system's keyring \(it does that by default where the system has one, such as the Keychain on a Mac\)\./);
    assert.doesNotMatch(page, /One limit: where `gh auth login` kept your own sign-in in the system's keyring/, 'the keyring limit is gone from the page');
    assert.doesNotMatch(page, /`gh` in her session can still find it there/, 'the keyring limit is gone from the page');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
