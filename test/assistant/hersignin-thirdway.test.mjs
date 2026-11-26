// Third ways to the owner's GitHub sign-in over https, proven CLOSED with real git in a temporary home (git is allowed
// by the suite's seal) and stand-in programs of this test's own that record when they are asked. The blank sign-in
// herSignedEnv hands a session of hers when the chosen file cannot be read must shut:
//   - a git credential helper of his, the HOST-specific one AND an unscoped `credential.helper` (git's empty
//     `credential.https://github.com.helper` resets the host's whole helper list, the generic one included);
//   - a GIT_ASKPASS/SSH_ASKPASS/core.askPass of his that would hand back his password;
//   - gh reading his stored sign-in (it is pointed at an empty folder of her own; a stand-in gh prints the
//     GH_CONFIG_DIR it was given).
// The baseline run (his own environment, no blank sign-in) shows the leak is real before the fix closes it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { herSignedEnv } from '../../src/assistant/hersignin.mjs';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const sh = (p, body) => { fs.writeFileSync(p, body, { mode: 0o755 }); return p; };

function fillGithub(env) {
  const r = spawnSync(realGit, ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('the blank sign-in shuts every https way to the owner\'s GitHub sign-in: helper (host and unscoped) and askpass', { skip: process.platform === 'win32' && 'the stand-ins are shell scripts' }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hersignin-third-')));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // A stand-in credential helper of his: on "get" it records it was asked, then hands back a sign-in.
    const helper = sh(path.join(bin, 'his-helper.sh'), '#!/bin/sh\nif [ "$1" = get ]; then echo asked >> "$MARKER"; printf \'username=owner\\npassword=OWNER_SECRET\\n\'; fi\n');
    // A stand-in askpass of his: records it was asked, then answers with his secret.
    const askpass = sh(path.join(bin, 'his-askpass.sh'), '#!/bin/sh\necho asked >> "$AMARKER"\necho OWNER_SECRET\n');
    // A stand-in gh FIRST on PATH that only prints the GH_CONFIG_DIR it was handed (never the real gh).
    const gh = sh(path.join(bin, 'gh'), '#!/bin/sh\necho "GH_CONFIG_DIR=$GH_CONFIG_DIR"\n');

    // His own git global config: an UNSCOPED credential.helper (fires for every host, github.com included).
    const ownerConfig = path.join(root, 'his.gitconfig');
    fs.writeFileSync(ownerConfig, `[credential]\n\thelper = "${helper}"\n`);

    // The folder the chosen file would live in exists, but the file does not: her session signs in as nobody.
    const credsDir = path.join(root, 'credentials');
    fs.mkdirSync(path.join(credsDir, 'github'), { recursive: true, mode: 0o700 });
    const cfg = { server: { herGitSignin: { file: 'github/missing.token' } } };

    const base = {
      HOME: root,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, // seal: git and gh are started by full path; this keeps the runner's PATH and its traps after the stand-in bin
      GIT_CONFIG_GLOBAL: ownerConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GH_TOKEN: 'his-token',
      GIT_ASKPASS: askpass,
    };
    const out = herSignedEnv(base, { byTia: true, cfg, credsDir, onProblem: () => {} });

    // Baseline: his own environment DOES reach his sign-in (so the leak the fix closes is real).
    const m1 = path.join(root, 'm1');
    const a1 = path.join(root, 'a1');
    const before = fillGithub({ ...base, MARKER: m1, AMARKER: a1 });
    assert.ok(fs.existsSync(m1), 'baseline: his credential helper was asked');
    assert.match(before.out, /OWNER_SECRET/, 'baseline: his sign-in was handed back');

    // Fixed: the blank sign-in reaches NOTHING of his.
    const m2 = path.join(root, 'm2');
    const a2 = path.join(root, 'a2');
    const after = fillGithub({ ...out, MARKER: m2, AMARKER: a2 });
    assert.ok(!fs.existsSync(m2), 'his credential helper (host-specific AND unscoped) is not asked');
    assert.ok(!fs.existsSync(a2), 'his GIT_ASKPASS is not asked');
    assert.ok(!/OWNER_SECRET/.test(after.out), 'none of his sign-in is handed back');
    assert.notEqual(after.status, 0, 'git cannot sign in: it fails rather than falling back to his');

    // gh is pointed at an empty folder of her own; the stand-in gh confirms the GH_CONFIG_DIR it is given.
    const ghRun = spawnSync(gh, ['auth', 'status'], { env: out, encoding: 'utf8' });
    assert.match(ghRun.stdout, new RegExp(`GH_CONFIG_DIR=${out.GH_CONFIG_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'gh is handed her empty folder');
    assert.ok(fs.statSync(out.GH_CONFIG_DIR).isDirectory() && fs.readdirSync(out.GH_CONFIG_DIR).length === 0, 'and that folder is empty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
