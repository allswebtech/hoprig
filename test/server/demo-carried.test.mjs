// The demo's stand-in, carried on to another provider, names that provider by the label the page shows.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const standIn = fileURLToPath(new URL('../../src/demo/session.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('demo: a session carried on says "on Team plan", not the inner name', { skip: process.platform === 'win32' && 'POSIX only' }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-carried-')));
  const cwd = path.join(root, 'shop');
  const config = path.join(root, 'config');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(config, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(config, 'profiles', 'team.env'), 'LABEL="Team plan"\nCLAUDE_CODE_OAUTH_TOKEN=made-up-not-a-token\n');
  const env = { ...process.env, HOPRIG_STATE_DIR: path.join(root, 'state'), HOPRIG_CONFIG_DIR: config };
  delete env.HOPRIG_PROFILES_DIR;
  const child = spawn(process.execPath, [standIn, 'team', '--resume', '11111111-2222-4333-a444-555555555555'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  try {
    for (const end = Date.now() + 10_000; Date.now() < end && !/nothing was lost/.test(out); await sleep(50));
    const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.match(plain, /Picked up the conversation on Team plan; nothing was lost\./, plain);
    assert.doesNotMatch(plain, /"team"/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
