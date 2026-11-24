// The demo's stand-in for Claude Code, run by itself in a folder of its story: a question answered from the message
// box (the number, then the Enter the page sends after it) leaves the session waiting, with no turn nobody asked for.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const standIn = fileURLToPath(new URL('../../src/demo/session.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('demo: the bookshop question answered with "2" and then Enter starts no turn', { skip: process.platform === 'win32' && 'POSIX only' }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-session-')));
  const cwd = path.join(root, 'bookshop');
  fs.mkdirSync(cwd);
  const state = path.join(root, 'state');
  const child = spawn(process.execPath, [standIn, 'max'], { cwd, env: { ...process.env, HOPRIG_STATE_DIR: state }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const until = async (re, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (re.test(out)) return;
    throw new Error(`not seen: ${re}\n${out}`);
  };
  try {
    await until(/Enter to confirm/);
    child.stdin.write('2');
    await until(/External imports are allowed/);
    child.stdin.write('\r');
    await sleep(2500); // a turn reads README.md within a second
    const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.doesNotMatch(plain, /> continue/, plain);
    assert.doesNotMatch(plain, /README\.md|npm test/, 'no work started');
    const runs = fs.readdirSync(path.join(state, 'runs')).filter((f) => f.endsWith('.json'));
    const run = JSON.parse(fs.readFileSync(path.join(state, 'runs', runs[0]), 'utf8'));
    assert.equal(run.status, 'waiting');
    // A message typed after it is still answered.
    child.stdin.write('add a cart page\r');
    await until(/Done: add a cart page/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
