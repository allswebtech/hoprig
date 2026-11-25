// What `hoprig get` promises for the projects folder holds in every place a project can be: a plain group's folder
// and a held folder of a group that is a repository. The lock and its take-over, a leftover finished or moved aside,
// the early "taken" when the place's folder for the name holds another repository, workspace status listing locks
// and leftovers there, printed commands that run as they read (this computer's folder has a space in its path), the
// same address with a port or an scp-like absolute path, and the dashboard's job and Tia showing "needs you".
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gitWorld, quietUi } from '../workspace/gitfix.mjs';

const w = gitWorld('get-group-rules');
test.after(() => w.cleanup());
// Nothing in these tests may reach a real server: GitHub addresses go to a folder that is not there.
fs.appendFileSync(path.join(w.root, 'gitconfig'), `[url "${String(path.join(w.root, 'no-such-server')).replaceAll('\\', '/')}/"]\n\tinsteadOf = https://github.com/\n`);
const C = w.computer('box two'); // a space in every path of this computer
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { getProject } = await import('../../src/pcsetup/getproject.mjs');
const L = await import('../../src/pcsetup/leftovers.mjs');
const { system } = await import('../../src/procid.mjs');
const { earlierIdentity } = await import('../server/helpers.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { showCommand } = await import('../../src/setup/system.mjs');
const { main: wsMain } = await import('../../src/workspace/cli.mjs');

/** A bare parent repository with a project.json naming it `name`. */
const parent = (repo, name) => {
  w.bare(repo);
  const seed = w.clone(w.url(repo), path.join(w.root, 'seed', repo));
  w.commit(seed, 'project.json', JSON.stringify({ name, repos: [], memories: {} }) + '\n', 'Add project.json');
  w.sh(seed, 'push', '-q');
  return w.url(repo);
};
w.bare('brain');
w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
fs.mkdirSync(C.projects, { recursive: true });
// A plain group, and a group that is a repository holding the folder "builds" (each member a repository of its own).
w.bare('kits');
const kits = w.clone(w.url('kits'), path.join(C.ws, 'kits'));
w.commit(kits, 'builds/README.md', '# builds\n', 'Add builds');
w.commit(kits, '.gitignore', '/builds/*/\n', 'Ignore the members');
const PLACES = { 'client-work': path.join(C.ws, 'client-work'), 'kits/builds': path.join(kits, 'builds') };
fs.mkdirSync(PLACES['client-work'], { recursive: true });
const other = w.bare('other-repo');
const U = {};
for (const id of Object.keys(PLACES)) {
  const k = id.replace('/', '-');
  for (const what of ['stale', 'dirlock', 'aside', 'finish', 'taken', 'port', 'page']) U[`${what}@${id}`] = parent(`${what}-${k}-workspace`, `${what}-${k}`);
}
M.writeMap({
  version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'client-work' }, { dir: 'kits', url: w.url('kits'), holds: [{ dir: 'builds' }] }],
  projects: Object.keys(PLACES).flatMap((id) => [
    { name: 'shop', in: id, url: U[`taken@${id}`], repos: [] },
    { name: 'site', in: id, url: U[`page@${id}`], repos: [] },
  ]),
  others: [],
}, C.ws);
const map = () => M.readMap(C.ws).map;
const get = async (spec, o = {}) => {
  const q = await quietUi();
  q.ui.yes = true;
  const r = await getProject(spec, { ui: q.ui, dir: C.projects, map: map(), ...o });
  return { ...r, text: q.text() };
};
const repoOf = (url) => ({ url, repo: path.basename(url, '.git') });
const status = async () => {
  let out = '';
  assert.equal(await wsMain(['status', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s) }), 0);
  return JSON.parse(out);
};
const statusText = async () => {
  const q = await quietUi();
  await wsMain(['status'], { ui: q.ui, write: () => {} });
  return q.text();
};

