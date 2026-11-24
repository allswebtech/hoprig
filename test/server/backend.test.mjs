import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { shellLine, shellQuote, tmuxUsable } from '../../src/server/backends/index.mjs';
import { CLEAR, assertTypable } from '../../src/server/backends/shell.mjs';
import { PANE_FORMAT, TITLE_FORMAT, TmuxBackend, XTVERSION_REPLY, parsePanes } from '../../src/server/backends/tmux.mjs';
import { tmuxNewEnough } from '../../src/server/backends/tmuxversion.mjs';
import { launchArgv } from '../../src/server/deck.mjs';

const box = sandbox();
test.after(() => box.cleanup());

test('tmux argv: UTF-8 always, socket and config only when set; exact-match targets', () => {
  assert.deepEqual(new TmuxBackend().argv('list-panes'), ['-u', 'list-panes']);
  const b = new TmuxBackend({ socket: 'test-sock', configFile: '/dev/null' });
  assert.deepEqual(b.argv('list-panes'), ['-u', '-L', 'test-sock', '-f', '/dev/null', 'list-panes']);
  assert.deepEqual(b.attachArgv('proj'), ['-u', '-L', 'test-sock', '-f', '/dev/null', '-T', 'RGB', 'attach-session', '-t', '=proj']);
});

test('tmux that ends before it has read the text it is given: the call fails, the dashboard stays up', { skip: process.platform === 'win32' && 'POSIX shell' }, async () => {
  // A server that went away between the look at the terminal and the paste: tmux says so and exits without reading
  // its input. The text is bigger than a pipe holds, so the rest of it meets a closed pipe (EPIPE), which must not
  // become an uncaught error.
  const bin = path.join(box.root, 'tmux-gone');
  fs.writeFileSync(bin, '#!/bin/sh\necho "no server running on /tmp/tmux-0/gone" >&2\nexit 1\n', { mode: 0o755 });
  const b = new TmuxBackend({ bin, socket: 'gone' });
  await assert.rejects(b.run(['load-buffer', '-b', 'paste-x', '-'], { input: 'x'.repeat(4 << 20) }), /no server running|EPIPE/);
  await new Promise((r) => setTimeout(r, 200)); // an uncaught error would come now and fail this file
});

