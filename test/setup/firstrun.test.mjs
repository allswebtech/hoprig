// The single guided run: the dashboard's steps, then this computer, a project, skills, then the summary.
// Every part is a fake that records its call, so the order, the skips and the flags can be checked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });

const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const FR = await import('../../src/setup/firstrun.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { which } = await import('../../src/setup/system.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude({ loggedIn: true }) });
function sys() {
  const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
  const made = K.sysInfo({ env, has: (c) => c !== 'systemctl' && !!which(c, env, process.platform), pm: null, root: false, serviceSupported: false, publicIps: [] });
  made.probe = async () => 0;
  return made;
}

const PROJECTS = path.join(s.tmp, 'projects');

/** Fake parts that record calls in `log`; `over` replaces some of them. */
function fakes(log, over = {}) {
  return {
    workspace: async () => ({ ok: true, changed: false }), // its own tests: test/workspace
    git: async () => ({ ok: true, changed: false }),
    pc: async (o) => {
      log.push(['pc', { yes: o.yes, dryRun: o.dryRun, rules: o.rules }]);
      return { ok: true, changed: false, missing: [], code: 0 };
    },
    projects: async () => ({ dir: PROJECTS, names: fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [] }),
    projectNew: async (args) => {
      log.push(['projectNew', args]);
      fs.mkdirSync(path.join(PROJECTS, args[0]), { recursive: true });
      return 0;
    },
    cloneProject: async (spec) => {
      log.push(['cloneProject', spec]);
      fs.mkdirSync(path.join(PROJECTS, 'shop'), { recursive: true });
      return 0;
    },
    projectSkills: async (o) => {
      log.push(['projectSkills', { project: o.project, yes: o.yes, dryRun: o.dryRun }]);
      return { ok: true, added: ['some-skill'], skipped: [] };
    },
    userSkills: async (o) => {
      log.push(['userSkills', { yes: o.yes, dryRun: o.dryRun }]);
      return { ok: true, added: [], skipped: [] };
    },
    ...over,
  };
}

const ui = (o = {}) => {
  const rec = recorder();
  const answers = [...(o.answers || [])];
  return { rec, ui: makeUi({ interactive: !!o.answers, write: rec.write, askLine: async (q) => { if (!answers.length) throw new Error(`unexpected question: ${q}`); return answers.shift(); }, ...o }) };
};

test('--only takes one part; anything else is refused', () => {
  assert.equal(SU.parseSetupArgs(['--only', 'pc']).only, 'pc');
  assert.equal(SU.parseSetupArgs(['--only=skills']).only, 'skills');
  assert.throws(() => SU.parseSetupArgs(['--only', 'all']), /--only must be one of: base, pc, git, workspace, project, skills/);
});

test('the whole run, in order: dashboard steps, this computer, a project, skills, then the summary', async () => {
  const log = [];
  const { ui: u, rec } = ui({ yes: true });
  const code = await SU.setup(['--yes', '--no-service'], { ui: u, sys: sys(), parts: fakes(log) });
  assert.equal(code, 0, rec.text);
  assert.deepEqual(log.map((x) => x[0]), ['pc', 'userSkills']);
  const t = rec.text;
  const at = (re) => t.search(re);
  assert.ok(at(/Claude Code 2\.1\.300/) < at(/\nA project\n/), 'dashboard steps first');
  assert.ok(at(/\nA project\n/) < at(/\nSkills\n/));
  assert.ok(at(/\nSkills\n/) < at(/hoprig is ready/), 'the summary last');
});

test('--yes: the default kits without the working rules, no project added, only the skills that need no person', async () => {
  const log = [];
  const { ui: u, rec } = ui({ yes: true });
  await FR.runParts(u, { yes: true, dryRun: false }, { parts: fakes(log) });
  assert.deepEqual(log, [['pc', { yes: true, dryRun: false, rules: false }], ['userSkills', { yes: true, dryRun: false }]]);
  assert.match(rec.text, /Later: hoprig project new <name>/);
});

test('--dry-run: every part told so, nothing created', async () => {
  const log = [];
  const { ui: u, rec } = ui({ dryRun: true });
  await FR.runParts(u, { yes: false, dryRun: true }, { parts: fakes(log) });
  assert.deepEqual(log, [['pc', { yes: false, dryRun: true, rules: null }], ['userSkills', { yes: false, dryRun: true }]]);
  assert.match(rec.text, /\(dry run\) would ask for a project/);
  assert.equal(fs.existsSync(PROJECTS), false);
});

test('--only pc / project / skills runs that part alone; --only base runs none of them', async () => {
  for (const [only, expect] of [['pc', ['pc']], ['skills', ['userSkills']]]) {
    const log = [];
    await FR.runParts(ui({ yes: true }).ui, { yes: true }, { only, parts: fakes(log) });
    assert.deepEqual(log.map((x) => x[0]), expect, only);
  }
  const log = [];
  const { ui: u } = ui({ yes: true });
  assert.equal(await SU.setup(['--only', 'base', '--yes', '--no-service'], { ui: u, sys: sys(), parts: fakes(log) }), 0);
  assert.deepEqual(log, []);
  const log2 = [];
  const only = ui({ yes: true });
  await SU.setup(['--only', 'pc', '--yes'], { ui: only.ui, sys: sys(), parts: fakes(log2) });
  assert.deepEqual(log2.map((x) => x[0]), ['pc']);
  assert.doesNotMatch(only.rec.text, /hoprig is ready|Dashboard/, 'no dashboard steps, no summary');
});

