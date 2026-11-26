// The upkeep switch "credentials" (credrepo.mjs upkeepCredentials, automation/workspacesync.mjs): off by default and
// then nothing is committed; on, a change is committed as "Update credentials" and pushed to the address the map
// names; a repository that is public by then (or whose visibility gh cannot say) is not pushed to, and that is told
// once. Sync keeps the same rule. What is said is counts, never a name in the folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from '../pcsetup/dryrun-fixture.mjs';
import { SHELL_STANDINS } from '../seal.mjs';

// The stand-in gh (and ssh) of these tests are shell scripts: on Windows the runner starts them through sh.
const SH_GH = SHELL_STANDINS;

const ws = await import('../../src/workspace/cli.mjs');
const { upkeepCredentials } = await import('../../src/workspace/credrepo.mjs');
const { DEFAULTS, cleanSettingsPatch } = await import('../../src/automation/settings.mjs');
const { decide, apply } = await import('../../src/automation/workspacesync.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const NAME = 'marker-name-5d1e';

/** A world whose credentials folder is a private repository on the stand-in GitHub, named by the map. */
async function world(tc, name) {
  const w = await dryWorld(tc, name);
  assert.equal((await runCli((a, o) => ws.main(a, o), ['map', '--upgrade', '--yes'])).code, 0);
  const c = path.join(w.ws, 'credentials');
  fs.mkdirSync(path.join(c, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(c, 'shop', `${NAME}.env`), 'K=1\n');
  fs.chmodSync(c, 0o700);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(w.server, 'alex', 'credentials.git')]);
  const r = await runCli((a, o) => ws.main(a, o), ['credentials', '--repo', gh('credentials')], { interactive: true, answers: () => 'credentials' });
  assert.equal(r.code, 0, r.text);
  w.creds = c;
  w.bare = path.join(w.server, 'alex', 'credentials.git');
  w.change = () => fs.writeFileSync(path.join(c, 'shop', `${NAME}.env`), `K=${Date.now()}\n`);
  w.serverLog = () => w.sh(w.bare, 'log', '--format=%s', 'main').split('\n');
  return w;
}

test('off by default: no switch on, no round of it, nothing committed', SH_GH, async (tc) => {
  assert.equal(DEFAULTS.workspace.credentials, false);
  const s = { ...DEFAULTS.workspace };
  const d = decide({ data: {}, now: Date.now(), boot: true, settings: s });
  assert.equal(d.actions.some((a) => a.type === 'credentials'), false);
  assert.equal(cleanSettingsPatch({ workspace: { credentials: true } }).workspace.credentials, true);
  assert.throws(() => cleanSettingsPatch({ workspace: { credentials: 'yes' } }), /on or off/);
  // A sync round of the upkeep with the switch off: the change stays uncommitted.
  const w = await world(tc, 'cu-off');
  w.change();
  await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  assert.notEqual(w.sh(w.creds, 'status', '--porcelain'), '', 'never committed without the switch');
  assert.deepEqual(w.serverLog(), ['Credentials']);
});

test('on: a change is committed as "Update credentials" and pushed; the activity line has counts only', SH_GH, async (tc) => {
  const w = await world(tc, 'cu-on');
  const d = decide({ data: {}, now: Date.now(), boot: true, settings: { ...DEFAULTS.workspace, credentials: true } });
  assert.ok(d.actions.some((a) => a.type === 'credentials'));
  w.change();
  const records = [];
  const notes = [];
  await apply(d.actions.filter((a) => a.type === 'credentials'), { record: (x) => records.push(x), notify: (x) => notes.push(x), data: {}, save: () => {}, workspaceCredentials: () => upkeepCredentials({ dir: w.ws }) });
  assert.deepEqual(w.serverLog(), ['Update credentials', 'Credentials']);
  assert.equal(w.sh(w.creds, 'status', '--porcelain'), '');
  assert.equal(w.sh(w.creds, 'log', '-1', '--format=%an'), 'Test Dev', 'the folder\'s own git identity');
  assert.deepEqual(records.map((r) => r.did), ['The credentials were committed (1 changed file)', 'The credentials were pushed to the address the map names']);
  assert.equal(JSON.stringify([records, notes]).includes(NAME), false, 'no file name of the folder');
  if (process.platform !== 'win32') assert.equal(fs.statSync(w.creds).mode & 0o777, 0o700);
});

test('public by now: committed, never pushed, told once; sync does not push it either', SH_GH, async (tc) => {
  const w = await world(tc, 'cu-public');
  fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  w.change();
  const notes = [];
  let data = {};
  const ctx = () => ({ record: () => {}, notify: (x) => notes.push(x), data, save: (x) => (data = x), workspaceCredentials: () => upkeepCredentials({ dir: w.ws }) });
  await apply([{ type: 'credentials' }], ctx());
  await apply([{ type: 'credentials' }], ctx());
  assert.deepEqual(w.serverLog(), ['Credentials'], 'nothing pushed');
  assert.equal(notes.length, 1, 'said once');
  assert.match(notes[0].message, /not pushed: .*is refused: it is public on GitHub/);
  const s = await syncAll({ dir: w.ws, projects: w.projects, upkeep: true, push: true });
  const cr = s.repos.find((x) => x.label === 'credentials');
  assert.match(cr.todo.map((t) => t.why).join(' '), /to push: not pushed, .*public on GitHub/);
  assert.deepEqual(w.serverLog(), ['Credentials']);
  // gh cannot say (not signed in): not pushed either.
  fs.rmSync(path.join(w.server, 'alex', 'visibility.json'));
  process.env.FAKE_GH_USER = '';
  try {
    const r = await upkeepCredentials({ dir: w.ws });
    assert.match(r.needs.join(' '), /could not be asked: gh is not signed in/);
  } finally {
    w.use();
  }
  assert.deepEqual(w.serverLog(), ['Credentials']);
});

test('a remote that is not the map\'s address is never pushed to', SH_GH, async (tc) => {
  const w = await world(tc, 'cu-remote');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(w.server, 'alex', 'elsewhere.git')]);
  w.sh(w.creds, 'remote', 'set-url', '--push', 'origin', gh('elsewhere'));
  w.change();
  const r = await upkeepCredentials({ dir: w.ws });
  assert.match(r.needs.join(' '), /not the address the map names/);
  assert.equal(w.sh(path.join(w.server, 'alex', 'elsewhere.git'), 'for-each-ref'), '');
});
