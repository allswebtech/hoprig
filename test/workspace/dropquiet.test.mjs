// What `hoprig drop` does by itself: nothing. On a made-up workspace with three projects where no drop was ever made,
// a start of the dashboard with default settings (its automations tick once at boot: the map's upkeep) and an upkeep
// round of the map, then `workspace status` and the finish step `get` runs for a cut-off drop, change nothing of the
// projects. A whole-home snapshot (every path with its type, size, mode, time, inode and hash, where each link points,
// the refs and HEAD of every repository, the git "server" too) is taken before and after; only the brain and Hoprig's
// own settings and state may differ. Then a real drop shows the snapshot sees a change.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { closedGateways } from '../seal.mjs';
import { dropOn, dropWorld, getOn, owner } from './dropfix.mjs';
import { quietUi } from './gitfix.mjs';

const w = await dropWorld('quiet');
test.after(() => w.cleanup());
const [A] = w.computers;

function snapshot(roots) {
  const out = new Map();
  const gitDirs = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      const e = { type, size: st.size, mode: st.mode, mtime: st.mtimeMs, ino: st.ino };
      if (type === 'file') e.hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      if (type === 'link') e.to = fs.readlinkSync(p);
      out.set(p, e);
      if (type === 'dir') {
        if (name === '.git' || (name.endsWith('.git') && fs.existsSync(path.join(p, 'HEAD')))) gitDirs.push(p);
        walk(p);
      }
    }
  };
  for (const r of roots) walk(r);
  for (const g of gitDirs) {
    const refs = execFileSync('git', ['--git-dir', g, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' });
    let head = '';
    try {
      head = execFileSync('git', ['--git-dir', g, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      head = '(no commit)';
    }
    out.set(`refs:${g}`, { refs, head });
  }
  return out;
}
const changes = (a, b) => {
  const lines = [];
  for (const [k, v] of a) {
    if (!b.has(k)) lines.push(`removed ${k}`);
    else if (JSON.stringify(v) !== JSON.stringify(b.get(k))) lines.push(`changed ${k}`);
  }
  for (const k of b.keys()) if (!a.has(k)) lines.push(`added ${k}`);
  return lines;
};

test('with default settings nothing of drop runs by itself: a dashboard start and an upkeep round change nothing of three projects', async (tc) => {
  // A third project in the map, then all three got as in real use.
  const notesUrl = w.bare('notes-workspace');
  const brain = A.brain;
  w.sh(brain, 'pull', '-q');
  const mapFile = path.join(brain, 'workspace.json');
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  map.projects.push({ name: 'notes', url: notesUrl, repos: [] });
  fs.writeFileSync(mapFile, JSON.stringify(map, null, 2) + '\n');
  w.sh(brain, 'commit', '-q', '-am', 'notes');
  w.sh(brain, 'push', '-q');
  const g = await getOn(A, ['shop', 'blog', 'notes']);
  assert.equal(g.code, 0, g.text);
  // What a drop would remove or ask about, of every kind: build output, an untracked file, an ignored one, a private
  // folder, work not committed, a commit only here.
  const api = path.join(A.shop, 'code', 'shop-api');
  fs.mkdirSync(path.join(api, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(api, 'node_modules', 'x', 'i.js'), 'made again\n');
  fs.writeFileSync(path.join(A.shop, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(A.projects, 'blog', 'draft.md'), 'not committed\n');
  fs.mkdirSync(path.join(A.projects, 'notes', 'no-ai'));
  fs.writeFileSync(path.join(A.projects, 'notes', 'no-ai', 'mine.md'), 'mine\n');
  w.commit(path.join(A.projects, 'notes'), 'only-here.md', 'a commit only on this computer\n');
  fs.writeFileSync(path.join(A.projects, 'blog', 'README.md'), 'an edit\n');

  const roots = [A.home, w.server];
  const before = snapshot(roots);
  A.use();

  // 1. The dashboard starts with default settings (only the password and the terminals are set) and ticks once.
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: 'pty', roots: [A.home], passwordHash: await hashPassword('test-password-1') }, addons: closedGateways() }); // the gateway's port is the test's own
  // Its own workspace, named: the made-up one in this computer's temporary home, never the real one.
  const wasWs = process.env.HOPRIG_WORKSPACE_DIR;
  process.env.HOPRIG_WORKSPACE_DIR = A.ws;
  const app = createServer({ dashboardFile: false });
  await app.listen(Number(process.env.DROP_QUIET_PORT || 0), '127.0.0.1'); // a free port: two suites on one computer at the same moment must not meet
  const store = path.join(A.env.HOPRIG_STATE_DIR, 'automation', 'workspace.json');
  let ticked = false;
  try {
    for (const end = Date.now() + 30_000; Date.now() < end && !ticked; await new Promise((r) => setTimeout(r, 200))) {
      try {
        ticked = JSON.parse(fs.readFileSync(store, 'utf8')).lastMapAt > 0;
      } catch {
        /* not yet */
      }
    }
  } finally {
    await app.close(); // waits for the tick in progress
    await app.backend.close?.();
    if (wasWs === undefined) delete process.env.HOPRIG_WORKSPACE_DIR;
    else process.env.HOPRIG_WORKSPACE_DIR = wasWs;
  }
  assert.ok(ticked, 'the boot tick ran the map\'s upkeep');

  // 2. An upkeep round as the automation runs it with default settings (commit on: the brain has a git server).
  const { realWorkspaceMap } = await import('../../src/automation/workspacesync.mjs');
  const up = await realWorkspaceMap({ commit: true, push: false, memory: false });
  assert.ok(!up.error, JSON.stringify(up));

  // 3. workspace status, and the finish step every hoprig get of a project runs first.
  const { main: workspaceMain } = await import('../../src/workspace/cli.mjs');
  const q = await quietUi();
  let json = '';
  await workspaceMain(['status', '--json'], { ui: q.ui, write: (s) => (json += s) });
  assert.equal(JSON.parse(json).dropping, undefined, 'no drop was made: none is named');
  const { finishDropping } = await import('../../src/workspace/dropacts.mjs');
  for (const n of ['shop', 'blog', 'notes']) assert.deepEqual(await finishDropping(A.projects, n, A.ctx, q.ui, { get: true }), []);

  const diff = changes(before, snapshot(roots));
  const ours = (k) => [path.join(A.ws, 'ai_brain'), A.env.HOPRIG_CONFIG_DIR, A.env.HOPRIG_STATE_DIR].some((d) => k.includes(`${d}${path.sep}`) || k.endsWith(d)) || k.includes(`refs:${path.join(w.server, 'team', 'brain.git')}`);
  // The look at the projects (every 30 minutes and at start) only FETCHES: git's own record of what the server has
  // (FETCH_HEAD, the remote-tracking refs, new objects) changes, never a branch, HEAD or a working tree; and the map's own
  // commit goes up to the brain's git server.
  const fetched = (k) => k.startsWith(A.projects + path.sep) && /(^|[\\/])\.git([\\/](objects([\\/].*)?|FETCH_HEAD|refs[\\/]remotes([\\/].*)?))?$/.test(k);
  const server = (k) => k.startsWith(path.join(w.server, 'team', 'brain.git'));
  const theirs = diff.filter((l) => {
    const k = l.replace(/^(removed|changed|added) /, '');
    return !ours(k) && !fetched(k) && !server(k);
  });
  assert.deepEqual(theirs, [], 'only the brain and Hoprig\'s own settings and state may change');
  assert.ok(!diff.some((l) => l.includes(A.projects) && !fetched(l.replace(/^(removed|changed|added) /, ''))), 'nothing of the projects but what a fetch writes');
  tc.diagnostic(`what changed besides: ${diff.length} path(s) of the brain, settings and state`);

  // The control: a real drop of one of them changes the snapshot (the snapshot sees what a drop does).
  fs.rmSync(path.join(A.projects, 'blog', 'draft.md'));
  w.sh(path.join(A.projects, 'blog'), 'checkout', '--', 'README.md');
  const mid = snapshot(roots);
  const d = await dropOn(A, ['blog'], { answers: owner('blog') });
  assert.equal(d.code, 0, d.text);
  assert.ok(changes(mid, snapshot(roots)).some((l) => l === `removed ${path.join(A.projects, 'blog')}`), 'the drop shows');
});
