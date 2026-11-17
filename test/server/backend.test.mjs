import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { shellLine, shellQuote, tmuxUsable } from '../../src/server/backends/index.mjs';
import { CLEAR, assertTypable } from '../../src/server/backends/shell.mjs';
import { PANE_FORMAT, TmuxBackend, parsePanes } from '../../src/server/backends/tmux.mjs';
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

test('tmux calls are argument arrays (recorded)', async () => {
  const b = new TmuxBackend({ socket: 's' });
  const calls = [];
  b.run = async (args, o) => {
    calls.push([args, o && o.input]);
    return args[0] === 'new-session' ? '%7\n' : '';
  };
  await assert.rejects(b.create({ name: 'p', dir: '/w', argv: ['/usr/bin/node', "it's"] }), (e) => e.status === 400);
  assert.deepEqual(calls, [], 'refused before tmux is asked for anything');
  const r = await b.create({ name: 'p', dir: '/w/my dir', argv: ['/usr/bin/node', '/x/bin.mjs', 'work'] });
  assert.deepEqual(r, { name: 'p', id: '%7' });
  assert.deepEqual(calls[0][0], ['new-session', '-d', '-s', 'p', '-c', '/w/my dir', '-e', 'COLORTERM=truecolor', '-P', '-F', '#{pane_id}']);
  assert.deepEqual(calls[1][0], ['send-keys', '-t', '%7', '-l', '--', `${CLEAR}; /usr/bin/node /x/bin.mjs work`]);
  assert.deepEqual(calls[2][0], ['send-keys', '-t', '%7', 'Enter']);
  // tmux's own status line is hidden for the session (by pane id: set-option has no "=name" form), and focus
  // events are on for Claude Code.
  assert.deepEqual(calls.slice(3).map((c) => c[0]), [['set-option', '-t', '%7', 'status', 'off'], ['set-option', '-s', 'focus-events', 'on']]);
  calls.length = 0;
  await b.sendText('%7', 'one line; rm -rf / $(x)');
  assert.deepEqual(calls.map((c) => c[0]), [['copy-mode', '-q', '-t', '%7'], ['send-keys', '-t', '%7', '-l', '--', 'one line; rm -rf / $(x)']]);
  calls.length = 0;
  await b.sendText('%7', 'two\nlines');
  assert.equal(calls[1][0][0], 'load-buffer');
  assert.equal(calls[1][1], 'two\nlines', 'text goes through stdin');
  assert.deepEqual(calls[2][0].slice(0, 3), ['paste-buffer', '-p', '-d']);
  calls.length = 0;
  await b.respawn('%7', '/w', ['n', 'p2', '--resume', 'id']);
  assert.deepEqual(calls[0][0], ['respawn-pane', '-k', '-t', '%7', '-c', '/w', '-e', 'COLORTERM=truecolor']);
  assert.deepEqual(calls[1][0], ['clear-history', '-t', '%7']);
  assert.deepEqual(calls[2][0], ['send-keys', '-t', '%7', '-l', '--', `${CLEAR}; n p2 --resume id`]);
  calls.length = 0;
  await assert.rejects(b.respawn('%7', '/w', ['n', 'a\u0015b']), (e) => e.status === 400);
  assert.deepEqual(calls, [], 'refused before what runs there is stopped');
  calls.length = 0;
  await b.scroll('%7', 'up', 5);
  assert.deepEqual(calls.map((c) => c[0]), [['copy-mode', '-e', '-t', '%7'], ['send-keys', '-t', '%7', '-X', '-N', '5', 'scroll-up']]);
  calls.length = 0;
  await b.kill('p');
  await b.rename('p', 'q');
  assert.deepEqual(calls.map((c) => c[0]), [['kill-session', '-t', '=p'], ['rename-session', '-t', '=p', 'q']]);
  await assert.rejects(b.sendKey('%7', 'C-b'), /unknown key/);
  await assert.rejects(b.scroll('%7', 'sideways'), /unknown scroll/);
});

test('list-panes parsing (path may contain tabs)', () => {
  assert.equal(PANE_FORMAT.split('\t').length, 12);
  // window_activity (1700000160) is the program's last output: the later of the two counts.
  const line = ['proj', '1700000000', '1', '1700000100', '1700000160', '1', '1', '%3', '4242', '0', 'node', '/home/u/a\tb'].join('\t');
  const [p] = parsePanes(line + '\n\n');
  assert.deepEqual(p, {
    session: 'proj', id: '%3', pid: 4242, cwd: '/home/u/a\tb', command: 'node', created: 1700000000000,
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
  const panes = await b.list();
  assert.deepEqual(panes.map((p) => [p.session, p.id]), [['plain', id]]);
  assert.equal(panes[0].cwd.normalize('NFC'), fs.realpathSync(dir).normalize('NFC'));
});

test('tmux 3.2 is the oldest the backend uses; a build without a number counts as new', () => {
  for (const v of ['tmux 3.2', 'tmux 3.3a', 'tmux 3.6', 'tmux next-3.5', 'tmux 4.0', 'tmux master', '']) assert.equal(tmuxNewEnough(v), true, v);
  for (const v of ['tmux 3.1c', 'tmux 3.0a', 'tmux 2.9a', 'tmux 1.8']) assert.equal(tmuxNewEnough(v), false, v);
});

test('the start line: only words that no shell reads specially, quoted when they hold a space or other letters', () => {
  assert.equal(shellQuote('plain-word_1.2/x'), 'plain-word_1.2/x');
  assert.equal(shellQuote('/Users/a b/node'), "'/Users/a b/node'");
  assert.equal(shellQuote('/home/जय/bin'), "'/home/जय/bin'");
  assert.equal(shellLine(['x', 'y z']), `${CLEAR}; x 'y z'`, 'no cd: the terminal starts in its folder');
  assert.equal(shellLine(['/n', '--launch', '/s/launch/ab.json'], { mark: '/s/runs/.start-1' }), `${CLEAR}; /n --launch /s/launch/ab.json; command rm -f /s/runs/.start-1`);
  for (const ok of ['/a/b-c_d.e', 'C:x', 'a@b', '50%', 'a+b=c,d', 'Ünïcödé', '漢字', 'नमस्ते', '١٢٣']) assert.doesNotThrow(() => assertTypable([ok], 'posix'), ok);
  // A quote, a backslash, the shell's own characters, any control byte or line end, and an empty word: refused.
  for (const bad of ["it's", 'a"b', 'a\\b', 'a!b', '$(x)', '`x`', 'a;b', 'a&b', 'a|b', 'a>b', 'a<b', '~/x', 'a*b', 'a?b', '[a]', '{a,b}', '#x', 'a\tb', 'a\nb', 'a\rb', 'a\u0015b', 'a\u0000b', 'a\u007fb', 'a\u0085b', '']) {
    assert.throws(() => shellLine(['/n', bad]), (e) => e.status === 400 && /^Hoprig cannot start a terminal from this path: /.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => shellLine(['/n'], { mark: "/s/it's" }), (e) => e.status === 400, 'the mark too');
  assert.doesNotThrow(() => assertTypable(['C:\\Program Files (x86)\\nodejs\\node.exe'], 'win32'), 'Windows: not typed, its paths as they are');
  for (const bad of ['a"b', 'a\nb', '']) assert.throws(() => assertTypable([bad], 'win32'), (e) => e.status === 400, JSON.stringify(bad));
  assert.equal(CLEAR, "printf '\\033[H\\033[2J\\033[3J'");
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
