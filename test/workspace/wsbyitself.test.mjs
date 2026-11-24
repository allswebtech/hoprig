// What this part of the workspace (which computer has what, the page's drop, who may) does BY ITSELF in the real
// dashboard: nothing. On an isolated home with a brain, two computers' files and a group, a real server start and
// three automation ticks leave the whole home as it was (paths, sizes, modes, contents; the brain's refs and status),
// and no file call or program start comes from whohas.mjs, dropweb.mjs or whomay.mjs. One request of the page then
// reads them, so the watch is shown to see them.
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dropWorld } from './dropfix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'automation', 'fixtures', 'fake-claude.mjs');
const posix = process.platform !== 'win32';
const OURS = /src[\\/]workspace[\\/](whohas|dropweb|whomay)\.mjs/;

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
const gitOut = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const brainState = (brain) => ({ refs: gitOut(brain, 'for-each-ref', '--format=%(refname) %(objectname)'), status: gitOut(brain, 'status', '--porcelain=v1', '--branch') });

/** File calls and program starts whose stack holds one of this part's modules. */
function watch() {
  const seen = { ours: [] };
  let on = true;
  const orig = { cp: {}, fs: {} };
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    orig.cp[k] = childProcess[k];
    childProcess[k] = function (file, ...rest) {
      if (on && OURS.test(new Error().stack)) seen.ours.push(`${k} ${file}`);
      return orig.cp[k].call(this, file, ...rest);
    };
  }
  for (const k of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'writeFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync']) {
    orig.fs[k] = fs[k];
    const wrapped = function (p, ...rest) {
      if (on && OURS.test(new Error().stack)) seen.ours.push(`${k} ${typeof p === 'string' ? p : ''}`);
      return orig.fs[k].call(this, p, ...rest);
    };
    Object.assign(wrapped, orig.fs[k]);
    fs[k] = wrapped;
  }
  syncBuiltinESMExports();
  seen.pause = () => (on = false);
  seen.resume = () => (on = true);
  seen.stop = () => {
    Object.assign(childProcess, orig.cp);
    Object.assign(fs, orig.fs);
    syncBuiltinESMExports();
  };
  return seen;
}

test('a server start and three ticks: this part runs nothing, reads nothing and changes nothing; one page request reads', { timeout: 120_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const w = await dropWorld('byitself', { labels: ['desk', 'box2'], group: true });
  const [D] = w.computers;
  D.use();
  process.env.HOPRIG_WORKSPACE_DIR = D.ws; // a workspace of its own: never the real one
  // Traps first on PATH: none of these may be reached.
  const traps = path.join(w.root, 'traps');
  const trapped = path.join(w.root, 'trapped.log');
  fs.mkdirSync(traps);
  for (const n of ['ssh', 'sudo', 'systemctl', 'loginctl', 'npm', 'apt-get']) fs.writeFileSync(path.join(traps, n), `#!/bin/sh\necho "${n} $*" >> '${trapped}'\nexit 99\n`, { mode: 0o755 });
  process.env.PATH = `${traps}${path.delimiter}${process.env.PATH}`;
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const claudeBin = path.join(w.root, 'fake-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`, { mode: 0o755 });
  saveConfig({ claudeBin, usage: false, server: { backend: 'pty', roots: [D.home], passwordHash: await hashPassword('pw-for-tests') } });
  // Both computers' files are in the brain's history, as on a real pair of computers, and up to date with what each
  // has now (the group was cloned after the labels were given): the upkeep then has nothing of its own to write.
  const C = await import('../../src/workspace/computer.mjs');
  for (const c of w.computers) {
    c.use();
    await C.writeOwnFile(c.ctx);
    gitOut(c.brain, 'pull', '-q', '--rebase');
    gitOut(c.brain, 'add', '--', 'computers');
    if (gitOut(c.brain, 'status', '--porcelain')) gitOut(c.brain, 'commit', '-q', '-m', `computer ${path.basename(c.home)}`);
    gitOut(c.brain, 'push', '-q');
  }
  D.use();
  process.env.HOPRIG_WORKSPACE_DIR = D.ws;
  gitOut(D.brain, 'pull', '-q', '--rebase');

  const before = snapshot(w.root);
  const brainBefore = brainState(D.brain);
  const seen = watch();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `wsbyitself-${process.pid}` });
  const { port } = await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const auto = app.features.find((f) => f.name === 'automation').automation;
  for (let i = 0; i < 3; i++) await auto.tick();
  await new Promise((r) => setTimeout(r, 500));
  seen.pause();
  const quiet = [...seen.ours];
  const after = snapshot(w.root);
  const brainAfter = brainState(D.brain);

  assert.deepEqual(quiet, [], 'no file call and no program from this part');
  // The dashboard's own state folder (its sessions, its tokens' use) is the server's, not the owner's files.
  const changed = changes(before, after).filter((f) => !f.startsWith('desk/.state'));
  assert.deepEqual(changed, [], 'nothing in the home changed: paths, sizes, modes, contents');
  assert.deepEqual(brainAfter, brainBefore, 'the brain\'s refs and status are as they were');
  assert.equal(fs.existsSync(trapped) ? fs.readFileSync(trapped, 'utf8') : '', '', 'no trapped program');

  // One request of the page: now the watch must see the reader (it would have seen it above).
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const asked = snapshot(w.root); // the sign-in keeps what the password is like in config.json: the login's, not ours
  seen.resume();
  const r = await fetch(`${base}/api/workspace/whohas`, { headers: { Cookie: cookie } });
  seen.pause();
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.computers.map((c) => c.label).sort(), ['box2', 'desk']);
  assert.ok(seen.ours.length > 0, 'the watch sees the reader when the page asks');
  assert.deepEqual(changes(asked, snapshot(w.root)).filter((f) => !f.startsWith('desk/.state')), [], 'even asked, nothing in the home changes');
});
