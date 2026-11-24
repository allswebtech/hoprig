// The credentials repository on restore (restore.mjs): owner-only from its first file on, cloned after workspace
// setup made its starting folder, a failed clone that a second restore finishes, and git's own reason when it fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-restorecreds');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { workspaceSetup } = await import('../../src/workspace/setup.mjs');
const { stream } = await import('../../src/setup/system.mjs');

let n = 0;
/** A brain on the server whose map names the credentials repository `creds` (made on the server only when `made`). */
function brainNaming(made = true) {
  const k = ++n;
  const brainUrl = w.bare(`brain${k}`, { empty: true });
  const creds = made ? w.bare(`creds${k}`) : w.url(`creds${k}`);
  const A = w.computer(`a${n}`);
  A.use();
  const brain = path.join(A.ws, 'ai_brain');
  w.sh(A.home, 'clone', '-q', brainUrl, brain);
  w.commit(brain, 'BRAIN.md', '# brain\n');
  M.writeMap({ version: 2, groups: [], brain: { url: brainUrl }, credentials: { url: creds }, projects: [], others: [] }, A.ws);
  w.sh(brain, 'add', '-A');
  w.sh(brain, 'commit', '-q', '-m', 'map');
  w.sh(brain, 'push', '-q', '-u', 'origin', 'main');
  return { brainUrl, creds, makeCreds: () => w.bare(`creds${k}`) };
}
const mode = (d) => fs.statSync(d).mode & 0o777;

test('the credentials folder is owner-only before git writes its first file', async () => {
  const { brainUrl } = brainNaming();
  const B = w.computer(`b${n}`);
  B.use();
  const cdir = path.join(B.ws, 'credentials');
  const seen = [];
  const runner = (argv, o) => {
    if (argv.includes('clone') && argv.at(-1) === cdir) seen.push(fs.existsSync(cdir) ? mode(cdir) : 'not there');
    return stream(argv, o);
  };
  const { ui } = await quietUi();
  const r = await restoreWorkspace(brainUrl, { ui, dir: B.ws, runner });
  assert.equal(r.plan.find((e) => e.kind === 'credentials').result, 'cloned');
  assert.deepEqual(seen, [0o700], 'the folder git clones into is owner-only already');
  assert.equal(mode(cdir), 0o700);
  assert.ok(fs.existsSync(path.join(cdir, '.git')));
});

test('restore after workspace setup: the starting credentials folder is kept aside and the repository is cloned', async () => {
  const { brainUrl } = brainNaming();
  const B = w.computer(`b${n}`);
  B.use();
  await workspaceSetup({ cfg: { workspaceDir: B.ws, projectsDir: path.join(B.ws, 'projects') } });
  assert.ok(fs.existsSync(path.join(B.ws, 'credentials', 'README.md')), 'setup made its starting folder');
  const { ui } = await quietUi();
  const r = await restoreWorkspace(brainUrl, { ui, dir: B.ws });
  assert.equal(r.plan.find((e) => e.kind === 'credentials').result, 'cloned');
  assert.ok(fs.existsSync(path.join(B.ws, 'credentials', '.git')));
  const aside = fs.readdirSync(B.ws).filter((x) => x.startsWith('credentials.unused-'));
  assert.equal(aside.length, 1, 'kept next to it, never deleted');
  assert.ok(fs.existsSync(path.join(B.ws, aside[0], 'README.md')));
});

test('a credentials clone that failed: no starting folder is made in its place, and a second restore clones it', async () => {
  const { brainUrl, makeCreds } = brainNaming(false);
  const B = w.computer(`b${n}`);
  B.use();
  const { ui } = await quietUi();
  const r1 = await restoreWorkspace(brainUrl, { ui, dir: B.ws });
  // git's own reason, not its last words ("and the repository exists.").
  assert.match(r1.plan.find((e) => e.kind === 'credentials').result, /^failed: .*(does not appear to be a git repository|not found)/i);
  const cdir = path.join(B.ws, 'credentials');
  assert.equal(fs.existsSync(path.join(cdir, 'README.md')), false, 'set-up\'s starting folder is not made where the repository goes');
  makeCreds();
  const r2 = await restoreWorkspace(brainUrl, { ui, dir: B.ws });
  assert.equal(r2.plan.find((e) => e.kind === 'credentials').result, 'cloned', JSON.stringify(r2.plan[1]));
  assert.ok(fs.existsSync(path.join(cdir, '.git')));
  assert.equal(mode(cdir), 0o700);
});

test('the credentials repository is kept in step: a commit on the server reaches the second home after one upkeep round', async () => {
  const { brainUrl, creds } = brainNaming();
  const B = w.computer(`b${n}`);
  B.use();
  const { ui } = await quietUi();
  await restoreWorkspace(brainUrl, { ui, dir: B.ws });
  const other = w.clone(creds, path.join(w.root, `creds-elsewhere-${n}`));
  const sha = w.commit(other, 'shop.env.example', 'KEY=\n', 'Add a key name');
  w.sh(other, 'push', '-q');
  const { syncAll } = await import('../../src/workspace/sync.mjs');
  const r = await syncAll({ dir: B.ws, projects: path.join(B.ws, 'projects'), upkeep: true });
  assert.ok(r.repos.some((x) => x.label === 'credentials'), JSON.stringify(r.repos));
  assert.equal(w.sh(path.join(B.ws, 'credentials'), 'rev-parse', 'HEAD'), sha);
  assert.equal(mode(path.join(B.ws, 'credentials')), 0o700, 'still only its owner\'s');
});