test('tmux calls are argument arrays (recorded)', async () => {
  const b = new TmuxBackend({ socket: 's' });
  const calls = [];
  b.run = async (args, o) => {
    calls.push([args, o && o.input]);
    return args[0] === 'new-session' ? '%7\n' : '';
  };
  await assert.rejects(b.create({ name: 'p', dir: '/w', argv: ['/usr/bin/node', "it's"] }), (e) => e.status === 400);
  assert.deepEqual(calls, [], 'refused before tmux is asked for anything');
  const r = await b.create({ name: 'p', dir: '/w/my #(dir)', argv: ['/usr/bin/node', '/x/bin.mjs', 'work'] });
  assert.deepEqual(r, { name: 'p', id: '%7' });
  // -c is a format to tmux: "#" doubled, so "#(…)" in a folder's name is never run. The pane's launcher uses the
  // dashboard's state folder, whatever the tmux server was started with.
  const env = ['-e', 'COLORTERM=truecolor', '-e', `HOPRIG_STATE_DIR=${box.state}`];
  assert.deepEqual(calls[0][0], ['new-session', '-d', '-s', 'p', '-c', '/w/my ##(dir)', ...env, '-P', '-F', '#{pane_id}']);
  assert.deepEqual(calls[1][0], ['send-keys', '-t', '%7', '-l', '--', `${CLEAR}; /usr/bin/node /x/bin.mjs work`]);
  assert.deepEqual(calls[2][0], ['send-keys', '-t', '%7', 'Enter']);
  // tmux's own status line is hidden for the session (by pane id: set-option has no "=name" form), and focus
  // events are on for Claude Code.
  // The program's title goes to the page (set-titles), never tmux's default of the host name.
  assert.deepEqual(calls.slice(3).map((c) => c[0]), [['set-option', '-t', '%7', 'status', 'off'], ['set-option', '-s', 'focus-events', 'on'],
    ['set-option', '-t', '%7', 'set-titles', 'on'], ['set-option', '-t', '%7', 'set-titles-string', TITLE_FORMAT]]);
  calls.length = 0;
  await b.sendText('%7', 'one line; rm -rf / $(x)');
  assert.deepEqual(calls.map((c) => c[0]), [['copy-mode', '-q', '-t', '%7'], ['send-keys', '-t', '%7', '-l', '--', 'one line; rm -rf / $(x)']]);
  calls.length = 0;
  await b.sendText('%7', 'two\nlines');
  assert.equal(calls[1][0][0], 'load-buffer');
  assert.equal(calls[1][1], 'two\nlines', 'text goes through stdin');
  assert.deepEqual(calls[2][0].slice(0, 3), ['paste-buffer', '-p', '-d']);
  calls.length = 0;
  await b.respawn('%7', '/w#{pane_id}', ['n', 'p2', '--resume', 'id']);
  // What runs under the pane's shell ends first (here tmux names no shell: nothing to end; ending.test.mjs).
  assert.deepEqual(calls[0][0], ['display-message', '-p', '-t', '%7', '#{pane_dead} #{pane_pid}']);
  assert.deepEqual(calls[1][0], ['respawn-pane', '-k', '-t', '%7', '-c', '/w##{pane_id}', ...env]);
  assert.deepEqual(calls[2][0], ['clear-history', '-t', '%7']);
  assert.deepEqual(calls[3][0], ['send-keys', '-t', '%7', '-l', '--', `${CLEAR}; n p2 --resume id`]);
  calls.length = 0;
  // A run of "#" before "[" is a style to tmux, copied through as it is: left alone, or the folder would be another one.
  await b.respawn('%7', '/w/notes #[draft] a##[b ##(x) #', ['n', 'p2']);
  assert.deepEqual(calls[1][0].slice(4, 6), ['-c', '/w/notes #[draft] a##[b ####(x) ##']);
  calls.length = 0;
  await assert.rejects(b.respawn('%7', '/w', ['n', 'a\u0015b']), (e) => e.status === 400);
  assert.deepEqual(calls, [], 'refused before what runs there is stopped, or its programs are ended');
  calls.length = 0;
  await b.scroll('%7', 'up', 5);
  assert.deepEqual(calls.map((c) => c[0]), [['copy-mode', '-e', '-t', '%7'], ['send-keys', '-t', '%7', '-X', '-N', '5', 'scroll-up']]);
  calls.length = 0;
  await b.kill('p');
  await b.rename('p', 'q');
  // A Close, too, ends what runs under the shells of all the session's panes first.
  assert.deepEqual(calls.map((c) => c[0]), [['list-panes', '-s', '-t', '=p', '-F', '#{pane_dead} #{pane_pid}'], ['kill-session', '-t', '=p'], ['rename-session', '-t', '=p', 'q']]);
  await assert.rejects(b.sendKey('%7', 'C-b'), /unknown key/);
  await assert.rejects(b.scroll('%7', 'sideways'), /unknown scroll/);
});

test('tmux: the programs ended before a respawn or a Close are those under the live panes\' shells only', async () => {
  // A dead pane (remain-on-exit, from the owner's tmux.conf) names the pid of a shell that has ended: by now that pid
  // may be another process's, and what runs under it is nothing of the pane's.
  const asked = [];
  const b = new TmuxBackend({ socket: 's', descendants: async (pid) => (asked.push(pid), []) });
  let panes = '';
  b.run = async (args) => (args[0] === 'display-message' || args[0] === 'list-panes' ? panes : '');
  panes = '1 4242\n';
  await b.respawn('%7', '/w', ['n']);
  await b.kill('p');
  assert.deepEqual(asked, [], 'a dead pane: nothing is asked for, nothing signalled');
  panes = '0 4242\n1 4343\n0 4444\n0 1\n0 x\n';
  await b.kill('p');
  assert.deepEqual(asked, [4242, 4444], 'every live pane of the session, nothing else');
  // Ending the whole server (tests) asks for the panes of every session, then ends tmux.
  const calls = [];
  b.run = async (args) => (calls.push(args), args[0] === 'list-panes' ? '' : '');
  await b.killServer();
  assert.deepEqual(calls, [['list-panes', '-a', '-F', '#{pane_dead} #{pane_pid}'], ['kill-server']]);
});