for (const [id, pdir] of Object.entries(PLACES)) {
  test(`${id}: a stale lock of the place is listed by status and taken over by the next get`, async (t) => {
    const url = U[`stale@${id}`];
    const file = L.lockPathFor(pdir, repoOf(url));
    assert.ok(!file.startsWith(pdir + path.sep), 'the lock lives in the state folder, never in the place\'s folder');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A pid another process has now: a process of this test's own (every system tells its start; on macOS the suite's
    // ps answers only for the test's processes), and the lock names the one that had its pid before, in this system's
    // own form (src/procid.mjs: one of another form cannot be compared, and is no proof that the writer has ended).
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    t.after(() => other.kill('SIGKILL'));
    await new Promise((res) => other.once('spawn', res));
    const now = system.of([other.pid]).get(other.pid);
    assert.ok(now, 'this system tells the start of a process of this test\'s');
    fs.writeFileSync(file, `${JSON.stringify({ pid: other.pid, proc: earlierIdentity(now) })}\n`);
    assert.deepEqual((await status()).locks.filter((l) => l.path === file).map((l) => l.running), [false]);
    assert.ok((await statusText()).includes(`${file}  a lock of hoprig get: its run has ended`));
    const r = await get(url, { into: id });
    assert.equal(r.result, 'cloned', r.text);
    assert.ok(r.dir.startsWith(pdir + path.sep), r.dir);
    assert.ok(!fs.existsSync(file), 'released after the run');
    assert.equal((await status()).locks.some((l) => l.path === file), false);
  });

  test(`${id}: a live lock of the place makes the get busy, with a remove line that runs as it reads`, async () => {
    const url = U[`dirlock@${id}`];
    const lock = L.takeLock(pdir, repoOf(url));
    try {
      const r = await get(url, { into: id });
      assert.equal(r.result, 'busy', r.text);
      const file = L.lockPathFor(pdir, repoOf(url));
      assert.ok(r.message.endsWith(`removing its lock is safe:  ${showCommand(['rm', file])}`), r.message);
      assert.ok(r.message.includes(`'${file}'`), 'the path with a space is quoted');
    } finally {
      lock.release();
    }
  });

  test(`${id}: a folder at the lock's name is moved aside, and the get goes on`, async () => {
    const url = U[`dirlock@${id}`];
    const file = L.lockPathFor(pdir, repoOf(url));
    fs.mkdirSync(file, { recursive: true });
    fs.writeFileSync(path.join(file, 'mine.txt'), 'mine\n');
    const r = await get(url, { into: id });
    assert.equal(r.result, 'cloned', r.text);
    const locks = path.dirname(file);
    const aside = fs.readdirSync(locks).filter((n) => n.startsWith(`${path.basename(file)}.aside-`));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(locks, aside[0], 'mine.txt'), 'utf8'), 'mine\n');
    assert.match(r.text, /was not a lock file \(a folder or a link\): it was moved aside, nothing deleted/);
  });

  test(`${id}: a leftover of another address at this run's temporary name is moved aside there; status offers a remove line that runs`, async () => {
    const url = U[`aside@${id}`];
    const temp = path.join(pdir, L.tempNameFor(repoOf(url)));
    w.clone(other, temp); // a complete clone, but of another repository
    const r = await get(url, { into: id });
    assert.equal(r.result, 'cloned', r.text);
    assert.match(r.text, /moved aside \(nothing deleted\)/);
    const left = (await status()).leftovers.filter((l) => l.path.startsWith(`${temp}.aside-`));
    assert.equal(left.length, 1, 'status lists the leftover moved aside in the place\'s folder');
    assert.equal(left[0].aside, true);
    assert.equal(left[0].fix, `look at it, then remove it:  ${showCommand(['rm', '-rf', left[0].path])}`);
    execFileSync('sh', ['-c', left[0].fix.split('remove it:  ')[1]]);
    assert.ok(!fs.existsSync(left[0].path), 'the printed line removed exactly that folder');
    assert.ok(fs.existsSync(r.dir), 'and nothing else');
  });

  test(`${id}: a complete leftover of this address is listed with a get that goes back into the place, and finished by it`, async () => {
    const url = U[`finish@${id}`];
    const temp = path.join(pdir, L.tempNameFor(repoOf(url)));
    w.clone(url, temp); // a run killed after its clone
    const [l] = (await status()).leftovers.filter((x) => x.path === temp);
    assert.equal(l.complete, true);
    assert.equal(l.fix, `hoprig get ${url} --in ${id}`, 'without --in the get would go into the projects folder and clone again');
    const r = await get(url, { into: id });
    assert.equal(r.result, 'cloned', r.text);
    assert.match(r.text, /a complete clone an earlier run left here is used/);
    assert.ok(!fs.existsSync(temp));
    assert.ok(!fs.existsSync(path.join(C.projects, path.basename(r.dir))));
  });

  test(`${id}: the map's folder for the name holds another repository: "taken", needing the owner, with a fix that runs`, async () => {
    const target = path.join(pdir, 'shop');
    w.clone(other, target);
    const r = await get(`${id}/shop`);
    assert.equal(r.result, 'taken', r.text);
    assert.equal(r.ok, false);
    assert.ok(r.fix.startsWith(showCommand(['mv', target, `${target}.aside-`]).slice(0, -1)), r.fix);
    assert.ok(r.message.includes(`${target} is in the way: it is a clone of ${other}, not of ${U[`taken@${id}`]}`), r.message);
    assert.ok(!fs.existsSync(path.join(pdir, L.tempNameFor(repoOf(U[`taken@${id}`])))), 'nothing was cloned');
    execFileSync('sh', ['-c', r.fix]);
    assert.ok(!fs.existsSync(target));
    const again = await get(`${id}/shop`);
    assert.equal(again.result, 'cloned', again.text);
    assert.equal(again.dir, target);
  });

  test(`${id}: one address, one place, also with the scheme's own port or the scp-like absolute path`, async () => {
    const url = U[`port@${id}`];
    const elsewhere = path.join(C.projects, `port-${id.replace('/', '-')}`);
    w.clone(url, elsewhere);
    // the remote written another way: the scp-like form with an absolute path (git writes it; the map never keeps it)
    const srv = (n) => `/srv/${n}`;
    w.sh(elsewhere, 'remote', 'set-url', 'origin', `git@git.example.test:${srv(path.basename(url))}`);
    for (const spec of [`ssh://git@git.example.test${srv(path.basename(url))}`, `ssh://git@git.example.test:22${srv(path.basename(url))}`]) {
      const r = await get(spec, { into: id });
      assert.equal(r.result, 'misnamed', `${spec}: ${r.text}`);
      assert.equal(r.here, elsewhere);
      assert.equal(r.fix, showCommand(['mv', elsewhere, path.join(pdir, path.basename(elsewhere))]));
      assert.ok(r.fix.includes(`'${elsewhere}'`), 'the paths with a space are quoted');
    }
    // and a map entry written with the scheme's own port is found by the address without it
    const k = id.replace('/', '-');
    const m = map();
    m.projects.push({ name: 'ported', in: id, url: `ssh://git@git.example.test:22/srv/ported-${k}.git`, repos: [] });
    M.writeMap(m, C.ws);
    const q = await quietUi();
    q.ui.dryRun = true;
    const d = await getProject(`ssh://git@git.example.test/srv/ported-${k}.git`, { ui: q.ui, dir: C.projects, map: map() });
    assert.equal(d.result, 'would clone', q.text());
    assert.equal(d.dir, path.join(pdir, 'ported'), 'the map\'s place and name');
  });
}