/** A brain whose map names credentials and one project, shop, whose project.json names a credential link. */
function brainWithProject({ credsMade = true } = {}) {
  const k = ++n;
  const brainUrl = w.bare(`brain${k}`, { empty: true });
  const creds = credsMade ? w.bare(`creds${k}`) : w.url(`creds${k}`);
  const shopUrl = w.bare(`shop${k}`, { empty: true });
  const A = w.computer(`a${n}`);
  A.use();
  const seed = path.join(w.root, `shop-seed-${k}`);
  w.sh(w.root, 'clone', '-q', shopUrl, seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), '/.env.local\n');
  w.commit(seed, 'project.json', `${JSON.stringify({ name: 'shop', repos: [], memories: {}, credentials: { '.env.local': 'shop/shop.env' } }, null, 2)}\n`);
  w.sh(seed, 'push', '-q', '-u', 'origin', 'main');
  const brain = path.join(A.ws, 'ai_brain');
  w.sh(A.home, 'clone', '-q', brainUrl, brain);
  M.writeMap({ version: 2, groups: [], brain: { url: brainUrl }, credentials: { url: creds }, projects: [{ name: 'shop', url: shopUrl, repos: [] }], others: [] }, A.ws);
  w.sh(brain, 'add', '-A');
  w.sh(brain, 'commit', '-q', '-m', 'map');
  w.sh(brain, 'push', '-q', '-u', 'origin', 'main');
  const fill = (dir) => {
    const c = w.clone(creds, path.join(w.root, `creds-fill-${k}`));
    w.commit(c, 'shop/shop.env', 'KEY=restore-secret\n');
    w.sh(c, 'push', '-q');
  };
  if (credsMade) fill();
  return { brainUrl, creds, makeCreds: () => (w.bare(`creds${k}`), fill()) };
}

test('restore --with-projects clones the brain, then the credentials, then the projects, and makes the link', async () => {
  const { brainUrl, creds } = brainWithProject();
  const B = w.computer(`b${n}`);
  B.use();
  const order = [];
  const runner = (argv, o) => {
    if (argv.includes('clone')) order.push(argv[argv.indexOf('--') + 1]);
    return stream(argv, o);
  };
  const { ui, text } = await quietUi();
  const r = await restoreWorkspace(brainUrl, { ui, dir: B.ws, runner, withProjects: true });
  assert.equal(r.ok, true, text());
  assert.deepEqual(order.slice(0, 2), [brainUrl, creds], 'the brain first, the credentials right after it');
  assert.ok(order.length >= 3, 'then the project');
  const link = path.join(B.ws, 'projects', 'shop', '.env.local');
  assert.equal(fs.readFileSync(link, 'utf8'), 'KEY=restore-secret\n');
  assert.equal(path.isAbsolute(fs.readlinkSync(link)), false);
  assert.equal(text().includes('restore-secret'), false);
});

test('a restore whose credentials cannot be cloned goes on: the link waits, and the next run makes it', async () => {
  const { brainUrl, makeCreds } = brainWithProject({ credsMade: false });
  const B = w.computer(`b${n}`);
  B.use();
  const { ui, text } = await quietUi();
  const r1 = await restoreWorkspace(brainUrl, { ui, dir: B.ws, withProjects: true });
  assert.match(r1.plan.find((e) => e.kind === 'credentials').result, /^failed: /);
  assert.equal(r1.plan.find((e) => e.kind === 'project').result, 'cloned', 'the rest goes on');
  assert.match(text(), /shop\/\.env\.local → credentials\/shop\/shop\.env: waiting for the credentials/);
  const link = path.join(B.ws, 'projects', 'shop', '.env.local');
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined, 'no empty file in its place');
  assert.equal(mode(path.join(B.ws, 'credentials')), 0o700);
  makeCreds();
  const q2 = await quietUi();
  const r2 = await restoreWorkspace(brainUrl, { ui: q2.ui, dir: B.ws, withProjects: true });
  assert.equal(r2.plan.find((e) => e.kind === 'credentials').result, 'cloned');
  // The project was here already: the link that waited is made by this restore all the same.
  assert.match(q2.text(), /shop\/\.env\.local → credentials\/shop\/shop\.env: linked now/, q2.text());
  assert.equal(fs.readFileSync(link, 'utf8'), 'KEY=restore-secret\n');
  assert.equal(q2.text().includes('restore-secret'), false);
  // workspace link finds it right and leaves it.
  const ws = await import('../../src/workspace/cli.mjs');
  process.env.HOPRIG_WORKSPACE_DIR = B.ws;
  try {
    const q = await quietUi();
    // (Its exit says the coding tools' own links too: this brain has no CLAUDE.md for them, which is not this test's.)
    await ws.main(['link', '--yes'], { ui: q.ui, write: () => {} });
    assert.match(q.text(), /shop\/\.env\.local → credentials\/shop\/shop\.env: linked$/m, q.text());
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
  }
});