test('list-panes parsing (path may contain tabs)', () => {
  assert.equal(PANE_FORMAT.split('\t').length, 13);
  // window_activity (1700000160) is the program's last output: the later of the two counts.
  const line = ['proj', '$7', '1700000000', '1', '1700000100', '1700000160', '1', '1', '%3', '4242', '0', 'node', '/home/u/a\tb'].join('\t');
  const [p] = parsePanes(line + '\n\n');
  assert.deepEqual(p, {
    session: 'proj', id: '%3', sid: '$7', pid: 4242, cwd: '/home/u/a\tb', command: 'node', created: 1700000000000,
    attached: 1, activity: 1700000160000, active: true, dead: false,
  });
  assert.deepEqual(parsePanes('garbage\n'), []);
});

test('tmux without a UTF-8 locale (a service, a CI step): sessions are listed, a non-ASCII folder keeps its name', { skip: !tmuxUsable() && 'no tmux 3.2 or newer here' }, async (t) => {
  const saved = {};
  for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const dir = path.join(box.root, 'café');
  fs.mkdirSync(dir);
  const conf = path.join(box.root, 'empty.conf'); // so the user's tmux.conf does not apply
  fs.writeFileSync(conf, '');
  const b = new TmuxBackend({ socket: `backend-test-${process.pid}`, configFile: conf });
  t.after(async () => {
    const sock = await b.run(['display', '-p', '#{socket_path}']).catch(() => '');
    await b.killServer();
    if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });
  const { id } = await b.create({ name: 'plain', dir });
  // tmux reads a pane's folder from its process, which goes to its folder a moment after tmux has made it: until then
  // the folder is the tmux server's own (seen once under a loaded suite). Asked again for up to 3 s.
  const want = fs.realpathSync(dir).normalize('NFC');
  let panes = await b.list();
  for (const end = Date.now() + 3000; panes[0]?.cwd.normalize('NFC') !== want && Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 50));
    panes = await b.list();
  }
  assert.deepEqual(panes.map((p) => [p.session, p.id]), [['plain', id]]);
  assert.equal(panes[0].cwd.normalize('NFC'), want);
});

test('tmux 3.2 is the oldest the backend uses; a build without a number counts as new', () => {
  for (const v of ['tmux 3.2', 'tmux 3.3a', 'tmux 3.6', 'tmux next-3.5', 'tmux 4.0', 'tmux master', '']) assert.equal(tmuxNewEnough(v), true, v);
  for (const v of ['tmux 3.1c', 'tmux 3.0a', 'tmux 2.9a', 'tmux 1.8']) assert.equal(tmuxNewEnough(v), false, v);
});

