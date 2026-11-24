// "!" in the App: the owner's shell command in the session's folder (src/chat/bang.mjs), its output going with his
// next message as his own text (web/chat/bang.js), and Claude Code's / menu (web/chat/popovers.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import './fakedom.mjs';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('bang');
test.after(() => box.cleanup());
const B = await import('../../src/chat/bang.mjs');
globalThis.window = globalThis.window || { addEventListener() {} };
const P = await import('../../web/chat/bang.js');
const posix = process.platform !== 'win32';

test('a command line from the page: text of 1 to 4000 characters, no NUL; the shell gets it as its own input', () => {
  assert.equal(B.bangCommand('  npm test \n'), 'npm test');
  for (const bad of ['', '   ', 'a\0b', 'x'.repeat(4001), null, 3, ['ls']]) assert.equal(B.bangCommand(bad), null, String(bad).slice(0, 20));
  assert.deepEqual(B.shellFor('ls -la', 'linux', { SHELL: '/bin/bash' }), ['/bin/bash', ['-c', 'ls -la']], 'an array: the line is never put into another command line');
  assert.deepEqual(B.shellFor('ls', 'darwin', {}), ['/bin/zsh', ['-c', 'ls']]);
  assert.deepEqual(B.shellFor('dir', 'win32', {}), ['powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'dir']]);
});

test('it runs in the session\'s folder, with the dashboard\'s environment minus its secrets, stdout and stderr as they came', { skip: !posix && 'POSIX shell' }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const r = await B.runBang(dir, 'pwd; echo "key=${ANTHROPIC_API_KEY:-none}"; echo oops >&2; exit 3', { env: { ...process.env, SHELL: '/bin/sh', ANTHROPIC_API_KEY: 'sk-ant-secret' } });
  assert.equal(r.code, 3);
  assert.equal(r.output, `${dir}\nkey=none\noops\n`, 'its folder; a provider key never reaches the command');
  assert.equal(r.timedOut, false);
});

test('a long output keeps its end; a command still running at the time limit is stopped, its children too', { skip: !posix && 'POSIX shell' }, async () => {
  const dir = box.root;
  const big = await B.runBang(dir, `i=0; while [ $i -lt 20000 ]; do echo "line $i"; i=$((i+1)); done`, { env: { ...process.env, SHELL: '/bin/sh' } });
  assert.equal(big.cut, true);
  assert.ok(big.output.length <= B.OUTPUT_MAX);
  assert.match(big.output, /line 19999\n$/, 'the end, where a run says how it went');
  const slow = await B.runBang(dir, 'sleep 30 & sleep 30', { timeMs: 300, env: { ...process.env, SHELL: '/bin/sh' } });
  assert.deepEqual([slow.timedOut, slow.code], [true, null]);
  assert.ok(slow.ms < 5000);
});

test('a command that ends but leaves a program running is over at once, with its exit code; that program is not killed', { skip: !posix && 'POSIX shell' }, async () => {
  const r = await B.runBang(box.root, 'sleep 37 & echo $!', { timeMs: 4000, env: { ...process.env, SHELL: '/bin/sh' } });
  const pid = Number(r.output.trim());
  try {
    assert.deepEqual([r.code, r.timedOut, r.stopped], [0, false, false], 'done, not "stopped after 5 minutes"');
    assert.ok(r.ms < 2000, `it came back at once (${r.ms} ms), not at the time limit`);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the program the owner started in the background still runs');
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('a program left running in the background may still write after the command is over: it is not killed for that', { skip: !posix && 'POSIX shell' }, async () => {
  // A dev server started with "&" writes a log line soon after: its pipe must stay readable, or that write kills it.
  const r = await B.runBang(box.root, '(sleep 0.4; echo late; echo late >&2; sleep 30) & echo $!', { timeMs: 4000, drainMs: 100, env: { ...process.env, SHELL: '/bin/sh' } });
  const pid = Number(r.output.trim());
  try {
    assert.deepEqual([r.code, r.timedOut, r.stopped], [0, false, false]);
    assert.ok(r.ms < 2000, `it came back at once (${r.ms} ms)`);
    await new Promise((res) => setTimeout(res, 1200));
    assert.doesNotThrow(() => process.kill(pid, 0), 'the program still runs after its late output');
    assert.equal(r.output.trim(), String(pid), 'output after the command was over is not added to it');
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('a program left in the background that writes without pause takes next to none of the dashboard\'s time', { skip: !posix && 'POSIX shell' }, async () => {
  // `yes &` after the command is over: its pipes are emptied a few times a second, not read chunk by chunk as they
  // came (that took a whole core until the program ended). It is held back by its full pipe, and not killed.
  const r = await B.runBang(box.root, 'echo $$; (sleep 0.3; yes) & echo $!', { timeMs: 4000, env: { ...process.env, SHELL: '/bin/sh' } });
  const [group, pid] = r.output.trim().split('\n').map(Number);
  try {
    assert.equal(r.code, 0);
    await new Promise((res) => setTimeout(res, 500)); // it writes by now
    const before = process.cpuUsage();
    await new Promise((res) => setTimeout(res, 2000));
    const used = process.cpuUsage(before);
    const ms = (used.user + used.system) / 1000;
    assert.ok(ms < 400, `the dashboard's own time over two seconds: ${Math.round(ms)} ms`);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the program still runs');
  } finally {
    try {
      process.kill(-group, 'SIGKILL'); // the shell's process group: the writer with it
    } catch {
      /* gone */
    }
  }
});

test('the owner stops a command that would wait for ever: its whole group ends, the output so far is kept', { skip: !posix && 'POSIX shell' }, async () => {
  const ac = new AbortController();
  const seen = [];
  const p = B.runBang(box.root, 'echo begun; sleep 777 & sleep 778', { signal: ac.signal, onOutput: (t) => seen.push(t), env: { ...process.env, SHELL: '/bin/sh' } });
  while (!seen.join('').includes('begun')) await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const r = await p;
  assert.deepEqual([r.code, r.stopped, r.timedOut, r.output], [null, true, false, 'begun\n']);
  assert.ok(r.ms < 3000);
});

test('the page: "!" starts a shell line, and its runs go in front of the next message as the owner\'s text', () => {
  assert.equal(P.bangOf('!npm test'), 'npm test');
  assert.equal(P.bangOf('! git status  '), 'git status');
  assert.equal(P.bangOf('!'), null, 'nothing to run');
  assert.equal(P.bangOf('say !hi'), null);
  const t = P.shellText([{ command: 'npm test', code: 1, output: 'FAIL a.test\n', cut: false, timedOut: false }, { command: 'sleep 999', code: null, output: '', timedOut: true }]);
  assert.equal(t, "I ran this command in the session's folder:\n$ npm test\n```\nFAIL a.test\n```\nExit code 1.\n\nI ran this command in the session's folder:\n$ sleep 999\n```\n(no output)\n```\nIt was stopped after 5 minutes.");
  assert.match(P.shellText([{ command: 'tail -f x', code: null, output: '', stopped: true }]), /I stopped it\.$/);
  const long = P.shellText([{ command: 'x', code: 0, output: 'y'.repeat(20000) }]);
  assert.match(long, /\[… the start of the output is left out\]/);
  assert.ok(long.length < 13 * 1024, 'the message keeps within its size');
  // The composer: a "!" line runs instead of being sent, and the runs go with the next message, then are cleared.
  const src = fs.readFileSync(new URL('../../web/chat/composer.js', import.meta.url), 'utf8');
  assert.match(src, /const cmd = given === undefined \? bangOf\(typed\) : null;\n\s*if \(cmd\) \{[\s\S]*?return shell\.run\(cmd\);\n\s*\}/);
  assert.match(src, /const lead = given === undefined && shell\.count\(\) && !typed\.startsWith\('\/'\) \? shell\.text\(\) : '';/);
  assert.match(src, /files\.clear\(\);\n\s*if \(lead\) shell\.clear\(\);/);
});

test('a command that runs since before the page opened (a reload, another window) shows with Stop; its end is not sent', async () => {
  const textOf = (n) => (n.children ? n.children.map(textOf).join('') : n.text ?? '');
  let server = { running: true, command: 'tail -f log', output: 'one\n' };
  const calls = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u);
    calls.push(`${init.method || 'GET'} ${url.replace(/^.*\/api\/chats\/x/, '')}`);
    const send = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (url.endsWith('/shell/stop')) return send(200, { stopped: true });
    if (url.endsWith('/shell') && init.method === 'POST') return send(409, { error: 'a command runs in this session already; wait for its output' });
    return send(200, server);
  };
  try {
    const page = P.createShellRuns({ A: '/api/chats/x' });
    document.body.append(page.el);
    const src = fs.readFileSync(new URL('../../web/chat/composer.js', import.meta.url), 'utf8');
    assert.match(src, /\n {2}shell\.adopt\(\);/, 'the composer looks for one when the page opens');
    await page.adopt();
    assert.equal(page.running(), true, 'it shows as running');
    assert.ok(page.el.querySelector('.chat-shell-stop'), 'with Stop');
    assert.equal(textOf(page.el.querySelector('.chat-shell-live')), 'one\n', 'and its output so far');
    assert.equal(page.stop(), true, 'Esc and Stop reach it');
    assert.ok(calls.includes('POST /shell/stop'));
    server = { running: false };
    await new Promise((r) => setTimeout(r, 700)); // the next look (every 500 ms)
    assert.equal(page.running(), false, 'it ended');
    assert.deepEqual([page.count(), page.text()], [0, ''], 'its end went to the page that started it: nothing is sent from here');
    // A "!" while one from elsewhere runs: the 409 brings that one in, with Stop, instead of only a refusal.
    server = { running: true, command: 'npm run dev', output: '' };
    await page.run('echo x');
    assert.equal(page.running(), true);
    assert.match(textOf(page.el.querySelector('.chat-shell-cmd')), /npm run dev/);
    server = { running: false };
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(page.running(), false);
    // The page left while one runs: it stops asking (no poll left behind for up to 5 minutes).
    server = { running: true, command: 'npm run dev', output: '' };
    await page.adopt();
    page.el.remove();
    await new Promise((r) => setTimeout(r, 700));
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(calls.length, n, 'no more looks once the page is gone');
    assert.equal(page.running(), false);
  } finally {
    globalThis.fetch = before;
  }
});

test('the / menu as Claude Code\'s: by name, no Hoprig tag, /compact takes its focus text, /config opens Settings, /help helps', async () => {
  const M = await import('../../web/chat/popovers.js');
  assert.deepEqual(M.byName([{ name: 'review' }, { name: 'clear' }, { name: 'compact' }]).map((c) => c.name), ['clear', 'compact', 'review']);
  const src = fs.readFileSync(new URL('../../web/chat/popovers.js', import.meta.url), 'utf8');
  assert.ok(!src.includes("'Hoprig'"), 'no Hoprig tag');
  assert.ok(!src.includes("'Claude Code')]"), 'no Claude Code tag');
  assert.match(src, /\} else if \(it\.own && !complete && !it\.hint\) \{/, 'an own command with an argument goes into the box');
  const page = fs.readFileSync(new URL('../../web/chat/page.js', import.meta.url), 'utf8');
  assert.match(page, /\{ name: 'compact', hint: '\[instructions\]'/);
  assert.match(page, /\{ name: 'config', description: 'Open Settings', run: \(\) => goTo\('#\/settings'\) \}/);
  // Claude Code has no /mode and no /terminal: their lines say they are Hoprig's.
  for (const name of ['mode', 'terminal']) {
    const lines = page.split('\n').filter((l) => l.includes(`name: '${name}'`));
    assert.ok(lines.length && lines.every((l) => /description: [`']Hoprig: /.test(l) && (l.match(/description: [`']Hoprig: /g) || []).length === (l.match(/description:/g) || []).length), name);
  }
  assert.match(page, /\{ name: 'help', description: 'Show help and available commands', run: \(\) => helpSheet\(own\(\), composer\.commands\(\)\) \}/);
});