test('a re-clone after a cut-off clone is owner-only before git writes, and a loose credentials repository is made 700', async () => {
  const { brainUrl, creds } = brainNaming();
  const fill = w.clone(creds, path.join(w.root, `creds-cut-${n}`));
  w.commit(fill, 'shop/shop.env', 'KEY=cut-secret\n');
  w.sh(fill, 'push', '-q');
  const B = w.computer(`b${n}`);
  B.use();
  const cdir = path.join(B.ws, 'credentials');
  const { execFileSync } = await import('node:child_process');
  // Run 1: the clone is cut off (its objects fetched, no index: what a kill while it wrote the files leaves).
  let cut = false;
  const runner1 = async (argv, o) => {
    if (argv.includes('clone') && argv.at(-1) === cdir && !cut) {
      cut = true;
      execFileSync('git', ['clone', '-q', '--no-checkout', '--', argv.at(-2), cdir]);
      fs.rmSync(path.join(cdir, '.git', 'index'), { force: true });
      return { ok: false, code: null, signal: 'SIGKILL', output: '' };
    }
    return stream(argv, o);
  };
  const { ui } = await quietUi();
  await restoreWorkspace(brainUrl, { ui, dir: B.ws, runner: runner1 });
  // Run 2: the cut-off clone is moved aside and cloned again; the new folder is 700 before git writes into it.
  const seen = [];
  const runner2 = (argv, o) => {
    if (argv.includes('clone') && argv.at(-1) === cdir) seen.push(fs.existsSync(cdir) ? mode(cdir) : 'not there');
    return stream(argv, o);
  };
  const r2 = await restoreWorkspace(brainUrl, { ui, dir: B.ws, runner: runner2 });
  assert.equal(r2.plan.find((e) => e.kind === 'credentials').result, 'cloned');
  assert.deepEqual(seen, [0o700], 'the folder git clones into is owner-only already');
  assert.equal(fs.readFileSync(path.join(cdir, 'shop', 'shop.env'), 'utf8'), 'KEY=cut-secret\n');
  // A credentials repository others can open (what a kill right after git's own mkdir left): restore makes it 700.
  fs.chmodSync(cdir, 0o775);
  const r3 = await restoreWorkspace(brainUrl, { ui, dir: B.ws });
  assert.equal(r3.plan.find((e) => e.kind === 'credentials').result, 'here');
  assert.equal(mode(cdir), 0o700);
});

test('a cut-off credentials clone that restore moves aside is said by restore and named by workspace status', async () => {
  const { brainUrl, creds } = brainNaming();
  const fill = w.clone(creds, path.join(w.root, `creds-said-${n}`));
  w.commit(fill, 'shop/shop.env', 'KEY=said-secret\n');
  w.sh(fill, 'push', '-q');
  const B = w.computer(`b${n}`);
  B.use();
  const cdir = path.join(B.ws, 'credentials');
  const { execFileSync } = await import('node:child_process');
  let cut = false;
  const runner1 = async (argv, o) => {
    if (argv.includes('clone') && argv.at(-1) === cdir && !cut) {
      cut = true;
      execFileSync('git', ['clone', '-q', '--no-checkout', '--', argv.at(-2), cdir]);
      fs.rmSync(path.join(cdir, '.git', 'index'), { force: true });
      return { ok: false, code: null, signal: 'SIGKILL', output: '' };
    }
    return stream(argv, o);
  };
  await restoreWorkspace(brainUrl, { ui: (await quietUi()).ui, dir: B.ws, runner: runner1 });
  const q = await quietUi();
  const r2 = await restoreWorkspace(brainUrl, { ui: q.ui, dir: B.ws });
  assert.equal(r2.plan.find((e) => e.kind === 'credentials').result, 'cloned');
  const aside = fs.readdirSync(B.ws).filter((x) => /^\.credentials\.broken-/.test(x));
  assert.equal(aside.length, 1, 'kept aside, never deleted');
  assert.match(q.text(), /credentials: a clone that was cut off was moved aside as .*\.credentials\.broken-.*: look at it, then remove it yourself/, q.text());
  assert.equal(q.text().includes('said-secret'), false);
  const ws = await import('../../src/workspace/cli.mjs');
  process.env.HOPRIG_WORKSPACE_DIR = B.ws;
  try {
    const t = await quietUi();
    await ws.main(['status'], { ui: t.ui, write: () => {} });
    assert.match(t.text(), /\.credentials\.broken-\S+ {2}a clone that was cut off, kept aside/, t.text());
    const out = [];
    await ws.main(['status', '--json'], { ui: (await quietUi()).ui, write: (x) => out.push(x) });
    assert.deepEqual(JSON.parse(out.join('')).brokenAside, [path.join(B.ws, aside[0])]);
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
  }
});
