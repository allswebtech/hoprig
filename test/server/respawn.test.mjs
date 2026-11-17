// A respawn of a terminal (a move to another provider, "Continue here" in a chat) ends what runs in it while its
// terminal is still open, and only then starts the new command; on tmux and on the built-in terminals. The program in
// the terminal is a small launcher (it forwards SIGHUP and waits for its child, as src/launch.mjs does) with a child
// that reads the terminal and takes a moment to end (as Claude Code saves on its way out). With the terminal closed
// first (tmux respawn-pane -k alone, or the built-in terminal's shell ended first), the child ends after the new
// command has started, and on Node 20 it aborts on its way out instead: Node 20 cannot set back a terminal that is gone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { PtyBackend } from '../../src/server/backends/pty.mjs';
import { TmuxBackend } from '../../src/server/backends/tmux.mjs';

const box = sandbox('respawn');
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
readline.createInterface({ input: process.stdin }).on('line', () => {});
process.on('SIGHUP', () => setTimeout(() => process.exit(0), 300));
fs.writeFileSync(process.argv[2], '');
`;
const PARENT = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [child, out] = process.argv.slice(2);
const p = spawn(process.execPath, [child, out + '.ready'], { stdio: 'inherit' });
process.on('SIGHUP', () => p.kill('SIGHUP'));
p.on('exit', (code, signal) => {
  fs.writeFileSync(out, JSON.stringify({ code, signal }));
  process.exit(0);
});
`;

for (const kind of ['tmux', 'pty']) {
  const skip = process.platform === 'win32' ? 'POSIX terminals' : kind === 'tmux' && !tmuxUsable() && 'no tmux 3.2 or newer here';
  test(`a respawn ends the programs in the terminal, with their terminal open, before the new command starts (${kind})`, { skip }, async (t) => {
    const dir = fs.mkdtempSync(path.join(box.root, `${kind}-`));
    const child = path.join(dir, 'child.mjs');
    const parent = path.join(dir, 'parent.mjs');
    fs.writeFileSync(child, CHILD);
    fs.writeFileSync(parent, PARENT);
    const out = path.join(dir, 'ended.json');
    const next = path.join(dir, 'next-started');
    let b;
    if (kind === 'tmux') {
      const conf = path.join(dir, 'empty.conf'); // so the user's tmux.conf does not apply
      fs.writeFileSync(conf, '');
      b = new TmuxBackend({ socket: `respawn-test-${process.pid}`, configFile: conf });
      t.after(async () => {
        const sock = await b.run(['display', '-p', '#{socket_path}']).catch(() => '');
        await b.killServer();
        if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
      });
    } else {
      b = new PtyBackend();
      t.after(() => b.close());
    }

    const { id } = await b.create({ name: 'moving', dir, argv: [process.execPath, parent, child, out] });
    await until('the program in the terminal', () => fs.existsSync(`${out}.ready`));
    await b.respawn(id, dir, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(next)}, '')`]);
    // When the respawn is done the old programs have ended, and ended by themselves.
    assert.ok(fs.existsSync(out), 'the old programs had ended before the new command was typed');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { code: 0, signal: null });
    await until('the new command', () => fs.existsSync(next));
    // The terminal itself stays, under the same id.
    assert.ok((await b.list()).some((p) => p.id === id && p.session === 'moving'));
  });
}
