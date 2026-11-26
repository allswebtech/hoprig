// What each command's result says as a field report (src/field/wire.mjs): only the result's own words and fields are
// read, a doctor run that is all ticks makes no report, and the messages a command printed never reach one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-field-wire-')));
process.env.HOPRIG_STATE_DIR = path.join(root, 'state');
process.env.HOPRIG_CONFIG_DIR = path.join(root, 'config');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const w = await import('../../src/field/wire.mjs');
const { reportsDir, makeReport } = await import('../../src/field/report.mjs');

const MSG = 'clone of /home/alex/Workspace/projects/shop failed: alex@box2';
// The reports as the reader sees them (kind, outcome, the file's time with all its digits, the name): said on a failure.
const seen = () => {
  try {
    return fs.readdirSync(reportsDir()).filter((n) => n.endsWith('.json')).map((n) => {
      const r = JSON.parse(fs.readFileSync(path.join(reportsDir(), n), 'utf8'));
      return `${r.kind}/${r.outcome} ${fs.statSync(path.join(reportsDir(), n)).mtimeMs} ${n}`;
    }).join(' | ');
  } catch (e) {
    return `(not read: ${e.code})`;
  }
};
const allText = () => fs.readdirSync(reportsDir()).map((n) => fs.readFileSync(path.join(reportsDir(), n), 'utf8')).join('\n');

test('adopt: apply and retire by their own line kinds and codes; a dry run makes none; no word of a line reaches one', () => {
  const said = `${MSG} (blog, ~/code/blog)`;
  const ok = w.reportAdopt({ ok: true, lines: [
    { what: 'copy', ok: true, words: said }, { what: 'HEAD', ok: true, words: said }, { what: 'fsck', ok: true, words: said },
    { what: 'recent', ok: true, warn: true, words: said }, { what: 'commit', ok: true, words: said },
    { what: 'memory', ok: true, words: said }, { what: 'sessions', ok: true, words: said }, { what: 'secrets', ok: true, words: said },
  ] }, Date.now());
  assert.equal(ok.kind, 'adopt');
  assert.equal(ok.outcome, 'ok');
  assert.deepEqual(ok.steps.map((x) => [x.id, x.end]), [['copy', 'ok'], ['proof', 'ok'], ['commit', 'ok'], ['memory', 'ok'], ['sessions', 'ok']]);
  const bad = w.reportAdopt({ ok: false, lines: [{ what: 'copy', ok: true, words: said }, { what: 'files', ok: false, words: said }, { what: 'undone', ok: true, words: said }] }, Date.now());
  assert.deepEqual([bad.outcome, bad.class, bad.steps.find((x) => x.id === 'proof').end], ['failed', 'program-failed', 'failed']);
  assert.equal(w.reportAdopt({ code: 'ECHANGED' }, Date.now()).class, 'refused');
  assert.equal(w.reportAdopt({ code: 'ENOIDENTITY' }, Date.now()).class, 'not-set-up');
  assert.equal(w.reportAdopt({ code: 'EEXISTS' }, Date.now()).class, 'folder-in-the-way');
  assert.equal(w.reportAdopt({ ok: true, dryRun: true, lines: [] }, Date.now()), null, 'a dry run makes no report');
  const held = w.reportRetire({ ok: false, counts: { branches: 1 }, words: said }, Date.now());
  assert.deepEqual([held.class, held.steps[0].id, held.steps[0].end], ['refused', 'check', 'failed']);
  assert.equal(w.reportRetire({ ok: false, refused: true, words: said }, Date.now()).class, 'refused');
  const stopped = w.reportRetire({ ok: false, removed: [], words: 'stopped: nothing is removed' }, Date.now());
  assert.deepEqual([stopped.class, stopped.steps[0].end], ['stopped', 'by-hand']);
  assert.deepEqual(w.reportRetire({ ok: true, removed: ['/x'] }, Date.now()).steps.map((x) => x.id), ['check', 'remove']);
  for (const r of [ok, bad, held, stopped]) assert.ok(r.steps.every((x) => x.id !== 'other'), JSON.stringify(r.steps));
  assert.ok(!allText().includes('alex') && !allText().includes('blog') && !allText().includes('/home/'), 'no word of a line reaches a report');
});