test('the start line: only words that no shell reads specially, quoted when they hold a space or other letters', () => {
  assert.equal(shellQuote('plain-word_1.2/x'), 'plain-word_1.2/x');
  assert.equal(shellQuote('/Users/a b/node'), "'/Users/a b/node'");
  assert.equal(shellQuote('/home/जय/bin'), "'/home/जय/bin'");
  assert.deepEqual(shellLine(['x', 'y z']), { line: `${CLEAR}; x 'y z'`, env: {} }, 'no cd: the terminal starts in its folder');
  assert.deepEqual(shellLine(['/n', '--launch', '/s/launch/ab.json'], { mark: '/s/runs/.start-1' }), { line: `${CLEAR}; /n --launch /s/launch/ab.json; command rm -f /s/runs/.start-1`, env: {} });
  for (const ok of ['/a/b-c_d.e', 'C:x', 'a@b', '50%', 'a+b=c,d', 'Ünïcödé', '漢字', 'नमस्ते', '١٢٣']) assert.doesNotThrow(() => assertTypable([ok], 'posix'), ok);
  // A quote, a backslash, the shell's own characters, any control byte or line end, and an empty word: refused.
  for (const bad of ["it's", 'a"b', 'a\\b', 'a!b', '$(x)', '`x`', 'a;b', 'a&b', 'a|b', 'a>b', 'a<b', '~/x', 'a*b', 'a?b', '[a]', '{a,b}', '#x', 'a\tb', 'a\nb', 'a\rb', 'a\u0015b', 'a\u0000b', 'a\u007fb', 'a\u0085b', '']) {
    assert.throws(() => shellLine(['/n', bad]), (e) => e.status === 400 && /^Hoprig cannot type this path into a shell: /.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => shellLine(['/n'], { mark: "/s/it's" }), (e) => e.status === 400, 'the mark too');
  assert.doesNotThrow(() => assertTypable(['C:\\Program Files (x86)\\nodejs\\node.exe'], 'win32'), 'Windows: not typed, its paths as they are');
  for (const bad of ['a"b', 'a\nb', '']) assert.throws(() => assertTypable([bad], 'win32'), (e) => e.status === 400, JSON.stringify(bad));
  assert.equal(CLEAR, "printf '\\033[H\\033[2J\\033[3J'");
});

test('the start line types only plain ASCII: a word with other letters is named from the environment, and arrives whole', { skip: process.platform === 'win32' && 'POSIX shells' }, () => {
  // A line editor may read a typed byte above 0x7f as a key of its own (bash 3.2 under the C locale: a Meta key).
  const dir = fs.mkdtempSync(path.join(box.root, 'startline-'));
  try {
    const own = path.join(dir, 'जय-é-漢');
    fs.mkdirSync(own);
    const script = path.join(own, 'récord.mjs');
    const out = path.join(dir, 'out.json');
    fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)));\n`);
    const mark = path.join(own, '.start-1');
    fs.writeFileSync(mark, '');
    const { line, env } = shellLine([process.execPath, script, 'plain', script], { mark });
    assert.match(line, /^[\x20-\x7e]*$/, `only ASCII is typed: ${JSON.stringify(line)}`);
    assert.equal(line.includes('"$HOPRIG_WORD_1" plain "$HOPRIG_WORD_2"'), true, line);
    assert.deepEqual(env, { HOPRIG_WORD_1: script, HOPRIG_WORD_2: script, HOPRIG_WORD_3: mark });
    for (const sh of ['/bin/sh', '/bin/bash', '/bin/dash'].filter((s) => fs.existsSync(s))) {
      fs.rmSync(out, { force: true });
      fs.writeFileSync(mark, '');
      const r = spawnSync(sh, ['-c', line], { env: { ...process.env, ...env, LC_ALL: 'C', LANG: 'C' }, encoding: 'utf8' });
      assert.equal(r.status, 0, `${sh}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [script, 'plain', script], `${sh}: byte for byte`);
      assert.equal(fs.existsSync(mark), false, `${sh}: the mark is removed by its name too`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launch command contract', () => {
  const L = ['/node', '/bin.mjs'];
  const p = { name: 'work', env: {} };
  const id = '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b';
  assert.deepEqual(launchArgv(L, { profile: p }), ['/node', '/bin.mjs', 'work']);
  assert.deepEqual(launchArgv(L, { profile: p, mode: 'continue' }), [...L, 'work', '-c']);
  // options for one session come after the account and before a first message
  assert.deepEqual(launchArgv(L, { profile: p, flags: ['--effort', 'high'], prompt: 'go' }), [...L, 'work', '--effort', 'high', '--', 'go']);
  assert.deepEqual(launchArgv(L, { profile: p, mode: 'resume', sessionId: id }), [...L, 'work', '--resume', id]);
  assert.deepEqual(
    launchArgv(L, { profile: p, mode: 'move', sessionId: id, carryArgs: ['--model', 'opus', '--verbose', 'a prompt'] }),
    [...L, 'work', '--model', 'opus', '--verbose', '--resume', id],
  );
  // a profile with its own model drops --model on the move (src/launch.mjs moveArgs)
  const api = { name: 'api', env: { ANTHROPIC_MODEL: 'x' } };
  assert.deepEqual(launchArgv(L, { profile: api, mode: 'move', sessionId: id, carryArgs: ['--model', 'opus'] }), [...L, 'api', '--resume', id]);
  // a session nobody typed into has no conversation to resume: it starts there under the same id
  assert.deepEqual(launchArgv(L, { profile: p, mode: 'move', sessionId: id, carryArgs: ['--verbose'], fresh: true }), [...L, 'work', '--verbose', '--session-id', id]);
  assert.throws(() => launchArgv(L, { profile: p, mode: 'resume' }));
  assert.throws(() => launchArgv(L, { profile: p, mode: 'bogus' }));
});

