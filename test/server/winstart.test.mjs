// A start on Windows, given Windows' answers through the platform the code takes, on any OS. Nothing is typed into a
// Windows terminal: the built-in terminal (ConPTY) gets the launcher's argv as one command line. When the program is an
// .exe no shell reads that line, so a backslash, a space, an apostrophe, a % or a $ in a path is only a character; a
// double quote or a line break would end the word or the line. A .cmd or .bat program is started through cmd.exe,
// which reads % ! ^ & | < > in the line: none of them may be in any word of such a start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('winstart');
test.after(() => box.cleanup());
const { assertTypable } = await import('../../src/server/backends/shell.mjs');
const { PtyBackend } = await import('../../src/server/backends/pty.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { launchDir } = await import('../../src/launchfile.mjs');

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SCRIPT = 'C:\\Program Files\\nodejs\\node_modules\\hoprig\\bin\\hoprig.mjs';
const FILE = 'C:\\Users\\alpha\\AppData\\Local\\hoprig\\state\\launch\\0123456789abcdef0123456789abcdef.json';
const CMD = 'C:\\Users\\alpha\\AppData\\Roaming\\npm\\hoprig.cmd';

test('a node.exe launcher: its path as it is, with a space, an apostrophe, a % or a $; a double quote or a line break is refused', () => {
  const fine = [
    NODE,
    'C:\\hostedtoolcache\\windows\\node\\24.22.3\\x64\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    "C:\\Users\\o'brien\\node.exe",
    'C:\\tools\\50%\\node.exe',
    'C:\\tools\\%shop%\\node.exe',
    'C:\\tools\\$shop\\node.exe',
    'C:\\tools\\a & b!c^d\\node.exe',
  ];
  for (const node of fine) {
    assert.doesNotThrow(() => assertTypable([node, SCRIPT, '--launch', FILE], 'win32'), node);
    assert.throws(() => assertTypable([node], 'linux'), (e) => e.status === 400, `a POSIX shell would read it: ${node}`);
  }
  for (const bad of ['C:\\Program Files\\node"js\\node.exe', 'C:\\Program Files\\nodejs\nnode.exe', 'C:\\Program Files\\nodejs\r\\node.exe', 'C:\\a\tb\\node.exe', '']) {
    assert.throws(() => assertTypable([bad, SCRIPT, '--launch', FILE], 'win32'), (e) => e.status === 400, JSON.stringify(bad));
    assert.throws(() => assertTypable([NODE, SCRIPT, '--launch', bad], 'win32'), (e) => e.status === 400, `the launch file's word too: ${JSON.stringify(bad)}`);
  }
});

test('the Windows sentence says what Windows refuses, not the list of a POSIX shell', () => {
  const word = 'C:\\Program Files\\node"js\\node.exe';
  assert.throws(() => assertTypable([word], 'win32'), (e) => {
    assert.equal(e.status, 400);
    assert.ok(e.message.startsWith(`Hoprig cannot type this path into a shell: ${JSON.stringify(word)}. On Windows a word of the start cannot hold a quote, a line break or another control character: `), e.message);
    assert.doesNotMatch(e.message, /Only letters, digits/);
    assert.doesNotMatch(e.message, /cmd\.exe/, 'an .exe is not started through cmd.exe');
    return true;
  });
  assert.throws(() => assertTypable([CMD, '--launch', 'C:\\a%b\\x.json'], 'win32'), (e) => /nor any of % ! \^ & \| < > when the program is a \.cmd or \.bat file \(Windows starts it through cmd\.exe\)/.test(e.message));
  assert.throws(() => assertTypable(["/opt/it's here/bin/hoprig.mjs"], 'linux'), (e) => /^Hoprig cannot type this path into a shell: "\/opt\/it's here\/bin\/hoprig\.mjs"\. Only letters, digits, spaces and _ \. \/ : @ % \+ = , - can be typed: /.test(e.message), 'the POSIX sentence as before');
});

test('a .cmd or .bat launcher goes through cmd.exe: a word with % ! ^ & | < > is refused, a plain one starts', () => {
  assert.doesNotThrow(() => assertTypable([CMD, '--launch', FILE], 'win32'));
  assert.doesNotThrow(() => assertTypable(["C:\\Users\\o'brien\\npm\\hoprig.cmd", '--launch', 'C:\\Users\\$shop\\launch\\a.json'], 'win32'), 'an apostrophe or a $ reads nothing in cmd.exe');
  for (const bad of ['C:\\Users\\a%PATH%b\\state\\launch\\a.json', 'C:\\a!b\\x.json', 'C:\\a^b\\x.json', 'C:\\a & b\\x.json', 'C:\\a|b\\x.json', 'C:\\a<b\\x.json', 'C:\\a>b\\x.json']) {
    assert.throws(() => assertTypable([CMD, '--launch', bad], 'win32'), (e) => e.status === 400 && e.message.includes(JSON.stringify(bad)), bad);
  }
  for (const prog of ['C:\\a & b\\hoprig.cmd', 'C:\\a%x%\\HOPRIG.CMD', 'C:\\a!b\\run.Bat']) {
    assert.throws(() => assertTypable([prog, '--launch', FILE], 'win32'), (e) => e.status === 400 && e.message.includes(JSON.stringify(prog)), prog);
  }
  // The same words after an .exe: no shell reads them there.
  assert.doesNotThrow(() => assertTypable([NODE, '--launch', 'C:\\Users\\a%PATH%b\\x.json', 'C:\\a & b!^\\x.json'], 'win32'));
});

/** The built-in terminal of Windows against a stand-in for node-pty: what it was started with, and what was typed. */
function windowsBackend() {
  const procs = [];
  const spawn = (file, args, opts) => {
    const exits = [];
    const p = {
      file, args, opts, pid: 4000 + procs.length, process: file, written: [],
      onData: () => {},
      onExit: (f) => exits.push(f),
      write: (d) => p.written.push(d),
      resize: () => {},
      kill: () => setImmediate(() => exits.splice(0).forEach((f) => f({ exitCode: 0 }))),
    };
    procs.push(p);
    return p;
  };
  return { backend: new PtyBackend({ platform: 'win32', spawn, descendants: async () => [] }), procs };
}
const launchFiles = () => {
  try {
    return fs.readdirSync(launchDir());
  } catch {
    return [];
  }
};

test('a start by launch file in a Windows terminal: node.exe under C:\\Program Files starts with the script and the file, nothing typed', async () => {
  for (const node of [NODE, "C:\\Users\\o'brien\\50% $shop\\node.exe"]) {
    const { backend, procs } = windowsBackend();
    try {
      const deck = new Deck({ backend, config: () => ({ launcher: [node, SCRIPT] }), profiles: () => [], root: false });
      await deck.start({ dir: box.root, profile: { name: 'shop' }, mode: 'new', prompt: 'first "message" & %PATH%\nline two' });
      assert.equal(procs.length, 1, node);
      const [p] = procs;
      assert.equal(p.file, node, 'the program as it is: ConPTY quotes it into the one command line');
      assert.equal(p.args.length, 3);
      assert.deepEqual(p.args.slice(0, 2), [SCRIPT, '--launch']);
      assert.equal(path.dirname(p.args[2]), launchDir());
      assert.deepEqual(p.written, [], 'nothing typed into it');
      const held = JSON.parse(fs.readFileSync(p.args[2], 'utf8'));
      assert.deepEqual([held.cwd, held.argv], [box.root, ['shop', '--', 'first "message" & %PATH%\nline two']], 'the first message only in the file');
      fs.rmSync(p.args[2], { force: true });
    } finally {
      await backend.close();
    }
  }
});

test('a Windows terminal refuses a launcher with a quote, a line break, or a cmd.exe word, before anything is made', async () => {
  for (const launcher of [['C:\\Program Files\\node"js\\node.exe', SCRIPT], [NODE, 'C:\\hoprig\nbin\\hoprig.mjs'], ['C:\\a & b\\npm\\hoprig.cmd'], ['C:\\Users\\a%USERNAME%b\\npm\\hoprig.cmd']]) {
    const { backend, procs } = windowsBackend();
    try {
      const deck = new Deck({ backend, config: () => ({ launcher }), profiles: () => [], root: false });
      const before = launchFiles().length;
      await assert.rejects(deck.start({ dir: box.root, profile: { name: 'shop' }, mode: 'new', prompt: 'hi' }), (e) => e.status === 400 && /^Hoprig cannot type this path into a shell: /.test(e.message), JSON.stringify(launcher));
      assert.equal(procs.length, 0, 'no terminal started');
      assert.equal(launchFiles().length, before, 'no launch file written');
    } finally {
      await backend.close();
    }
  }
  // A plain .cmd launcher starts: cmd.exe reads nothing in its words.
  const { backend, procs } = windowsBackend();
  try {
    const deck = new Deck({ backend, config: () => ({ launcher: [CMD] }), profiles: () => [], root: false });
    await deck.start({ dir: box.root, profile: { name: 'shop' }, mode: 'new', prompt: 'a & b %PATH%' });
    assert.deepEqual([procs[0].file, procs[0].args[0]], [CMD, '--launch']);
    assert.deepEqual(procs[0].written, []);
    fs.rmSync(procs[0].args[1], { force: true });
  } finally {
    await backend.close();
  }
});
