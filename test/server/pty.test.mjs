// The built-in pty backend against a stand-in for node-pty, so every OS's behaviour (Windows included) is checked
// on any OS. The real node-pty path is covered end to end in integration.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLEAR } from '../../src/server/backends/shell.mjs';
import test from 'node:test';
import { PtyBackend, bufferText, defaultShell, keySequence, pasteBytes, startPlan, termEnv } from '../../src/server/backends/pty.mjs';
import { createBackend, tmuxUsable } from '../../src/server/backends/index.mjs';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** Wait until fn() is true (the headless terminal parses output asynchronously; a loaded machine is slower). */
const waitFor = async (fn, what = 'condition') => {
  for (const end = Date.now() + 5000; Date.now() < end; await tick(10)) if (fn()) return;
  assert.fail(`timed out waiting for ${what}`);
};

/** A fake node-pty: records spawns, writes, resizes and kills; the test drives output and exit. */
function fakePty() {
  const procs = [];
  const spawn = (file, args, opts) => {
    const dataFns = [];
    const exitFns = [];
    const p = {
      file, args, opts, pid: 100 + procs.length, process: file, written: [], size: [opts.cols, opts.rows], killed: null, done: false,
      onData: (f) => dataFns.push(f),
      onExit: (f) => exitFns.push(f),
      write: (d) => p.written.push(d),
      resize: (c, r) => (p.size = [c, r]),
      kill: (sig) => {
        p.killed = sig || 'default';
        setImmediate(() => p.exit(0));
      },
      emit: (d) => dataFns.forEach((f) => f(d)),
      exit: (code) => {
        if (p.done) return;
        p.done = true;
        exitFns.forEach((f) => f({ exitCode: code }));
      },
    };
    procs.push(p);
    return p;
  };
  return { procs, spawn };
}

const backend = (platform, extra = {}) => {
  const f = fakePty();
  const b = new PtyBackend({ platform, spawn: f.spawn, ...extra });
  test.after(() => b.close());
  return { b, procs: f.procs };
};