test('a hub stops after the dashboard steps', async () => {
  const log = [];
  const { ui: u, rec } = ui({ yes: true });
  await SU.setup(['--hub', '--yes', '--no-service', '--access', 'local'], { ui: u, sys: sys(), parts: fakes(log) });
  assert.deepEqual(log, []);
  assert.doesNotMatch(rec.text, /\nA project\n/);
  const again = ui({ yes: true });
  await SU.setup(['--only', 'skills', '--yes'], { ui: again.ui, sys: sys(), parts: fakes(log) });
  assert.deepEqual(log, [], 'hubOnly is remembered: no parts later either');
  assert.match(again.rec.text, /A hub has no computer, project or skills step/);
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), '{}');
});

test('a failing part does not stop the next ones; it is named at the end with its retry, and the exit code says so', async () => {
  const log = [];
  const parts = fakes(log, { pc: async () => { throw new Error('apt is locked by another program'); } });
  const { ui: u, rec } = ui({ yes: true });
  const code = await SU.setup(['--yes', '--no-service'], { ui: u, sys: sys(), parts });
  assert.equal(code, 1);
  assert.deepEqual(log.map((x) => x[0]), ['userSkills'], 'the skills still ran');
  assert.match(rec.text, /This computer for coding: not finished \(apt is locked by another program\)\s+retry: hoprig pc setup/);
  const failedSkills = fakes([], { userSkills: async () => ({ ok: false, added: [], skipped: [{ id: 'x', why: 'offline' }] }) });
  const r = await FR.runParts(ui({ yes: true }).ui, { yes: true }, { parts: failedSkills });
  assert.deepEqual(r.map((x) => [x.part, x.ok]), [['pc', true], ['git', true], ['workspace', true], ['project', true], ['skills', false]]);
});

test('a project: a new name is created and its skills are offered for it', async () => {
  const log = [];
  const { ui: u } = ui({ answers: ['demo'] });
  await FR.runParts(u, {}, { parts: fakes(log) });
  assert.deepEqual(log.map((x) => x[0]), ['pc', 'projectNew', 'projectSkills']);
  assert.deepEqual(log[1][1], ['demo']);
  assert.equal(log[2][1].project, path.join(PROJECTS, 'demo'));
});

test('projects already there: nothing asked; --only project asks, an existing name is just chosen', async () => {
  const log = [];
  const { ui: u, rec } = ui({ answers: [] });
  await FR.runParts(u, {}, { parts: fakes(log) });
  assert.match(rec.text, /projects: demo/);
  assert.deepEqual(log.map((x) => x[0]), ['pc', 'userSkills']);
  const log2 = [];
  await FR.runParts(ui({ answers: ['demo'] }).ui, {}, { only: 'project', parts: fakes(log2) });
  assert.deepEqual(log2, [], 'chosen, not created again');
});

test('a project from GitHub is cloned; an answer that is no project is refused and the rest goes on', async () => {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  const log = [];
  await FR.runParts(ui({ answers: ['someone/shop'] }).ui, {}, { parts: fakes(log) });
  assert.deepEqual(log.map((x) => x[0]), ['pc', 'cloneProject', 'projectSkills']);
  assert.equal(log[2][1].project, path.join(PROJECTS, 'shop'));
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  const log2 = [];
  const { ui: u, rec } = ui({ answers: ['not a project!'] });
  const r = await FR.runParts(u, {}, { parts: fakes(log2) });
  assert.match(rec.text, /"not a project!" is not a project name/);
  assert.deepEqual(r.map((x) => [x.part, x.ok]), [['pc', true], ['git', true], ['workspace', true], ['project', false], ['skills', true]]);
  assert.equal(log2.at(-1)[0], 'userSkills');
});

test('Enter skips the project', async () => {
  const log = [];
  await FR.runParts(ui({ answers: [''] }).ui, {}, { parts: fakes(log) });
  assert.deepEqual(log.map((x) => x[0]), ['pc', 'userSkills']);
});

test('the real user skills step: the bundled hoprig skill, without a network, once', async () => {
  const said = [];
  const sui = { say: (l) => said.push(l), confirm: async () => true };
  const r = await FR.userSkills({ ui: sui, yes: true });
  assert.equal(r.ok, true, said.join('\n'));
  assert.deepEqual(r.added, ['hoprig']);
  assert.ok(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'hoprig', 'SKILL.md')));
  const again = await FR.userSkills({ ui: sui, yes: true });
  assert.deepEqual(again.added, []);
  assert.match(said.at(-1), /the ones that come with Hoprig are installed/);
  const dry = await FR.userSkills({ ui: sui, dryRun: true });
  assert.deepEqual(dry.added, []);
});