test('drop: a project it could not find, work only here, a question with no terminal, the owner stopping it', () => {
  assert.equal(w.reportDrop([{ result: 'refused', ok: false, refusals: [{ what: MSG }] }], Date.now()).class, 'not-found');
  const pushes = w.reportDrop([{ result: 'refused', ok: false, ref: 'example/shop', pushes: [{ repo: 'shop', branch: 'main' }], refusals: [{ what: MSG }] }], Date.now());
  assert.equal(pushes.class, 'git-not-pushed');
  assert.deepEqual(pushes.steps, [{ id: 'push', end: 'failed', stepIns: 0 }]);
  assert.equal(w.reportDrop([{ result: 'refused', ok: false, ref: 'example/shop', noTerminal: true, asks: [{}], pushes: [] }], Date.now()).class, 'refused');
  // No terminal to ask in (a session's drop): commits only here are still git-not-pushed, files not committed
  // git-not-clean. A local commit on the default branch comes as a question, not as a push.
  const main = w.reportDrop([{ result: 'refused', ok: false, ref: 'example/shop', noTerminal: true, pushes: [], asks: [{ ask: 'default branch', repo: 'projects/shop', branch: 'main', commits: 1 }] }], Date.now());
  assert.equal(main.class, 'git-not-pushed');
  assert.deepEqual(main.steps, [{ id: 'push', end: 'failed', stepIns: 1 }]);
  assert.equal(w.reportDrop([{ result: 'refused', ok: false, ref: 'example/shop', noTerminal: true, pushes: [{ repo: 'shop', branch: 'fix' }], asks: [{ ask: 'confirm' }] }], Date.now()).class, 'git-not-pushed');
  assert.equal(w.reportDrop([{ result: 'refused', ok: false, ref: 'example/shop', noTerminal: true, pushes: [], asks: [{ ask: 'work', repos: [] }] }], Date.now()).class, 'git-not-clean');
  const stopped = w.reportDrop([{ result: 'stopped', ok: false, ref: 'example/shop', asks: [{}, {}] }], Date.now());
  assert.equal(stopped.class, 'stopped');
  assert.deepEqual(stopped.steps, [{ id: 'remove', end: 'by-hand', stepIns: 2 }]);
  assert.equal(w.reportDrop([{ result: 'dropped', ok: true, ref: 'example/shop' }], Date.now()).outcome, 'ok');
});

test('get: each project a clone step, the first failure by its result word', () => {
  const r = w.reportGet([{ result: 'cloned', ok: true }, { result: 'taken', ok: false, message: MSG }, { result: 'failed', ok: false, message: MSG }], Date.now());
  assert.equal(r.class, 'folder-in-the-way');
  assert.deepEqual(r.steps.map((s) => s.end), ['ok', 'failed', 'failed']);
});

test('get: a bare name with no GitHub sign-in is signin-needed, not a refusal to keep something safe', async () => {
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const { getProject } = await import('../../src/pcsetup/getproject.mjs');
  const ui = makeUi({ interactive: false, write: () => {} });
  // gh that is not signed in: every call fails, so no account is reachable.
  const gh = async () => ({ ok: false, code: 1, stdout: '', stderr: 'not logged in', error: null });
  const res = await getProject('shop', { ui, dir: path.join(root, 'projects'), gh, run: gh, map: null });
  assert.equal(res.result, 'refused');
  const r = w.reportGet([res], Date.now());
  assert.equal(r.class, 'signin-needed');
  assert.deepEqual(r.steps, [{ id: 'signin', end: 'failed', stepIns: 0 }]);
  assert.equal(w.reportGet([{ result: 'misnamed', ok: false }], Date.now()).class, 'refused', 'a real safety refusal stays one');
  assert.equal(w.reportGet([{ result: 'refused', ok: false, fieldClass: 'zoltan' }], Date.now()).class, 'refused', 'only a class of the list');
});

