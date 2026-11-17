// The one-time cleanup of what VS Code Server left, on a made-up state folder and temp folder (never the real ones):
// its folder and dead socket folders go, a live socket folder stays, a leftover server is stopped only when its
// command line carries our own folder, the settings key goes, and it all runs once.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor-cleanup');
test.after(() => box.cleanup());
const { cleanupVscode, MARKER } = await import('../../src/editor/cleanup.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');

const quiet = () => {};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A stand-in process in a group of its own whose command line carries `args`. */
function fake(args) {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { detached: true, stdio: 'ignore' });
  p.unref();
  return p;
}
const waitGone = async (pid) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};

function stateWith(name, pidRec, tmp = path.join(box.root, name, 'tmp')) {
  const state = path.join(box.root, name, 'state');
  const data = path.join(state, 'vscode');
  fs.mkdirSync(path.join(data, 'cli'), { recursive: true });
  fs.mkdirSync(path.join(data, 'server', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'cli', 'code-server.bin'), Buffer.alloc(2 * 1024 * 1024));
  fs.mkdirSync(tmp, { recursive: true });
  if (pidRec) fs.writeFileSync(path.join(data, 'server.pid'), JSON.stringify(pidRec(data, tmp)));
  return { state, tmp, data };
}

test('POSIX: our leftover server is stopped, its folders and the settings key removed, and it runs once', { skip: process.platform === 'win32' }, async (t) => {
  let proc;
  // A Unix socket's path has room for 103 bytes on macOS (107 on Linux), and macOS's own temp folder takes about 50 of
  // them: under the test's folder there, the live socket's path was longer, Node cut it short to the folder itself,
  // and the listen failed with EADDRINUSE. The real temp folder plus hoprig-vscode-XXXXXX/vs.sock is about 77.
  const shortTmp = fs.mkdtempSync('/tmp/hv-');
  t.after(() => fs.rmSync(shortTmp, { recursive: true, force: true }));
  const { state, tmp, data } = stateWith('ours', (d, tm) => {
    proc = fake(['serve-web', '--cli-data-dir', path.join(d, 'cli')]);
    return { pid: proc.pid, run: path.join(tm, 'hoprig-vscode-ours'), marker: path.join(d, 'cli') };
  }, shortTmp);
  t.after(() => alive(proc.pid) && process.kill(-proc.pid, 'SIGKILL'));
  fs.mkdirSync(path.join(tmp, 'hoprig-vscode-ours'));
  fs.mkdirSync(path.join(tmp, 'hoprig-vscode-dead'));
  fs.writeFileSync(path.join(tmp, 'hoprig-vscode-dead', 'vs.sock'), ''); // a socket file nothing listens on
  fs.mkdirSync(path.join(tmp, 'hoprig-vscode-live'));
  fs.mkdirSync(path.join(tmp, 'something-else'));
  const live = net.createServer().listen(path.join(tmp, 'hoprig-vscode-live', 'vs.sock'));
  await new Promise((r, fail) => live.once('listening', r).once('error', fail));
  t.after(() => live.close());
  saveConfig({ vscode: { enabled: true, idleMinutes: 15 }, keep: 1 });
  const lines = [];

  const r = await cleanupVscode(state, { tmpDir: tmp, config: loadConfig, saveConfig, log: (m) => lines.push(m) });
  assert.equal(r.ran, true);
  assert.deepEqual(r.stopped, [proc.pid]);
  assert.ok(await waitGone(proc.pid), 'the leftover server ended');
  assert.equal(fs.existsSync(data), false, 'its state folder is gone');
  assert.ok(r.removedBytes >= 2 * 1024 * 1024);
  assert.match(lines.join('\n'), /Removed the VS Code Server files .*\(2 MB\)/);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['hoprig-vscode-live', 'something-else'], 'a folder whose socket still answers stays');
  assert.equal(r.configKey, true);
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8'));
  assert.deepEqual([('vscode' in raw), raw.keep], [false, 1]);
  assert.ok(fs.existsSync(path.join(state, MARKER)));

  // Once: a second start does nothing, even when something like it appears again.
  fs.mkdirSync(path.join(data), { recursive: true });
  const again = await cleanupVscode(state, { tmpDir: tmp, config: loadConfig, saveConfig, log: quiet });
  assert.equal(again.ran, false);
  assert.equal(fs.existsSync(data), true);
});

test('POSIX: a process with the recorded number but without our folder on its command line is never stopped', { skip: process.platform === 'win32' }, async (t) => {
  let proc;
  const { state, tmp, data } = stateWith('stranger', (d, tm) => {
    proc = fake(['some-other-program', '--cli-data-dir', '/elsewhere/cli']); // the number was reused by another program
    return { pid: proc.pid, run: path.join(tm, 'hoprig-vscode-x'), marker: '/elsewhere/cli' }; // a marker the file claims is not trusted
  });
  t.after(() => alive(proc.pid) && process.kill(-proc.pid, 'SIGKILL'));
  const r = await cleanupVscode(state, { tmpDir: tmp, log: quiet });
  assert.deepEqual(r.stopped, []);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive(proc.pid), true, 'still running');
  assert.equal(fs.existsSync(data), false, 'the files go anyway');
});

