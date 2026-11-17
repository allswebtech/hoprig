// Nothing from outside is typed into a shell (src/launchfile.mjs, src/server/backends/shell.mjs). Real terminals,
// built-in and tmux (on its own socket), under bash and dash as the terminal's shell, with a stand-in launcher that
// records what it was started with: text that a shell's line editor would act on (Ctrl-U, Tab, quotes, line breaks)
// reaches the launcher whole, the typed line holds none of it, the shell runs none of it, and a start line works once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const RECORD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'record-launcher.mjs');
const box = sandbox('launchline');
process.env.HOME = box.home; // the shells read their (empty) start files from here, not the person's own
const { Deck } = await import('../../src/server/deck.mjs');
const { launchDir } = await import('../../src/launchfile.mjs');
const { tmuxUsable } = await import('../../src/server/backends/index.mjs');
const { nodePty } = await import('../../src/server/backends/nodepty.mjs');
const { ptySpawn } = await import('../../src/server/backends/nodepty.mjs');
const { ensureSpawnHelper } = await import('../../src/server/backends/pty-helper.mjs');

const POSIX = process.platform !== 'win32';
const SHELLS = ['/bin/bash', '/bin/dash', ...(process.env.HOPRIG_TEST_FISH ? [process.env.HOPRIG_TEST_FISH] : [])].filter((s) => fs.existsSync(s));
const TMUX = POSIX && tmuxUsable();
const sockets = [];
test.after(() => {
  for (const s of sockets) {
    try {
      execFileSync('tmux', ['-L', s, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* not running */
    }
    // tmux leaves the socket file behind: one more in the shared tmux folder at every run.
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, s), { force: true });
  }
  box.cleanup();
});

// The last check's strings: Ctrl-U erased the opening quote and the rest ran; Tab closed the quote by completing.
const CTRL_U = 'hello \u0015touch PWNED; # rest';
const TAB = 'package.j\tab; touch PWNED; #';
const BIG = [
  '-starts with a dash',
  `it's "quoted" and \\back\\slashed\\' $(touch PWNED_SUB) \`touch PWNED_TICK\` !! !$ $HOME %1 ~ * ? [a] {b,c}`,
  'नमस्ते, 漢字, emoji 🙂, ÄÖÜ',
  '\ttabbed line\r\nwindows line end',
  'x'.repeat(20_000),
].join('\n');
const FOLDER = 'x\u0015touch PWNED_DIR; #';
// tmux reads its start folder (-c) as a format: "#(…)" would run a command, "#{…}" would be replaced by a value.
// $HOME: the job would run with tmux's own folder as its working directory, so the file is named from HOME.
const FORMATS = ['f#(touch $HOME.PWNED_FMT)x', 'p#{pane_id}q', 'a##b #'];
const fmtRan = () => fs.existsSync(`${box.home}.PWNED_FMT`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const recordedDir = () => path.join(box.state, 'recorded');
const recorded = () => {
  try {
    return fs.readdirSync(recordedDir()).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(recordedDir(), f), 'utf8')));
  } catch {
    return [];
  }
};
const pwned = () => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('PWNED')) out.push(path.join(d, e.name));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name));
    }
  };
  walk(box.root);
  return out;
};
const launchFiles = () => {
  try {
    return fs.readdirSync(launchDir());
  } catch {
    return [];
  }
};

