// A session page that was opened before an update keeps its old script until it is reloaded, and after a restart of
// the dashboard it connects to the new server. Its messages are those of the page before the paste frames: every key
// and every paste as ONE {t:'in', d} frame, never flagged as a paste, never cut. Here they meet the real server, on
// the built-in backend and on tmux, with a program that records every byte it reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { sandbox } from './helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (await fn()) return;
  throw new Error(`timed out waiting for ${what}`);
};
/** What the page of the integration head sent for typed keys and for a paste: one frame, no flag. */
const oldInput = (d) => JSON.stringify({ t: 'in', d });

async function dashboard(t, kind) {
  const box = sandbox('oldpage');
  const got = path.join(box.root, 'got');
  const prog = path.join(box.root, 'record.cjs');
  fs.writeFileSync(prog, `const fs = require('fs');\nprocess.stdin.setRawMode(true);\nprocess.stdout.write('\\x1b[?2004hREADY\\n');\nprocess.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(got)}, b));\nsetInterval(() => {}, 1000);\n`);
  const conf = path.join(box.root, 'empty.conf');
  fs.writeFileSync(conf, '');
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('test-password-1') } });
  const app = createServer({ tmuxSocket: `oldpage-${process.pid}`, tmuxConfigFile: conf, automation: { tick: false }, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const open = [];
  t.after(async () => {
    for (const w of open) w.terminate();
    await app.close();
    if (kind === 'tmux') {
      const sock = await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '');
      await app.backend.killServer();
      if (sock.trim()) fs.rmSync(sock.trim(), { force: true });
    }
    await app.backend.close();
    box.cleanup();
  });
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const connect = async (name) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term?name=${name}&cols=80&rows=24`, { headers: { Origin: base, Cookie: cookie } });
    open.push(ws);
    const out = { ws, screen: '', closed: null };
    ws.on('message', (d) => (out.screen += d.toString()));
    ws.on('close', (code) => (out.closed = code));
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('unexpected-response', (rq, res) => reject(new Error(`upgrade ${res.statusCode}`)));
    });
    return out;
  };
  const read = () => (fs.existsSync(got) ? fs.readFileSync(got, 'latin1').replace(/\x1b\[[IO]/g, '') : '');
  const answers = async () => (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status === 200;
  return { app, box, prog, read, connect, answers };
}

/** The same old page's messages on either backend; `name` is a session whose program records what it reads. */
async function oldPage(d, name) {
  const a = await d.connect(name);
  await until('the program', () => a.screen.includes('READY'));
  a.ws.send(oldInput('hi'));
  a.ws.send(oldInput('\x1b'));
  await until('typed keys', () => d.read() === 'hi\x1b');
  // Fifty lines pasted: one frame of about 3 KiB, under the server's 64 KiB, written as it comes (not held).
  const fifty = `\x1b[200~${Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\r')}\x1b[201~`;
  a.ws.send(oldInput(fifty));
  await until('the fifty lines', () => d.read() === `hi\x1b${fifty}`);
  // 100 KiB in one frame: over the server's 64 KiB, under the socket's 128 KiB: dropped, as before the update; the
  // socket stays and the next key arrives.
  a.ws.send(oldInput(`\x1b[200~${'A'.repeat(100 << 10)}\x1b[201~`));
  a.ws.send(oldInput('k'));
  await until('the key after the dropped paste', () => d.read().endsWith('k'));
  assert.equal(d.read(), `hi\x1b${fifty}k`, 'nothing of the 100 KiB paste, as before');
  assert.equal(a.closed, null);
  // A megabyte in one frame: the socket refuses it and closes (1009) that terminal only; the dashboard answers (the
  // server before the update ended there, every terminal and page with it).
  a.ws.send(oldInput(`\x1b[200~${'B'.repeat(1 << 20)}\x1b[201~`));
  await until('the socket closed', () => a.closed !== null);
  assert.equal(a.closed, 1009, 'too big');
  assert.ok(await d.answers(), 'the dashboard still answers');
  // The old page connects again on any code but 4000 ("session ended"), and its keys arrive.
  const b = await d.connect(name);
  await wait(300);
  b.ws.send(oldInput('z'));
  await until('a key after the reconnect', () => d.read().endsWith('z'));
  assert.equal(d.read(), `hi\x1b${fifty}kz`, 'no byte of the megabyte paste reached the program');
  return b;
}

test('a page still on the old script, against the new server on the built-in backend', { skip: process.platform === 'win32' && 'POSIX pseudo-terminal', timeout: 60_000 }, async (t) => {
  const d = await dashboard(t, 'pty');
  await d.app.backend.create({ name: 'rec', dir: d.box.root, argv: [process.execPath, d.prog] });
  const b = await oldPage(d, 'rec');
  b.ws.close();
});

test('a page still on the old script and a tmux session started by the old version, against the new server', { skip: (!tmuxUsable() || process.platform === 'win32') && 'no tmux 3.2 or newer here', timeout: 60_000 }, async (t) => {
  const d = await dashboard(t, 'tmux');
  // What the old version made: the session and its status line off, no terminal title of the program's own.
  const id = (await d.app.backend.run(['new-session', '-d', '-s', 'rec', '-x', '80', '-y', '24', '-P', '-F', '#{pane_id}', process.execPath, d.prog])).trim();
  await d.app.backend.run(['set-option', '-t', id, 'status', 'off']);
  const b = await oldPage(d, 'rec');
  // The new attach doubles tmux's prefix for this session too (it asks tmux at every attach): the old page's
  // Ctrl+B and the key after it reach the program, not tmux.
  b.ws.send(oldInput('\x02'));
  await wait(200);
  b.ws.send(oldInput('x'));
  await until('Ctrl+B and x', () => d.read().endsWith('\x02x'));
  assert.match(await d.app.backend.run(['list-panes', '-t', '=rec', '-F', '#{pane_dead}']), /^0$/m, 'no tmux command ran (x would ask to kill the pane)');
  // The title is set when a session starts: one from the old version keeps tmux's default and the page shows the
  // session's name alone, until the session is started again.
  assert.equal((await d.app.backend.run(['display-message', '-p', '-t', '=rec', '#{set-titles}'])).trim(), '0', 'set-titles off (tmux prints a boolean option as 0)');
  b.ws.close();
});