test('get: a clone the server refused without a sign-in is git-auth; a repository that is not there is not', { skip: process.platform === 'win32' && 'the stand-in is a shell script' }, async () => {
  const http = await import('node:http');
  const { signInProbe } = await import('../../src/pcsetup/getproject.mjs');
  // One server that asks for a sign-in (401), one that has no such repository (404): both on this computer.
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/team/')) res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="example"' });
    else res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const env = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-gitconfig') });
  try {
    assert.equal(await signInProbe(`${base}/team/secret.git`), 'git-auth');
    assert.equal(await signInProbe(`${base}/example/nothere.git`), null);
    assert.equal(await signInProbe('git@example.com:team/x.git'), null, 'only an http(s) address is asked');
    // No prompt and no sign-in window of a credential manager for a check made only for the report.
    const seen = [];
    await signInProbe(`${base}/team/secret.git`, { run: async (argv, o) => (seen.push(o.env), { ok: false, code: 128, output: '' }) });
    assert.equal(seen[0].GIT_TERMINAL_PROMPT, '0');
    assert.equal(seen[0].GCM_INTERACTIVE, 'never');
  } finally {
    process.env = env;
    await new Promise((r) => srv.close(r));
  }
  // getProject passes what the probe found on with its failed result (a clone that cannot run, a stand-in probe).
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const { getProject } = await import('../../src/pcsetup/getproject.mjs');
  const ui = makeUi({ interactive: false, write: () => {} });
  const failing = async () => ({ ok: false, code: 128, output: '' });
  const asked = [];
  const res = await getProject('https://git.example.com/team/secret.git', { ui, dir: path.join(root, 'projects-auth'), runner: failing, run: failing, gh: failing, map: null, probe: async (u) => (asked.push(u), 'git-auth') });
  assert.equal(res.result, 'failed');
  assert.deepEqual(asked, ['https://git.example.com/team/secret.git']);
  assert.equal(w.reportGet([res], Date.now()).class, 'git-auth');
  const auth = w.reportGet([{ result: 'failed', ok: false, fieldClass: 'git-auth' }], Date.now());
  assert.equal(auth.class, 'git-auth');
  assert.equal(w.reportGet([{ result: 'failed', ok: false }], Date.now()).class, 'program-failed');
});

test('doctor: only a run with a cross makes a report; its first cross gives the class', () => {
  assert.equal(w.reportDoctor([{ id: 'node', status: 'ok' }, { id: 'pty', status: 'warn' }], Date.now()), null);
  const r = w.reportDoctor([{ id: 'node', status: 'ok' }, { id: 'pty', status: 'fail', detail: MSG }, { id: 'skill:shop', status: 'fail' }], Date.now());
  assert.equal(r.class, 'terminal-module');
  assert.deepEqual(r.steps.map((s) => `${s.id}:${s.end}`), ['pty:failed', 'skill:failed', 'node:ok']);
});