test('the sign-in check at start belongs to the real serve command only', async () => {
  // A server made by a test or the demo must never start the real `claude`; `serve` asks for it by name.
  const fs = await import('node:fs');
  const url = await import('node:url');
  const read = (rel) => fs.readFileSync(url.fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  assert.match(read('../../src/server/cli.mjs'), /createServer\(\{ host, port, loginCheck: true \}\)/);
  assert.match(read('../../src/server/server.mjs'), /if \(opts\.loginCheck === true\) \{/);
  assert.doesNotMatch(read('../../src/demo/index.mjs'), /loginCheck/);
});

test('tmux attach: tmux\'s question for the terminal\'s name is answered once, so a lone Esc is not held and joined to the next key', { skip: process.platform === 'win32' && 'POSIX pseudo-terminal' }, async () => {
  // A stand-in for tmux: it asks the outer terminal what tmux 3.6 asks at attach, twice, and records what it reads.
  const got = path.join(box.root, 'xtversion-got');
  const bin = path.join(box.root, 'tmux-asks');
  fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('fs');\nprocess.stdin.setRawMode(true);\nprocess.stdout.write('\\x1b[c\\x1b[>q');\nsetTimeout(() => process.stdout.write('\\x1b[>q'), 300);\nprocess.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(got)}, b));\nsetTimeout(() => process.exit(0), 1500);\n`, { mode: 0o755 });
  const stream = new TmuxBackend({ bin, socket: 'xtv' }).attach('proj', { cols: 80, rows: 24 });
  const seen = [];
  stream.onData((d) => seen.push(d));
  await new Promise((resolve) => stream.onExit(resolve));
  assert.match(seen.join(''), /\x1b\[>q/, 'the question still reaches the browser (its terminal answers what it knows)');
  const answer = fs.existsSync(got) ? fs.readFileSync(got, 'latin1') : '';
  assert.equal(answer, XTVERSION_REPLY, 'one answer, a name tmux does not take for a terminal it must work around');
  assert.match(XTVERSION_REPLY, /^\x1bP>\|[\x20-\x7e]+\x1b\\$/);
});

/**
 * A stand-in for tmux whose attach client records what it reads, ignores the hang-up (so a write after close would
 * still arrive) and ends after 2.5 s; it names the prefix after `answerMs`.
 */
function slowTmux(file, got, answerMs) {
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require('fs');\nconst a = process.argv.slice(2);\nif (a.includes('display-message')) setTimeout(() => console.log('C-b\\tNone\\t10'), ${answerMs});\nelse if (a.includes('list-keys')) console.log('bind-key -T prefix C-b send-prefix');\nelse {\n  process.on('SIGHUP', () => {});\n  process.stdin.setRawMode(true);\n  process.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(got)}, b));\n  setTimeout(() => process.exit(0), 2500);\n}\n`, { mode: 0o755 });
}
const readOr = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'latin1') : '');

test('tmux attach: keys typed before tmux has named its prefix are dropped when the page leaves first, never written to a closed client', { skip: process.platform === 'win32' && 'POSIX pseudo-terminal' }, async () => {
  const got = path.join(box.root, 'late-got');
  const bin = path.join(box.root, 'tmux-late');
  slowTmux(bin, got, 300);
  const stream = new TmuxBackend({ bin, socket: 'late' }).attach('proj', { cols: 80, rows: 24 });
  stream.onData(() => {});
  await new Promise((r) => setTimeout(r, 100));
  stream.write('z'); // typed, and the page closed, in the same moment
  stream.close();
  stream.write('y');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(readOr(got), '', 'nothing is written after close (node-pty: "Unhandled pty write error EBADF")');
  await new Promise((r) => stream.onExit(r));
});

test('tmux attach: a tmux slow to name its prefix does not hold the keys: they go on after a second', { skip: process.platform === 'win32' && 'POSIX pseudo-terminal' }, async () => {
  const got = path.join(box.root, 'slow-got');
  const bin = path.join(box.root, 'tmux-slow');
  slowTmux(bin, got, 2000);
  const stream = new TmuxBackend({ bin, socket: 'slow' }).attach('proj', { cols: 80, rows: 24 });
  stream.onData(() => {});
  await new Promise((r) => setTimeout(r, 100));
  stream.write('a');
  for (const end = Date.now() + 1800; !readOr(got) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readOr(got), 'a', 'within about a second, not the 10 s a hung tmux call takes');
  await new Promise((r) => stream.onExit(r));
});