test('start plans: POSIX types into a login shell, Windows runs argv directly and falls back to PowerShell', () => {
  const sh = { file: '/bin/zsh', args: ['-l'] };
  assert.deepEqual(startPlan({ platform: 'darwin', dir: '/w d', argv: ['/n', 'x y'], shell: sh }), {
    file: '/bin/zsh', args: ['-l'], cwd: '/w d', type: `${CLEAR}; /n 'x y'`, then: null,
  }, 'the shell starts in the folder; nothing of it is typed');
  assert.throws(() => startPlan({ platform: 'linux', dir: '/w', argv: ['/n', "it's"], shell: sh }), (e) => e.status === 400 && /cannot type this path into a shell/.test(e.message));
  assert.throws(() => startPlan({ platform: 'win32', dir: 'C:\\w', argv: ['C:\\n.exe', 'a"b'] }), (e) => e.status === 400, 'Windows: no quote in its one command line');
  assert.equal(startPlan({ platform: 'linux', dir: '/w', shell: sh }).type, null, 'a plain shell types nothing');
  const win = startPlan({ platform: 'win32', dir: 'C:\\Users\\me\\proj', argv: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\app\\bin\\x.mjs', 'work', '--resume', 'id'] });
  assert.deepEqual(win, {
    file: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\app\\bin\\x.mjs', 'work', '--resume', 'id'], cwd: 'C:\\Users\\me\\proj',
    type: null, then: { file: 'powershell.exe', args: ['-NoLogo'] },
  });
  assert.deepEqual(startPlan({ platform: 'win32', dir: 'C:\\w' }), { file: 'powershell.exe', args: ['-NoLogo'], cwd: 'C:\\w', type: null, then: null });
  assert.deepEqual(defaultShell('linux', { SHELL: '/usr/bin/fish' }), { file: '/usr/bin/fish', args: ['-l'] });
  assert.deepEqual(defaultShell('darwin', {}), { file: '/bin/zsh', args: ['-l'] });
  assert.deepEqual(defaultShell('linux', {}), { file: '/bin/sh', args: ['-l'] });
});

test('terminal environment: its own id, no tmux leak, a UTF-8 locale when none is set', () => {
  const e = termEnv('pty-1', 'linux', { PATH: '/bin', TMUX: '/tmp/t,1,0', TMUX_PANE: '%3' }); // seal: a value no program is started with
  assert.equal(e.HOPRIG_TERM_ID, 'pty-1');
  assert.equal(e.TMUX, undefined);
  assert.equal(e.TMUX_PANE, undefined);
  assert.equal(e.COLORTERM, 'truecolor');
  assert.equal(e.LC_CTYPE, 'C.UTF-8');
  assert.equal(termEnv('x', 'darwin', {}).LC_CTYPE, 'UTF-8');
  assert.equal(termEnv('x', 'linux', { LANG: 'de_DE.UTF-8' }).LC_CTYPE, undefined, 'a set locale is kept');
  assert.equal(termEnv('x', 'win32', {}).LC_CTYPE, undefined);
});

test('keys and pastes', () => {
  assert.equal(keySequence('Up'), '\x1b[A');
  assert.equal(keySequence('Up', true), '\x1bOA', 'application cursor keys');
  assert.equal(keySequence('BTab'), '\x1b[Z');
  assert.equal(keySequence('C-c'), '\x03');
  assert.throws(() => keySequence('C-b'), /unknown key/);
  assert.equal(pasteBytes('one line', true), 'one line', 'one line is typed, never bracketed');
  assert.equal(pasteBytes('a\nb', false), 'a\rb');
  assert.equal(pasteBytes('a\nb', true), '\x1b[200~a\rb\x1b[201~');
  assert.equal(pasteBytes('a\x1b[201~\nrm -rf ~', true), '\x1b[200~a\rrm -rf ~\x1b[201~', 'the text cannot end the paste early');
});

test('POSIX: create, type, list, bracketed paste only when the program asks, keys in cursor mode', async () => {
  const { b, procs } = backend('linux', { shell: { file: '/bin/bash', args: ['-l'] } });
  const { name, id } = await b.create({ name: 'proj', dir: '/w', argv: ['/n', 'work'] });
  assert.equal(name, 'proj');
  assert.match(id, /^pty-[0-9a-f]{12}$/);
  const p = procs[0];
  assert.equal(p.file, '/bin/bash');
  assert.equal(p.opts.cwd, '/w');
  assert.equal(p.opts.env.HOPRIG_TERM_ID, id);
  assert.deepEqual(p.written, [`${CLEAR}; /n work\r`]);
  await assert.rejects(b.create({ name: 'proj', dir: '/w' }), /duplicate/);
  await assert.rejects(b.create({ name: '-x', dir: '/w' }), /bad session name/);

  const [t] = await b.list();
  assert.equal(t.session, 'proj');
  assert.equal(t.id, id);
  assert.equal(t.pid, p.pid);
  assert.equal(t.cwd, '/w');
  assert.equal(t.dead, false);

  p.written.length = 0;
  await b.sendText(id, 'two\nlines');
  assert.deepEqual(p.written, ['two\rlines']);
  p.emit('\x1b[?2004h\x1b[?1h');
  p.written.length = 0;
  await b.sendText(id, 'two\nlines');
  await b.sendKey(id, 'Up');
  assert.deepEqual(p.written, ['\x1b[200~two\rlines\x1b[201~', '\x1bOA']);
  await assert.rejects(b.sendKey(id, 'F13'), /unknown key/);
  await assert.rejects(b.sendText('pty-nope', 'x'), /no terminal/);
  await b.scroll(id, 'up', 3); // the browser scrolls by itself
  await assert.rejects(b.scroll(id, 'sideways'), /unknown scroll/);
  assert.deepEqual(b.capabilities, { nativeScrollback: true, persistent: false });
});

test('capture: plain text of history and screen, wrapped rows joined', async () => {
  const { b, procs } = backend('linux');
  const { id } = await b.create({ name: 'c', dir: '/w', cols: 10, rows: 4 });
  procs[0].emit('\x1b[31mred\x1b[0m line\r\n' + 'abcdefghijKLMNOP\r\n' + Array.from({ length: 30 }, (_, i) => `n${i}`).join('\r\n'));
  const all = await b.capture(id, 100);
  assert.ok(all.startsWith('red line\nabcdefghijKLMNOP\nn0\n'), JSON.stringify(all));
  assert.equal(await b.capture(id, 2), 'n28\nn29\n');
});

test('attach: a later browser gets the current screen first, then live output; size follows the newest browser', async () => {
  const { b, procs } = backend('darwin');
  await b.create({ name: 's', dir: '/w' });
  const p = procs[0];
  p.emit('before \x1b[38;2;255;100;0mcolour\x1b[0m 漢字🙂\r\n');
  const one = b.attach('s', { cols: 100, rows: 30 });
  let a = '';
  one.onData((d) => (a += d));
  await waitFor(() => a.includes('before'), 'the first snapshot');
  assert.match(a, /before \x1b\[38;2;255;100;0mcolour/);
  assert.deepEqual(p.size, [100, 30]);
  const two = b.attach('s', { cols: 50, rows: 20 });
  let c = '';
  two.onData((d) => (c += d));
  await waitFor(() => c.includes('before'), 'the second snapshot');
  assert.ok(c.includes('漢字🙂'), 'the second browser sees the screen as it is');
  assert.deepEqual(p.size, [50, 20]);
  p.emit('live\r\n');
  assert.ok(a.endsWith('live\r\n') && c.endsWith('live\r\n'), 'both get live output');
  two.write('typed');
  assert.equal(p.written.at(-1), 'typed');
  assert.equal((await b.list())[0].attached, 2);
  two.close();
  assert.equal((await b.list())[0].attached, 1);

  // a browser that falls far behind gets a fresh screen instead of megabytes of backlog
  one.pause();
  p.emit('x'.repeat(3 << 20));
  p.emit('\r\nend');
  a = '';
  one.resume();
  await waitFor(() => a.includes('end'), 'the fresh screen');
  assert.ok(a.startsWith('\x1bc'), 'reset first');
  assert.ok(a.length < 1 << 20 && a.includes('end'), 'then the current screen');
  // a short pause just holds the output back
  one.pause();
  p.emit('held');
  a = '';
  assert.equal(a, '');
  one.resume();
  assert.equal(a, 'held');
  one.close();
});

test('attach: a program that took the mouse with SGR reports gets them again after a reload', async () => {
  const { b, procs } = backend('linux');
  await b.create({ name: 'm', dir: '/w' });
  const p = procs[0];
  const snapshot = async () => {
    const s = b.attach('m', {});
    let d = '';
    s.onData((x) => (d += x));
    await waitFor(() => d.includes('ready'), 'the snapshot');
    s.close();
    return d;
  };
  p.emit('\x1b[?1049h\x1b[?1003h\x1b[?1006hready');
  const one = await snapshot();
  assert.ok(one.includes('\x1b[?1003h') && one.includes('\x1b[?1006h'), 'the mouse mode and its encoding');
  p.emit('\x1b[?1006l');
  assert.ok(!(await snapshot()).includes('\x1b[?1006h'), 'turned off again');
  p.emit('\x1b[?1006h\x1bcready');
  assert.ok(!(await snapshot()).includes('\x1b[?1006h'), 'a full reset ends it');
  p.emit('\x1b[?1000l\x1b[?1006hready');
  assert.ok((await snapshot()).includes('\x1b[?1006h'), 'asked for before tracking: kept for when the program turns it on');
});

test('the headless terminal answers queries only while no browser is attached', async () => {
  const { b, procs } = backend('linux');
  await b.create({ name: 'q', dir: '/w' });
  const p = procs[0];
  p.written.length = 0;
  p.emit('\x1b[6n');
  await waitFor(() => p.written.length > 0, 'the answer');
  assert.deepEqual(p.written, ['\x1b[1;1R']);
  const s = b.attach('q', {});
  s.onData(() => {});
  await tick();
  p.written.length = 0;
  p.emit('\x1b[6n');
  await tick();
  assert.deepEqual(p.written, [], 'the browser answers now');
  s.close();
});

test('respawn: same name and id, old process stopped, history cleared, new command started', async () => {
  const { b, procs } = backend('linux', { shell: { file: '/bin/sh', args: ['-l'] } });
  const { id } = await b.create({ name: 'r', dir: '/w', argv: ['/n', 'a'] });
  const s = b.attach('r', {});
  let seen = '';
  s.onData((d) => (seen += d));
  await tick(); // the snapshot (empty) first
  procs[0].emit("You've hit your limit\r\n");
  await b.respawn(id, '/w2', ['/n', 'b', '--resume', 'x']);
  assert.equal(procs[0].killed, 'SIGHUP');
  assert.equal(procs.length, 2);
  assert.equal(procs[1].opts.env.HOPRIG_TERM_ID, id);
  assert.deepEqual(procs[1].written, [`${CLEAR}; /n b --resume x\r`]);
  assert.equal(procs[1].opts.cwd, '/w2', 'the new shell starts in the folder');
  // A line that cannot be typed is refused before anything is stopped.
  await assert.rejects(b.respawn(id, '/w2', ['/n', '$(x)']), (e) => e.status === 400);
  assert.equal(procs.length, 2, 'nothing stopped, nothing started');
  await waitFor(() => seen.includes('\x1bc'), 'the reset in the browser');
  assert.ok(seen.indexOf('\x1bc') > seen.indexOf('hit your limit'), 'after the old output, in order');
  assert.doesNotMatch(await b.capture(id, 100), /limit/);
  const [t] = await b.list();
  assert.deepEqual([t.session, t.id, t.pid, t.cwd], ['r', id, procs[1].pid, '/w2']);
  procs[0].emit('late output of the old process');
  assert.doesNotMatch(await b.capture(id, 100), /late output/);
  s.close();
});

test('POSIX: when the shell exits the session ends and browsers are told', async () => {
  const { b, procs } = backend('linux');
  await b.create({ name: 'e', dir: '/w' });
  const s = b.attach('e', {});
  let ended = false;
  s.onExit(() => (ended = true));
  procs[0].exit(0);
  assert.equal(ended, true);
  assert.deepEqual(await b.list(), []);
  assert.throws(() => b.attach('e', {}), /no session/);
});

test('Windows: the command runs without a shell; when it ends the terminal stays, with PowerShell in it', async () => {
  const { b, procs } = backend('win32');
  const { id } = await b.create({ name: 'w', dir: 'C:\\proj', argv: ['C:\\node.exe', 'C:\\bin.mjs', 'work'] });
  assert.equal(procs[0].file, 'C:\\node.exe');
  assert.deepEqual(procs[0].args, ['C:\\bin.mjs', 'work']);
  assert.deepEqual(procs[0].written, [], 'nothing typed');
  procs[0].emit('claude says bye\r\n');
  procs[0].exit(3);
  assert.equal(procs.length, 2);
  assert.equal(procs[1].file, 'powershell.exe');
  assert.equal(procs[1].opts.cwd, 'C:\\proj');
  assert.equal(procs[1].opts.env.HOPRIG_TERM_ID, id);
  const text = await b.capture(id, 10);
  assert.match(text, /claude says bye/);
  assert.match(text, /node\.exe exited with code 3/);
  assert.equal((await b.list()).length, 1);
  // respawn on Windows: no SIGHUP (ConPTY ends the console's processes), argv again without a shell
  await b.respawn(id, 'C:\\proj', ['C:\\node.exe', 'C:\\bin.mjs', 'backup', '--resume', 'x']);
  assert.equal(procs[1].killed, 'default');
  assert.deepEqual(procs[2].args, ['C:\\bin.mjs', 'backup', '--resume', 'x']);
  // the fallback shell exiting ends the terminal
  procs[2].exit(0);
  procs[3].exit(0);
  assert.deepEqual(await b.list(), []);
});

test('rename and kill', async () => {
  const { b, procs } = backend('linux');
  await b.create({ name: 'a', dir: '/w' });
  await b.create({ name: 'b', dir: '/w' });
  await assert.rejects(b.rename('a', 'b'), /duplicate/);
  await b.rename('a', 'c');
  assert.deepEqual((await b.list()).map((t) => t.session).sort(), ['b', 'c']);
  await b.kill('c');
  assert.equal(procs[0].killed, 'SIGHUP');
  assert.deepEqual((await b.list()).map((t) => t.session), ['b']);
  await assert.rejects(b.kill('c'), /no session/);
  await b.close();
  assert.equal(procs[1].killed, 'SIGHUP');
  assert.deepEqual(await b.list(), []);
});

test('bufferText trims trailing blank rows', async () => {
  const { b, procs } = backend('linux');
  const { id } = await b.create({ name: 't', dir: '/w', rows: 10 });
  procs[0].emit('only\r\n');
  assert.equal(await b.capture(id, 40), 'only\n');
  assert.equal(typeof bufferText, 'function');
});

test('createBackend: auto picks tmux when it runs, else pty; the kind can be forced', () => {
  const missing = path.join(os.tmpdir(), 'no-such-tmux-for-test'); // the test's own area, so the seal leaves it; it is simply not there
  assert.equal(tmuxUsable(missing), false);
  assert.equal(tmuxUsable('tmux', 'win32'), false, 'never on Windows');
  const auto = createBackend({ kind: 'auto', bin: missing });
  assert.equal(auto.kind, 'pty');
  auto.close();
  if (process.platform !== 'win32') {
    // a tmux too old to start a session the way the backend does is passed over, like a missing one
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'old-tmux-'));
    const old = path.join(dir, 'tmux');
    fs.writeFileSync(old, '#!/bin/sh\necho "tmux 3.1c"\n', { mode: 0o755 });
    assert.equal(tmuxUsable(old), false);
    const passed = createBackend({ kind: 'auto', bin: old });
    assert.equal(passed.kind, 'pty');
    passed.close();
    fs.writeFileSync(old, '#!/bin/sh\necho "tmux 3.2"\n', { mode: 0o755 });
    assert.equal(tmuxUsable(old), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const pty = createBackend({ kind: 'pty' });
  assert.equal(pty.kind, 'pty');
  pty.close();
  if (process.platform !== 'win32') {
    const t = createBackend({ kind: 'tmux', socket: 's' });
    assert.equal(t.kind, 'tmux');
    assert.deepEqual(t.capabilities, { nativeScrollback: false, persistent: true });
  }
  const dflt = createBackend({});
  assert.equal(dflt.kind, tmuxUsable() ? 'tmux' : 'pty');
  dflt.close();
  assert.throws(() => createBackend({ kind: 'screen' }), /unknown session backend/);
});

test('the processes a terminal started: a pid that is another process by the time of the signal gets none (Linux)', { skip: process.platform === 'win32' && 'a terminal\'s processes get SIGHUP, read from /proc: Windows has neither' }, async () => {
  const { spawn } = await import('node:child_process');
  const kid = () => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    test.after(() => c.kill('SIGKILL'));
    return c;
  };
  const gone = (c) => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', r)));
  // The system's answer about the pid: the start it had when collected, another one at the signal (its pid handed out
  // again), as procid.mjs would read them from /proc.
  const reused = kid();
  let asked = 0;
  const ident = { self: () => 'L:boot:1', of: (pids) => new Map(pids.map((p) => [p, `L:boot:${asked++ === 0 ? 1000 : 2000}`])) };
  const { b } = backend('linux', { descendants: async () => [reused.pid], ident });
  await b.create({ name: 'r', dir: '/w' });
  await b.kill('r');
  await tick(200);
  assert.equal(reused.exitCode ?? reused.signalCode, null, 'another process now: no signal');
  // Gone already when collected (/proc had nothing on it): whoever has its pid after the wait gets no signal either.
  const later = kid();
  const goneThen = { self: () => 'L:boot:1', of: (pids) => new Map(pids.map((p) => [p, null])) };
  const { b: b3 } = backend('linux', { descendants: async () => [later.pid], ident: goneThen });
  await b3.create({ name: 'g', dir: '/w' });
  await b3.kill('g');
  await tick(200);
  assert.equal(later.exitCode ?? later.signalCode, null, 'gone when collected: no signal');
  // /proc cannot be read at all: as before, only whether the pid is alive (the terminal's processes still end).
  const blind = kid();
  const noProc = { self: () => null, of: (pids) => new Map(pids.map((p) => [p, null])) };
  const { b: b4 } = backend('linux', { descendants: async () => [blind.pid], ident: noProc });
  await b4.create({ name: 'n', dir: '/w' });
  await b4.kill('n');
  await Promise.race([gone(blind), tick(5000)]);
  assert.equal(blind.signalCode, 'SIGHUP');
  // The same process at both moments (the real reader): it is ended, as before.
  const same = kid();
  const { b: b2 } = backend('linux', { descendants: async () => [same.pid] });
  await b2.create({ name: 's', dir: '/w' });
  await b2.kill('s');
  await gone(same);
  assert.equal(same.signalCode, 'SIGHUP');
});

test('what ignores SIGHUP (a nohup job) does not outlive a closed terminal: SIGTERM once the shell has ended', { skip: process.platform === 'win32' && 'SIGHUP and SIGTERM are POSIX signals: Windows ends a process only at once', timeout: 15_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const deaf = spawn(process.execPath, ['-e', "process.on('SIGHUP', () => {}); setInterval(() => {}, 1 << 30); console.log('ready')"], { stdio: ['ignore', 'pipe', 'ignore'] });
  test.after(() => deaf.kill('SIGKILL'));
  await new Promise((r) => deaf.stdout.once('data', r)); // its SIGHUP handler is in place
  const { b } = backend('linux', { descendants: async () => [deaf.pid] });
  await b.create({ name: 'n', dir: '/w' });
  const t0 = Date.now();
  await b.kill('n');
  // SIGHUP first (ignored), the wait for it, then the shell (here it ends at once), then SIGTERM.
  await new Promise((r) => (deaf.exitCode !== null || deaf.signalCode !== null ? r() : deaf.once('exit', r)));
  assert.equal(deaf.signalCode, 'SIGTERM');
  assert.ok(Date.now() - t0 < 5000, 'the wait for it is bounded');
});
