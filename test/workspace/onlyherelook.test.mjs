// The upkeep's two looks (src/workspace/onlyherelook.mjs, src/automation/workspacesync.mjs): off until turned on,
// once a day and once a week, they only read, they keep counts and never a name of what the daily check found, and
// the owner is told once per changed answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, cleanSettingsPatch } from '../../src/automation/settings.mjs';
import { apply, decide } from '../../src/automation/workspacesync.mjs';
import { lookOnlyHere, lookServers, onlyHereLine, readLooks, serversLine } from '../../src/workspace/onlyherelook.mjs';

const DAY = 86_400_000;
const off = { ...DEFAULTS.workspace, map: false, ffProjects: {} }; // (the look at the projects has its own tests: instep-brain.test.mjs)
const types = (r) => r.actions.map((a) => a.type);

test('both looks are off at first, and a patch takes only true or false for them', () => {
  assert.equal(DEFAULTS.workspace.onlyHere, false);
  assert.equal(DEFAULTS.workspace.servers, false);
  assert.deepEqual(types(decide({ data: {}, now: 10 * DAY, boot: true, settings: off })), [], 'off: nothing is looked at');
  const patched = cleanSettingsPatch({ workspace: { onlyHere: true, servers: false } }).workspace;
  assert.deepEqual([patched.onlyHere, patched.servers], [true, false]);
  assert.throws(() => cleanSettingsPatch({ workspace: { onlyHere: 'yes' } }));
  assert.throws(() => cleanSettingsPatch({ workspace: { servers: 1 } }));
});

test('the daily look runs once a day and the weekly one once a week, never twice in between', () => {
  const s = { ...off, onlyHere: true, servers: true };
  const first = decide({ data: {}, now: 10 * DAY, settings: s });
  assert.deepEqual(types(first), ['onlyHere', 'servers']);
  assert.deepEqual(types(decide({ data: first.data, now: 10 * DAY + 23 * 3600_000, settings: s })), [], 'not again the same day');
  const second = decide({ data: first.data, now: 11 * DAY, settings: s });
  assert.deepEqual(types(second), ['onlyHere'], 'a day later: the daily one only');
  assert.deepEqual(types(decide({ data: second.data, now: 17 * DAY, settings: s })), ['onlyHere', 'servers'], 'a week after the first: both');
});

