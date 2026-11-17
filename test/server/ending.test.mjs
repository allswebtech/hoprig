// A respawn of a terminal (a move to another provider, "Continue here" in a chat) and a Close end what runs in it
// while its terminal is still open, and only then start the new command or close the terminal; on tmux and on the
// built-in terminals. The program in the terminal is a small launcher (it forwards SIGHUP and waits for its child, as
// src/launch.mjs does) with a child that reads the terminal and takes a moment to end (as Claude Code saves on its way
// out); the child writes to the terminal on its way out, and exits 3 when that fails (the terminal is gone). With the
// terminal closed first (tmux respawn-pane -k or kill-session alone, or the built-in terminal's shell ended first), the
// child ends after the new command has started or the Close has returned, and on Node 20 it aborts on its way out
// instead: Node 20 cannot set back a terminal that is gone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { STOP_WAIT_MS } from '../../src/server/backends/proctree.mjs';
import { PtyBackend } from '../../src/server/backends/pty.mjs';
import { TmuxBackend } from '../../src/server/backends/tmux.mjs';

const box = sandbox('ending');
test.after(() => box.cleanup());

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const CHILD = `
import fs from 'node:fs';
import readline from 'node:readline';
const [ready, ms] = process.argv.slice(2);
readline.createInterface({ input: process.stdin }).on('line', () => {});
process.on('SIGHUP', () => setTimeout(() => {
  try {
    fs.writeSync(1, 'saved\\r\\n');
  } catch {
    process.exit(3);
  }
  process.exit(0);
}, Number(ms)));
fs.writeFileSync(ready, '');
`;
const PARENT = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [child, out, ms] = process.argv.slice(2);
fs.writeFileSync(out + '.pid', String(process.pid));
const p = spawn(process.execPath, [child, out + '.ready', ms], { stdio: 'inherit' });
process.on('SIGHUP', () => p.kill('SIGHUP'));
p.on('exit', (code, signal) => {
  fs.writeFileSync(out, JSON.stringify({ code, signal }));
  process.exit(0);
});
`;

/** A backend of `kind` and a terminal "moving" running the launcher stand-in whose child takes `ms` to end. */
async function setup(t, kind, ms) {
  const dir = fs.mkdtempSync(path.join(box.root, `${kind}-`));
  const child = path.join(dir, 'child.mjs');
  const parent = path.join(dir, 'parent.mjs');
  fs.writeFileSync(child, CHILD);
  fs.writeFileSync(parent, PARENT);
  const out = path.join(dir, 'ended.json');
  let b;
  if (kind === 'tmux') {
    const conf = path.join(dir, 'empty.conf'); // so the user's tmux.conf does not apply
    fs.writeFileSync(conf, '');
    b = new TmuxBackend({ socket: `ending-test-${process.pid}-${path.basename(dir)}`, configFile: conf });
    t.after(async () => {
      const sock = await b.run(['display', '-p', '#{socket_path}']).catch(() => '');
      await b.killServer();
      if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
    });
  } else {
    b = new PtyBackend();
    t.after(() => b.close());
  }
  const { id } = await b.create({ name: 'moving', dir, argv: [process.execPath, parent, child, out, String(ms)] });
  await until('the program in the terminal', () => fs.existsSync(`${out}.ready`));
  const ended = () => {
    assert.ok(fs.existsSync(out), 'the old programs had ended before the call returned');
    // Ended by themselves, and their terminal was still there on their way out.
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { code: 0, signal: null });
  };
  return { b, id, dir, out, ended, launcher: () => Number(fs.readFileSync(`${out}.pid`, 'utf8')) };
}

const next = (dir) => {
  const file = path.join(dir, 'next-started');
  return { file, argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, '')`] };
};

for (const kind of ['tmux', 'pty']) {
  const skip = process.platform === 'win32' ? 'POSIX terminals' : kind === 'tmux' && !tmuxUsable() && 'no tmux 3.2 or newer here';

  test(`a respawn ends the programs in the terminal, with their terminal open, before the new command starts (${kind})`, { skip }, async (t) => {
    const { b, id, dir, ended } = await setup(t, kind, 300);
    const n = next(dir);
    await b.respawn(id, dir, n.argv);
    ended();
    await until('the new command', () => fs.existsSync(n.file));
    // The terminal itself stays, under the same id.
    assert.ok((await b.list()).some((p) => p.id === id && p.session === 'moving'));
  });

  test(`a respawn waits longer for the process that holds the conversation, when it is the terminal's (${kind})`, { skip }, async (t) => {
    // A coding tool that takes longer than STOP_WAIT_MS to save: the move names its launcher, which ends after it.
    const { b, id, dir, ended, launcher } = await setup(t, kind, STOP_WAIT_MS + 600);
    const n = next(dir);
    const t0 = Date.now();
    await b.respawn(id, dir, n.argv, { hold: launcher() });
    assert.ok(Date.now() - t0 >= STOP_WAIT_MS + 500, 'waited past STOP_WAIT_MS');
    ended();
    await until('the new command', () => fs.existsSync(n.file));
  });

  test(`a Close ends the programs in the terminal, with their terminal open, before the terminal goes (${kind})`, { skip }, async (t) => {
    const { b, ended } = await setup(t, kind, 300);
    await b.kill('moving');
    ended();
    assert.ok(!(await b.list()).some((p) => p.session === 'moving'), 'the terminal is gone');
  });
}
