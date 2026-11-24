// What the box does BY ITSELF in the real dashboard: nothing. A real server start and three automation ticks on an
// isolated home leave the home as it was (paths, sizes, modes, contents), start no bwrap or sandbox-exec, and make no
// file call or program start from src/box. The box runs only when a command or a feature's wiring asks for it.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const OURS = /src[\\/]box[\\/]/;
const MEANS = /(^|[\\/])(bwrap|sandbox-exec)$/;

/** Every path under `root` → kind, size, mode and a hash of its content (a link: where it points). */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      const st = fs.lstatSync(p);
      if (e.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) {
        out[rel] = `dir ${(st.mode & 0o7777).toString(8)}`;
        walk(p);
      } else out[rel] = `file ${st.size} ${(st.mode & 0o7777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

/** Program starts of the means, and file calls or program starts whose stack holds a module of src/box. */
function watch() {
  const seen = [];
  const orig = { cp: {}, fs: {} };
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    orig.cp[k] = childProcess[k];
    childProcess[k] = function (file, ...rest) {
      if (MEANS.test(String(file)) || OURS.test(new Error().stack)) seen.push(`${k} ${file}`);
      return orig.cp[k].call(this, file, ...rest);
    };
  }
  for (const k of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync', 'mkdtempSync', 'writeFileSync', 'mkdirSync', 'rmSync']) {
    orig.fs[k] = fs[k];
    const wrapped = function (p, ...rest) {
      if (OURS.test(new Error().stack)) seen.push(`${k} ${typeof p === 'string' ? p : ''}`);
      return orig.fs[k].call(this, p, ...rest);
    };
    Object.assign(wrapped, orig.fs[k]);
    fs[k] = wrapped;
  }
  syncBuiltinESMExports();
  return {
    seen,
    stop() {
      Object.assign(childProcess, orig.cp);
      Object.assign(fs, orig.fs);
      syncBuiltinESMExports();
    },
  };
}

test('a server start and three ticks: the box runs nothing, reads nothing and changes nothing', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  // This test's own temporary folder: the self-test of the box makes its folders under os.tmpdir(), and other box
  // test files run beside this one in the same shared one. Pointing TMPDIR here before src/box is imported keeps the
  // check below ("the box made no temporary folder") about THIS test's folder, never another file's by chance.
  const privTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'box-byitself-priv-'));
  const origTmp = process.env.TMPDIR;
  process.env.TMPDIR = privTmp;
  const dirs = sandbox('box-byitself');
  process.env.HOME = dirs.home;
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ claudeBin: path.join(dirs.root, 'no-claude'), usage: false, server: { backend: 'pty', roots: [dirs.home], passwordHash: await hashPassword('pw-for-tests') } });
  fs.writeFileSync(path.join(dirs.home, 'notes.txt'), 'made-up notes');
  const before = snapshot(dirs.root);
  const boxTmp = () => fs.readdirSync(path.dirname(dirs.root)).filter((n) => /^hoprig-box-/.test(n)).sort();
  const tmpBefore = boxTmp();
  const w = watch();
  let app = null;
  t.after(async () => {
    w.stop();
    if (app) await app.close().catch(() => {});
    dirs.cleanup();
    if (origTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = origTmp;
    fs.rmSync(privTmp, { recursive: true, force: true });
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `box-byitself-${process.pid}` });
  await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const auto = app.features.find((f) => f.name === 'automation').automation;
  for (let i = 0; i < 3; i++) await auto.tick();
  await new Promise((r) => setTimeout(r, 500));
  const seen = [...w.seen];
  w.stop();
  const after = snapshot(dirs.root);

  assert.deepEqual(seen, [], 'no start of the means, and no file call or program from src/box');
  // The dashboard's own state folder (its sessions, its tokens' use) is the server's, not the box's.
  assert.deepEqual(changes(before, after).filter((f) => !f.startsWith('state/') && f !== 'state'), [], 'nothing outside the dashboard\'s own state changed');
  // The box makes its temporary folders under the system's temporary folder: the start made none.
  assert.deepEqual(boxTmp(), tmpBefore);
});
