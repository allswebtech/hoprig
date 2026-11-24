// What docs/OPERATOR.md, docs/WORK.md, docs/WORKSPACE.md and docs/HUB.md say about the product, held to the code that
// decides it: a default read from the code's own reader, a list read from the code's own list. When the code changes,
// the sentence has to change with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
/** A page's section under `## heading` (or `### heading`), up to the next heading of the same or a higher level. */
const part = (file, heading, level = 2) => {
  const t = read(file);
  const mark = `\n${'#'.repeat(level)} ${heading}\n`;
  const at = t.indexOf(mark);
  assert.ok(at >= 0, `${file} has a section "${heading}"`);
  const rest = t.slice(at + mark.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return rest.slice(0, next < 0 ? undefined : next);
};
const OPERATOR = 'docs/OPERATOR.md';

test('Operator: Tia acts by herself by a rule you switched on or by Tia decides, both only while Tia acts by herself and Tia are on; all off at first', async () => {
  const { readOperator, RULE_IDS } = await import('../src/operator/rules.mjs');
  const { readDecide } = await import('../src/operator/decide-store.mjs');
  // At their defaults (an empty settings file): the master switch, every rule and Tia decides are off.
  const off = readOperator({});
  assert.equal(off.acts, false, 'Tia acts by herself is off at first');
  assert.equal(off.active, false);
  assert.ok(RULE_IDS.length > 0 && RULE_IDS.every((id) => off.rules[id] === false), 'every rule is off at first');
  assert.equal(readDecide({}).on, false, 'Tia decides is off at first');
  // Both ways need the master switch and Tia herself: the rules and the decider both read `active`.
  assert.equal(readOperator({ operator: { acts: true } }).active, false, 'with Tia off, nothing acts');
  assert.equal(readOperator({ operator: { acts: true }, assistant: { enabled: true } }).active, true);
  assert.match(read('src/operator/decider.mjs'), /return readOperator\(cfg\)\.active && readDecide\(cfg\)\.on;/, 'Tia decides runs only while active');
  const rules = flat(part(OPERATOR, 'What Tia does by herself (her rules)')).trim();
  assert.match(rules, /^Tia may do a step by herself only by a rule you switched on or by \*\*Tia decides\*\* \(below\), and only while \*\*Tia acts by herself\*\* is on and Tia herself is on \(Settings → Tia\)\. All of it is off after an install and after an update\./);
  assert.doesNotMatch(rules, /only by a rule you switched on, and only while/);
});

/** The first cells of a Markdown table's rows in `text` (header and divider left out). */
const firstCells = (text) => text.split('\n').filter((l) => /^\| [a-z]/.test(l) && !/^\| (Kind|Rule) \|/.test(l)).map((l) => l.split('|')[1].trim());
const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

test('Operator: the rules table and its count are the code\'s list of rules, the kinds table the detectors\' kinds', async () => {
  const { RULE_IDS } = await import('../src/operator/rules.mjs');
  const { KINDS } = await import('../src/operator/item.mjs');
  const rules = part(OPERATOR, 'What Tia does by herself (her rules)');
  assert.deepEqual(firstCells(rules), [...RULE_IDS], 'one row per rule, in the code\'s order');
  assert.match(flat(rules), new RegExp(`There are ${NUMBERS[RULE_IDS.length]} rules, and only these:`));
  assert.match(flat(part(OPERATOR, 'The page')), new RegExp(`her ${NUMBERS[RULE_IDS.length]} rules \\(below\\)`));
  assert.deepEqual(firstCells(part(OPERATOR, 'What it watches')).sort(), [...KINDS].sort(), 'one row per kind of item');
});

test('Operator: the page names its Computers part, its room words and its switch, off at first', async () => {
  // The page's modules look at the document when they load: the least of one, as test/operator/rooms-page.test.mjs gives it.
  globalThis.Node ??= class {};
  const el = () => ({ style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, addEventListener() {}, append() {}, appendChild() {}, replaceChildren() {}, querySelector: () => null, querySelectorAll: () => [] });
  globalThis.document ??= { createElement: el, createElementNS: el, createTextNode: () => ({}), getElementById: () => null, querySelector: () => null, addEventListener: () => {}, visibilityState: 'visible', body: el(), head: el(), documentElement: el() };
  const { ROOM_WORDS, LOOK_SENTENCE } = await import('../web/operator-rooms.js');
  const { lookOthersOn } = await import('../src/operator/rooms.mjs');
  assert.equal(lookOthersOn({}), false, 'Look at my other computers too is off at first');
  const page = flat(part(OPERATOR, 'The page'));
  assert.match(page, /\*\*Computers\*\*: /);
  for (const w of Object.values(ROOM_WORDS)) assert.ok(page.includes(`**${w}**`), `the room word "${w}"`);
  assert.ok(page.includes(`The switch **${LOOK_SENTENCE}** is off at first`));
});

const WORK = 'docs/WORK.md';

test('Work: the page names every tab of Work, and repeating work and saving missions are not called unbuilt', async () => {
  // The tabs as the page's own list holds them (web/work.js TABS: [id, label, icon]).
  const src = read('web/work.js');
  const tabs = /const TABS = (\[\[.*?\]\]);/.exec(src);
  assert.ok(tabs, 'web/work.js has its list of tabs');
  const labels = JSON.parse(tabs[1].replace(/'/g, '"')).map((x) => x[1]);
  const page = part(WORK, 'The page');
  for (const l of labels) assert.match(page, new RegExp(`^- \\*\\*${l}\\*\\*: `, 'm'), `the tab "${l}" has its line`);
  // A repeat rule is taken by the code today, so the opening does not say it comes later.
  const { checkRepeat } = await import('../src/work/repeat.mjs');
  assert.equal(checkRepeat({ kind: 'daily' }).kind, 'daily');
  assert.doesNotMatch(read(WORK).slice(0, 600), /Repeating work comes later/);
  // Save commits mission files beside the list (src/work/save.mjs isExtra, saveplan.mjs isMissionFile).
  assert.match(read('src/work/save.mjs'), /isMissionFile\(file\)/);
  assert.doesNotMatch(flat(part(WORK, 'Not built yet')), /missions' files/);
  // The command's Today does not list sessions; Work → Today (a tab), Home and the Operator page do.
  assert.match(read('src/work/cli.mjs'), /Sessions that need an OK are on the dashboard\\?'s Today\./);
  assert.match(flat(part(WORK, 'Commands')), /The command does not list the sessions that need an OK: they are on Work → Today, on Home and on the Operator page\./);
});

test('Workspace: the page names the commands that take no --json or no --dry-run, as the command reads its flags', () => {
  const cli = read('src/workspace/cli.mjs');
  // setup and link take only --dry-run and --yes (their flagsOk lists); git takes no word at all (cli-git.mjs).
  for (const sub of ['setup', 'link']) {
    const at = cli.indexOf(`if (sub === '${sub}') {`);
    assert.ok(at >= 0, `cli.mjs handles ${sub}`);
    assert.match(cli.slice(at, at + 200), /flagsOk\(rest, \['--dry-run', '--yes'\]\)/, `${sub} takes no --json`);
  }
  const git = read('src/workspace/cli-git.mjs');
  assert.match(git, /if \(sub === 'git'\) \{\n\s+if \(args\.length\) return usage\(\);/, 'git takes no flag');
  // auto reads no dry-run flag; mylink add|remove refuses any word after the path.
  assert.match(git, /flags\(args, \{ map: 'v', commit: 'v', memory: 'v', sync: 'v', push: 'v', 'push-branches': 'v', credentials: 'v', every: 'v', json: 'bool' \}\)/);
  assert.match(cli, /if \(more\.length \|\| \(sub === 'list' \? p !== undefined : !p\)\) return usage\(\);/);
  const page = flat(read('docs/WORKSPACE.md'));
  assert.match(page, /Most of them take `--json`; `setup`, `link` and `git` do not\. Most of those that change something take `--dry-run`, which shows exactly what would happen; `auto` and `mylink add\|remove` do not\./);
  assert.doesNotMatch(page, /Every one of them takes `--json`/);
});

test('Workspace: the shell files that get the PATH line are the ones the code picks, each only where it applies', async () => {
  const os = await import('node:os');
  const { shellFiles } = await import('../src/setup/localbin.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-shells-'));
  const names = (o) => shellFiles({ home, platform: 'linux', ...o }).map((x) => path.relative(home, x.file));
  // A plain sh user on Linux with no other start file: only ~/.profile.
  assert.deepEqual(names({ shell: '/bin/sh' }), ['.profile']);
  assert.deepEqual(names({ shell: '/bin/bash' }), ['.profile', '.bashrc']);
  assert.deepEqual(names({ shell: '/bin/zsh' }), ['.profile', '.zshenv']);
  assert.deepEqual(names({ shell: '/usr/bin/fish' }), ['.profile', path.join('.config', 'fish', 'conf.d', 'hoprig.fish')]);
  assert.ok(names({ shell: '/bin/sh', platform: 'darwin' }).includes('.zshenv'), 'macOS always gets ~/.zshenv');
  assert.equal(shellFiles({ home, shell: '/bin/bash', platform: 'linux' }).find((x) => x.file.endsWith('.bashrc')).at, 'top');
  fs.rmSync(home, { recursive: true, force: true });
  const page = flat(part('docs/WORKSPACE.md', 'The command in every shell'));
  assert.match(page, /at the \*\*top\*\* of `~\/\.bashrc`, before the line that stops a non-interactive shell \(when bash is your shell or that file is there\); in `~\/\.zshenv` \(when zsh is your shell, on macOS, or that file is there\); and in `~\/\.config\/fish\/conf\.d\/hoprig\.fish` when fish is your shell\./);
});

test('Workspace: the route list names every route of the workspace feature, and the folders are in Settings → Workspace', () => {
  const src = read('src/workspace/feature.mjs');
  const routes = [...src.matchAll(/\['(GET|POST)', \/\^((?:\\\/|[a-z])+)\$\//g)].map((m) => [m[1], m[2].replace(/\\\//g, '/')]);
  assert.ok(routes.length >= 20, 'the feature has its routes table');
  const page = flat(part('docs/WORKSPACE.md', 'The AI brain in the dashboard'));
  for (const [method, p] of routes) {
    const named = new RegExp(`\`(?:${method}|GET\\|POST) ${p.replace(/\//g, '\\/')}(?:\\?[^\`]*)?\``);
    assert.match(page, named, `${method} ${p} is named`);
  }
  // The workspace folders panel is drawn by Settings → Workspace; the Setup part of a computer's page only links there.
  assert.match(read('web/workspace.js'), /fill\(box, placesPanel\(st, draw\), computerPanel\(\), workspaceFolders\(\)/);
  assert.match(read('web/pcsetup.js'), /h\('a\.row', \{ href: link\('#\/settings\/workspace'\) \}/);
  assert.match(page, /The workspace folders themselves are in \*\*Settings → Workspace\*\* \(the \*\*Setup\*\* part of a computer's page links there\)\./);
});

test('Workspace: the once-only note after the update comes only when keeping the workspace in step is on', async () => {
  const { DEFAULTS } = await import('../src/automation/settings.mjs');
  const { decide, apply } = await import('../src/automation/workspacesync.mjs');
  const off = decide({ data: {}, now: 10 * 3600_000, boot: true, settings: DEFAULTS.workspace });
  assert.equal(DEFAULTS.workspace.sync, false, 'keeping in step is off at first');
  assert.ok(!off.actions.some((a) => a.type === 'sync'), 'no sync round while it is off');
  const on = decide({ data: {}, now: 10 * 3600_000, boot: true, settings: { ...DEFAULTS.workspace, sync: true } });
  const sync = on.actions.filter((a) => a.type === 'sync');
  assert.equal(sync.length, 1);
  const told = [];
  const ctx = { record() {}, notify: (n) => told.push(n), save() {}, data: {}, workspaceSync: async () => ({ repos: [], memory: [], tools: [], notHere: [] }) };
  const r = await apply(sync, ctx).catch(() => null);
  assert.ok(told.length >= 1 && /kept in step when you ask/.test(told[0].title), 'the first round with keeping in step on tells it');
  if (r && r.data) assert.equal(r.data.saidOnDemand, true);
  const page = flat(part('docs/WORKSPACE.md', 'What changes when you update from 0.3'));
  assert.match(page, /When keeping the workspace in step is on, its first round after the update says this once, in a notification\./);
  assert.doesNotMatch(page, /notification as before\. The first round after the update says this once\./);
});
