// The two database folders, one per engine: database/postgresql and database/mysql. A new computer gets both; a
// computer set up before gets only database/mysql (its dry run changes nothing in the whole home), and what is in
// database/postgresql is never touched. The PHP kit says before its one yes that it makes database/mysql with MariaDB,
// and makes only that folder, owner-only and empty, once MariaDB is installed. The kit's runner is a recorder: nothing
// is installed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from './helpers.mjs';

const t = tempHome('ws-db');
test.after(() => t.cleanup());
const { workspaceStatus } = await import('../../src/workspace/layout.mjs');
const { workspaceSetup, setUpFolder } = await import('../../src/workspace/setup.mjs');
const { describeFolder, DESCRIBED } = await import('../../src/workspace/computer.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const posix = process.platform !== 'win32';
const mysql = path.join(t.ws, 'database', 'mysql');
const pg = path.join(t.ws, 'database', 'postgresql');

/** Every entry of the whole home: its kind, mode and, for a file, a hash of its content. */
function snapshot(dir = t.root) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    out[rel] = `${st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file'} ${(st.mode & 0o777).toString(8)}${st.isFile() ? ` ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` : ''}`;
  }
  return out;
}

// A Linux computer with apt and sudo, where PHP, Composer and MariaDB are all missing.
const sys = { platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: t.home, env: { PATH: '/usr/bin' }, clt: true, dnf5: false, has: (b) => b === 'sudo', exists: () => false, list: () => [], which: () => null, run: async () => ({ ok: false, code: 127, stdout: '', stderr: 'not found' }) };  // seal: simulated sys facts; which() and run() are stubbed, no program is started
const noExtras = { suggested: [], php: [], java: null };
async function phpKit({ dryRun = false } = {}) {
  const ran = [];
  const out = [];
  const ui = makeUi({ yes: true, dryRun, interactive: false, write: (x) => out.push(x), askLine: async () => '' });
  await runPcSetup({ ui, kits: ['php'], sys, runner: async (argv) => (ran.push(argv), { ok: true, code: 0, output: '' }), extras: noExtras });
  return { ran, text: out.join('') };
}

test('a new computer: set-up makes database/postgresql and database/mysql (owner-only), and the description names both', async () => {
  const r = await workspaceSetup();
  assert.ok(r.did.some((d) => d.path === '~/Workspace/database/postgresql'));
  assert.ok(r.did.some((d) => d.path === '~/Workspace/database/mysql'));
  for (const d of [pg, mysql]) assert.ok(fs.statSync(d).isDirectory(), d);
  if (posix) assert.equal(fs.statSync(mysql).mode & 0o777, 0o700);
  const st = workspaceStatus();
  const f = st.folders.find((x) => x.id === 'database-mysql');
  assert.deepEqual([f.rel, f.exists, f.purpose], ['database/mysql', true, 'Local MySQL or MariaDB data and dumps.']);
  assert.equal(st.folders.find((x) => x.id === 'database').rel, 'database/postgresql', 'the old id still means PostgreSQL\'s folder');
  // The computer's file describes database/ one level down: both engines' folders, under the key older peers read.
  assert.ok(DESCRIBED.includes('database') && !DESCRIBED.includes('database-mysql'));
  assert.deepEqual(describeFolder(t.ws, 'database').items.map((i) => i.name), ['mysql', 'postgresql']);
});