test('doctor: every check that can end with a cross has a class of its own, never "other"', () => {
  const src = (f) => fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8');
  const ids = new Set();
  // checks.mjs: result('<id>', …, 'fail' …) on one line, and the three folders of dirsCheck (result(id, …)).
  for (const m of src('setup/checks.mjs').matchAll(/result\('([a-z-]+)',[^\n]*'fail'/g)) ids.add(m[1]);
  assert.match(src('setup/checks.mjs'), /result\(id, label, 'fail'/);
  for (const id of ['dir-config', 'dir-profiles', 'dir-state']) ids.add(id);
  // The workspace's own checks, and pc status's disks (one line each, "disk-0", "disk-1").
  for (const m of src('workspace/doctor.mjs').matchAll(/check\('([a-z-]+)',[^\n]*'fail'/g)) ids.add(m[1]);
  assert.match(src('pcsetup/status.mjs'), /`disk-\$\{i\}`[^\n]*status/);
  ids.add('disk-0');
  for (const id of ['node', 'password', 'pty', 'claude', 'login', 'config', 'workspace-map']) assert.ok(ids.has(id), `the walk finds ${id}`);
  for (const id of ids) {
    const r = w.reportDoctor([{ id, status: 'fail' }], Date.now());
    assert.notEqual(r.class, 'other', id);
    // The step names the check that failed, so the inbox says "failed at: disk", not "failed at: other".
    assert.notEqual(r.steps[0].id, 'other', `${id}'s step`);
  }
  assert.deepEqual(['disk-1', 'workspace-map', 'workspace-brain'].map((id) => w.reportDoctor([{ id, status: 'fail' }], Date.now()).steps[0].id), ['disk', 'map', 'brain']);
  assert.equal(w.reportDoctor([{ id: 'password', status: 'fail' }], Date.now()).class, 'not-set-up');
});

test('pc setup and kits, setup and update by exit code', () => {
  const k = w.reportPcSetup('kit', [{ step: { kit: 'node' }, ok: true }, { step: { kit: 'php' }, ok: false }, { step: { kit: 'php' }, ok: false, skipped: true }], 1, Date.now());
  assert.equal(k.kind, 'kit');
  assert.equal(k.class, 'install-failed');
  assert.deepEqual(k.steps.map((s) => s.end), ['ok', 'failed', 'skipped']);
  assert.equal(w.reportByCode('go-live', 0, Date.now()).outcome, 'ok');
  assert.equal(w.reportByCode('go-live', 1, Date.now(), 'install-failed').class, 'install-failed');
  assert.equal(w.reportByCode('setup', 1, Date.now()).class, 'other');
});

test('a command\'s report also goes into the owner\'s copy folder when he set one', async () => {
  const { writeFieldSettings } = await import('../../src/field/settings.mjs');
  const mine = path.join(root, 'notes');
  fs.mkdirSync(mine);
  writeFieldSettings({ copyDir: mine });
  const r = w.reportGet([{ result: 'failed', ok: false }], Date.now());
  assert.deepEqual(fs.readdirSync(mine).map((n) => n.includes(r.id)), [true]);
  writeFieldSettings({ copyDir: '' });
});

test('nothing a command printed reaches a report', () => {
  const text = allText();
  for (const s of ['/home', 'alex', 'box2', 'shop', 'clone of']) assert.equal(text.includes(s), false, s);
});

test('a dry run makes no report, in either spelling: update -n and setup -n as --dry-run', async () => {
  const cli = await import('../../src/setup/cli.mjs');
  const count = () => (fs.existsSync(reportsDir()) ? fs.readdirSync(reportsDir()).length : 0);
  const before = count();
  const write = process.stdout.write;
  process.stdout.write = () => true; // the update's plan is printed; a dry run runs none of it
  try {
    for (const a of [['-n'], ['--dry-run']]) await cli.main('update', a);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(count(), before, 'no report from a dry run of update');
  for (const a of [['-n'], ['--dry-run'], ['--yes', '-n']]) assert.equal(cli.isDryRun('setup', a), true, a.join(' '));
  for (const a of [['-n'], ['--dry-run']]) assert.equal(cli.isDryRun('go-live', a), true, a.join(' '));
  assert.equal(cli.isDryRun('setup', ['--yes']), false);
  assert.equal(cli.isDryRun('go-live', []), false);
});

test('the doc\'s whole report is one the code makes: the reader takes it, and get makes the same steps and class', async () => {
  const { strictReport } = await import('../../src/field/shape.mjs');
  const doc = fs.readFileSync(new URL('../../docs/FIELD-REPORTS.md', import.meta.url), 'utf8');
  const text = /```json\n([\s\S]*?\n)```/.exec(doc)[1];
  const r = strictReport(text);
  assert.ok(r, 'the doc\'s example is exactly the shape');
  const made = w.reportGet([{ result: 'failed', ok: false, fieldClass: r.class }], Date.now());
  assert.deepEqual({ kind: made.kind, outcome: made.outcome, class: made.class, steps: made.steps }, { kind: r.kind, outcome: r.outcome, class: r.class, steps: r.steps });
});

test('a command that works right after the same kind failed prints one line naming the way-round command, and only then', () => {
  fs.rmSync(reportsDir(), { recursive: true, force: true });
  const lines = [];
  const was = w.setHintWriter((l) => lines.push(l));
  try {
    const ok = () => w.reportGet([{ result: 'cloned', ok: true }], Date.now());
    ok();
    assert.equal(lines.length, 0, 'nothing failed before: no line');
    w.reportGet([{ result: 'failed', ok: false, message: MSG }], Date.now());
    assert.equal(lines.length, 0, 'a failure itself: no line');
    ok();
    assert.equal(lines.length, 1, `a success right after a failure of the same kind: one line; reports: ${seen()}`);
    assert.match(lines[0], /hoprig field way-round --failed "<what failed>" --worked "<what worked>"/);
    ok();
    assert.equal(lines.length, 1, `once per failure; reports: ${seen()}`);
    // Another kind's failure is not this kind's way round.
    w.reportDrop([{ result: 'refused', ok: false }], Date.now());
    ok();
    assert.equal(lines.length, 1, 'a drop that failed says nothing about a get');
    w.reportDrop([{ result: 'dropped', ok: true, ref: 'example/shop' }], Date.now());
    assert.equal(lines.length, 2, 'the drop that works after the drop that failed');
    // A failure more than an hour before is no "moment ago".
    fs.rmSync(reportsDir(), { recursive: true, force: true });
    const end = Date.now() - 2 * 3600_000;
    makeReport({ kind: 'get', steps: [{ id: 'clone', end: 'failed' }], error: 'program-failed', startedAt: end - 1000, endedAt: end });
    ok();
    assert.equal(lines.length, 2, 'a failure two hours ago: no line');
  } finally {
    w.setHintWriter(was);
  }
});

test('reports written a moment apart on a file system with coarse times (the same time for each) keep their order: the line still comes', (t) => {
  // A file system whose own times are coarse gives files written within its tick the same time (and a clock set back
  // gives a later file an earlier one). Played here: each report file, as it is put in place, gets one fixed time.
  const { renameSync } = fs;
  const coarse = new Date(Date.now() - 1000);
  fs.renameSync = function (from, to, ...rest) {
    const r = renameSync.call(fs, from, to, ...rest);
    if (path.dirname(to) === reportsDir()) fs.utimesSync(to, coarse, coarse);
    return r;
  };
  const lines = [];
  const was = w.setHintWriter((l) => lines.push(l));
  t.after(() => {
    fs.renameSync = renameSync;
    w.setHintWriter(was);
  });
  // Eight times over: with a tie, which of the two earlier reports reads as "the one before" was a toss.
  for (let i = 1; i <= 8; i++) {
    fs.rmSync(reportsDir(), { recursive: true, force: true });
    w.reportGet([{ result: 'cloned', ok: true }], Date.now());
    w.reportGet([{ result: 'failed', ok: false, message: MSG }], Date.now());
    w.reportGet([{ result: 'cloned', ok: true }], Date.now());
    assert.equal(lines.length, i, `round ${i}: the success right after the failure has its line; reports: ${seen()}`);
  }
});

test('a time set on a report that reads back a hair below what was set (seconds in a double) keeps the order: the line comes once per failure', (t) => {
  // The file system is handed a time as seconds in a double, and may give it back a hair below (…677.9998 for …678).
  // Played here: each report's time reads back 0.2 µs below the time set.
  const { utimesSync, statSync } = fs;
  const set = new Map();
  fs.utimesSync = function (p, a, m, ...rest) {
    if (path.dirname(String(p)) === reportsDir()) set.set(String(p), m instanceof Date ? m.getTime() : m * 1000);
    return utimesSync.call(fs, p, a, m, ...rest);
  };
  fs.statSync = function (p, ...rest) {
    const st = statSync.call(fs, p, ...rest);
    if (st && set.has(String(p))) st.mtimeMs = set.get(String(p)) - 0.0002;
    return st;
  };
  const lines = [];
  const was = w.setHintWriter((l) => lines.push(l));
  t.after(() => {
    Object.assign(fs, { utimesSync, statSync });
    w.setHintWriter(was);
  });
  for (let i = 1; i <= 8; i++) {
    fs.rmSync(reportsDir(), { recursive: true, force: true });
    set.clear();
    w.reportGet([{ result: 'cloned', ok: true }], Date.now());
    w.reportGet([{ result: 'failed', ok: false, message: MSG }], Date.now());
    w.reportGet([{ result: 'cloned', ok: true }], Date.now());
    assert.equal(lines.length, i, `round ${i}: the line after the failure; reports: ${seen()}`);
    w.reportGet([{ result: 'cloned', ok: true }], Date.now());
    assert.equal(lines.length, i, `round ${i}: once per failure; reports: ${seen()}`);
  }
});

test('set-up on a server is its own kind, with its steps and the class of what was left open', () => {
  const server = w.reportSetup({ server: true, steps: [{ id: 'password', end: 'ok' }, { id: 'access', end: 'failed' }, { id: 'service', end: 'failed' }], error: 'open-to-network' }, 1, Date.now());
  assert.equal(server.kind, 'server-setup');
  assert.equal(server.class, 'open-to-network');
  assert.deepEqual(server.steps.map((x) => x.id), ['password', 'access', 'service']);
  const desk = w.reportSetup({ server: false, steps: [{ id: 'claude', end: 'ok' }], error: 'missing-program' }, 0, Date.now());
  assert.equal(desk.kind, 'setup');
  assert.equal(desk.outcome, 'ok', 'exit 0 is a set-up that went well, whatever the summary held');
  // A summary that is missing or not one (set-up stopped before it filled it) still makes a plain report.
  assert.equal(w.reportSetup(null, 1, Date.now()).kind, 'setup');
  assert.equal(w.reportSetup({ server: 'yes', error: '/home/alex' }, 1, Date.now()).class, 'other');
});

test('the restart after an update is a go-live report; a restart of the same version is none', async () => {
  fs.rmSync(reportsDir(), { recursive: true, force: true });
  const { installWithReport } = await import('../../src/server/cli.mjs');
  const { appVersion } = await import('../../src/setup/checks.mjs');
  const mine = appVersion();
  const seq = (...xs) => { let i = 0; return async () => xs[Math.min(i++, xs.length - 1)]; };
  const ok = await installWithReport({ facts: seq({ version: '0.0.1', pid: 10 }, { version: mine, pid: 11 }), run: async () => 0, wait: 1 });
  assert.equal(ok, 0);
  let made = fs.readdirSync(reportsDir()).map((n) => JSON.parse(fs.readFileSync(path.join(reportsDir(), n), 'utf8')));
  assert.equal(made.length, 1);
  assert.equal(made[0].kind, 'go-live');
  assert.equal(made[0].outcome, 'ok');
  assert.deepEqual(made[0].steps.map((x) => [x.id, x.end]), [['restart', 'ok'], ['health', 'ok']]);
  // The same version running: a plain restart, no go-live.
  await installWithReport({ facts: seq({ version: mine, pid: 12 }, { version: mine, pid: 13 }), run: async () => 0, wait: 1 });
  // Nothing running before: nothing to compare, no go-live.
  await installWithReport({ facts: seq(null, { version: mine, pid: 14 }), run: async () => 0, wait: 1 });
  assert.equal(fs.readdirSync(reportsDir()).length, 1);
  // The old one still holds the port: the new version never answers.
  await installWithReport({ facts: seq({ version: '0.0.1', pid: 20 }), run: async () => 0, wait: 1, tries: 3 });
  // The service manager failed.
  assert.equal(await installWithReport({ facts: seq({ earlier: true, pid: 30 }), run: async () => 1, wait: 1 }), 1);
  made = fs.readdirSync(reportsDir()).sort().map((n) => JSON.parse(fs.readFileSync(path.join(reportsDir(), n), 'utf8')));
  // Reports of one second sort by their random ids: compare the set, the one that went well and the two that did not.
  assert.deepEqual(made.map((r) => [r.kind, r.class]).sort(), [['go-live', 'none'], ['go-live', 'port-in-use'], ['go-live', 'service-failed']]);
});
