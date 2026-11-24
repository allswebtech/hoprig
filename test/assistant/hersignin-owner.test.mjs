// A session of the OWNER's own (byTia false) is not changed by a letter by Tia's git sign-in, whatever he chose for
// HER sessions: no file, a readable file, or a file that cannot be read. herSignedEnv must return his own environment
// itself — the same object, untouched — so his sessions keep his full sign-in and the blank sign-in (which only his
// token-less, helper-cleared her-sessions get) never reaches him. (src/assistant/hersignin.mjs, herSignedEnv.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { herSignedEnv } from '../../src/assistant/hersignin.mjs';

test('a session of the owner\'s own is returned unchanged, with any sign-in file chosen for her sessions', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hersignin-owner-')));
  try {
    const credsDir = path.join(root, 'credentials');
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(path.join(credsDir, 'token'), 'ghp_her_token\n');
    const his = { HOME: root, GH_TOKEN: 'ghp_HIS_own', GITHUB_TOKEN: 'ghp_HIS_own', GH_ENTERPRISE_TOKEN: 'his-ent', GIT_ASKPASS: '/his/askpass', GH_CONFIG_DIR: '/his/.config/gh', PATH: '/usr/bin' }; // seal: input to herSignedEnv, a pure function that starts no program
    const onProblem = () => { throw new Error('the owner\'s own session must not be touched'); };
    // No file chosen, a readable file chosen, and a file that cannot be read: his session is identical every time.
    for (const cfg of [{}, { server: { herGitSignin: { file: 'token' } } }, { server: { herGitSignin: { file: 'gone' } } }]) {
      const out = herSignedEnv(his, { byTia: false, cfg, credsDir, onProblem });
      assert.equal(out, his, 'his own environment itself is returned, not even a copy');
    }
    // And his keys are all still there, with his values.
    assert.deepEqual(his, { HOME: root, GH_TOKEN: 'ghp_HIS_own', GITHUB_TOKEN: 'ghp_HIS_own', GH_ENTERPRISE_TOKEN: 'his-ent', GIT_ASKPASS: '/his/askpass', GH_CONFIG_DIR: '/his/.config/gh', PATH: '/usr/bin' }); // seal: expected value of a pure function's output; starts no program
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