test('tmux attach: a Ctrl+B typed in the browser reaches the program, and the key after it is not a tmux command', { skip: (!tmuxUsable() || process.platform === 'win32') && 'no tmux 3.2 or newer here' }, async (t) => {
  // The program in the pane asks for bracketed paste (as Claude Code does) and records every byte it reads; tmux runs
  // with an empty config (its default prefix, Ctrl+B).
  const got = path.join(box.root, 'prefix-got');
  const prog = path.join(box.root, 'record.cjs');
  fs.writeFileSync(prog, `const fs = require('fs');\nprocess.stdin.setRawMode(true);\nprocess.stdout.write('\\x1b[?2004h');\nprocess.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(got)}, b));\nsetInterval(() => {}, 1000);\n`);
  const conf = path.join(box.root, 'prefix.conf');
  fs.writeFileSync(conf, '');
  const b = new TmuxBackend({ socket: `prefix-test-${process.pid}`, configFile: conf });
  let stream = null;
  t.after(async () => {
    if (stream) stream.close();
    const sock = await b.run(['display', '-p', '#{socket_path}']).catch(() => '');
    await b.killServer();
    if (sock.trim()) fs.rmSync(sock.trim(), { force: true });
  });
  await b.run(['new-session', '-d', '-s', 'rec', '-x', '80', '-y', '24', process.execPath, prog]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  stream = b.attach('rec', { cols: 80, rows: 24 });
  stream.onData(() => {});
  await wait(800);
  stream.write('\x02');
  await wait(300);
  stream.write('x'); // after a prefix tmux would ask to kill the pane
  await wait(300);
  stream.write('\x1b[200~p\x02q\x1b[201~');
  await wait(300);
  stream.write('\x1b\x02'); // Ctrl+Alt+B: one key for tmux (M-C-b), no prefix
  await wait(300);
  stream.write('x'); // a prefix left over would make it a tmux command again
  await wait(300);
  stream.write('d'); // and this one would detach
  const read = () => (fs.existsSync(got) ? fs.readFileSync(got, 'latin1').replace(/\x1b\[[IO]/g, '') : '');
  for (const end = Date.now() + 5000; !read().endsWith('d') && Date.now() < end;) await wait(50);
  assert.equal(read(), '\x02x\x1b[200~p\x02q\x1b[201~\x1b\x02xd', 'each key once, as typed; the paste as it is; Ctrl+Alt+B as it is');
  assert.match(await b.run(['list-panes', '-t', '=rec', '-F', '#{pane_dead}']), /^0$/m, 'the pane lives');
});

test('tmux attach: a whole paste written just before the page leaves reaches the program whole, end mark included', { skip: (!tmuxUsable() || process.platform === 'win32') && 'no tmux 3.2 or newer here' }, async (t) => {
  const got = path.join(box.root, 'leave-got');
  const prog = path.join(box.root, 'record-leave.cjs');
  fs.writeFileSync(prog, `const fs = require('fs');\nprocess.stdin.setRawMode(true);\nprocess.stdout.write('\\x1b[?2004h');\nprocess.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(got)}, b));\nsetInterval(() => {}, 1000);\n`);
  const conf = path.join(box.root, 'leave.conf');
  fs.writeFileSync(conf, '');
  const b = new TmuxBackend({ socket: `leave-test-${process.pid}`, configFile: conf });
  t.after(async () => {
    const sock = await b.run(['display', '-p', '#{socket_path}']).catch(() => '');
    await b.killServer();
    if (sock.trim()) fs.rmSync(sock.trim(), { force: true });
  });
  await b.run(['new-session', '-d', '-s', 'rec', '-x', '80', '-y', '24', process.execPath, prog]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const stream = b.attach('rec', { cols: 80, rows: 24 });
  stream.onData(() => {});
  await wait(800);
  const paste = `\x1b[200~${'A'.repeat(1 << 20)}\x1b[201~`;
  stream.write(paste);
  stream.close(); // the page left at once: the socket hands over a paste only when it is whole
  const read = () => (fs.existsSync(got) ? fs.readFileSync(got, 'latin1').replace(/\x1b\[[IO]/g, '') : '');
  for (const end = Date.now() + 8000; !read().endsWith('\x1b[201~') && Date.now() < end;) await wait(100);
  assert.equal(read().length, paste.length, 'cut off, the program stays inside the paste and takes the next keys as paste text');
  await new Promise((r) => stream.onExit(r));
});
