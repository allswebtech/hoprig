// The dashboard's commands print their usage for --help ("hoprig serve --help" said only "unknown option --help"), and
// change nothing. The skill's command reference asks the commands for their help (tools/build-skill.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealed } from '../seal.mjs';

const BIN = fileURLToPath(new URL('../../bin/hoprig.mjs', import.meta.url));

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'help-test-'));
  const env = sealed({
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    HOPRIG_CONFIG_DIR: path.join(home, 'config'), HOPRIG_STATE_DIR: path.join(home, 'state'),
    HOPRIG_WORKSPACE_DIR: path.join(home, 'ws'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    // A dashboard that starts anyway must not take a port another test uses.
    PORT: '0',
  });
  const r = spawnSync(process.execPath, [BIN, ...args], { env, cwd: home, input: '', timeout: 20_000, encoding: 'utf8' });
  const left = fs.readdirSync(home, { recursive: true });
  fs.rmSync(home, { recursive: true, force: true });
  return { ...r, left };
}

for (const args of [['serve', '--help'], ['passwd', '--help'], ['service', '-h']]) {
  test(`hoprig ${args.join(' ')} prints the usage and changes nothing`, () => {
    const r = run(args);
    assert.equal(r.error, undefined, `it did not end by itself (${r.error && r.error.code})`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^usage:\\n  hoprig ${args[0]}\\b`), 'that command\'s own lines');
    assert.deepEqual(r.left, [], 'nothing is written in the home');
  });
}