test('a computer that never used it: nothing is looked at in the temp folder, the settings stay, the marker is written', async () => {
  const state = path.join(box.root, 'never', 'state');
  const tmp = path.join(box.root, 'never', 'tmp');
  fs.mkdirSync(path.join(tmp, 'hoprig-vscode-abc'), { recursive: true });
  let psCalls = 0;
  let saved = 0;
  const r = await cleanupVscode(state, { tmpDir: tmp, ps: () => (psCalls++, ''), config: () => ({ server: {} }), saveConfig: () => saved++, log: quiet });
  assert.deepEqual([r.ran, r.stopped, r.removedTmp, r.configKey, psCalls, saved], [true, [], [], false, 0, 0]);
  assert.ok(fs.existsSync(path.join(tmp, 'hoprig-vscode-abc')), 'another install\'s folder is not touched');
  assert.ok(fs.existsSync(path.join(state, MARKER)));
});

test('the dashboard runs it at start, in its own state folder', async () => {
  const { createServer } = await import('../../src/server/server.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const state = process.env.HOPRIG_STATE_DIR;
  fs.mkdirSync(path.join(state, 'vscode', 'server'), { recursive: true });
  saveConfig({ server: { passwordHash: await hashPassword('pw'), port: 1 }, vscode: { enabled: false } });
  const tmp = path.join(box.root, 'start-tmp');
  fs.mkdirSync(tmp);
  const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
  const app = createServer({ backend, watch: false, dashboardFile: false, machines: { claudeVersion: async () => null }, editor: { cleanup: { tmpDir: tmp, log: quiet } } });
  await app.listen(0, '127.0.0.1');
  try {
    for (let i = 0; i < 50 && !fs.existsSync(path.join(state, MARKER)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(path.join(state, MARKER)));
    assert.equal(fs.existsSync(path.join(state, 'vscode')), false);
    assert.equal('vscode' in JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8')), false);
  } finally {
    await app.close();
  }
});

test('only what the feature made goes: another program\'s files in a "vscode" folder stay, and so does the folder', async () => {
  const { state, data } = stateWith('shared');
  fs.writeFileSync(path.join(data, 'server.pid'), '{}');
  fs.mkdirSync(path.join(data, 'theirs'));
  fs.writeFileSync(path.join(data, 'theirs', 'keep.txt'), 'not ours');
  const lines = [];
  const r = await cleanupVscode(state, { tmpDir: path.join(box.root, 'shared', 'tmp'), log: (m) => lines.push(m) });
  assert.equal(r.ran, true);
  assert.deepEqual(fs.readdirSync(data), ['theirs'], 'cli/, server/ and server.pid went; the rest stays');
  assert.equal(fs.readFileSync(path.join(data, 'theirs', 'keep.txt'), 'utf8'), 'not ours');
  assert.match(lines.join('\n'), /holds files the dashboard did not make/);
  assert.ok(fs.existsSync(path.join(state, MARKER)));
});

test('the run-once marker is written only when the files went: a failed removal is tried again at the next start', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { state, data } = stateWith('stuck');
  fs.chmodSync(path.join(data, 'cli'), 0o500); // its file cannot be removed
  try {
    const r = await cleanupVscode(state, { tmpDir: path.join(box.root, 'stuck', 'tmp'), log: quiet });
    assert.equal(r.ran, true);
    assert.equal(fs.existsSync(path.join(state, MARKER)), false);
  } finally {
    fs.chmodSync(path.join(data, 'cli'), 0o700);
  }
  const again = await cleanupVscode(state, { tmpDir: path.join(box.root, 'stuck', 'tmp'), log: quiet });
  assert.equal(again.ran, true);
  assert.equal(fs.existsSync(data), false);
  assert.ok(fs.existsSync(path.join(state, MARKER)));
});

test('temp folders: another user\'s, and a young one without a socket yet (a server still starting), stay', { skip: process.platform === 'win32' }, async () => {
  const { state, tmp } = stateWith('tmpdirs');
  for (const n of ['hoprig-vscode-old', 'hoprig-vscode-young']) fs.mkdirSync(path.join(tmp, n));
  const later = Date.now() + 60 * 60_000;
  fs.utimesSync(path.join(tmp, 'hoprig-vscode-young'), later / 1000, later / 1000);
  // As another user: nothing in the temp folder is this user's.
  const old = () => Date.now() + 30 * 60_000;
  const other = await cleanupVscode(state, { tmpDir: tmp, uid: (process.getuid?.() ?? 0) + 1, now: old, log: quiet });
  assert.deepEqual(other.removedTmp, []);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['hoprig-vscode-old', 'hoprig-vscode-young']);
  fs.rmSync(path.join(state, MARKER));
  fs.mkdirSync(path.join(state, 'vscode'), { recursive: true });
  const mine = await cleanupVscode(state, { tmpDir: tmp, now: old, log: quiet });
  assert.deepEqual(mine.removedTmp.map((d) => path.basename(d)), ['hoprig-vscode-old']);
  assert.deepEqual(fs.readdirSync(tmp), ['hoprig-vscode-young']);
});
