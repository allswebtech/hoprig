// What the README and the site's pages say about the product, held to the code that does it: a default, a switch's
// name, what an installer installs. When the code changes, the sentence has to change with it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealed } from './seal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
/** The README's section under `## heading`, up to the next `## `. */
const section = (heading) => {
  const t = read('README.md');
  const at = t.indexOf(`\n## ${heading}\n`);
  assert.ok(at >= 0, `the README has a section "${heading}"`);
  const end = t.indexOf('\n## ', at + 4);
  return t.slice(at, end < 0 ? undefined : end);
};
const SLEEP = 'site/content/use-cases/work-while-you-sleep.md';
/** A page's section under `## heading`, up to the next `## `. */
const part = (file, heading) => {
  const t = read(file);
  const at = t.indexOf(`\n## ${heading}\n`);
  assert.ok(at >= 0, `${file} has a section "${heading}"`);
  const end = t.indexOf('\n## ', at + 4);
  return t.slice(at, end < 0 ? undefined : end);
};
/** The Missions part of docs/WORK.md, on one line. */
const missions = () => flat(read('docs/WORK.md').split('## Missions')[1].split('\n## ')[0]);
/** docs/OPERATOR.md's part on her administrator rights and git sign-in, on one line. */
const rights = () => flat(part('docs/OPERATOR.md', 'Administrator rights and the git sign-in of her sessions'));
/** The README's section "Not built, or not proven yet", on one line. */
const notBuilt = () => flat(section('Not built, or not proven yet'));
/** docs/HANDS-OFF.md on one line. */
const handsOff = () => flat(read('docs/HANDS-OFF.md'));
// Made-up places for the wall, as test/hands-off-examples.test.mjs has them: nothing here exists on disk.
// They are POSIX places, read as on Linux everywhere: on Windows `/w` is the drive-relative `W:`, which no home is.
const places = { platform: 'linux', cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
/** A made-up git for the wall: the default branch is main, the session stands on the work branch feature. */
const git = (cwd, args) => {
  const a = args.join(' ');
  if (/^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return 'origin/main';
  if (a === 'symbolic-ref --short HEAD') return 'feature';
  return null;
};
/** The kind the wall holds a shell line for, or null when it goes through. */
const held = async (line) => {
  const { wallHeld } = await import('../src/wall.mjs');
  const h = wallHeld({ tool: 'Bash', input: { command: line }, cwd: places.cwd, git, places });
  return h ? h.kind : null;
};

test('the work-while-you-sleep use case shows Work → Schedules, and the screenshot tool takes that page', () => {
  assert.match(read('tools/screenshots.mjs'), /'work-schedules-desktop-light': async \(\) => view\('#\/work\/schedules'/);
  assert.match(read(SLEEP), /!\[Work → Schedules[^\]]*\]\(\/screenshots\/work-schedules-desktop-light\.webp\)/);
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/screenshots/work-schedules-desktop-light.webp')));
  // The caption says what the picture holds: the demo's schedules (it makes two and no repeating task).
  const demo = read('src/demo/index.mjs');
  assert.equal([...demo.matchAll(/await api\('\/api\/automation\/schedules', \{/g)].length, 2, 'the demo makes two schedules');
  assert.doesNotMatch(demo, /\brepeat: \{/, 'the demo makes no repeating task');
  assert.match(read(SLEEP), /!\[Work → Schedules: two schedules, with the queued messages below\]/);
});

test('with tmux, Reopen sessions after a restart is off at first, and the pages say so; tmux is explained where it first stands', async () => {
  const { DEFAULTS, restoreOn } = await import('../src/automation/settings.mjs');
  assert.equal(restoreOn(DEFAULTS, { capabilities: { persistent: true } }), true, 'tmux: on at first too: a restart of the computer ends tmux');
  assert.equal(restoreOn(DEFAULTS, { capabilities: { persistent: false } }), true, 'the built-in terminals: on at first');
  for (const text of [flat(section('It keeps going without you')), flat(read(SLEEP))]) {
    assert.doesNotMatch(text, /survive a restart by themselves/);
    assert.match(text, /With tmux \(a program that keeps terminals running[^)]*\) it is off at first/);
    assert.match(text, /not a restart of the computer/);
  }
  const readme = read('README.md');
  const first = readme.search(/\btmux\b/);
  assert.match(readme.slice(first, first + 80), /^tmux \(a program that keeps terminals running/);
});

test('what starts by itself: fixed rules start things, and what they start can be an AI run; no page says "no AI"', async () => {
  // The dashboard offers both: a schedule that lets the AI work by itself, and a task run by AI at a time.
  assert.match(read('web/automation.js'), /'Let the AI work by itself'/);
  assert.match(read('web/workitems.js'), /'Run by AI'/);
  const readme = flat(section('It keeps going without you'));
  const sleep = flat(read(SLEEP));
  for (const text of [readme, sleep]) {
    assert.doesNotMatch(text, /No AI (is )?involved/);
    assert.match(text, /with no AI deciding/);
    assert.match(text, /What they start can be an AI session/);
    assert.match(text, /\*\*Schedules\*\*: [^.]*let the AI work by itself/);
  }
  assert.doesNotMatch(sleep, /never start by themselves/);
  // The list is whole: a mission's tasks start too, after its plan's Accept, and missions are off at first.
  const { missionSettings } = await import('../src/mission/settings.mjs');
  assert.equal(missionSettings({}).on, false, 'missions are off at first');
  assert.match(read('web/mission.js'), /'Missions and the team'/);
  assert.match(sleep, /A task of Work starts on your \*\*Do it\*\*, on your yes to Tia's card, at the time you set on it with \*\*Run by AI\*\*, or, in a mission whose plan you accepted, by Tia \(missions are off until you turn them on, on Work → Team\)\./);
});

/**
 * install.sh run for real on a made-up Linux computer with nothing installed but what the script needs to run: a node
 * that reports `node`, an apt-get, sudo and curl that are stand-ins, and no build tools. Without --yes and with no
 * terminal it shows what it will install and runs it; the stand-ins make that fail, so nothing is installed.
 */
function installerAsks(node) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-install-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const fixture = path.join(ROOT, 'test', 'fixtures', 'runner', 'node-version.mjs');
  const programs = { uname: 'echo Linux', 'apt-get': 'exit 1', sudo: 'exit 1', curl: 'exit 0', node: `exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(fixture)} "$@"` };
  for (const [name, body] of Object.entries(programs)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const tool of ['sh', 'id', 'sed', 'mktemp', 'tail', 'rm', 'env', 'cat', 'mkdir', 'chmod', 'grep']) {
    const real = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p)); // seal: a value no program is started with
    if (real) fs.symlinkSync(real, path.join(bin, tool));
  }
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return new Promise((resolve) => {
    // The stand-in sudo and apt-get fail: the installer says what it installs, then runs it, and ends at that failure.
    const child = spawn('sh', [path.join(ROOT, 'install.sh')], { env: sealed({ PATH: bin, HOME: home, SEAL_FAKE_NODE: node }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, home });
    });
  });
}

test('the install paragraph names what install.sh installs, with sudo, and the lowest Node.js is the one the code says', { skip: process.platform === 'win32' && 'install.sh is for macOS and Linux' }, async () => {
  const { MIN_NODE_TEXT } = await import('../src/nodefloor.mjs');
  assert.equal(/\n  MIN_NODE=(\S+) /.exec(read('install.sh'))[1], MIN_NODE_TEXT, 'install.sh checks the floor of src/nodefloor.mjs');
  const [major, minor] = MIN_NODE_TEXT.split('.').map(Number);
  const older = await installerAsks(`${major}.${minor - 1}.9`);
  assert.equal(older.code, 1, older.out);
  assert.doesNotMatch(older.out, /no terminal to ask in|Install now/, 'it asks nothing: it says what it installs and does it');
  assert.match(older.out, /hoprig installer: installing build-essential python3 tmux did not succeed/, 'it ran the install, which the stand-in refused');
  assert.match(older.out, /^Hoprig needs a few parts of the system\. If your computer asks for its password, type it and press Enter/m, 'the system parts, with sudo, said in one plain line');
  assert.match(older.out, /Found Node\.js \S+, older than \S+, the lowest Hoprig runs on: the newest long-term release of Node\.js goes in its place, for you only, with nvm\./, 'an older Node.js is installed again');
  const floor = await installerAsks(MIN_NODE_TEXT.split('.').length === 3 ? MIN_NODE_TEXT : `${MIN_NODE_TEXT}.0`);
  assert.doesNotMatch(floor.out, /Found Node\.js/, 'the lowest supported Node.js is kept');
  assert.match(floor.out, /^Hoprig needs a few parts of the system\./m);
  const v = MIN_NODE_TEXT.replaceAll('.', '\\.');
  const p = flat(section('Install'));
  assert.match(p, new RegExp(`It says what is missing and installs it without asking \\(Node\\.js ${v} or newer when it is missing or older, and on Linux the build tools and a few system parts, with sudo, which asks for its own password; Ctrl-C stops it\\)`));
  assert.match(flat(read('README.md')), new RegExp(`Requires Node\\.js ${v} or newer \\(`));
  assert.match(read('docs/INSTALL.md'), new RegExp(`\\n- \\*\\*Node\\.js ${v} or newer\\.\\*\\*`));
  // The skill's own package (npx hoprig-skill) says the floor its package.json asks for. Its README is written by
  // hand: tools/build-skill.mjs writes only the skill files, the package.json and the LICENSE.
  assert.equal(JSON.parse(read('packages/hoprig-skill/package.json')).engines.node, `>=${MIN_NODE_TEXT}`);
  assert.match(read('packages/hoprig-skill/README.md'), new RegExp(`\\nNode\\.js ${v} or later\\. No dependency\\.`));
});

test('the install paragraph: setup ends with a QR code, and on a server with how to reach it instead', async (t) => {
  // Setup's own last step, run with made-up facts (settings and state folders of this test's own, a phone address on
  // a made-up network); what it prints is what the sentence says. With a phone address it makes a one-time sign-in
  // link: its token is kept in <state folder>/login-links.json, so the folders are this test's own, made here and
  // removed at its end (src/paths.mjs reads them from the environment at each call), as test/setup does.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-setup-'));
  const before = { config: process.env.HOPRIG_CONFIG_DIR, state: process.env.HOPRIG_STATE_DIR };
  const runLinks = before.state && path.join(before.state, 'login-links.json');
  const runLinksAtStart = runLinks && fs.existsSync(runLinks) ? fs.readFileSync(runLinks, 'utf8') : null;
  process.env.HOPRIG_CONFIG_DIR = path.join(own, 'config');
  process.env.HOPRIG_STATE_DIR = path.join(own, 'state');
  t.after(() => {
    for (const [k, v] of [['HOPRIG_CONFIG_DIR', before.config], ['HOPRIG_STATE_DIR', before.state]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(own, { recursive: true, force: true });
  });
  const { stepSummary } = await import('../src/setup/setup.mjs');
  const { makeUi } = await import('../src/setup/ui.mjs');
  const end = async (state) => {
    let text = '';
    await stepSummary(makeUi({ interactive: false, write: (s) => (text += s), askLine: async () => '' }), state, { user: 'alex', publicIps: [], env: {} });
    return text;
  };
  const desk = await end({ phoneUrl: 'http://192.168.1.20:7433/' });
  assert.match(desk, /Scan with your phone's camera/);
  // The sign-in token went into this test's own state folder, and the run's state folder is as it was.
  assert.equal(JSON.parse(fs.readFileSync(path.join(own, 'state', 'login-links.json'), 'utf8')).pending.length, 1, 'one sign-in link, in the test\'s own folder');
  if (runLinks) assert.equal(fs.existsSync(runLinks) ? fs.readFileSync(runLinks, 'utf8') : null, runLinksAtStart, 'the run\'s state folder got no sign-in link');
  assert.match(desk, /[▀▄█]/, 'a QR code is drawn');
  const server = await end({ server: { kind: 'ssh' } });
  assert.match(server, /How to open the dashboard:/);
  assert.doesNotMatch(server, /[▀▄█]|Scan with/, 'no QR code on a server');
  assert.match(flat(section('Install')), /ends with a QR code \(on a server: how to reach it from your own computer\)/);
});

test('the Operator line: one recommended step, nothing without a tap unless a rule of Tia, Tia decides or a look is on (all off at first)', async () => {
  const { readOperator, RULE_IDS } = await import('../src/operator/rules.mjs');
  const { readDecide } = await import('../src/operator/decide-store.mjs');
  const off = readOperator({});
  assert.equal(off.acts, false);
  assert.ok(RULE_IDS.length > 0 && RULE_IDS.every((id) => off.rules[id] === false), 'every rule is off at first');
  assert.equal(readDecide({}).on, false, 'Tia decides is off at first');
  // A look starts a session by itself with no rule and no Tia decides: only Tia acts by herself and the look's own switch.
  const { looks, readLook } = await import('../src/operator/look.mjs');
  assert.equal(readLook({}).on, false, 'the looks are off at first');
  const lookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  const only = { operator: { acts: true, look: { on: true } }, assistant: { enabled: true } };
  assert.ok(RULE_IDS.every((id) => readOperator(only).rules[id] === false) && readDecide(only).on === false);
  assert.equal(looks({ ctx: { config: () => only }, dir: () => lookDir }).enabled(), true, 'a look may start with every rule and Tia decides off');
  fs.rmSync(lookDir, { recursive: true, force: true });
  // The Operator has no page of its own: its cards are rows of Home's Needs you, and the switches of Tia are on Settings, Tia.
  assert.match(read('web/operator.js'), /#\/operator opens Home/);
  assert.match(read('web/operator-tia.js'), /fold\('tia-alone', 'What she may do alone'/);
  const what = flat(section('What it does'));
  const op = /- \*\*Operator\*\*:[^\n]*?(?= - \*\*Updates\*\*)/.exec(what)[0];
  assert.match(op, /one recommended step for each/);
  // Both ways Tia acts without a tap are named, as the page names them.
  assert.match(op, /nothing happens until you tap it, unless you switched on one of Tia's rules, \*\*Tia decides\*\* or \*\*Tia looks into what nobody can explain\*\* \(all are off at first/);
  assert.match(flat(read('docs/OPERATOR.md')), /nothing happens until you tap it, unless you switch on one of Tia's rules, \*\*Tia decides\*\* or \*\*Tia looks into what nobody can explain\*\* \(below\)\. All of them are off after an install and after an update\./);
  assert.match(read('site/content/changelog.md'), /^- \*\*While Tia's rules, Tia decides and her looks are off, nothing happens until you tap\.\*\*/m);
  // Three places name what needs you; each says what it holds that the others do not.
  assert.match(op, /everything Hoprig watches/);
  // Work's Today lists what is due this week and what waits for his yes (todayView); the page adds the sessions that
  // need an OK or reached a usage limit. Said in those words, not as "your own part".
  const { todayView } = await import('../src/work/today.mjs');
  const day = '2030-03-04';
  const v = todayView([
    { id: 'a', title: 'due in three days', status: 'open', date: '2030-03-07', days: 3 },
    { id: 'b', title: 'waits for your yes', status: 'waiting' },
    { id: 'c', title: 'in a month', status: 'open', date: '2030-04-04', days: 31 },
  ], day);
  assert.deepEqual(v.needsYou.map((it) => it.id).sort(), ['a', 'b']);
  // The sessions that need an OK are Home's, not Work's any more (Work keeps the tasks).
  assert.doesNotMatch(read('web/work.js'), /filter\(needsYou\)/);
  assert.match(what, /\*\*Work\*\*: your tasks, and its \*\*Tasks\*\* tab that lists what waits for your yes first and what is due this week\./);
  assert.doesNotMatch(what, /your own part/);
});

test('Work, what is not there yet: Do it has a branch of its own now; the OKs are on the dashboard', async () => {
  // A run of Do it, like a run that ends by itself, works on a branch of its own (alone.mjs branchOf), never the default branch.
  const { branchOf } = await import('../src/work/alone.mjs');
  assert.equal(branchOf('T-12 fix login'), 'work/t-12-fix-login');
  assert.match(read('src/work/doit.mjs'), /const asked = branchOf\(id\);/);
  // A session that waits for an OK is an item of the Operator; Today's view of the task list has no sessions in it
  // (the page adds them), and `hoprig tasks` prints that view.
  const { detectAsks } = await import('../src/operator/detect/asks.mjs');
  const asks = detectAsks({ sessions: [{ name: 'shop', asks: ['main'], askType: 'permission' }] });
  assert.deepEqual(asks.map((it) => it.kind), ['asks']);
  const { todayView } = await import('../src/work/today.mjs');
  assert.deepEqual(Object.keys(todayView([], '2030-03-04')).sort(), ['counts', 'doneLately', 'needsYou', 'toReview', 'today', 'week']);
  assert.match(read('src/work/cli.mjs'), /const t = todayView\(items, store\.today\(\)\);/);
  assert.match(read('web/home.js'), /cardOrder\(oneCardPerKey/, 'Home lists the sessions that need an OK first');
  const item = flat(/- \*\*Work, what is not there yet\*\*[\s\S]*?(?=\n- \*\*)/.exec(section('Not built, or not proven yet'))[0]);
  assert.doesNotMatch(item, /\(only a run/);
  assert.doesNotMatch(item, /not on a branch of its own/);
  assert.match(item, /The sessions that need an OK are shown on the dashboard \(Home, the Operator\), not in `hoprig tasks`\./);
});

test('the automations have the dashboard\'s own names: the queue switch, and no "Restore" for reopening sessions', () => {
  const page = read('web/automation.js');
  for (const name of ['Reopen sessions after a restart', 'Try again after a server error']) assert.ok(page.includes(`'${name}'`), name);
  assert.ok(!read('web/workschedules.js').includes('Queued messages'), 'the queue is on the session, not on Schedules');
  const pages = [section('It keeps going without you'), read(SLEEP)].map(flat);
  // The queue has no switch any more; the README's section may still say it did until its own words are changed.
  for (const text of pages) assert.match(text, /\*\*Queue\*\* \((the switch \*\*Send the next queued message\*\*, on at first|always on: it acts only on messages you queued); you queue a message on the session itself\)/);
  // "Restore code", "Restore conversation" (Rewind) and `workspace restore` are other things of the same word.
  const oldName = /\bRestore\b(?! code| conversation)/;
  for (const f of ['site/content/use-cases/always-on-coding-machine.md', SLEEP]) assert.doesNotMatch(read(f), oldName, f);
  assert.doesNotMatch(section('Not built, or not proven yet'), oldName);
  assert.match(flat(read('site/content/use-cases/always-on-coding-machine.md')), /\*\*Reopen sessions after a restart\*\* \(Settings → Automations\)/);
});

test('the commands table: a row with subcommands lists all of them, and the table says it is a short list', async () => {
  const table = section('Commands');
  const row = (start) => (table.split('\n').find((l) => l.startsWith(start)) || '');
  const { USAGE: SHIP } = await import('../src/ship/cli.mjs');
  for (const sub of [...new Set([...SHIP.matchAll(/hoprig ship ([a-z]+)/g)].map((m) => m[1]))]) assert.match(row('hop ship '), new RegExp(`\\b${sub}\\b`), `ship ${sub}`);
  const service = /service ([a-z|]+)/.exec(read('src/server/cli.mjs'))[1].split('|');
  assert.deepEqual(service, ['install', 'uninstall', 'status', 'restart']);
  for (const sub of service) assert.match(row('hop service '), new RegExp(`\\b${sub}\\b`), `service ${sub}`);
  assert.match(read('bin/hoprig.mjs'), /case 'sync': \{[^}]*ws\.main\(\['sync', \.\.\.rest\]\)/);
  assert.match(row('hop sync '), /= hop workspace sync/);
  assert.match(flat(table), /A short list: `hop help` has every command, and `hop <command> --help` its words\./);
  assert.match(row('hop box '), /no network, and it cannot see your home folder/);
  // Every row names a command the program dispatches (bin/hoprig.mjs), or a provider's name (<profile>).
  const bin = read('bin/hoprig.mjs');
  const rows = table.split('\n').filter((l) => l.startsWith('hop'));
  assert.ok(rows.length > 20, 'the table is there');
  for (const l of rows) {
    // The command part is what stands before the first wide gap; "hop" alone and "hop <profile>" name no command.
    const cmd = l.split(/\s{2,}/)[0].split(' ')[1];
    if (cmd === undefined || cmd.startsWith('<')) continue;
    assert.ok(bin.includes(`case '${cmd}':`), `hop ${cmd} is a command`);
  }
  // Tasks: every subcommand the row names is one of the command's own (its usage), and done, open and drop all stand.
  const { USAGE: TASKS } = await import('../src/work/cli.mjs');
  const taskSubs = new Set([...TASKS.matchAll(/hoprig tasks ([a-z|-]+)/g)].flatMap((m) => m[1].split('|')));
  const tasksRow = /^hop tasks \[today\] ((?:\| [a-z-]+ )+)/.exec(row('hop tasks '))[1].split('|').map((w) => w.trim()).filter(Boolean);
  for (const sub of tasksRow) assert.ok(taskSubs.has(sub), `tasks ${sub}`);
  for (const sub of ['done', 'open', 'drop']) assert.ok(tasksRow.includes(sub), `the row names tasks ${sub}`);
  // Workspace: both rows name only the command's own subcommands (src/workspace/cli.mjs and cli-git.mjs).
  const { GIT_COMMANDS } = await import('../src/workspace/cli-git.mjs');
  const wsSubs = new Set([...GIT_COMMANDS, ...[...read('src/workspace/cli.mjs').matchAll(/\bsub === '([a-z-]+)'/g)].map((m) => m[1])]);
  for (const l of rows.filter((x) => x.startsWith('hop workspace '))) {
    for (const sub of /^hop workspace ([a-z| -]+?)\s{2,}/.exec(l)[1].split('|').map((w) => w.trim())) assert.ok(wsSubs.has(sub), `workspace ${sub}`);
  }
});

test('Tried by hand only on Linux: short sentences, plain words, and where CI runs the tests (macOS; Windows, not blocking)', () => {
  const wf = read('.github/workflows/test.yml');
  assert.match(wf, /os: \[ubuntu-latest, macos-latest\]/);
  assert.match(wf, /\n {4}runs-on: windows-latest\n {4}timeout-minutes: \d+\n {4}continue-on-error: true\n/, 'the Windows job does not block');
  const item = flat(/- \*\*Tried by hand only on Linux\*\*[\s\S]*?(?=\n- \*\*)/.exec(section('Not built, or not proven yet'))[0]);
  assert.doesNotMatch(section('Not built, or not proven yet'), /\*\*Run only on Linux\*\*/);
  assert.doesNotMatch(item, /the workspace on demand|in use\b/);
  assert.match(item, /Everything new in this version was also run only on Linux, and not yet with two real computers linked/);
  assert.match(item, /The tests also run on GitHub on macOS, and on Windows, where a failure does not yet block\./);
  assert.match(item, /projects fetched only when you ask \(`hoprig get`, `hoprig drop`\)/);
  // One idea in a sentence: no sentence of the item is longer than 70 words.
  for (const s of item.split(/ - |(?<=[.:])\s+(?=[A-Z*])/)) assert.ok(s.split(' ').length <= 70, `${s.split(' ').length} words: ${s}`);
});

test('the Computers guide names a hub\'s rows in Work → Activity by the label the page shows', () => {
  assert.match(read('web/automation.js'), /hub: 'Another dashboard'/);
  assert.match(read('src/machines/tokenaudit.mjs'), /did: `The main computer \$\{name\} /);
  assert.match(flat(read('docs/COMPUTERS.md')), /in this computer's \*\*Work → Activity\*\*, marked "Another dashboard", with the main computer's name in the sentence, such as "The main computer office-pc started the public link"/);
});

test('the section on her administrator rights and git sign-in says what the code does', async () => {
  const { FULL_ADMIN_PER_HOUR, HER_RIGHTS_DEFAULT, fullConfirmSentence } = await import('../src/assistant/herrights.mjs');
  const { GIT_HOST } = await import('../src/assistant/hersignin.mjs');
  const text = rights();
  assert.equal(HER_RIGHTS_DEFAULT, 'off');
  assert.match(text, /\*\*Off\*\* \(the default, and what an install leaves;/);
  assert.ok(text.includes(`\`${fullConfirmSentence('this computer')}\``), 'the sentence typed to turn Full on is the one the route takes');
  assert.ok(text.includes(`At most ${FULL_ADMIN_PER_HOUR} of her own such commands run in an hour`), 'the hour\'s limit is the one of the code');
  assert.ok(text.includes(`a token for ${GIT_HOST}`), 'the git server named is the one the sign-in is for');
  // What Full does not lift, as the wall and the hook decide it (a delete as administrator stays his card).
  assert.match(text, /even at Full a delete as administrator outside the session's own folder \(`sudo rm`/);
  // A delete plainly inside the folder runs at Full (test/assistant/fullholds.test.mjs), as without sudo.
  assert.match(text, /A delete plainly inside the session's own folder \(`sudo rm -rf build`\) runs at Full, as it does without `sudo`/);
  // What Full still holds beside it (wall.mjs behindAdmin `unsure`, a nested administrator command), what it does not
  // (adminReads), and her own tool's `$` word (adminrefused.mjs word-not-read) and delete (policy.mjs).
  assert.match(text, /Also your card at Full: a program that does not only read given a word Hoprig cannot read with certainty \(another variable than `\$HOME`, `~name`, a list in braces\), and an administrator command inside another command's text/);
  assert.match(text, /A program that only reads \(`sudo ls ~`, `sudo journalctl …`\) is not held for naming the home folder/);
  assert.match(text, /Her own command \(not a session's\) with a `\$` word is refused at every level: she runs the words as written/);
  assert.match(text, /her own command that deletes as administrator is your card at Full wherever it deletes/);
  assert.match(text, /is refused at every level/);
  assert.match(text, /\| Full \| runs with no card, except a delete as administrator outside the session's own folder and what no level allows \(your card\) \| your card \|/);
  // The limits: what the hook does not read, and a Codex or OpenCode session of hers refused below Full (start.mjs).
  assert.match(text, /What a script or another program it starts then does .* is not read, so this protects against a mistake, not against a session that hides what it does/);
  assert.match(text, /below Full she cannot start a session on them/);
  assert.match(text, /no hold: a delete as administrator outside the session's own folder, a push to the main branch/);
  assert.doesNotMatch(text, /at Off or Ask it runs with no card/, 'the stale words of before the refusal are gone');
  assert.match(text, /A session of hers stays hers until it ends/);
  // The README points to it from Tia's section.
  assert.match(section('Tia (experimental, off by default)'), /docs\/OPERATOR\.md#administrator-rights-and-the-git-sign-in-of-her-sessions/);
  assert.match(flat(section('Tia (experimental, off by default)')), /even at Full a delete outside the session's own folder \(also as administrator\), a push or a merge into the main branch, a release, a pull request, a direct call to GitHub or GitLab \(`gh api`, `glab api`\) that can change something there, a deploy, a change to `project\.json` or to Hoprig's own files, and a line Hoprig cannot read stay yours/);
});

// docs/INSTALL.md:202-218 "A server with only a root login": the installer's one question as root, word for word
test('the install guide gives the installer\'s one question as root, and its steps, as install.sh asks them', () => {
  const sh = read('install.sh');
  assert.match(sh, /printf 'Make the user %s and set Hoprig up there\? \[Y\/n\] ' "\$WU"/);
  assert.match(sh, /WORK_NAMES='hoprig /, 'the first name is hoprig');
  assert.match(sh, /SUDOERS=\/etc\/sudoers\.d\/90-hoprig-\$WU/);
  const p = part('docs/INSTALL.md', 'A server with only a root login');
  assert.match(p, /\nMake the user hoprig and set Hoprig up there\? \[Y\/n\]\n/);
  assert.match(flat(p), /`\/etc\/sudoers\.d\/90-hoprig-hoprig` checked by `visudo`/);
  assert.match(flat(p), /`--yes` to make the user, `--stay-root` to keep Hoprig on root instead/);
  assert.match(sh, /there is no terminal to ask in, so nothing was made\. To make the user \$WU and set Hoprig up there: \$CMD --yes {3}To keep Hoprig on root instead: \$CMD --stay-root/);
});

// docs/INSTALL.md:207-208 and README.md:127 "Under root the dashboard does not offer bypass permissions mode at all"
test('under root bypass permissions mode is not offered, and the install guide says so', async () => {
  const { gateModes, BYPASS, bypassAllowed } = await import('../src/bypassgate.mjs');
  assert.equal(bypassAllowed({ allowBypass: true }, true), false);
  assert.ok(!gateModes(['default', BYPASS], { allowBypass: true }, true).includes(BYPASS));
  assert.ok(gateModes(['default', BYPASS], { allowBypass: true }, false).includes(BYPASS), 'as a user it is offered when allowed');
  assert.match(flat(part('docs/INSTALL.md', 'A server with only a root login')), /Under root the dashboard does not offer bypass permissions mode at all\./);
  assert.match(flat(part('README.md', 'Install')), /On a server with only a root login, the installer does not set Hoprig up under root \(Claude Code refuses bypass permissions mode for root\): it lists its steps and asks once, \*Make the user hoprig and set Hoprig up there\?\*/);
});

// docs/INSTALL.md:226-231 "The move needs the network", said before the first command of the move
test('the move needs the network for the user\'s install, said before its first step, with the hosts the move asks', async () => {
  const { networkNeeds } = await import('../src/setup/movenet.mjs');
  const hosts = networkNeeds('/nowhere', { readFile: () => { throw new Error('none'); } }).map((n) => n.host);
  assert.deepEqual(hosts, ['registry.npmjs.org', 'nodejs.org', 'raw.githubusercontent.com', 'github.com', 'claude.ai', 'downloads.claude.ai']);
  const p = part('docs/INSTALL.md', 'Moving Hoprig off root');
  const net = p.indexOf('**The move needs the network.**');
  assert.ok(net >= 0, 'said in its own words');
  assert.ok(net < p.indexOf('hoprig move-to-user --dry-run'), 'before the first command');
  assert.match(flat(p), /\(from the npm registry, nodejs\.org, raw\.githubusercontent\.com, github\.com, claude\.ai and downloads\.claude\.ai\)/);
  assert.match(flat(p), /before it makes or copies anything/);
  assert.doesNotMatch(flat(p), /from root's installed copy, not from the network\)/, 'the switch does not say the install needs no network');
  assert.match(flat(part('docs/COMPUTERS.md', 'A computer where Hoprig works as root')), /That server needs the network for the user's own install/);
  assert.match(flat(part('README.md', 'Install')), /`hoprig move-to-user`, which needs the network/);
});

// docs/INSTALL.md:239-248 "Its options": every flag `hoprig move-to-user --help` lists
test('the install guide lists every option the help of move-to-user lists', async () => {
  const { MOVE_USAGE, parseMoveArgs } = await import('../src/setup/movecli.mjs');
  const flags = [...new Set(MOVE_USAGE.match(/--[a-z-]+/g))];
  for (const f of ['--user', '--new', '--no-admin', '--dry-run', '--yes', '--json', '--back']) assert.ok(flags.includes(f), f);
  const p = part('docs/INSTALL.md', 'Moving Hoprig off root');
  for (const f of flags) assert.match(p, new RegExp(`\\n- \`${f}( NAME)?\`[ :(]`), `the page lists ${f}`);
  assert.equal(parseMoveArgs(['--new', '--user', 'alpha']).fresh, true);
});

// docs/INSTALL.md:224 "**Settings → Runs as root**": the page's own title
test('Settings → Runs as root is the page\'s own title', () => {
  assert.match(read('web/rootsettings.js'), /id: 'root', title: 'Runs as root'/);
  assert.match(read('docs/INSTALL.md'), /\*\*Settings → Runs as root\*\* say so/);
  assert.match(read('web/moveuser.js'), /label: 'Show what the move does'/);
  assert.match(read('docs/INSTALL.md'), /\*\*Settings → Runs as root → Show what the move does\*\*/);
});

// README.md:745-768 "Not built, or not proven yet": OpenCode's version of another computer IS shown now (line taken out)
test('the README no longer says other computers report Claude Code\'s version only', () => {
  assert.match(read('src/machines/health.mjs'), /opencode: \(oc && /);
  assert.match(read('web/health.js'), /v\.opencode \? `OpenCode \$\{v\.opencode\}`/);
  assert.doesNotMatch(flat(part('README.md', 'Not built, or not proven yet')), /Claude Code's version only/);
});

// docs/WORK.md:455 "It is off until you turn it on, twice": both switches off at their defaults, with the page's labels.
test('missions are off at first, twice, under the labels of Work → Team', async () => {
  const { DEFAULTS, missionSettings, worksOn } = await import('../src/mission/settings.mjs');
  assert.equal(DEFAULTS.on, false);
  assert.deepEqual(missionSettings({}).projects, {});
  assert.equal(worksOn(missionSettings({}), 'shop'), false);
  assert.equal(worksOn(missionSettings({ missions: { on: true } }), 'shop'), false, 'the project switch is still off');
  const web = read('web/mission.js');
  assert.match(web, /toggle\('Tia works by herself'/);
  assert.match(web, /'Tia works on this by herself\.'/);
  assert.match(missions(), /\*\*It is off until you turn it on\*\*, twice/);
});

// docs/WORK.md:581-586 at a usage limit: an hour after the first limit, and what "Tia decides" may choose there.
test('at a usage limit a task waits until an hour after the first limit, or Tia decides when both her switches are on', async () => {
  const { LIMIT_MS } = await import('../src/mission/engine.mjs');
  assert.equal(LIMIT_MS, 60 * 60_000);
  const m = missions();
  assert.match(m, /when none is free it waits until an hour after the first limit, says until when, and tries again/);
  assert.doesNotMatch(m, /when none is free it waits an hour, says/);
  const { readDecide } = await import('../src/operator/decide-store.mjs');
  assert.equal(readDecide({}).on, false);
  assert.equal(readDecide({}).missions, false);
  assert.match(read('web/operator-decide.js'), /toggle\('Tia decides'/);
  assert.match(read('web/operator-decide.js'), /toggle\('Also a mission\\'s choices'/);
  const { missionSteps } = await import('../src/operator/decide-table.mjs');
  assert.deepEqual(missionSteps('mission-limit', { to: 'gw2', waitMs: 30 * 60_000 }).map((s) => s.id), ['next-provider', 'wait']);
  assert.deepEqual(missionSteps('mission-sent-back', {}), []);
  assert.match(m, /With \*\*Tia decides\*\* and its switch \*\*Also a mission's choices\*\* on \(Operator page; both off until you turn them on\)/);
  assert.match(m, /a provider billed by use only at "Hands off"/);
  assert.match(read('web/tiaactivity.js'), /handsoff: 'Hands off'/);
  assert.match(m, /A task sent back twice stays yours/);
});

// docs/WORK.md:524-528 a check held by another run is tried again later, never handed over as checked.
test('a check another run held is tried again every minute and obeys the pause controls', async () => {
  const { REGATE_MS } = await import('../src/mission/engine.mjs');
  assert.equal(REGATE_MS, 60_000);
  const eng = read('src/mission/engine.mjs');
  assert.match(eng, /t\.recheck = true;/);
  assert.match(eng, /const paused = pausedFor\(p, m\.project\);/);
  const m = missions();
  assert.match(m, /its check is tried again every minute until the worktree is free, and it is never handed to you as checked/);
  assert.match(m, /That later check obeys the switches, your working hours and this computer's load, as a new start does/);
});

// docs/WORK.md:613-615 the Operator's rules leave a mission's session alone.
test('the Operator does nothing about a mission session at a limit, stuck, ended or asking', async () => {
  const { OWNER_OF, engineOwns } = await import('../src/mission/seam.mjs');
  for (const k of ['limit', 'stuck', 'ended', 'asks']) {
    assert.equal(OWNER_OF[k], 'mission', k);
    assert.equal(engineOwns({ kind: k, target: { mission: true } }), true, k);
  }
  const m = missions();
  assert.match(m, /the Operator page's rules and Tia's decisions there do nothing: only the mission moves its own tasks/);
  assert.doesNotMatch(m, /she does nothing about it by herself yet/);
});

// docs/BOX.md:14-15 what `hoprig box run` does at its time limit and when nothing ran.
test('hoprig box run stops after 30 minutes with exit 124, and ends with 3 when nothing ran', async () => {
  const { USAGE, parseRun } = await import('../src/box/cli.mjs');
  assert.match(USAGE, /after 30 minutes it is stopped \(exit 124\)/);
  assert.ok(parseRun(['--bogus']).why, 'a wrong option is refused');
  const cli = read('src/box/cli.mjs');
  assert.match(cli, /const RUN_MS = 30 \* 60_000;/);
  assert.match(cli, /const NO = 3;/);
  assert.match(cli, /return 124;/);
  const doc = flat(read('docs/BOX.md'));
  assert.match(doc, /After 30 minutes it stops the command with every process it started \(exit 124\)\. When nothing ran \(no box, a wrong option\), it says why in one line and ends with 3\./);
});

// docs/HANDS-OFF.md:68-70 the administrator rights the wall holds: sudoedit, run0, machinectl shell and login,
// systemd-run without --user
test('HANDS-OFF names every door to administrator rights the wall holds', async () => {
  const { wallKind } = await import('../src/wall.mjs');
  const t = handsOff();
  for (const w of ['`sudoedit`', '`run0`', '`machinectl shell`', '`machinectl login`']) assert.ok(t.includes(w), `the page names ${w}`);
  assert.match(t, /`systemd-run` without `--user`/);
  for (const line of ['sudoedit /etc/hosts', 'run0 id', 'machinectl shell', 'machinectl login', 'systemd-run make']) assert.equal(wallKind(line), 'admin', line);
  assert.equal(wallKind('systemd-run --user make test'), null);
});

// docs/HANDS-OFF.md:131-132 a command text a program is handed (env -S) is read: the old page said it was stepped over
test('HANDS-OFF says the text env -S is handed is read, as the wall reads it', async () => {
  const { wallKind } = await import('../src/wall.mjs');
  const t = handsOff();
  assert.doesNotMatch(t, /stepped over rather than read/);
  assert.match(t, /A command line a program is handed as its text is read like any other: `env -S "sudo su"` is held\./);
  assert.equal(wallKind('env -S "sudo su"'), 'admin');
  assert.equal(wallKind('env -S "make all"'), null);
});

// docs/HANDS-OFF.md:117-126 the commit form a coding tool writes is a heredoc over several lines; written on one line,
// as the old page showed it, the wall holds it
test('HANDS-OFF shows the commit form that goes through as the several lines it is', async () => {
  const { wallHeld } = await import('../src/wall.mjs');
  const page = read('docs/HANDS-OFF.md');
  const block = "git commit -m \"$(cat <<'EOF'\nFix the build\nEOF\n)\"";
  assert.ok(page.includes(`\`\`\`sh\n${block}\n\`\`\``), 'the page shows the commit form as a code block');
  assert.ok(!page.includes("`git commit -m \"$(cat <<'EOF' … EOF)\"`"), 'not as one line, which the wall holds');
  assert.equal(wallHeld({ tool: 'Bash', input: { command: block }, places, git: () => null }), null);
  assert.equal(wallHeld({ tool: 'Bash', input: { command: "git commit -m \"$(cat <<'EOF' … EOF)\"" }, places, git: () => null }).kind, 'unreadable');
});

// docs/HANDS-OFF.md:83-99 what the wall does not read is said in the part about the wall, before its known limits
test('HANDS-OFF says what the wall does not read early, in the part about the wall', async () => {
  const { wallHeld } = await import('../src/wall.mjs');
  const t = handsOff();
  const not = t.indexOf('**What the wall does not read.**');
  assert.ok(not > t.indexOf('## The net and the wall'), 'in the part about the wall');
  assert.ok(not < t.indexOf('**Known limits'), 'before the known limits');
  assert.match(t, /It reads the command line a session hands its shell, and the path a file tool would write\./);
  for (const line of ['bash fix.sh', 'source steps.sh', 'git p']) assert.equal(wallHeld({ tool: 'Bash', input: { command: line }, places, git: () => null }), null, line);
});

// docs/HANDS-OFF.md:97-98 only the shell and the four file tools reach the wall
test('HANDS-OFF names the tools the wall reads: the shell and four file tools', async () => {
  const { wallHeld } = await import('../src/wall.mjs');
  const { WALL_MATCHER } = await import('../src/handsoff.mjs');
  const t = handsOff();
  assert.match(t, /its shell \(Bash\) and its four file tools \(Write, Edit, MultiEdit, NotebookEdit\): Read, Grep and Glob only read/);
  assert.equal(WALL_MATCHER, 'Bash|Write|Edit|MultiEdit|NotebookEdit');
  const file = '/w/.config/hoprig/config.json';
  for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.equal(wallHeld({ tool, input: { file_path: file }, places }).kind, 'settings', tool);
  for (const tool of ['Read', 'Grep', 'Glob']) assert.equal(wallHeld({ tool, input: { file_path: file }, places }), null, tool);
});

// docs/HANDS-OFF.md:37 the note's field in Settings, quoted with its own words
test('HANDS-OFF quotes the project note\'s field as Settings shows it', () => {
  const words = 'How you want such questions answered';
  assert.ok(handsOff().includes(`"${words}"`), 'the page quotes the field');
  assert.ok(read('web/handsoffsettings.js').includes(`placeholder: '${words},`), 'the field says it');
});

// docs/HANDS-OFF.md:99 on Windows the wall's hook cannot run, so Hands-off is not offered
test('HANDS-OFF says Hands-off is not offered on Windows', async () => {
  const { handsOffOffered } = await import('../src/handsoff.mjs');
  assert.match(handsOff(), /anything on Windows: there the wall's hook cannot run, so Hands-off is not offered at all\./);
  assert.equal(handsOffOffered({}, 'win32'), false);
  assert.equal(handsOffOffered({ handsOff: { offered: true } }, 'win32'), false);
  assert.equal(handsOffOffered({}, 'linux'), true);
});

// docs/OPERATOR.md:295-296 "Off (the default, and what an install leaves; an update keeps Off and Ask each time ...)"
test('the operator guide says what an update does to each administrator-rights level, as herRightsLevel reads it', async () => {
  const { herRightsLevel, HER_RIGHTS_DEFAULT } = await import('../src/assistant/herrights.mjs');
  const at = (level) => ({ server: { herRights: { level, version: '0.0.1' } } });
  assert.equal(HER_RIGHTS_DEFAULT, 'off');
  assert.equal(herRightsLevel({}, '9.9.9'), 'off', 'an install leaves Off');
  assert.equal(herRightsLevel(at('off'), '9.9.9'), 'off', 'an update keeps Off');
  assert.equal(herRightsLevel(at('ask'), '9.9.9'), 'ask', 'an update keeps Ask each time');
  assert.equal(herRightsLevel(at('full'), '9.9.9'), 'ask', 'an update turns Full into Ask each time');
  assert.equal(herRightsLevel(at('full'), '0.0.1'), 'full', 'Full stays under the version it was chosen in');
  const text = rights();
  assert.match(text, /\*\*Off\*\* \(the default, and what an install leaves; an update keeps Off and Ask each time as they were, and turns Full into Ask each time, below\)/);
  assert.doesNotMatch(text, /what an install and every update leave/, 'the old words said an update leaves Off');
});

// docs/OPERATOR.md:353-356 "First its limit: a session runs as your user, so this protects against a mistake, not
// against a session that goes looking for your own sign-in. It also covers only `gh` and git over https ..."
test('the operator guide says the git sign-in\'s limit first, and that it changes nothing of ssh', async () => {
  const { herGitEnv, GIT_HOST } = await import('../src/assistant/hersignin.mjs');
  const env = herGitEnv('made-up-token', { base: { GH_TOKEN: 'his-own', GIT_SSH_COMMAND: 'his-own-ssh' } });
  const keys = Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => env[k]);
  assert.ok(keys.length > 0, 'her sign-in sets git keys');
  assert.ok(keys.every((k) => k.startsWith(`credential.https://${GIT_HOST}.`)), `only https credential keys for ${GIT_HOST}: ${keys}`);
  assert.equal(env.GIT_SSH_COMMAND, 'his-own-ssh', 'nothing of ssh is changed');
  assert.ok(!('GIT_SSH' in env), 'no ssh program is set');
  assert.equal(env.GH_TOKEN, 'made-up-token', 'gh gets her token');
  const doc = read('docs/OPERATOR.md');
  const at = doc.indexOf('\n### The git sign-in of her sessions\n');
  assert.ok(at >= 0, 'the part has its heading');
  const signin = flat(doc.slice(at, doc.indexOf('<!-- tia-acts', at)));
  assert.match(signin, /^ ### The git sign-in of her sessions First its limit: a session runs as your user, so this protects against a mistake, not against a session that goes looking for your own sign-in\./);
  assert.match(signin, /It also covers only `gh` and git over https to github\.com: Hoprig changes nothing of ssh, so a repository whose address is `git@github\.com:…` \(git over ssh\) signs in with your user's own ssh sign-in, as before\./);
  assert.equal(signin.split('protects against a mistake').length, 2, 'the limit is said once, at the start');
});

// docs/OPERATOR.md:305-306 "At most 50 of her own such commands run in an hour ... the administrator commands of a
// session she starts are not counted."
test('the operator guide says the hour\'s limit at Full counts only her own administrator commands', async () => {
  const { FULL_ADMIN_PER_HOUR } = await import('../src/assistant/herrights.mjs');
  assert.equal(FULL_ADMIN_PER_HOUR, 50);
  // The count is made for her run_command only (core.mjs facts) and read by the policy; the hook of a session of hers
  // and the chat card that follows it never count.
  assert.match(read('src/assistant/core.mjs'), /e\.tool === 'run_command' && e\.outcome === 'done'/);
  assert.match(read('src/assistant/policy.mjs'), /\(f\.admin\.ranLastHour \|\| 0\) >= FULL_ADMIN_PER_HOUR/);
  for (const f of ['src/hook.mjs', 'src/chat/handsoff.mjs']) assert.doesNotMatch(read(f), /FULL_ADMIN_PER_HOUR|ranLastHour/, f);
  assert.match(rights(), new RegExp(`At most ${FULL_ADMIN_PER_HOUR} of her own such commands run in an hour; after that each one is a card again\\. This count is of her own commands only: the administrator commands of a session she starts are not counted\\.`));
});

// docs/OPERATOR.md:321-329 "What no level allows": the forms adminrefused.mjs refuses at every level
test('the operator guide lists what no level allows as adminRefusal and sudoArgv refuse it', async () => {
  const { adminRefusal, sudoArgv } = await import('../src/assistant/adminrefused.mjs');
  const ctx = { hoprigDirs: ['/srv/made-up/hoprig-state'], home: '/home/alex', cwd: '/home/alex/shop' };
  const id = (line) => (sudoArgv(line, ctx).refuse || {}).id;
  assert.equal(id('run0 ls'), 'non-sudo-escalator');
  assert.equal(id('su -c ls'), 'non-sudo-escalator');
  assert.equal(id('sudo -u alex ls'), 'option-not-read');
  assert.equal(id('sudo -nE ls'), 'option-not-read', 'a bundled flag');
  assert.equal(id('sudo nice ls'), 'passer-as-admin');
  assert.equal(id('sudo timeout 5 ls'), 'passer-as-admin');
  assert.equal(id('sudo env -i ls'), 'passer-as-admin');
  assert.equal(id('sudo unshare -r ls'), 'privilege-tool-as-admin');
  assert.equal(id('sudo chroot / ls'), 'privilege-tool-as-admin');
  assert.equal(id('sudo cat /etc/sudoers'), 'protected-path', 'naming a sudo rules file is refused even to read it');
  assert.equal(id('sudo cat /srv/made-up/hoprig-state/config.json'), 'hoprig-own', 'a path inside Hoprig\'s own folders, also to read it');
  assert.equal(id('sudo ls /tmp ; ls'), 'not-single', 'a line that joins an administrator command with another');
  // A plain one runs as its words, so the list is not all of sudo.
  assert.deepEqual(sudoArgv('sudo ls /tmp', ctx), { argv: ['sudo', 'ls', '/tmp'] });
  assert.equal(adminRefusal('sudo ls /tmp', ctx), null);
  const text = rights();
  assert.match(text, /\(`su`, `doas`, `pkexec`, `run0`, `sudo su`, `sudo -i`, `sudo -s`\), a sudo option that can change who or what runs \(`sudo -u`, a bundled flag: several one-letter options written as one word\), a program run as administrator through another program that hides which one runs \(`sudo nice …`, `sudo timeout …`, `sudo env -i …`\) or through a privilege tool \(`setpriv`, `unshare`, `chroot` and the like\)/);
  assert.match(text, /naming one of their files is refused even to read it\), a set-user-id bit \(a mark that makes a program run as its owner, such as root\), a path inside Hoprig's own install, settings, state or service \(also to read it\), a line Hoprig cannot read with certainty, and a line that joins an administrator command with another command\./);
});

// docs/OPERATOR.md:336 the table's head: what else a session she starts holds as your card, at every level
test('the operator guide names every act a session she starts holds as your card, as herHeld keeps it', async () => {
  const { WALL_TITLE } = await import('../src/wall.mjs');
  const { herHeld } = await import('../src/hook.mjs');
  const cfg = { server: { herRights: { level: 'full', version: '1.0.0' } } };
  const ev = { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: '/home/alex/shop' };
  // At Full every act of the wall but a plain administrator one stays held; below Full all of them.
  for (const kind of Object.keys(WALL_TITLE)) {
    const held = { kind, acts: [{ kind }] };
    const full = herHeld(held, ev, { cfg, version: '1.0.0' });
    if (kind === 'admin') assert.equal(full, null, 'Full lifts a plain administrator act');
    else assert.equal(full && full.kind, kind, `${kind} stays his card at Full`);
    assert.equal(herHeld(held, ev, { cfg, version: '2.0.0' }).kind, kind, `${kind} is held below Full`);
  }
  const text = rights();
  assert.match(text, /Besides an administrator command, yours alone are: a push or a merge into the main branch, a push of a tag or one that deletes branches, a release, a pull request, a direct call to GitHub or GitLab \(`gh api`, `glab api`\) that can change something there, a deploy, a delete outside the session's own folder, a change to `project\.json` or to Hoprig's own files, and a line Hoprig cannot read\. \| Her level \| An administrator command \| Everything else that is yours alone \|/);
  // Each kind of the wall is named in the sentence before the table (by the words of its title).
  const head = text.slice(text.indexOf('Besides an administrator command, yours alone are:'), text.indexOf('|---|'));
  for (const w of ['push', 'merge', 'push of a tag', 'deletes branches', 'release', 'pull request', 'GitHub or GitLab', 'deploy', 'delete outside', 'project.json', "Hoprig's own files", 'cannot read']) assert.ok(head.includes(w), w);
});

// docs/OPERATOR.md:290-291 the two settings under Settings → Tia by the page's own section titles (web/tia.js)
test('the operator guide names her two settings by the titles Settings → Tia shows', () => {
  const page = read('web/tia.js');
  for (const t of ['Administrator rights on this computer', 'Git sign-in for her sessions']) assert.ok(page.includes(`'${t}'`), t);
  assert.match(flat(read('docs/OPERATOR.md')), /Two settings under \*\*Settings → Tia\*\*, per computer: \*\*Administrator rights on this computer\*\* and \*\*Git sign-in for her sessions\*\*/);
});

// README.md:656-659 (Tia's section): what stays yours even at Full in a session she started, as herHeld keeps it
test('the README names every act a session she started keeps as your card at Full', async () => {
  const { WALL_TITLE } = await import('../src/wall.mjs');
  const { herHeld } = await import('../src/hook.mjs');
  const cfg = { server: { herRights: { level: 'full', version: '1.0.0' } } };
  const ev = { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: '/home/alex/shop' };
  for (const kind of Object.keys(WALL_TITLE)) {
    const full = herHeld({ kind, acts: [{ kind }] }, ev, { cfg, version: '1.0.0' });
    if (kind === 'admin') assert.equal(full, null, 'Full lifts a plain administrator act');
    else assert.equal(full && full.kind, kind, `${kind} stays his card at Full`);
  }
  const text = flat(section('Tia (experimental, off by default)'));
  assert.match(text, /even at Full a delete outside the session's own folder \(also as administrator\), a push or a merge into the main branch, a release, a pull request, a direct call to GitHub or GitLab \(`gh api`, `glab api`\) that can change something there, a deploy, a change to `project\.json` or to Hoprig's own files, and a line Hoprig cannot read stay yours, and a Codex or OpenCode session of hers is refused below Full/);
});

// README.md, docs/COMPUTERS.md, docs/HUB.md, docs/INSTALL.md (:243, :247), docs/WORKSPACE.md, docs/PC-SETUP.md: the
// pages say "main computer" as the dashboard does; "hub" stays only in code, a link, a file name, the --hub flag and
// the token audit's quoted sentence (docs/COMPUTERS.md:214-215, src/machines/tokenaudit.mjs)
test('the documents say main computer where the dashboard says it, and hub only for the flag', () => {
  assert.match(read('web/computers.js'), /'Mark as my main computer'/);
  assert.match(read('src/machines/hubcert.mjs'), /was made by the main computer itself/);
  const KEPT = 'with the main computer\'s name in the sentence, such as "The main computer office-pc started the public link"';
  assert.match(read('src/machines/tokenaudit.mjs'), /did: `The main computer \$\{name\} /, 'the quoted sentence is still the code\'s');
  const WORD = /(?<![\w\-./#])hubs?('s)?(?![\w\-]|\.\w)/i;
  const pages = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  const left = [];
  for (const page of pages) {
    let t = read(page);
    // The generated part of the Operator guide is made by tools/tia-acts-doc.mjs, not written here.
    t = t.replace(/<!-- tia-acts:[\s\S]*?<!-- \/tia-acts -->/, '');
    t = t.replace(/^\s*```[\s\S]*?^\s*```/gm, '');
    t = flat(t).split(KEPT).join('').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/Docker Hub/g, '');
    const m = t.match(new RegExp(`.{0,50}${WORD.source}.{0,30}`, 'gi'));
    if (m) left.push(...m.map((s) => `${page}: ${s}`));
  }
  assert.deepEqual(left, []);
  assert.match(flat(read('docs/INSTALL.md')), /The main computer passes it when its look said the move makes the user/);
  assert.match(flat(read('docs/INSTALL.md')), /the look as one line of JSON \(the main computer reads it\)/);
  assert.match(flat(read('docs/WORKSPACE.md')), /\*\*Mark as my main computer\*\*/);
});

// docs/INSTALL.md:219-220 HOPRIG_YES is not a yes as root; only --yes on the command line (install.sh work_ask)
test('the install guide says HOPRIG_YES is no yes for root, as install.sh reads it', () => {
  const sh = read('install.sh');
  assert.match(sh, /ROOT_YES=0/);
  assert.match(sh, /--yes \| -y\) YES=1; ROOT_YES=1;/, 'only the --yes word sets the root yes');
  assert.doesNotMatch(sh, /ROOT_YES=\$\{?HOPRIG_YES/, 'the variable never sets the root yes');
  assert.match(sh, /\[ "\$ROOT_YES" = 1 \] && return 0/);
  assert.match(flat(read('docs/INSTALL.md')), /`HOPRIG_YES` in the environment is not a yes here: only `--yes` on the command line is\./);
});

// docs/INSTALL.md:252-254 Keep Hoprig on root on purpose: the page's panel, its typed sentence, what follows
test('the install guide names Keep Hoprig on root on purpose with the sentence the page asks for', async () => {
  const { STAY_ROOT_SENTENCE, stayRootChoice } = await import('../src/setup/rootfacts.mjs');
  const page = read('web/rootsettings.js');
  assert.match(page, /title: 'Keep Hoprig on root on purpose'/);
  assert.match(page, /Bypass permissions mode stays unavailable, and doctor and Health then show root as information only/);
  assert.throws(() => stayRootChoice({ sentence: 'keep it' }, true), /type the sentence/);
  assert.equal(stayRootChoice({ sentence: ` ${STAY_ROOT_SENTENCE} ` }, true), true);
  assert.equal(stayRootChoice(false, true), false, 'the choice can be taken back');
  const doc = flat(read('docs/INSTALL.md'));
  assert.ok(doc.includes(`**Keep Hoprig on root on purpose**: you type \`${STAY_ROOT_SENTENCE}\`, the choice is kept in this computer's settings and can be taken back there`));
  assert.match(doc, /bypass permissions mode stays unavailable, and doctor and Health then show root as information only/);
});

// README.md:749-750 "Codex is not part of this version": the one list of offered coding tools leaves it out
test('the README says Codex is switched off, and the list of offered coding tools leaves it out', async () => {
  assert.match(notBuilt(), /\*\*Codex is not part of this version\.\*\* Its code is kept and tested, but it is switched off/);
  const { OFFERED, isOffered } = await import('../src/codetools/offered.mjs');
  assert.deepEqual([...OFFERED], ['claude', 'opencode']);
  assert.equal(isOffered('codex'), false);
});

// README.md "Reopen sessions after a restart": Claude Code's and OpenCode's terminal sessions come back, each on its own
// conversation; an OpenCode one with no id is named, not reopened. Tia continues only the folder's newest OpenCode one.
test("the README says a restart reopens Claude Code's and OpenCode's terminal sessions, and Tia continues OpenCode only by the folder's newest", async () => {
  assert.doesNotMatch(notBuilt(), /OpenCode's sessions are not reopened after a restart/);
  assert.match(flat(section('It keeps going without you')), /\*\*Reopen sessions after a restart\*\*: Claude Code's and OpenCode's terminal sessions come back where they were, each on its own conversation\. An OpenCode session whose conversation has no id yet is not reopened on another one: Work → Activity names it as not reopened\./);
  assert.match(notBuilt(), /Tia cannot continue an earlier OpenCode conversation by its id; she can only continue the folder's newest one\./);
  assert.match(read('web/automation.js'), /rule\('Reopen sessions after a restart'/);
  // The restore learns a Claude Code and an OpenCode terminal session, and not a Codex one.
  const { decide } = await import('../src/automation/restore.mjs');
  const ids = { claude: '11111111-1111-4111-8111-111111111111', opencode: 'ses_AbCdEf1234567890', codex: '0199a9e2-1111-7222-8333-444444444444' };
  const card = (tool) => ({ name: `s-${tool}`, kind: 'claude', tool, cwd: '/tmp/shop', sessionId: ids[tool], profile: { name: 'alpha' } });
  const r = decide({ cards: [card('claude'), card('opencode'), card('codex')], data: null, now: 1, boot: false, enabled: true });
  assert.deepEqual(Object.keys(r.data.sessions), ['s-claude', 's-opencode']);
  // Her two starts refuse a conversation id for any coding tool but Claude Code; "continue" is the folder's newest.
  assert.match(read('src/assistant/tools.mjs'), /if \(a\.conversation && a\.coding_tool && a\.coding_tool !== 'claude'\) throw toolError\(`an earlier conversation is resumed here only in Claude Code/);
  assert.match(read('src/assistant/chats.mjs'), /if \(a\.conversation && a\.coding_tool && a\.coding_tool !== 'claude'\) throw toolError\(`an earlier conversation is continued here only in Claude Code/);
  assert.match(read('src/assistant/tools.mjs'), /continue \(the folder's newest conversation\)/);
});

// README.md "Reopen sessions after a restart": a terminal a chat took over stays closed at any moment after the press.
// The take-over is written down before the terminal is ended (src/automation/taken.mjs); no tick has to see the shell.
test('the README says a terminal a chat took over stays closed after a restart, however soon after Continue here', async () => {
  assert.doesNotMatch(notBuilt(), /Reopening can bring back a terminal a chat took over|within about 20 seconds/);
  assert.match(flat(section('It keeps going without you')), /A terminal a chat took over with \*\*Continue here\*\* stays closed, however soon after the press the dashboard ends\./);
  const { decide } = await import('../src/automation/restore.mjs');
  const s = { name: 't', cwd: '/tmp/shop', profile: 'alpha', sessionId: 'c1', runId: 'r1', carryArgs: [], goneAt: null, shellSince: null };
  const data = { lastTickAt: 1, sessions: { t: s } };
  // No tick saw the shell (shellSince null) and no chat is open yet: the record alone keeps it closed.
  assert.equal(decide({ cards: [], data, now: 2, boot: true, enabled: true }).actions.length, 1, 'without a take-over: reopened');
  const r = decide({ cards: [], data, now: 2, boot: true, enabled: true, taken: [{ tool: 'claude', conversation: 'c1', runId: 'r1' }] });
  assert.equal(r.actions.length, 0, 'taken over: not reopened');
  assert.match(read('src/chat/handoff.mjs'), /takeBack = noteTaken\(\{ tool, conversation: c\.conversationId, runId: term\.run && term\.run\.runId \}\);\n\s+try \{\n(\s+\/\/.*\n)*\s+if \(term\.name && \(await ctx\.deck\.madeAlone\?\.\(term\.name\)\)\) await ctx\.deck\.end\(term\.name, \{ hold \}\);\n\s+else \{\n\s+await ctx\.deck\.respawn\(/);
  assert.match(read('web/chat/page.js'), /'Continue here'\)/);
});

// README.md:769 "dragging between two Files windows is not built": the window takes drops of files from outside only
test('the README says dragging between two Files windows is not built, and the Files window starts no drag', () => {
  assert.match(notBuilt(), /- \*\*Files on the desktop\*\*: dragging between two Files windows is not built\./);
  const files = read('web/desktop/files.js');
  assert.match(files, /\[\.\.\.e\.dataTransfer\.types\]\.includes\('Files'\)/);
  assert.doesNotMatch(files, /dragstart|draggable|setData\(/);
});

// A Ctrl+C before the coding tool ran is mended (src/server/deck.mjs #stopped, test/server/startstopped.test.mjs): the
// list says it no more. A launcher killed hard: its record lives by the launcher's pid alone, and a hook writes no gone record.
test('the README no longer lists a stopped start as running, and says what a launcher killed hard leaves', () => {
  assert.doesNotMatch(notBuilt(), /Ctrl\+C|start line|unused start file/);
  assert.match(read('src/server/deck.mjs'), /if \(!note\.launch \|\| !t \|\| !atPrompt\(t\.pid\)\) return void \(note\.front = 0\);/);
  assert.match(notBuilt(), /- \*\*A `hop` launcher that is killed hard while its coding tool goes on\*\*: Hoprig keeps a terminal session's record while its launcher runs, so after a `kill -9` of the launcher that terminal reads as a plain terminal, what the coding tool does and asks is not shown, and its conversation counts as free: Hoprig does not stop the App or another terminal from starting a second process on it\./);
  assert.match(read('src/runs.mjs'), /^\/\/ {3}pid {8}the launcher's process id \(the file is stale once this process is gone\)$/m);
  assert.match(read('src/procid.mjs'), /const live = list\.map\(\(\{ run \}\) => Number\.isInteger\(run\.pid\) && alive\(run\.pid\)\);/);
  assert.match(read('src/runfile.mjs'), /const run = readRun\(file\);\n\s+if \(!run\) return null;/);
});

// README.md:792-793 on Windows a second temporary address without a process identity is ended by hand
test('the README says Hoprig cannot stop a second temporary address it cannot identify, and says so', () => {
  assert.match(notBuilt(), /\*\*On Windows\*\*, a second temporary address of the public link whose file names no process identity \(one an earlier version started\) cannot be stopped by Hoprig: it says so, and that helper is ended by hand\./);
  assert.match(read('src/addons/publiclink.mjs'), /if \(now === null\) return \{ ok: false, stopped: false, error: `Hoprig cannot tell whether process \$\{sv\.pid\} is the cloudflared of port \$\{sv\.port\}'s temporary address: end that cloudflared by hand\.` \};/);
});

// docs/HANDS-OFF.md "The net and the wall": the wall knows only the commands it names for each kind; another tool for
// the same act goes through. The longer release list and a write call to GitHub's or GitLab's interface are held.
test('HANDS-OFF says the wall knows only the commands it names, and another way to the same act goes through', async () => {
  const t = handsOff();
  assert.match(t, /For each kind the wall holds the commands named here and a few more of the same kind; another command, or another way to the same act, is not held/);
  assert.match(t, /a tool for the same act other than the ones named above, such as a project's own publishing script under an unusual name, or a release made on a web page outside the session;/);
  assert.doesNotMatch(t, /another tool, or another command of a known tool, for the same act/, 'the old point with its now-held examples is gone');
  assert.match(t, /`gh api -X POST repos\/o\/r\/pulls` and `gh api repos\/o\/r\/issues -f title=x` are held\. A plain read, `gh api repos\/o\/r\/pulls`, goes through, and so does a call that names GET, whose fields only narrow what it reads: `gh api -X GET search\/issues -f q=bug` goes through\./);
  for (const line of ['gh release create v1', 'gh release upload v1 x.tgz', 'glab release create v1', 'poetry publish']) assert.equal(await held(line), 'release', line);
  assert.equal(await held('gh api -X POST repos/o/r/pulls'), 'api-write');
  for (const line of ['gh api repos/o/r/pulls', 'gh release view v1', 'gh release list', 'npm run ship', 'gh api -X GET search/issues -f q=bug', 'gh api --method GET repos/o/r/issues -F per_page=100']) assert.equal(await held(line), null, line);
});

// docs/HANDS-OFF.md "Known limits": a deploy script is held by name when npm run, make, its path, a shell or an
// interpreter runs it; other scripts and an unusual name go through
test('HANDS-OFF says which runs of a deploy script are held, an interpreter\'s among them', async () => {
  const t = handsOff();
  assert.doesNotMatch(t, /A deploy script is recognised by its name beginning with/);
  assert.doesNotMatch(t, /The same script run by another program, such as an interpreter/, 'the old "goes through" sentence is gone');
  assert.match(t, /A deploy script is held when its name begins with \*deploy\*, \*release\* or \*publish\* and it is run by `npm run`, `make`, its own path, a shell such as `bash` or an interpreter \(a program that runs a script's text, like Python\):/);
  assert.match(t, /Other scripts go through \(`node scripts\/build\.mjs`, `python3 manage\.py test`\), and so does a deploy script under an unusual name/);
  for (const line of ['npm run deploy', 'make release', './publish.sh', 'bash deploy.sh', 'python3 deploy.py', 'node scripts/release.mjs', 'deno run -A deploy.ts', 'bun run deploy']) assert.equal(await held(line), 'deploy', line);
  for (const line of ['node scripts/build.mjs', 'python3 manage.py test', 'npm run ship', 'make ship']) assert.equal(await held(line), null, line);
});

// docs/HANDS-OFF.md "What it reads": a program the wall knows in front of a command does not hide it, a package runner,
// an environment loader and python -m among them
test('HANDS-OFF says a program the wall knows does not hide a command, a package runner and python -m among them', async () => {
  const { runsItsWords } = await import('../src/wall.mjs');
  const t = handsOff();
  assert.match(t, /\*\*What it reads\.\*\* A program the wall knows in front of a command does not hide it:/);
  assert.doesNotMatch(t, /a command behind a program the wall does not know as one that runs its words/, 'the old "does not read" point is gone');
  assert.match(t, /`npx npm publish`, `cross-env A=1 npm publish`, `uv run twine upload dist\/\*`, `poetry run twine upload dist\/\*` and `bundle exec gem push shop-1\.0\.gem` are held as the command behind them is, and `python3 -m twine upload` is held as `twine upload` is/);
  for (const p of ['timeout', 'nice', 'strace', 'flock', 'cross-env', 'npx', 'dotenv']) assert.equal(runsItsWords(p), true, p);
  // A runner of two words is read with its subcommand; the tool alone never becomes one.
  for (const p of ['python3', 'npm', 'uv']) assert.equal(runsItsWords(p), false, p);
  for (const line of ['npx npm publish', 'cross-env A=1 npm publish', 'python3 -m twine upload']) assert.equal(await held(line), 'release', line);
  for (const line of ['npx vitest run', 'uv run pytest', 'python3 -m pytest -q']) assert.equal(await held(line), null, line);
});

// docs/HANDS-OFF.md:82-85 a merge or rebase is held when it would change the default branch, made while on it
test('HANDS-OFF says a merge or rebase is held only when it would change the default branch', async () => {
  const t = handsOff();
  assert.doesNotMatch(t, /merge or rebase onto the default branch/);
  assert.match(t, /a merge or rebase that would change the default branch \(made while standing on it\), is held/);
  assert.match(t, /On a work branch, `git merge main` and `git rebase main` change only the work branch and go through\./);
  assert.equal(await held('git rebase main'), null, 'on the work branch feature');
  const { wallHeld } = await import('../src/wall.mjs');
  const onMain = (cwd, args) => (args.join(' ') === 'symbolic-ref --short HEAD' ? 'main' : git(cwd, args));
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'git merge feature' }, cwd: places.cwd, git: onMain, places }).kind, 'merge', 'standing on main');
});

// docs/HANDS-OFF.md:8-12 the wall's limit is said in the opening paragraph, not only at the end
test('HANDS-OFF says in its opening that the wall is a help against a mistake, not a fence', () => {
  const t = handsOff();
  const opening = t.slice(0, t.indexOf('## Every card is exact'));
  assert.match(opening, /It reads each command line before it runs, so it is a help against a mistake, not a fence: a session runs as your user, and what a script or another program then does is not read \(see \*\*What the wall does not read\*\*, below\)\./);
  assert.match(opening, /in every permission mode \(the coding tool's setting for how much it asks you first; bypass permissions mode asks nothing\)/);
  assert.ok(t.includes('**What the wall does not read.**'), 'the part it points at is there');
});

// docs/HANDS-OFF.md:10-12 (the old opening used "the wall" before saying what it is) the opening says what the wall is
// before it points at "What the wall does not read"
test('HANDS-OFF says what the wall is in its opening, before it names it', () => {
  const t = handsOff();
  const opening = t.slice(0, t.indexOf('## Every card is exact'));
  const said = opening.indexOf('This part is called the wall.');
  assert.ok(said > 0, 'the opening names the part that reads each command');
  assert.ok(said < opening.indexOf('**What the wall does not read**'), 'before the first use of the word');
  assert.ok(opening.indexOf('holds the commands that are yours alone where they are run') < said, 'after what that part does');
});

// docs/HANDS-OFF.md "What it reads": Hoprig's own folders are found in the forms named; a wildcard or a brace list in
// a folder name that could name one of them is held
test('HANDS-OFF names the forms of a path to Hoprig\'s folders the wall finds, and says a wildcard that could name one is held', async () => {
  const t = handsOff();
  assert.doesNotMatch(t, /found however the path is written/);
  assert.match(t, /Hoprig's own folders are found when the path is written in full, from `~` or `\$HOME`, with a `\.\.` or with a doubled separator/);
  assert.doesNotMatch(t, /a path to Hoprig's own folders with a wildcard/, 'the old "does not read" point is gone');
  assert.match(t, /A path with a wildcard \(`\*`, `\?` or `\[\.\.\.\]`, the signs of a glob\) or a brace list in a folder's name is held too when it could name one of them, also when the wildcard stands in a folder above: `cat ~\/\.config\/hop\*\/config\.json`, `cat ~\/\.config\/\[h\]oprig\/config\.json`, `cat ~\/\.conf\*\/hoprig\/config\.json` and `cat ~\/\.config\/\{hoprig,other\}\/config\.json` are held\./);
  // A short path after a cd the wall can tell is read from where the shell then stands; one it cannot tell is not.
  assert.match(t, /A short path after a `cd` or a `pushd` whose target the wall can tell \(a plain path, a bare `cd`, `~` or `\$HOME`, also with braces or in double quotes, or a path with `\.\.`\) is read from the folder the shell then stands in: `cd ~ && cat \.config\/hoprig\/config\.json` and `cd \$HOME && cat \.config\/hoprig\/config\.json` are held\./);
  assert.match(t, /a short path to Hoprig's own folders after a `cd` whose target the wall cannot tell \(another variable, or `cd -`, which goes back to the folder before\): `cd \$DIR && cat \.config\/hoprig\/config\.json` goes through/);
  for (const line of ['cd ~ && cat .config/hoprig/config.json', 'cd $HOME && cat .config/hoprig/config.json']) assert.equal(await held(line), 'settings', line);
  assert.equal(await held('cd $DIR && cat .config/hoprig/config.json'), null);
  for (const line of ['cat /w/.config/hoprig/config.json', 'cat ~/.config/hoprig/config.json', 'cat $HOME/.config/hoprig/config.json', 'cat ../.config/hoprig/config.json', 'cat /w/.config//hoprig/config.json']) assert.equal(await held(line), 'settings', line);
  assert.ok(await held('rm -rf $HOME/.config//hoprig/'), 'a delete there is held too (as a delete outside the folder)');
  for (const line of ['cat ~/.config/hop*/config.json', 'cat ~/.conf*/hoprig/config.json', 'cat ~/.config/[h]oprig/config.json', 'cat ~/.config/{hoprig,other}/config.json']) assert.equal(await held(line), 'settings', line);
  // `hoprig?` needs one sign more than `hoprig`, so it cannot name that folder: it goes through, as on the base.
  assert.equal(await held('cat ~/.config/hoprig?/x'), null);
});

// docs/HANDS-OFF.md:89-90 origin/HEAD is explained where it stands; the wall asks git for exactly that record, and
// holds a push when git has no answer
test('HANDS-OFF explains origin/HEAD as the record of the server\'s default branch', async () => {
  const t = handsOff();
  assert.match(t, /it has no `origin\/HEAD`: the record, kept in the repository, of which branch the server calls its default/);
  const { wallHeld } = await import('../src/wall.mjs');
  const asked = [];
  const spy = (cwd, args) => {
    asked.push(args.join(' '));
    return null;
  };
  const h = wallHeld({ tool: 'Bash', input: { command: 'git push origin feature' }, cwd: places.cwd, git: spy, places });
  assert.ok(asked.includes('symbolic-ref --short refs/remotes/origin/HEAD'), asked.join(', '));
  assert.equal(h && h.kind, 'push');
});

// docs/INSTALL.md:215-221 sudo without a password: what it means, and --no-admin for none
test('the install guide says what sudo without a password means for the user, and that --no-admin gives none', () => {
  const sh = read('install.sh');
  assert.match(sh, /--no-admin\) NO_ADMIN=1 ;;/);
  assert.match(sh, /printf '%s ALL=\(ALL\) NOPASSWD:ALL\\n' "\$WU"/);
  assert.match(sh, /if \[ "\$NO_ADMIN" = 1 \]; then\n {4}say "· No administrator rights for \$WU \(--no-admin\)\."/);
  const p = flat(part('docs/INSTALL.md', 'A server with only a root login'));
  assert.match(p, /Sudo without a password means that a command run as that user, a session's too, can act as administrator without asking\. Run the installer with `--no-admin` to give the user no administrator rights: such steps then stay yours, as root\./);
  assert.match(p, /give it sudo \(the command that runs another command as administrator\) without a password/);
});

// docs/OPERATOR.md:290-291 and :368 where her two settings stand, and that the check button shows only with a file
test('the operator guide says the token check appears once a file is saved, and where the two settings stand', () => {
  const tia = read('web/tia.js');
  assert.match(tia, /sg\.file \? h\('div\.savebar', btn\('secondary', \{ label: 'Check what this token may do'/, 'the button is drawn only with a file');
  assert.match(tia, /fold\('tia-rights', 'Rights', tiaRights\(\{ isAlive \}\)\)/, 'the rights box is the Rights fold');
  const t = rights();
  assert.match(t, /\*\*Check what this token may do\*\* \(a button that appears once a token file is saved; it asks on your press only\)/);
  assert.match(t, /Both stand in that page's \*\*Rights\*\* fold, closed at first, so open it\./);
});

// docs/HANDS-OFF.md:43 and :107-112, docs/OPERATOR.md:303, :324, :327-328 words explained where they first stand
test('the Hands-off page and the operator guide explain the words a newcomer does not know', () => {
  const t = handsOff();
  assert.match(t, /a hook \(a check the coding tool runs before each step\) approved it/);
  for (const w of ['A script is a file of commands that a program runs.', 'An interpreter is a program that runs a script\'s text', 'A variable is a name that stands for a value', 'An alias is a short name', 'A heredoc is text handed to a command over several lines', 'A command substitution puts the output', 'A refspec is the part of a push that names the branch.', 'A glob is a pattern']) assert.ok(t.includes(w), w);
  assert.ok(t.indexOf('A heredoc is text') < t.indexOf('**What the wall does not read.**'), 'before the limits that use them');
  const r = rights();
  assert.match(r, /the audit log \(Hoprig's record of every act of hers that changes something\)/);
  assert.match(r, /a set-user-id bit \(a mark that makes a program run as its owner, such as root\)/);
  assert.match(r, /PAM and polkit, the system's sign-in and permission rules/);
});

// docs/HANDS-OFF.md:37-44 the first-time sheet: once per browser, kept in the browser's storage, read again from
// Settings; and that Hands-off itself costs nothing (fixed rules, no model)
test('HANDS-OFF says when the first-time sheet shows, where it is kept, how to read it again, and that Hands-off costs nothing', () => {
  const t = handsOff();
  assert.match(t, /The first time you turn on a Hands-off switch in a browser \(a session's, a project's or an App chat's\), a sheet "What Hands-off does" explains/);
  assert.match(t, /It only explains: the switch is already on, and closing the sheet does not turn it off\./);
  assert.match(t, /so you see it once per browser, not once per computer: another browser or a phone shows it again\./);
  assert.match(t, /To read it again, open Settings → Hands-off and press "Read the first-time summary again"\./);
  assert.match(t, /Hands-off costs nothing by itself: it reads the questions by fixed rules, with no model,/);
  const sheet = read('web/handsoff.js');
  assert.match(sheet, /const CONSENT_SEEN = 'handsoff\.firstSeen';/, 'the flag is one per browser');
  assert.match(sheet, /openSheet\(\{ title: 'What Hands-off does'/, 'the sheet\'s title');
  assert.match(sheet, /if \(!always && !takeFirstConsent\(store\)\) return null;/, 'shown once unless asked for again');
  assert.match(read('web/lib.js'), /localStorage\.getItem\(`pref:\$\{k\}`\)/, 'kept in the browser\'s own storage');
  assert.match(read('web/handsoffsettings.js'), /openConsentSheet\(\{ always: true \}\) \}, 'Read the first-time summary again'\)/);
  // Each of the three switches opens it when it is turned on.
  for (const f of ['web/session.js', 'web/chat/page.js', 'web/handsoffsettings.js']) assert.match(read(f), /openConsentSheet\(\)/, f);
  assert.match(read('src/handsoff.mjs'), /with no model/);
  assert.doesNotMatch(read('src/handsoff.mjs'), /\bfetch\(/, 'Hands-off asks no provider');
});