test('a computer set up before: the dry run names only database/mysql and changes nothing in the home; the real run makes only it', async () => {
  fs.rmdirSync(mysql);
  fs.writeFileSync(path.join(pg, 'dump.sql'), 'mine\n');
  const before = snapshot();
  const dry = await workspaceSetup({ dryRun: true });
  assert.deepEqual(dry.did, [{ path: '~/Workspace/database/mysql', what: 'database/mysql' }]);
  assert.ok(dry.left.some((l) => l.path === '~/Workspace/database/postgresql' && l.why === 'already there'));
  assert.deepEqual(snapshot(), before, 'a dry run changes nothing');
  const r = await workspaceSetup();
  assert.deepEqual(r.did, dry.did, 'what the dry run said is what was done');
  const after = snapshot();
  const added = Object.keys(after).filter((k) => !(k in before));
  assert.deepEqual(added, [path.join('home', 'Workspace', 'database', 'mysql')]);
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} is as it was`);
  assert.equal(fs.readFileSync(path.join(pg, 'dump.sql'), 'utf8'), 'mine\n');
});

test('one folder: made only when missing, never another one, nothing in a folder that is there, nothing without a workspace', async () => {
  fs.rmdirSync(mysql);
  fs.rmdirSync(path.join(t.ws, 'backups'));
  const r = await setUpFolder('database-mysql');
  assert.deepEqual(r.did.map((d) => d.path), ['~/Workspace/database/mysql']);
  assert.equal(fs.existsSync(path.join(t.ws, 'backups')), false, 'only the folder asked for');
  assert.deepEqual(fs.readdirSync(mysql), []);
  assert.deepEqual((await setUpFolder('database-mysql')).did, [], 'there already: nothing');
  fs.mkdirSync(path.join(t.ws, 'backups'));
  const away = path.join(t.root, 'away');
  process.env.HOPRIG_WORKSPACE_DIR = away;
  try {
    const n = await setUpFolder('database-mysql');
    assert.deepEqual(n.did, []);
    assert.match(n.left[0].why, /not set up on this computer yet/);
    assert.equal(fs.existsSync(away), false);
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
  }
});

test('the PHP kit: its dry run says it makes database/mysql with MariaDB and changes nothing; the run makes only that folder', async () => {
  fs.rmdirSync(mysql);
  const before = snapshot();
  const dry = await phpKit({ dryRun: true });
  assert.match(dry.text, /With MariaDB it also makes ~\/Workspace\/database\/mysql\/, the workspace's folder for this database's dumps and local data \(only you can open it\)\. MariaDB keeps its own data where its package puts it\.[^\n]*\n[\s\S]*would ask: Install these 2 steps now\?/, 'said before the one question');
  assert.deepEqual(dry.ran, []);
  assert.deepEqual(snapshot(), before, 'the kit\'s dry run changes nothing');

  const run = await phpKit();
  assert.ok(run.ran.some((argv) => argv.includes('mariadb-server')), 'MariaDB was in the steps');
  assert.match(run.text, /made ~\/Workspace\/database\/mysql\/: the workspace's folder for this database's dumps and local data \(only you can open it\)/);
  assert.deepEqual(fs.readdirSync(mysql), [], 'never a file inside it');
  if (posix) assert.equal(fs.statSync(mysql).mode & 0o777, 0o700);
  const after = snapshot();
  assert.deepEqual(Object.keys(after).filter((k) => !(k in before) && k.startsWith(path.join('home', 'Workspace'))), [path.join('home', 'Workspace', 'database', 'mysql')]);
  assert.equal(fs.readFileSync(path.join(pg, 'dump.sql'), 'utf8'), 'mine\n', 'PostgreSQL\'s folder is never touched');

  const again = await phpKit();
  assert.doesNotMatch(again.text, /database\/mysql/, 'there already: neither said nor made again');
});

test('the docs name both folders as the code makes them: the tree of WORKSPACE.md and README.md, and the kit in PC-SETUP.md', async () => {
  const { TREE } = await import('../../src/workspace/layout.mjs');
  const root = path.resolve(import.meta.dirname, '..', '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const flat = (s) => s.replace(/\s+/g, ' ');
  const ws = read('docs/WORKSPACE.md');
  const tree = ws.slice(ws.indexOf('~/Workspace/\n'), ws.indexOf('```', ws.indexOf('~/Workspace/\n')));
  for (const f of TREE.filter((x) => x.id !== 'projects')) assert.match(tree, new RegExp(`── ${f.rel}/`), `WORKSPACE.md's tree names ${f.rel}/`);
  assert.match(tree, /── database\/mysql\/ +local MySQL or MariaDB data and dumps \(only you can open it\); the PHP kit makes it with MariaDB/);
  assert.match(read('README.md'), /── git\/ {3}database\/postgresql\/ {3}database\/mysql\/ {3}backups\//);
  assert.match(flat(read('docs/PC-SETUP.md')), /With MariaDB the kit also makes the workspace's folder `database\/mysql\/` when it is missing \(only that folder, which only you can open, never a file inside it\), and says so before the one question and in its dry run\. .* MariaDB's own data folder is not moved or changed/);
  assert.match(flat(read('site/content/changelog.md')), /\*\*Two database folders, one per engine\.\*\* The workspace has `database\/mysql\/` beside `database\/postgresql\/`/);
});

test('the PHP kit leaves a file in the way alone and says so; without MariaDB in the steps it makes no folder', async () => {
  fs.rmdirSync(mysql);
  fs.writeFileSync(mysql, 'a file\n');
  const r = await phpKit();
  assert.doesNotMatch(r.text, /With MariaDB it also makes/, 'nothing to make: not promised');
  assert.equal(fs.readFileSync(mysql, 'utf8'), 'a file\n');
  fs.rmSync(mysql);
  // MariaDB here already: the kit installs PHP and Composer only, and the folder is left to `workspace setup`.
  const here = { ...sys, has: (b) => ['sudo', 'mariadbd'].includes(b), run: async (argv) => (argv.join(' ') === 'mariadbd --version' ? { ok: true, code: 0, stdout: 'mariadbd  Ver 11.8.6-MariaDB', stderr: '' } : sys.run(argv)) };
  const out = [];
  const ran = [];
  await runPcSetup({ ui: makeUi({ yes: true, interactive: false, write: (x) => out.push(x), askLine: async () => '' }), kits: ['php'], sys: here, runner: async (argv) => (ran.push(argv), { ok: true, code: 0, output: '' }), extras: noExtras });
  assert.ok(ran.length && !ran.some((argv) => argv.includes('mariadb-server')));
  assert.equal(fs.existsSync(mysql), false);
  assert.doesNotMatch(out.join(''), /database\/mysql/);
});

test('the Setup tab: the sheet of the PHP kit carries the folder sentence while database/mysql is missing, and none once it is there', async () => {
  const { Readable } = await import('node:stream');
  const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
  const sctx = { readJson: async () => ({}), backend: { list: async () => [] }, deck: { launcher: () => ['node', 'hoprig'], terminal: async () => {} } };
  const f = pcsetupFeature(sctx, { computer: () => 'box2', sys, projectsDir: () => path.join(t.ws, 'projects'), sudoNeedsPassword: async () => false, extras: noExtras });
  const kits = async () => {
    const [, , fn] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/pcsetup/kits'));
    return (await fn(Readable.from([]), null, new URLSearchParams())).kits.find((k) => k.id === 'php');
  };
  assert.equal(fs.existsSync(mysql), false);
  assert.deepEqual((await kits()).folder, ['With MariaDB it also makes ~/Workspace/database/mysql/, the workspace\'s folder for this database\'s dumps and local data (only you can open it). MariaDB keeps its own data where its package puts it.']);
  assert.equal(fs.existsSync(mysql), false, 'the sheet changes nothing');
  fs.mkdirSync(mysql);
  assert.deepEqual((await kits()).folder, []);
});