// ---- the dashboard's job and Tia ----

globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

function harness() {
  return import('../../src/pcsetup/feature.mjs').then(({ pcsetupFeature }) => {
    const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [], create: async () => {} }, deck: { launcher: () => ['node', 'x'] } };
    const f = pcsetupFeature(sctx, { sys: { platform: 'linux', has: () => false, run: async () => ({ ok: false, stdout: '', stderr: '' }), env: process.env, home: process.env.HOME }, projectsDir: () => C.projects });
    const call = async (method, p, body) => {
      const u = new URL(p, 'http://x');
      for (const [m, re, fn] of f.routes) {
        const match = re.exec(u.pathname);
        if (match && m === method) return fn(Object.assign(Readable.from([]), { body }), match, u.searchParams);
      }
      throw new Error(`no route ${method} ${p}`);
    };
    const job = async () => {
      for (let i = 0; i < 500; i++) {
        const j = await call('GET', '/api/pcsetup/job?from=0');
        if (!j.running) return j;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('job did not end');
    };
    return { call, job };
  });
}

async function tia(job, started = { started: true, name: 'site' }) {
  const { AuditLog } = await import('../../src/assistant/audit.mjs');
  const { CardStore } = await import('../../src/assistant/cards.mjs');
  const { createAssistantCore } = await import('../../src/assistant/core.mjs');
  const { JobStore } = await import('../../src/assistant/jobs.mjs');
  const { Skills } = await import('../../src/assistant/skills.mjs');
  const { FakeOps, baseState } = await import('../assistant/fake-dashboard.mjs');
  const ops = new FakeOps(baseState());
  const core = createAssistantCore({ ops, cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }) });
  ops.projectGet = async () => ({ ...started, job });
  const call = (tool, args) => core.call(tool, args, { conversation: 'c1' });
  const r = await call('manage_project', { action: 'get', spec: 'client-work/site' });
  assert.equal((await core.confirm((/card (c_[0-9a-z]+)/.exec(r.text) || [])[1])).ok, true);
  const shown = async (p) => !/was not shown/.test((await call('manage_project', { action: 'sync', project: p })).text);
  return { shown, outcomes: () => core.takeOutcomes('c1').map((o) => o.text).join('\n') };
}