/** A backend of `kind` whose terminals run `shell`, recording every byte typed into them and every byte they show. */
/** `c`: the shell runs under the C locale (LANG and LC_ALL "C"), where a line editor may read bytes above 0x7f as Meta keys. */
async function rig(kind, shell, { c = false, launcher = [process.execPath, RECORD] } = {}) {
  const typed = [];
  const shown = [];
  let backend;
  if (kind === 'pty') {
    const { PtyBackend } = await import('../../src/server/backends/pty.mjs');
    ensureSpawnHelper();
    const spawn = (file, args, opts0) => {
      const opts = c ? { ...opts0, env: { ...opts0.env, LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C' } } : opts0;
      const p = ptySpawn(file, args, opts);
      const write = p.write.bind(p);
      p.write = (d) => {
        typed.push(String(d));
        write(d);
      };
      p.onData((d) => shown.push(d));
      return p;
    };
    backend = new PtyBackend({ shell: { file: shell, args: ['-l'] }, spawn });
  } else {
    const { TmuxBackend } = await import('../../src/server/backends/tmux.mjs');
    const socket = `hoprig-f1-${process.pid}-${path.basename(shell)}${c ? '-c' : ''}`;
    sockets.push(socket);
    const conf = path.join(box.root, `${socket}.conf`);
    // A pane's environment is the server's global one: the C locale there, for every pane.
    fs.writeFileSync(conf, `set -g default-shell ${shell}\n${c ? 'set-environment -g LANG C\nset-environment -g LC_ALL C\nset-environment -g LC_CTYPE C\n' : ''}`);
    backend = new TmuxBackend({ socket, configFile: conf });
    const run = backend.run.bind(backend);
    backend.run = (args, o) => {
      if (args[0] === 'send-keys' && args.includes('-l')) typed.push(args[args.length - 1]);
      return run(args, o);
    };
  }
  const deck = new Deck({ backend, config: () => ({ launcher }), profiles: () => [] });
  return { backend, deck, typed, shown };
}

/** Start through the deck, wait for the stand-in's record, and check what every start must hold. */
async function startAndRecord(r, { dir, prompt = null, tool = 'claude' }) {
  const before = recorded().length;
  const typedBefore = r.typed.length;
  const name = await r.deck.start({ tool, dir, profile: { name: 'sub' }, mode: 'new', prompt });
  const rec = await until('the launcher\'s record', () => recorded()[before]);
  const term = (await r.backend.list()).find((t) => t.session === name);
  const line = r.typed.slice(typedBefore).join('');
  // (c) the typed line: the launcher's own command, the flag and a launch file of the launch folder, then the mark.
  assert.match(line, /--launch \S+\.json/, line);
  for (const piece of ['PWNED', 'touch', '\u0015', '\t', '\n', 'hello', 'package', 'quoted', 'xxxxxxxx', 'नमस्ते']) assert.equal(line.includes(piece), false, `the typed line holds "${JSON.stringify(piece)}": ${JSON.stringify(line)}`);
  assert.equal(line.includes(path.basename(dir)), false, 'the folder is not typed');
  assert.equal(/\bcd\b/.test(line), false, 'no cd is typed');
  // (d) the file is gone after the start.
  assert.deepEqual(launchFiles(), [], 'the launch file is gone once it was taken');
  return { name, term, rec, line };
}

const kinds = [...(nodePty ? ['pty'] : []), ...(TMUX ? ['tmux'] : [])];

for (const kind of kinds) {
  for (const shell of SHELLS) {
    const label = `${kind}, ${path.basename(shell)}`;
    test(`${label}: Ctrl-U and Tab in a first message reach the launcher whole and run nothing`, { skip: !POSIX && 'POSIX shells' }, async () => {
      const r = await rig(kind, shell);
      const dir = fs.mkdtempSync(path.join(box.root, 'w-'));
      for (const prompt of [CTRL_U, TAB]) {
        const { rec, name } = await startAndRecord(r, { dir, prompt });
        assert.deepEqual(rec.argv, ['sub', '--', prompt]);
        assert.ok(Buffer.from(rec.argv[2]).equals(Buffer.from(prompt)), 'byte for byte');
        assert.equal(rec.cwd, fs.realpathSync(dir));
        assert.equal(rec.pwd, dir);
        await r.backend.kill(name);
      }
      assert.deepEqual(pwned(), [], 'the shell ran nothing of the message');
      if (kind === 'pty') assert.equal(r.shown.join('').includes('touch PWNED'), false, 'the terminal never showed the message as typed text');
    });

    test(`${label}: a long message of several lines with quotes, $(…), backticks and ! arrives whole`, { skip: !POSIX && 'POSIX shells' }, async () => {
      const r = await rig(kind, shell);
      const dir = fs.mkdtempSync(path.join(box.root, 'w-'));
      const { rec, name, line } = await startAndRecord(r, { dir, prompt: BIG });
      assert.equal(rec.argv[2].length, BIG.length);
      assert.ok(Buffer.from(rec.argv[2]).equals(Buffer.from(BIG)), 'byte for byte, tabs and line ends too');
      assert.ok(line.length < 1000, `the typed line stays short: ${line.length}`);
      assert.deepEqual(pwned(), []);
      await r.backend.kill(name);
    });

    test(`${label}: a folder named with Ctrl-U: the launcher runs in it, nothing of its name is typed or run`, { skip: !POSIX && 'POSIX shells' }, async () => {
      const r = await rig(kind, shell);
      const dir = path.join(fs.mkdtempSync(path.join(box.root, 'w-')), FOLDER);
      fs.mkdirSync(dir);
      const { rec, name } = await startAndRecord(r, { dir, prompt: 'go' });
      assert.equal(rec.cwd, fs.realpathSync(dir));
      assert.ok(Buffer.from(rec.cwd).equals(Buffer.from(fs.realpathSync(dir))));
      assert.deepEqual(rec.argv, ['sub', '--', 'go']);
      assert.deepEqual(pwned(), [], 'the shell ran nothing of the folder\'s name');
      await r.backend.kill(name);
    });

    test(`${label}: folders named like tmux formats (#(…), #{…}, ##, a trailing #): started and moved there, nothing runs`, { skip: !POSIX && 'POSIX shells' }, async () => {
      const r = await rig(kind, shell);
      const parent = fs.mkdtempSync(path.join(box.root, 'w-'));
      for (const folder of FORMATS) {
        const dir = path.join(parent, folder);
        fs.mkdirSync(dir);
        const { rec, name, term } = await startAndRecord(r, { dir, prompt: 'go' });
        assert.ok(Buffer.from(rec.cwd).equals(Buffer.from(fs.realpathSync(dir))), `${JSON.stringify(rec.cwd)} is the folder ${JSON.stringify(folder)}`);
        // A move starts the launcher again in the same terminal (tmux: respawn-pane -c), in the run's folder.
        const count = recorded().length;
        const run = { runId: `fmt-${FORMATS.indexOf(folder)}`, sessionId: '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b', cwd: dir, carryArgs: [], tool: 'claude' };
        await r.deck.move(term, run, 'other', { profile: { name: 'other', env: {} } });
        const moved = await until('the moved launcher', () => recorded()[count]);
        assert.ok(Buffer.from(moved.cwd).equals(Buffer.from(fs.realpathSync(dir))), `moved: ${JSON.stringify(moved.cwd)}`);
        await r.backend.kill(name);
      }
      await wait(300); // a tmux job runs in the background
      assert.equal(fmtRan(), false, 'tmux ran no command from a folder\'s name');
      assert.deepEqual(pwned(), []);
    });

    test(`${label}: under the C locale, a launcher whose path has letters beyond ASCII starts, whole`, { skip: !POSIX && 'POSIX shells' }, async () => {
      // The words that are typed may hold letters of any script (./backends/shell.mjs): the computer's own paths, such
      // as a home folder named in the owner's language. The shell must pass them on as they are in every locale.
      const where = path.join(box.root, `लॉन्चर-é-漢-${kind}-${path.basename(shell)}`);
      fs.mkdirSync(where);
      const link = path.join(where, 'récord.mjs');
      fs.symlinkSync(RECORD, link);
      const r = await rig(kind, shell, { c: true, launcher: [process.execPath, link] });
      const dir = fs.mkdtempSync(path.join(box.root, 'w-'));
      const { rec, name, line, term } = await startAndRecord(r, { dir, prompt: 'go' });
      assert.ok(line.includes(link), `the path was typed: ${JSON.stringify(line)}`);
      assert.deepEqual(rec.argv, ['sub', '--', 'go']);
      // The shell really ran under the C locale.
      await until('the shell is back', async () => (await r.backend.capture(term.id, 20)).includes('RECORDED'));
      await r.backend.sendText(term.id, 'echo "LOCALE=$LC_ALL/$LANG"');
      await r.backend.sendKey(term.id, 'Enter');
      await until('the shell\'s locale', async () => (await r.backend.capture(term.id, 20)).includes('LOCALE=C/C'));
      await r.backend.kill(name);
    });

    test(`${label}: the same start line typed again starts nothing and says so; OpenCode's terminal and a move go the same way`, { skip: !POSIX && 'POSIX shells' }, async () => {
      const r = await rig(kind, shell);
      const dir = fs.mkdtempSync(path.join(box.root, 'w-'));
      const { term, line, name } = await startAndRecord(r, { dir, tool: 'opencode', prompt: CTRL_U });
      const count = recorded().length;
      assert.deepEqual(recorded().at(-1).argv, ['opencode', 'sub', '--', CTRL_U]);
      // The stand-in has ended: the terminal is at its shell. The same line, typed again, as from the shell's history.
      await until('the shell is back', async () => (await r.backend.capture(term.id, 20)).includes('RECORDED'));
      await r.backend.sendText(term.id, line.replace(/^printf '[^']*'; /, ''));
      await r.backend.sendKey(term.id, 'Enter');
      await until('the plain sentence', async () => /used already/.test(await r.backend.capture(term.id, 40)));
      await wait(300);
      assert.equal(recorded().length, count, 'nothing started');
      // A move (another provider) and a restart in place: the same terminal, the same rule.
      const run = { runId: 'r1', sessionId: '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b', cwd: dir, carryArgs: ['--effort', 'low'], tool: 'claude' };
      const typedBefore = r.typed.length;
      await r.deck.move(term, run, 'other', { profile: { name: 'other', env: {} } });
      const moved = await until('the moved launcher', () => recorded()[count]);
      assert.equal(moved.argv[0], 'other');
      assert.equal(moved.cwd, fs.realpathSync(dir));
      assert.match(r.typed.slice(typedBefore).join(''), /--launch \S+\.json; command rm -f /);
      assert.deepEqual(launchFiles(), []);
      assert.deepEqual(pwned(), []);
      await r.backend.kill(name);
    });
  }
}

test('a launcher path with a quote is refused with the plain sentence before anything is made', async () => {
  const made = [];
  const backend = { list: async () => [], create: async (o) => made.push(o), respawn: async (...a) => made.push(a) };
  const deck = new Deck({ backend, config: () => ({ launcher: [process.execPath, "/opt/it's here/bin/hoprig.mjs"] }), profiles: () => [] });
  const before = launchFiles().length;
  await assert.rejects(deck.start({ dir: box.root, profile: { name: 'sub' }, mode: 'new', prompt: 'hi' }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /^Hoprig cannot type this path into a shell: "\/opt\/it's here\/bin\/hoprig\.mjs"\. Only letters, digits, spaces and _ \. \/ : @ % \+ = , - can be typed/);
    return true;
  });
  const run = { runId: 'r', sessionId: '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b', cwd: box.root, carryArgs: [] };
  await assert.rejects(deck.move({ id: 't', session: 's' }, run, 'x', { profile: { name: 'x', env: {} } }), (e) => e.status === 400);
  assert.deepEqual(made, [], 'no terminal made, none restarted');
  assert.equal(launchFiles().length, before, 'no launch file written');
  for (const bad of ['/a\\b', '/a!b', '/a$b', '/a`b', '/a"b', '/a\nb', '/a\u0015b', '/a\tb', '/a~b', '/a*b']) {
    const d = new Deck({ backend, config: () => ({ launcher: [bad] }), profiles: () => [] });
    await assert.rejects(d.start({ dir: box.root, profile: { name: 'sub' }, mode: 'new' }), (e) => e.status === 400 && /cannot type this path into a shell/.test(e.message), JSON.stringify(bad));
  }
});

test('a folder whose name holds a line break is refused at the start with a plain sentence', async () => {
  const backend = { list: async () => [], create: async () => assert.fail('no terminal') };
  const deck = new Deck({ backend, config: () => ({ launcher: [process.execPath, RECORD] }), profiles: () => [] });
  await assert.rejects(deck.start({ dir: '/w/a\nb', profile: { name: 'sub' }, mode: 'new' }), (e) => e.status === 400 && /its name holds a line break/.test(e.message));
  await assert.rejects(deck.shell('/w/a\rb'), (e) => e.status === 400);
  // The same rule on every start: a terminal of the launcher's own (sign-ins, setup), a move or a restart in place.
  const lb = (e) => e.status === 400 && /its name holds a line break/.test(e.message);
  const strict = { ...backend, respawn: async () => assert.fail('nothing stopped') };
  const d2 = new Deck({ backend: strict, config: () => ({ launcher: [process.execPath, RECORD] }), profiles: () => [] });
  await assert.rejects(d2.runLauncher('login', '/w/a\nb', ['login']), lb);
  await assert.rejects(d2.terminal({ name: 'x', dir: '/w/a\nb', argv: null }), lb);
  await assert.rejects(d2.respawn('%1', '/w/a\r\nb', [process.execPath, RECORD, 'sub']), lb);
  const run = { runId: 'r1', sessionId: '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b', cwd: '/w/a\nb', carryArgs: [], tool: 'claude' };
  await assert.rejects(d2.move({ id: '%1', session: 's' }, run, 'other', { profile: { name: 'other', env: {} } }), lb);
  assert.deepEqual(launchFiles(), [], 'no launch file was written');
});