test('the daily look keeps counts by kind and no name or path of what it found', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-looks-'));
  const file = path.join(dir, 'workspace-looks.json');
  try {
    const check = async () => ({
      items: [{ kind: 'work', where: '~/secret-project', what: 'private words' }, { kind: 'work', where: '~/other' }, { kind: 'noserver', where: '~/x' }, { kind: '../odd', where: '~/y' }],
      asks: [{}], notChecked: [{ where: '~/z' }, { where: '~/q' }],
    });
    const r = await lookOnlyHere({ check, now: () => Date.UTC(2026, 10, 25), file });
    assert.deepEqual(r, { at: '2026-11-25T00:00:00.000Z', total: 4, kinds: { work: 2, noserver: 1, other: 1 }, asks: 1, notChecked: 2 });
    const kept = fs.readFileSync(file, 'utf8');
    for (const hidden of ['secret-project', 'private words', '~/', 'odd']) assert.ok(!kept.includes(hidden), `${hidden} is kept: ${kept}`);
    assert.deepEqual(readLooks(file).onlyHere, r);
    assert.equal(onlyHereLine(r), '4 things exist only on this computer (1 no git server, 1 other, 2 not committed)');
    assert.equal(onlyHereLine({ total: 0, kinds: {} }), '');
    assert.equal(onlyHereLine({ total: 1, kinds: { folder: 1 } }), '1 thing exists only on this computer (1 a folder in no git)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the upkeep says a changed answer once, tells the owner only when something is only here, and a failure once', async () => {
  const said = [];
  const told = [];
  let answer = { total: 2, kinds: { work: 2 } };
  let data = {};
  const round = () => apply([{ type: 'onlyHere' }], {
    data, record: (e) => said.push(e), notify: (n) => told.push(n), save: (d) => (data = d),
    workspaceOnlyHere: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  await round();
  assert.deepEqual(said.map((e) => e.did), ['2 things exist only on this computer (2 not committed)']);
  assert.equal(told.length, 1);
  assert.match(told[0].message, /Before you format this computer/);
  await round();
  assert.equal(said.length, 1, 'the same answer is not said again');
  assert.equal(told.length, 1, 'and not told again');
  answer = { total: 0, kinds: {} };
  await round();
  assert.equal(said[1].did, 'looked: nothing is only on this computer');
  assert.equal(told.length, 1, 'nothing only here: no notice');
  answer = new Error('the workspace cannot be read');
  await round();
  await round();
  assert.deepEqual(said.slice(2).map((e) => e.outcome), ['failed: the workspace cannot be read'], 'a failing look is said once, not every day');
});

test('the weekly look asks each server once, only reads, and tells gone, renamed and not looked apart', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-looks-ws-'));
  const file = path.join(home, 'workspace-looks.json');
  const ws = path.join(home, 'Workspace');
  const projects = path.join(ws, 'projects');
  try {
    for (const n of ['fine', 'gone', 'renamed', 'offline', 'plain']) fs.mkdirSync(path.join(projects, n, n === 'plain' ? '' : '.git'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'ai_brain'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'ai_brain', 'workspace.json'), JSON.stringify({ version: 2, brain: { url: null }, projects: ['fine', 'gone', 'renamed', 'offline', 'plain', 'elsewhere'].map((name) => ({ name, url: `https://github.com/alex/${name}.git`, repos: [] })), others: [] }));
    const calls = [];
    const run = async (argv) => {
      calls.push(argv.slice(3).join(' '));
      const name = path.basename(argv[2]);
      const cmd = argv[3];
      if (cmd === 'remote') return { ok: true, stdout: `https://github.com/alex/${name}.git\n`, stderr: '' };
      if (cmd === 'symbolic-ref') return { ok: true, stdout: 'origin/main\n', stderr: '' };
      if (name === 'gone') return { ok: false, stdout: '', stderr: 'remote: Repository not found.\nfatal: repository not found' };
      if (name === 'offline') return { ok: false, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: git.example' };
      return { ok: true, stdout: `ref: refs/heads/${name === 'renamed' ? 'trunk' : 'main'}\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n`, stderr: '' };
    };
    const r = await lookServers({ dir: ws, projects, run, now: () => Date.UTC(2026, 10, 25), file });
    assert.deepEqual(r, { at: '2026-11-25T00:00:00.000Z', looked: 2, gone: ['gone'], renamed: [{ label: 'renamed', here: 'main', there: 'trunk' }], notLooked: 1 });
    assert.ok(calls.every((c) => /^(remote get-url origin|symbolic-ref -q --short refs\/remotes\/origin\/HEAD|ls-remote --symref origin HEAD)$/.test(c)), `only reads: ${[...new Set(calls)].join(' | ')}`);
    assert.equal(calls.filter((c) => c.startsWith('ls-remote')).length, 4, 'a repository that is on this computer is asked once; a folder that is no repository and one that is not here are not');
    assert.equal(serversLine(r), '1 repository is not seen on the git server any more (gone, or your sign-in there no longer reaches it): gone; renamed: the server\'s default branch is trunk, here it is main');
    assert.equal(serversLine({ gone: [], renamed: [], looked: 3, notLooked: 0 }), '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the page has the two switches, off by default, each with what it does and that it only reads', async () => {
  const src = fs.readFileSync(new URL('../../web/wslooks.js', import.meta.url), 'utf8');
  assert.match(src, /toggle\(ONLY_HERE_LABEL, w\.onlyHere === true, \(v\) => save\(\{ onlyHere: v \}\), ONLY_HERE_HINT\)/);
  assert.match(src, /toggle\(SERVERS_LABEL, w\.servers === true, \(v\) => save\(\{ servers: v \}\), SERVERS_HINT\)/);
  assert.match(src, /It changes nothing and uploads nothing\./);
  assert.match(src, /It only reads, with your own git sign-in; nothing is fetched or changed\./);
  const page = fs.readFileSync(new URL('../../web/workspace.js', import.meta.url), 'utf8');
  assert.match(page, /\.\.\.looksToggles\(w, save\),/);
  assert.match(page, /credentials: false, onlyHere: false, servers: false, \.\.\./, 'the panel\'s own default is off');
});