test('the dashboard\'s Get and Tia: a group\'s folder that holds another repository needs the owner; once got, the project is named <place>/<name>', async () => {
  const { jobOutcome } = await import('../../web/projects.js');
  const { call, job } = await harness();
  const target = path.join(PLACES['client-work'], 'site');
  w.clone(other, target);
  await call('POST', '/api/pcsetup/project/clone', { spec: 'client-work/site' });
  const j = await job();
  assert.equal(j.result.ok, false, j.result.error);
  assert.equal(j.result.data.made, false);
  assert.equal(j.result.data.placed, false);
  assert.ok(j.result.data.fix.startsWith(showCommand(['mv', target, `${target}.aside-`]).slice(0, -1)), j.result.data.fix);
  assert.match(j.result.error, /is in the way: it is a clone of/);
  assert.equal(jobOutcome(j.result), 'needs-you');
  const t = await tia({ ...j.result, lines: [] });
  assert.match(t.outcomes(), /\.aside-/);
  for (const p of ['site', 'client-work/site']) assert.equal(await t.shown(p), false, p);
  // moved aside as the fix says: the next Get puts it into the group, and Tia names it as the page's list does
  execFileSync('sh', ['-c', j.result.data.fix]);
  await call('POST', '/api/pcsetup/project/clone', { spec: 'client-work/site' });
  const ok = await job();
  assert.equal(ok.result.ok, true, ok.result.error);
  assert.equal(ok.result.data.dir, target);
  assert.equal(jobOutcome(ok.result), 'done');
  const t2 = await tia({ ...ok.result, lines: [] });
  assert.equal(await t2.shown('client-work/site'), true, 'the id the page\'s list gives a project of a group');
  assert.equal(await t2.shown('site'), false, 'never the bare name: in the projects folder that is another project');
});

test('the dashboard\'s Get of <place>/<name>: the route says the place from the first moment, and Tia names it <place>/<name> while its job runs', async () => {
  const { call, job } = await harness();
  const m = map();
  m.projects.push({ name: 'later', in: 'client-work', url: 'https://github.com/alex/later-workspace.git', repos: [] }); // a clone that fails: nothing changes
  M.writeMap(m, C.ws);
  for (const spec of ['client-work/later', 'https://github.com/alex/later-workspace.git']) {
    const started = await call('POST', '/api/pcsetup/project/clone', { spec });
    assert.deepEqual(started, { started: true, name: 'later', place: 'client-work', dir: path.join(PLACES['client-work'], 'later') }, spec);
    const j = await job();
    assert.equal(j.result.data.place, 'client-work', spec);
  }
  // A project of the projects folder has no place, as before.
  assert.deepEqual(await call('POST', '/api/pcsetup/project/clone', { spec: 'alex/plain-workspace' }), { started: true, name: 'plain', dir: path.join(C.projects, 'plain') });
  await job();
  const t = await tia({ running: true, lines: [] }, { started: true, name: 'later', place: 'client-work' });
  assert.equal(await t.shown('client-work/later'), true, 'the map\'s id while the job runs');
  assert.equal(await t.shown('later'), false, 'never the bare name: it may be another project');
});
