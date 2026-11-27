// A tmux session made outside the dashboard with a command of its own (a launcher line with a first message, typed
// as `tmux new-session '<line>'`) is adopted like any other. A respawn of its pane (Continue here, a move, a restart in
// place) must start the pane's shell, never that creation command again: tmux's respawn-pane without a command runs
// the command the pane was created with, and a launcher with a first message started a new conversation each time.
// Real tmux on a socket of this test's own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('respawnadopted');
process.env.HOME = box.home; // the respawned login shell reads its start files from here
process.env.SHELL = '/bin/bash';
for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete process.env[k];
const { tmuxUsable } = await import('../../src/server/backends/index.mjs');
const { TmuxBackend } = await import('../../src/server/backends/tmux.mjs');
const usable = process.platform !== 'win32' && tmuxUsable();
test.after(() => box.cleanup());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await fn()) return;
  throw new Error(`timed out waiting for ${what}`);
}

test('tmux: a respawn of a pane created with a command of its own starts a shell, never that command again', { timeout: 60_000, skip: !usable && 'no tmux 3.2 or newer here' }, async (t) => {
  const socket = `hoprig-adopted-${process.pid}`;
  const conf = path.join(box.root, `${socket}.conf`);
  fs.writeFileSync(conf, 'set -g default-shell /bin/bash\n');
  const b = new TmuxBackend({ socket, configFile: conf });
  t.after(async () => {
    const sock = await b.run(['display', '-p', '#{socket_path}']).catch(() => '');
    await b.killServer().catch(() => {});
    if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
  });
  const dir = path.join(box.root, 'project');
  fs.mkdirSync(dir);
  const starts = path.join(box.root, 'starts.txt'); // one line each time the creation command runs
  const typed = path.join(box.root, 'typed.txt'); // made by the line the respawn types into the new shell
  // As a launcher line with a first message would: it runs, and it holds the pane.
  await b.run(['new-session', '-d', '-s', 'adopted', '-c', dir, `echo started >> ${starts}; exec sleep 300`]);
  const runs = () => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0);
  await until('the creation command', () => runs() === 1);
  const [pane] = (await b.list()).filter((p) => p.session === 'adopted');
  assert.ok(pane, 'the adopted session is listed');

  await b.respawn(pane.id, dir, ['touch', typed]);
  await until('the typed line in the new shell', () => fs.existsSync(typed));
  await wait(500); // a creation command run again would have written by now
  assert.equal(runs(), 1, 'the command the pane was created with did not run again');
  const [after] = (await b.list()).filter((p) => p.id === pane.id);
  assert.equal(after.command, 'bash', 'the pane runs its shell');

  // A second respawn (a later move) still starts the shell.
  fs.rmSync(typed);
  await b.respawn(pane.id, dir, ['touch', typed]);
  await until('the typed line after a second respawn', () => fs.existsSync(typed));
  await wait(500);
  assert.equal(runs(), 1, 'still one run of the creation command');
});
