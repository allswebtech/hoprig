// What README.md, RELEASING.md and the guides in docs/ say, held to the code that does it. Each claim reads the
// page and the code as text, so nothing of the product runs here: when the code changes, the sentence has to
// change with it, and a sentence changed alone fails too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
/** A page's part under a heading (`## Name` or `### Name`), up to the next heading of the same or a higher level. */
const part = (file, heading) => {
  const t = read(file);
  const m = new RegExp(`\\n(#{2,4}) ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`).exec(t);
  assert.ok(m, `${file} has a heading "${heading}"`);
  const level = m[1].length;
  const rest = t.slice(m.index + m[0].length);
  const next = new RegExp(`\\n#{2,${level}} `).exec(rest);
  return t.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length));
};

{
const GUIDES = ['docs/INSTALL.md', 'docs/WORKSPACE.md', 'docs/WORK.md', 'docs/COMPUTERS.md', 'docs/HUB.md', 'docs/PC-SETUP.md'];
/** The head row of every table of a page: the first `|` line after a line that is not one. */
const headRows = (file) => {
  const lines = read(file).split('\n');
  return lines.filter((l, i) => l.startsWith('|') && !(lines[i - 1] || '').startsWith('|'));
};

test('Guides: every head cell of a table begins with a capital letter or a code word (the website takes card labels from them)', () => {
  const rows = GUIDES.flatMap((f) => headRows(f).map((r) => [f, r]));
  assert.ok(rows.length >= 14, 'the guides have their tables');
  for (const [f, r] of rows) {
    for (const cell of r.split('|').slice(1, -1).map((c) => c.trim())) assert.match(cell, /^([A-Z]|`)/, `${f}: head cell "${cell}"`);
  }
  assert.ok(headRows('docs/INSTALL.md').includes('| Doctor says | Do this |'));
  assert.ok(headRows('docs/WORKSPACE.md').includes('| Claude Code\'s file or folder | Links to |'));
  assert.ok(headRows('docs/WORKSPACE.md').includes('| Coding tool | What is linked or named | In the brain |'));
});

test('WORK: a project\'s test command is set on Work → Team, in Tia\'s switches and limits, under Projects, and kept in the dashboard\'s settings', () => {
  const page = flat(part('docs/WORK.md', 'Missions: a goal Tia does by herself'));
  assert.ok(page.includes('You set it per project on **Work → Team**: open **Tia\'s switches and limits**, and under **Projects** type it into the project\'s field **Its test command**, then press **Save**. It is kept in the dashboard\'s settings, not in the project\'s files.'), 'the page says where');
  assert.ok(!page.includes('(set per project on Team;'), 'the old half-sentence is gone');
  const ui = read('web/mission.js');
  assert.ok(ui.includes("field('Its test command', test,"), 'the field is named so');
  assert.ok(ui.includes("h('h3.ms-h3', 'Projects')"), 'under Projects');
  assert.ok(ui.includes("h('span', 'Tia\\'s switches and limits')"), 'in the fold Tia\'s switches and limits');
  assert.ok(ui.includes("label: 'Save', dataset: { key: `save:${p}` }"), 'its own Save');
  assert.ok(ui.includes("export function paintTeam("), 'on the Team tab');
  assert.match(read('src/mission/settings.mjs'), /projects +\{ <name>: \{ on, auto, test: \[argv\] \} \}/, 'kept in the config under missions.projects');
  assert.ok(read('src/mission/feature.mjs').includes('saveConfig({ missions: next })'), 'saved into the dashboard\'s settings');
});

test('INSTALL: on a server (ssh with no desktop, a cloud\'s hardware, or a public address) choice 2 is not offered, --access network is refused, and doctor fails an open dashboard', () => {
  const page = flat(read('docs/INSTALL.md'));
  assert.ok(page.includes('devices on my network, e.g. your phone on the same Wi-Fi *(default; not offered on a server)*'));
  assert.ok(page.includes('On a server, choice 2 is not offered and `hoprig setup --access network` is refused, because there it would open the dashboard to the whole internet over plain http. Hoprig treats a computer as a server when it has a public address, and on Linux also when you reach it over SSH (remote login) and it has no desktop of its own, or when its hardware names a cloud. A Mac or a Windows computer counts as a server only by its public address. There `hoprig doctor` fails a dashboard that is open to the network.'));
  assert.ok(!page.includes('not offered on a server with a public address'), 'the narrower old words are gone');
  assert.ok(!page.includes('takes a computer for a server'), 'the old rule for every system is gone');
  const server = read('src/setup/server.mjs');
  for (const kind of ['public', 'ssh', 'cloud']) assert.ok(server.includes(`r.kind === '${kind}'`), `a server by ${kind}`);
  const live = server.slice(server.indexOf('export function liveReason('), server.indexOf('const CLOUD_NAMES'));
  assert.ok(live.includes("if (ips.length) return with_({ kind: 'public', address: ips[0] });"), 'a public address counts on every system');
  assert.ok(live.indexOf("  if (platform === 'linux') {") >= 0 && live.indexOf("  if (platform === 'linux') {") < live.indexOf('cloudOf('), 'the cloud\'s hardware is read on Linux only');
  const ssh = server.slice(server.indexOf('export function sshWithoutDesktop('), server.indexOf('const savedFile'));
  assert.ok(ssh.includes("  if (platform !== 'linux') return false;"), 'an ssh session without a desktop counts on Linux only');
  assert.ok(server.includes("'this is a server (reached over ssh, with no desktop of its own)'"));
  assert.ok(server.includes('this is a cloud server (its hardware says'));
  const setup = read('src/setup/setup.mjs');
  assert.ok(setup.includes("if (want === 'network' && exposed) {") && setup.includes('state.accessRefused = true;'), '--access network is refused');
  assert.ok(setup.includes("...(exposed ? [] : [['network',"), 'choice 2 is left out on a server');
  assert.ok(read('src/setup/checks.mjs').includes("if (server && openHost(want)) return result('access', 'Who can reach it', 'fail',"), 'doctor fails it');
});

test('COMPUTERS: what still needs a terminal on a server, and the Health page never takes a sudo password', () => {
  const page = flat(part('docs/COMPUTERS.md', '2. A server you can SSH into'));
  assert.ok(page.includes('Some steps still need a terminal on the server itself: installing Claude Code and signing in to it, adding its providers (a subscription\'s sign-in or an API key), and every step that asks for the server\'s administrator password (sudo). A restart of the server is on its page, under **Advanced → Power → Restart**, where the system lets your user restart it without that password; where it does not, the page shows the system\'s refusal, and you restart it from a terminal there.'));
  assert.ok(!page.includes('the providers\' profiles, the skills, a restart of the system when one is pending'), 'the old list is gone');
  // Claude Code: its doctor line has a command to type and no Fix of the page (no fixKit), and the page's sign-in signs in this dashboard's own computer.
  const checks = read('src/setup/checks.mjs');
  assert.ok(checks.includes("return result('claude', 'Claude Code', 'fail', 'not installed', `${APP} setup   (or: ${APP} claude install latest)`);"), 'Claude Code missing: a command to type');
  assert.ok(!/result\('claude'[^\n]*fixKit/.test(checks), 'no Fix for Claude Code');
  assert.ok(read('web/claudelogin.js').includes("const R = (p = '') => `~/api/accounts/claude-login${p}`; // always this dashboard's own computer"), 'the sign-in on the page is this computer\'s own');
  assert.ok(read('src/setup/checks.mjs').includes("const fix = 'claude   (then type /login; or: claude auth login)';"), 'the sign-in from a terminal');
  // Providers: another dashboard cannot reach a computer's accounts.
  assert.ok(read('src/machines/index.mjs').includes('/^\\/api\\/accounts(\\/|$)/'), 'the providers of another computer are not reachable from the main computer');
  // sudo with a password: the Health page gives the command to type there.
  assert.ok(read('web/health.js').includes('asks for a password, which this page never takes. Type this once in a terminal on'), 'the sudo case on Health');
  // A restart: Advanced → Power → Restart on every computer's page, the system's own refusal shown.
  const pc = read('web/pc.js');
  assert.ok(pc.includes("{ id: 'advanced', title: 'Advanced',"), 'the part Advanced');
  assert.ok(pc.includes("section('Power', undefined,") && pc.includes("powerBtn('reboot', 'Restart')"), 'Power → Restart');
  assert.ok(!/name \? section\('Power'/.test(pc), 'for this computer and another one alike');
  assert.ok(pc.includes('fill(powerMsg, errorBox(`${who} refused: ${e.message}.`));'), 'a refusal is shown');
  assert.ok(read('src/server/platform/linux.mjs').includes("const r = await run('systemctl', [action]);"), 'the system decides (systemctl reboot)');
  assert.ok(!read('src/machines/index.mjs').includes('pc\\/power'), 'another dashboard may send it');
  // The skills are no longer on the list: another computer's Skills page reaches it (the route is not forbidden to the main computer).
  assert.ok(!read('src/machines/index.mjs').includes('skillhub'), 'the skills of another computer are reachable');
  assert.ok(read('web/app.js').includes("export const CODING_PAGES = ['workspace', 'providers', 'brain', 'skills',"), 'Skills is a page of each computer');
  assert.ok(!page.includes('the skills,'), 'the skills are not said to need a terminal');
});

test('INSTALL: Node.js is installed when missing or older than 24.13.1, the floor of install.sh and src/nodefloor.mjs', () => {
  const page = read('docs/INSTALL.md');
  assert.ok(page.includes('| Node.js (when missing or older than 24.13.1) |'), 'the page says 24.13.1');
  assert.ok(!page.includes('older than 22'), 'the old floor is gone');
  assert.ok(read('install.sh').includes('MIN_NODE=24.13.1 '), 'install.sh');
  const floor = read('src/nodefloor.mjs');
  assert.ok(floor.includes("export const MIN_NODE = '24.13.1';") && floor.includes("MIN_NODE.replace(/\\.0$/, '')"), 'src/nodefloor.mjs reads 24.13.1');
});

test('HUB: the Docker image is for a main computer only (no "hub" in prose for it)', () => {
  const page = read('docs/HUB.md');
  assert.ok(page.includes('The `Dockerfile` in this repository builds an image for a main computer only (Node.js slim, no build tools, no terminal module):'));
  assert.ok(!page.includes('hub-only'), 'the old word is gone');
  const df = read('Dockerfile');
  assert.ok(df.includes('it shows and relays your other computers. No Claude Code and no terminal run in it'), 'it runs no sessions');
  assert.ok(df.includes('the terminal module, node-pty, is optional and left out'), 'no terminal module');
  assert.match(df, /^FROM node:[\d.]+-bookworm-slim$/m, 'Node.js slim');
});

test('WORK: with fewer than two like it, Today says once under the count that there is no estimate, and the digest says it beside the run', () => {
  const page = flat(read('docs/WORK.md'));
  assert.ok(page.includes('With fewer than two, a run gets no number: Work\'s Today tab says it once, under the count of what runs ("No estimate yet: nothing like it has finished here."), and the digest says "no estimate yet" beside the run.'));
  assert.ok(!page.includes('With fewer than two: "no estimate yet:'), 'the old words are gone');
  const pulse = read('web/workpulse.js');
  assert.ok(pulse.includes("const noBasis = (u) => !u.basis || u.basis.count < 2;"), 'fewer than two');
  assert.ok(pulse.includes("const est = kind === 'running' && !noBasis(u) ?"), 'a row without a basis carries no estimate');
  assert.ok(pulse.includes("return `No estimate${none === 1 ? '' : 's'} yet: nothing like ${none === 1 ? 'it' : 'these'} has finished here.`;"), 'the line under the count');
  assert.ok(pulse.includes("none ? h('p.wk-pulse-none', none) : null,") && pulse.indexOf("h('p.wk-pulse-none'") > pulse.indexOf("const line = h('p.wk-pulse-line'"), 'once, under the count');
  assert.ok(read('src/work/tellmsg.mjs').includes("if (u.basis.count < 2) lines.push(`Running: ${name}, no estimate yet`);"), 'the digest');
});

test('WORK: a mission\'s money limit is its own field "Spend cap per day ($)" under Limits on Team; Tia\'s daily limit for paid use counts of a mission only her paid move of a task and a mission\'s call of Tia decides there', () => {
  const page = flat(part('docs/WORK.md', 'Missions: a goal Tia does by herself'));
  assert.ok(page.includes('is what is left of today\'s **Spend cap per day ($)** (below) after what was spent and what her sessions that run now hold'));
  assert.ok(page.includes('and the **Spend cap per day ($)**, the missions\' own cap, set under **Limits** in **Tia\'s switches and limits** on Work → Team and counted from each run\'s own cost line (with no cap set, nothing starts). Tia\'s daily limit for paid use (Settings → Tia) does not count these sessions; of a mission, it counts only what the Operator does on a provider billed by use: her move of a task there (below), and a call of **Tia decides** about a mission\'s choice that runs there.'));
  assert.ok(!page.includes('it counts only her own move of a task'), 'the old words are gone');
  assert.ok(read('web/mission.js').includes("h('summary.fold-summary', h('span', 'Tia\\'s switches and limits')"), 'the fold that holds Limits');
  assert.ok(read('web/mission.js').indexOf("h('h3.ms-h3', 'Limits')") < read('web/mission.js').indexOf("return h('details.fold.ms-settings'"), 'Limits is drawn inside the fold');
  assert.ok(read('web/operator-decide.js').includes("toggle('Tia decides', d.on,"), 'the switch\'s label');
  const mis = read('src/operator/decider.mjs');
  const body = mis.slice(mis.indexOf('async function mission(item0)'), mis.indexOf('function view()'));
  assert.ok(body.includes("const held = holdCall(c, 'decide');") && body.includes("settle(Number(r.usd) || 0, 'a decision of the Operator', held.id);"), 'a mission\'s call of Tia decides is held and settled against her limit');
  assert.ok(mis.includes('return unpaid.length ? { provider: c.account } : { provider: c.account, paid: true, cap: tia.dailyCapUsd };'), 'on a paid provider the cap is her daily limit');
  assert.ok(page.includes('a provider billed by use only at "Hands off" and inside her daily limit for paid use.'));
  assert.ok(!/spend cap per day\*\*|today's spend cap/.test(page), 'the old lower-case names are gone');
  const ui = read('web/mission.js');
  assert.ok(ui.includes("num('Spend cap per day ($)', 'capUsd', s.capUsd,"), 'the field as the page draws it');
  assert.ok(ui.indexOf("h('h3.ms-h3', 'Limits')") >= 0 && ui.indexOf("h('h3.ms-h3', 'Limits')") < ui.indexOf("num('Spend cap per day ($)'"), 'under Limits');
  assert.ok(ui.includes("'Counted from each run\\'s own cost line. At the cap nothing new starts. 0: nothing starts.'"), 'from each run\'s cost line; 0 starts nothing');
  assert.ok(read('src/mission/engine.mjs').includes('const { left, budget } = budgetFor({ capUsd: s.capUsd, spentUsd: spentOn(all, dayOf(p)).usd, held,'), 'a session\'s budget comes from the missions\' own cap');
  assert.ok(read('src/mission/limits.mjs').includes("if (!(s.capUsd > 0)) return 'no spend cap is set yet: set one under Work → Team';"), 'none set: nothing starts');
  // The missions' code never reads Tia's limit or her ledger: only the Operator's move to a paid next provider does.
  for (const f of ['src/mission/engine.mjs', 'src/mission/limits.mjs', 'src/mission/feature.mjs', 'src/mission/settings.mjs', 'src/work/alone.mjs']) {
    const t = read(f);
    assert.ok(!t.includes('dailyCapUsd') && !t.includes('operator/money') && !t.includes('assistant/spend'), `${f} does not use Tia's daily limit`);
  }
  const dec = read('src/operator/decider.mjs');
  assert.ok(dec.includes("const money = ps ? (tia.level !== 'handsoff' ? `${ps.to} is paid per use, and Tia moves a task there only at \"Hands off\" (Settings → Tia)` : room(ps.what, tia.dailyCapUsd)) : null;"), 'her paid move: Hands off and room in her limit');
  assert.ok(dec.includes("hold(ps.what, tia.dailyCapUsd, `mission-"), 'the move is held against her limit');
});

test('COMPUTERS: a computer that no longer lets this dashboard in: its sentence, Setup and Health unread, Rename and Remove left under Advanced', () => {
  const page = flat(read('docs/COMPUTERS.md'));
  assert.ok(page.includes('| "Not allowed any more" | Its right was revoked on that computer. The New session sheet says: "It no longer lets this dashboard in. Add it again here: Computers → Add a computer"; the computer\'s own page says: "*name* no longer lets this dashboard in. Add it again here: Computers → Add a computer." Until you do, its **Setup** and **Health** tabs cannot read it; under **Advanced**, **Rename** and **Remove from this list** still work. |'), 'the row');
  assert.ok(!page.includes('Its right was revoked on that computer. Add it again'), 'the old row is gone');
  assert.ok(!page.includes('and the page says: "It no longer lets'), 'the sheet\'s sentence is not called the page\'s');
  const lib = read('web/lib.js');
  assert.ok(lib.includes("unauthorised: 'Not allowed any more',"), 'the state as the list draws it');
  assert.ok(lib.includes("unauthorised: 'It no longer lets this dashboard in. Add it again here: Computers → Add a computer',"), 'the sentence');
  assert.ok(read('web/store.js').includes("return { ok: false, why: NOT_ONLINE[m.status] || 'Not reachable now' };"), 'the New session sheet draws it');
  const relay = read('src/machines/relay.mjs');
  assert.ok(relay.includes("new RelayError('computer-not-allowed', `${machine} no longer lets this dashboard in. Add it again here: Computers → Add a computer.`)"), 'the computer\'s page sentence, from the relay');
  assert.ok(!page.includes('(it was revoked there)'), 'the old words of the computer\'s page are gone');
  assert.ok(!relay.includes('(it was revoked there)'), 'the relay no longer says it');
  assert.ok(read('web/pc.js').includes("`${label} no longer lets this dashboard in. Add it again here: Computers → Add a computer.`"), 'the page\'s own fallback says the same');
  assert.ok(read('src/machines/hub.mjs').includes(': e.message);'), 'the hub passes the relay\'s sentence on');
  assert.ok(read('web/pc.js').includes("if (m.status === 'unauthorised') return notAllowedCard(ctx.label(), m.error);"), 'the computer\'s page shows it');
  const pc = read('web/pc.js');
  assert.ok(pc.includes("setup: 'What it has for coding cannot be checked while it does not let this dashboard in.',"), 'Setup unread');
  assert.ok(pc.includes("health: 'Its checks cannot be read while it does not let this dashboard in.',"), 'Health unread');
  assert.ok(pc.includes("advanced: 'Its name, and taking it off this list. Its programs, ports and power can be used again once it lets this dashboard in.',"), 'Advanced keeps the name and the list');
  assert.ok(pc.includes("act('pencil', 'Rename',") && pc.includes("act('trash', 'Remove from this list',"), 'the two buttons');
  assert.ok(pc.includes('if (notAllowed(ctx.entry())) return [];'), 'move and power are not offered');
  assert.ok(read('web/health.js').includes("if (r.state === 'unauthorised') {"), 'Health names the state');
  assert.ok(read('src/machines/relay.mjs').includes("new Set(['computer-not-allowed', 'not-authorised'])"), 'old and new code are one state');
});

test('COMPUTERS: the table\'s join line uses the placeholder the join command prints', () => {
  const page = flat(read('docs/COMPUTERS.md'));
  assert.ok(page.includes('On each PC: `hoprig join https://<its address> <code>`.'));
  assert.ok(!page.includes('join https://<hub>'), 'the old placeholder is gone');
  assert.ok(read('src/machines/cli.mjs').includes("hoprig join https://<its address> CODE"), 'the placeholder the command prints');
});
}

{
// docs/HANDS-OFF.md "The net and the wall": a mission's run has the file tools only, and on a computer whose box says
// yes a work or fix run gets the one tool run_tests (src/work/alone.mjs BOX_TOOL), never a shell.
test('HANDS-OFF says a mission run can get run_tests besides the file tools, and no shell', () => {
  const page = flat(part('docs/HANDS-OFF.md', 'The net and the wall'));
  assert.ok(page.includes("with the file tools only, and, for a work or fix run on a computer whose box says yes, the box's tools of its role's list: `run_tests`, which runs the project's own test command in the box and no command of its own, and, where the role file's `runs` names them, `run_build`"), 'the page names run_tests and the others');
  assert.ok(page.includes('It has no shell, no git and nothing that reaches the network. The dashboard builds each command of the box as a list of words and reads it with the wall first'), 'the wall reads what the box runs');
  assert.ok(!page.includes('with the file tools only — no shell, no git, nothing that reaches the network — so it can'), 'the old "file tools only" sentence is gone');
  const alone = read('src/work/alone.mjs');
  assert.ok(alone.includes("export const BOX_TOOL = 'mcp__hoprig__run_tests';"), 'the tool is run_tests');
  assert.ok(alone.includes("...tools('--allowedTools', closed ? (one ? [...closed, ...boxToolNames(kinds)] : closed) : allowed),"), 'a restricted run gets them besides the file tools');
  assert.ok(alone.includes("const tool = by === 'mission' && !review && restricted && isTool(job.tool)"), 'only a mission run that is no look');
  assert.ok(alone.includes("'--restricted', '--strict-mcp-config'"), 'still the restricted mode');
  assert.ok(read('src/mission/engine.mjs').includes("if (tools && kinds.length && address() && (await boxReady(boxOf())).ok) {"), 'only a work or fix run, on a computer whose box says yes');
  assert.ok(read('src/mission/boxtool.mjs').includes('const held = wallSays(reads, tree);'), 'the wall reads every command of the box first');
});

// docs/HANDS-OFF.md "Known limits": a command substitution is held, except the two forms that name the current branch
// in a push, which are read as HEAD (src/wall.mjs neutralizeSafeSubst), so the push is judged as a push of HEAD.
test('HANDS-OFF says the two current-branch substitutions in a push are read as HEAD, held on the default branch', () => {
  const page = flat(read('docs/HANDS-OFF.md'));
  assert.ok(page.includes('a command substitution `$( … )` or a backtick is held, because its value could be any program,'), 'held, no longer "outright"');
  assert.ok(!page.includes('is held outright'), 'the old "held outright" is gone');
  assert.ok(page.includes('with or without the double quotes, the substitution is read as `HEAD`, so such a push goes through on a work branch and is held on the default branch, as a push of HEAD is. The other is the form a coding tool writes a commit in,'), 'the page says how it is read');
  const wall = read('src/wall.mjs');
  assert.ok(wall.includes('/^\\$\\(\\s*git\\s+(?:branch\\s+--show-current|rev-parse\\s+--abbrev-ref\\s+HEAD)\\s*\\)/'), 'the two forms, exactly');
  assert.ok(wall.includes("out += 'HEAD'; i += m[0].length; continue;"), 'read as HEAD');
  assert.ok(wall.includes("p[2] === '\"' ? line[k++] === '\"' : line[k] !== '\"'"), 'with or without the double quotes');
});

// docs/HANDS-OFF.md "What it reads": in bypass mode a delete is allowed by itself only when written in plain sight
// (src/asking.mjs bypassAllows → plainDelete); a delete in the quoted command eval runs is read by mayDelete, which
// reads an assignment, an array element's among them, as no program, so eval stays the command and the delete asks.
// Its first reading stops a subscript at a backtick, a $(, a blank or one of ;|&()<>; its second reading (wholeWords)
// reads the subscript up to the ] that closes it and keeps a value with a sign in its word, so those forms ask too.
test('HANDS-OFF says a delete behind an array element set before eval asks first in bypass mode', () => {
  const page = flat(read('docs/HANDS-OFF.md'));
  assert.ok(page.includes('In bypass permissions mode, a delete inside a quoted command that such a program runs is asked of you first, also when a variable is set in front of that program on the same line (`X=1` or `X+=1`, also with a value written with a sign, `X=$HOME/out`), when an element of a list (an array) is set there, whatever stands between the brackets (`A[0]=1`, `A[$i]=1`, `A["k"]=1`, `A[i + 1]=1` or `A[$(id -u)]=1`), and when the host or the user that program is given is written with a variable.'), 'the page says so');
  assert.ok(!page.includes('also when a variable or an array element is set in front of that program'), 'no promise for every array element');
  assert.ok(!page.includes('This is not promised where the value holds a sign'), 'the list of exceptions is gone: those forms ask now');
  const asking = read('src/asking.mjs');
  // The first reading ends the word X= at a $ ~ * or ! outside quotes (isWordChar has none of them); the second keeps it whole.
  assert.ok(asking.includes("const isWordChar = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c > '\\x7f' || '_-./+:@%=,'.includes(c);"), 'the first reading: a word holds no $, ~, * or !');
  assert.ok(asking.includes("if (close === '\"' && (line[k] === '`' || (line[k] === '$' && line[k + 1] === '('))) return no(k);"), 'a backtick or $( in a quoted subscript ends the reading');
  assert.ok(asking.includes("} else if (c === '`' || isBlank(c) || ';|&()<>'.includes(c)) break;"), 'the first reading: a backtick, a blank or one of ;|&()<> outside quotes ends the subscript');
  // The second reading: the line once more with every word kept whole as bash keeps it, and each command of a
  // $( … ) or a backtick as a line of its own; a delete seen in either reading is a delete.
  assert.ok(asking.includes('  if (seesDelete(line)) return true;\n  const whole = wholeWords(line);\n  return whole !== null && whole.some((l) => l !== line && seesDelete(l));'), 'either reading decides');
  assert.ok(asking.includes("if (e >= 0 && (line[e + 1] === '=' || (line[e + 1] === '+' && line[e + 2] === '='))) {\n        if (!commandsIn(i + 1, e, false)) return null;\n        out += '[]';"), 'a subscript is read up to the ] that closes it, whatever it holds');
  assert.ok(asking.includes("out += empty && sep(next) ? c : '_';"), 'a sign inside a word stays in the word');
  assert.ok(asking.includes("const isBlank = (c) => c === ' ' || c === '\\t' ||"), 'a blank is a space or a tab');
  assert.ok(asking.includes('return !!input && typeof input.command === \'string\' && plainDelete(input.command, places);'), 'bypass allows a delete only in plain sight');
  assert.match(asking, /const TAKES_COMMAND = new Set\(\['eval',/, 'eval takes a command to run');
  assert.ok(asking.includes('function readSubscript(line, i) {'), 'an array element\'s subscript is read');
  assert.ok(asking.includes("const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\\[[^\\]]*\\])?\\+?=/;"), 'NAME[subscript]= is an assignment, no program');
  const wall = read('src/wall.mjs');
  assert.ok(wall.includes("import { mayDelete, plainDelete } from './asking.mjs';"), 'the wall reads a delete with the same reader');
  assert.ok(wall.includes("if (id === null && p && mayDelete(part) && !(base && plainDelete(part, base))) id = 'delete outside';"), 'the wall holds a delete it cannot see is inside the folder');
});
}

{
test('OPERATOR: Tia OFF ends a Start-elsewhere hold only when her rule or she set it; his own tap stays', () => {
  const doc = flat(read('docs/OPERATOR.md'));
  assert.ok(doc.includes('**Undo** under **Computers** on this page ends it at once. **Tia OFF** on this page ends it too when this rule or Tia set it; one you started with your own tap stays until it ends by itself or you press Undo.'), 'the elsewhere row says which Tia OFF ends it');
  assert.ok(!doc.includes('ends one this rule set'), 'the broken sentence is gone');
  const feat = read('src/operator/feature.mjs');
  // The Operator page's Tia OFF posts to /api/operator/off, which ends her hold; Team's posts to
  // /api/work/missions/off, which only turns her work off.
  assert.match(read('web/operator-tia.js'), /await api\(`\$\{A\}\/off`, \{\}\);[\s\S]{0,300}\}, 'Tia OFF'\)/);
  assert.match(feat, /\['POST', \/\^\\\/api\\\/operator\\\/off\$\/[\s\S]{0,1500}endElsewhere\(\);/, 'the operator off route ends the hold');
  assert.match(read('web/mission.js'), /label: 'Tia OFF'[\s\S]{0,300}api\('\/api\/work\/missions\/off'/);
  const team = /\['POST', \/\^\\\/api\\\/work\\\/missions\\\/off\$\/, async \(req\) => \{([\s\S]*?)\}\],/.exec(read('src/mission/feature.mjs'));
  assert.ok(team, 'Team has its own off route');
  assert.ok(!/Elsewhere|liftHold/.test(team[1]), "Team's Tia OFF ends no hold");
  assert.match(feat, /result = await act\(it, b\.act, guard \? 'tia' : 'owner'\)/, 'a rule or a decision acts as tia, his tap as owner');
  assert.match(feat, /if \(away && away\.by === 'tia'\) \{\s*endElsewhere\(\);/, 'Tia OFF ends only her own hold');
  assert.match(read('src/operator/rooms.mjs'), /rooms\\\/elsewhere\\\/end\$/, 'Undo ends it at once');
});

test('SKILLS: a project\'s record is next to its skills; your own skills\' record is in the state folder', () => {
  const doc = flat(read('docs/SKILLS.md'));
  assert.ok(doc.includes('For a project\'s skills that record is `.hoprig-skills.json` next to them; for your own skills it is kept in Hoprig\'s state folder (on Linux `~/.local/state/hoprig/skillhub/user-skills.json`), so the record does not show up as a changed file in your AI brain: the git repository of your rules and skills that `hoprig workspace link` links your own skills folder to ([WORKSPACE.md](WORKSPACE.md)).'));
  assert.ok(!doc.includes('so your AI brain gets no changed file'), 'the unclear words are gone');
  assert.match(read('src/paths.mjs'), /: path\.join\(home\(\), '\.local', 'state', 'hoprig'\)\);/, 'the state folder on Linux');
  assert.match(read('src/workspace/link.mjs'), /<claude dir>\/skills\s+→ ai_brain\/skills/, 'workspace link points the skills folder at the brain');
  assert.match(read('docs/WORKSPACE.md'), /^# The workspace and the AI brain$/m);
  assert.ok(!doc.includes('`.hoprig-skills.json` next to the skills records the'), 'the old sentence is gone');
  const store = read('src/skillhub/store.mjs');
  assert.match(store, /export const MANIFEST = '\.hoprig-skills\.json';/);
  assert.match(store, /export const hubDir = \(\) => path\.join\(stateDir\(\), 'skillhub'\);/);
  assert.match(store, /export const userRecordFile = \(\) => path\.join\(hubDir\(\), 'user-skills\.json'\);/);
  assert.match(store, /recordFile = \(dir\) => \(isUserDir\(dir\) \? userRecordFile\(\) : path\.join\(dir, MANIFEST\)\)/);
});

test('OPERATOR: one name for Tia\'s limit, and the money lines quote the labels the code draws', () => {
  const t = read('docs/OPERATOR.md');
  const own = flat(t.slice(0, t.indexOf('<!-- tia-acts')) + t.slice(t.indexOf('<!-- /tia-acts -->')));
  for (const old of ['daily spending cap', 'daily cap', 'spending cap', 'against the cap', 'Set the daily cap']) assert.ok(!own.includes(old), `no "${old}" outside the generated part`);
  // Every limit sentence of the guide's own part names it so.
  assert.equal((own.match(/the daily limit for paid use/g) || []).length, 4, 'four sentences name the daily limit for paid use');
  assert.equal((own.match(/\*\*Set a daily limit for paid use\*\*/g) || []).length, 2, 'two quote the button');
  assert.ok(own.includes('Your own tap on **Continue on the next provider** is not counted.'));
  // The labels as the merged page draws them.
  assert.match(read('web/operator.js'), /h\('a\.btn\.small\.secondary', \{ href: link\(CAP_SWITCH\) \}, 'Set a daily limit for paid use'\)/, 'the Operator card\'s button');
  assert.match(read('web/tia.js'), /h\('label\.field-label', \{ for: 'tia-daily-cap' \}, 'Daily limit for paid use \(US \$\)'\)/, 'the field the button leads to');
  assert.match(read('src/operator/item.mjs'), /switch: \{ label: 'Continue on the next provider',/, 'the step\'s button');
  assert.match(read('web/tia.js'), /handsoff: \['Hands off', v\.help\.levelHandsoff\]/, 'her level Hands off');
  assert.match(read('src/assistant/tia.mjs'), /Your own tap on "Continue on the next provider" is not counted\./, 'the field\'s help says his tap is not counted too');
});

test('OPERATOR: a direct call to GitHub or GitLab that can change something there stays yours in a session she starts', () => {
  const own = flat(part('docs/OPERATOR.md', 'What a session she starts does'));
  assert.ok(own.includes('a release, a pull request, a direct call to GitHub or GitLab (`gh api`, `glab api`) that can change something there, a deploy, a delete outside the session\'s own folder'), 'the list names the direct call by its two commands');
  const wall = read('src/wall.mjs');
  assert.match(wall, /if \(\(head === 'gh' \|\| head === 'glab'\) && a === 'api' && \(rest\.some\(isGraphqlEndpoint\) \|\| apiWrites\(rest\)\)\) return 'api-write';/, 'the wall holds a gh or glab api call that can change something');
  assert.match(wall, /'api-write': 'A direct call to GitHub or GitLab',/, 'its card title');
  assert.match(wall, /'api-write': 'This calls GitHub or GitLab directly in a way that can change something there,/, 'its reason');
});

test('OPERATOR: a push of a tag and a push that deletes branches stay yours in a session she starts', () => {
  const own = flat(part('docs/OPERATOR.md', 'What a session she starts does'));
  assert.ok(own.includes('yours alone are: a push or a merge into the main branch, a push of a tag or one that deletes branches, a release,'), 'the list names a tag push and a deleting push');
  const wall = read('src/wall.mjs');
  assert.match(wall, /push: 'A push to the main branch or a tag',/, 'the card of a tag push');
  assert.match(wall, /'push-prune': 'A push that deletes branches',/, 'the card of a deleting push');
  assert.match(wall, /'push-prune': 'This would delete remote branches, by name or with a pruning push,/, 'by name or with a pruning push');
});

test('OPERATOR: a Console sign-in is billed by use, and with the switch off Auto mode leaves it out of what counts as paid', () => {
  const own = flat(part('docs/OPERATOR.md', 'What Tia decides (her one short call)'));
  assert.ok(own.includes('with an order of subscriptions only, it counts as free of charge. A Claude sign-in on a Console account is billed by use too. While **Also use pay-per-use providers** is off (Providers), Auto mode leaves out every provider the Providers page marks billed by use, such a sign-in included, so they do not count here.'), 'Which model says what a Console sign-in counts as');
  assert.match(read('web/accounts.js'), /toggle\('Also use pay-per-use providers', auto\.payPerUse === true,/, 'the switch as Providers draws it');
  // The accounts route marks a Console sign-in paid; paidName drops every provider marked paid while the switch is off.
  assert.match(read('src/server/accounts.mjs'), /paid: p\.paid === true \|\| billedLogin\(p\),/, 'a Console sign-in is listed paid');
  assert.match(read('src/routerstate.mjs'), /\.\.\.\(login && login\.paid \? \{ paid: true \} : \{\}\),/, 'the state list marks a Console sign-in paid');
  assert.match(read('src/operator/feature.mjs'), /return \{ profiles: st\.profiles \|\| \[\], autoSwitch: st\.autoSwitch \|\| \{\} \};/, 'the Operator reads that list');
  const spend = read('src/assistant/spend.mjs');
  assert.match(spend, /const routerDrops = \(p\) => !!p && p\.paid === true;/);
  assert.match(spend, /accounts\.autoSwitch\.payPerUse === false \? order\.filter\(\(n\) => !routerDrops\(/, 'switch off: those are dropped');
  assert.match(read('src/operator/money.mjs'), /if \(name === 'auto'\) return paidName\('auto', acc\);/, 'the Operator asks the same rule');
  assert.match(read('src/autoswitch.mjs'), /const billed = \(p\) => p\.paid === true \|\| billedLogin\(p\);/, 'Auto mode counts the sign-in billed by use');
});

test('PROVIDERS: Auto mode and providers billed by use, the row, and the message when nothing is left', () => {
  const own = flat(part('docs/PROVIDERS.md', 'Auto mode and providers billed by use'));
  assert.ok(own.includes('Auto mode (on Providers, **When an account reaches its limit**, **Carry on with the next provider**) uses a provider billed by use only while **Also use pay-per-use providers** is on.'));
  assert.ok(own.includes('such a sign-in is named "Claude sign-in billed by use (Console account)", never a subscription. While the switch is off, such a provider can stay in the order, but Auto mode leaves it out and its row says so.'));
  assert.ok(own.includes('When that leaves Auto mode nothing it may use, no session starts under Auto mode and nothing is spent; the same holds when the providers of the order are gone or do not serve Claude Code. A start from a terminal (`hoprig auto`), a request of a session that runs under it, a chat of the App and a run of Work then say why: each provider that is left out, with its reason, and the way out. With a provider billed by use that is turning that switch on, or putting a subscription into the order; else putting a provider that serves Claude Code into the order. A chat says that Claude Code could not start, and a run of Work that it did not start. Tia does not choose Auto mode then: she starts or moves the session on the next provider she may use, and with none she says why in the same words. A session that already runs under Auto mode on a provider billed by use gets nothing more while the switch is off: its message says to turn that switch on, or to start the session again under Auto mode.'));
  assert.ok(!own.includes('get a message that names the providers billed by use and the two ways out'), 'the old sentence of two starts only is gone');
  assert.ok(!own.includes('sessions under Auto mode do not start: the message names'), 'no promise of the message for every start');
  assert.match(read('bin/hoprig.mjs'), /case 'auto':[\s\S]{0,300}return start\('auto', rest\);/, '`hoprig auto` starts a session in Auto mode');
  const acc = read('web/accounts.js');
  assert.match(acc, /title: 'Carry on with the next provider'/);
  assert.match(acc, /title: 'When an account reaches its limit'/);
  assert.match(acc, /toggle\('Also use pay-per-use providers',/);
  assert.match(acc, /const BILLED_SIGNIN = 'Claude sign-in billed by use \(Console account\)';/);
  assert.match(acc, /PAY_PER_USE_HELP = 'API keys billed for every use, and a Claude sign-in on a Console account \(billed by use too\), take part in Auto mode only while this is on\./);
  assert.match(acc, /'Not used while pay-per-use is off' : 'Billed by use · not used while pay-per-use is off'/, 'the row says it is left out');
  assert.match(read('src/autoswitch.mjs'), /const left = \(n\) => !as\.payPerUse && paid\.has\(n\);/, 'left out only while the switch is off');
  const router = read('src/router.mjs');
  assert.ok(router.includes("const WHY_LEFT = { missing: ['does not exist any more', 'do not exist any more'], tools: ['does not serve Claude Code', 'do not serve Claude Code'], billed: ['is billed by use', 'are billed by use'] };"), 'each provider with its own reason: gone, not Claude Code, billed by use');
  assert.ok(router.includes("return `Auto mode has nothing it may use, because ${"), 'the reason');
  assert.ok(router.includes("? 'turn that switch on on the Providers page, or put a subscription into the order'"), 'the way out with a provider billed by use');
  assert.ok(router.includes(": 'put a provider that serves Claude Code into the order on the Providers page, or run: hoprig auto order <provider> <provider>';"), 'the way out without one');
  assert.ok(router.includes('const message = nothingUsableLine(order.length ? [] : leftOutOfOrder())'), 'the router says it');
  assert.ok(router.includes('which is billed by use, and "Also use pay-per-use providers" is off, so Auto mode does not use it: turn that switch on on the Providers page, or start the session again under Auto mode.'), 'a running session on a provider billed by use');
  assert.ok(read('src/launch.mjs').includes('why = [nothingUsableLine(leftOutOfOrder())'), 'a start says it');
  assert.ok(read('src/assistant/engine.mjs').includes("throw new Error(nothingUsableWhy(leftOutOfOrder()) || 'Auto mode has no order of providers yet');"), 'a chat and a run of Work get the same reason');
  assert.ok(read('src/chat/run.mjs').includes('let env = await (chat.o.resolveEnv || providerEnv)(chat.profile);'), 'a chat asks it at its start');
  assert.ok(read('src/chat/chat.mjs').includes("error: `${this.engine.label} could not start: ${e.message}`"), 'a chat says it could not start');
  assert.ok(read('src/work/alone.mjs').includes("env = await env;\n    } catch (e) {\n      return { run: await settle(r, j, repos, { state: 'failed', reason: `The run did not start: ${e.message}`"), 'a run of Work whose provider cannot be used says it did not start');
  const tia = read('src/assistant/tia.mjs');
  assert.ok(tia.includes("const allowed = autoOut ? tia.allowed.filter((n) => n !== 'auto') : tia.allowed;"), 'Tia goes on to the next provider she may use');
  assert.ok(tia.includes("return nothingUsable(left) || 'Auto mode has no providers in its order';"), 'her reason is the router\'s');
  assert.ok(read('src/assistant/core.mjs').includes('const autoWhy = autoOut && nothingUsableWhy(leftOutOfOrder(pool));'), 'and its way out');
});

test('OPERATOR: her git sign-in, one truth: gh gets a value that is not a token, and the limit stays a mistake guard', () => {
  const own = flat(part('docs/OPERATOR.md', 'The git sign-in of her sessions'));
  assert.ok(own.includes('a session runs as your user, so this protects against a mistake, not against a session that goes looking for your own sign-in.'));
  assert.ok(own.includes('If the file cannot be read, her sessions get no token at all, not yours. There `gh` in her session gets a value that is not a token, so it fails with a sign-in error and never uses yours, also where `gh auth login` kept your own sign-in in the system\'s keyring'));
  assert.ok(!/One limit: where `gh auth login`|except gh's system keyring/.test(own), 'no sentence says the keyring is a gap');
  const s = read('src/assistant/hersignin.mjs');
  assert.match(s, /const HIS_GIT_TOKENS = \['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'\];/);
  assert.match(s, /So each of the four gets a value that is plainly not a\s+\/\/ token/, 'each token variable gets a placeholder');
  assert.match(s, /out\.GH_CONFIG_DIR = dir;/, 'an empty gh folder of her own');
  assert.match(s, /export const GIT_HOST = 'github\.com';/, 'git over https to github.com');
});
}

{
const readme = () => flat(read('README.md'));
const notBuilt = () => flat(part('README.md', 'Not built, or not proven yet'));

test('README: New session opens with the projects as rows, one tap starts, More options holds the rest', () => {
  const page = readme();
  assert.match(page, /\*\*New session\*\* on Home opens with \*\*Tap a project to start\*\*: the projects as big rows \(\*\*Recent\*\*, then \*\*All projects\*\*, then \*\*Another folder…\*\*\), and one tap on a row starts an App chat there with nothing else asked\./);
  assert.match(page, /\*\*More options\*\* holds only what must be chosen before the start: \*\*Open in a terminal\*\* \(the coding tool's own screen instead of the chat\), \*\*Coding tool\*\* \(when two or more are ready\), \*\*An earlier conversation\*\*, \*\*On a branch of its own\*\* and \*\*Read other projects too\*\*\./);
  assert.doesNotMatch(page, /asks two things at once/);
  const popup = read('web/newsession-popup.js');
  // The computers are chips only where several are linked; a project's New session names no computer.
  assert.match(popup, /const key = store\.multi && !st\.preset \? JSON\.stringify\(/);
  assert.match(popup, /if \(!key\) return paint\(pcSlot\);/);
  assert.match(popup, /preset: project,/);
  assert.match(popup, /'Tap a project to start'/);
  // The line and More options come first, the projects below them.
  assert.match(popup, /h\('div\.ns-root', intro, moreSlot, opts, pcSlot, status, projSlot,/);
});

test('README: Tia runs on, Automatic is the first subscription that can answer now, never a paid provider by herself', () => {
  const page = readme();
  assert.match(page, /The provider she thinks on is set there by \*\*Tia runs on\*\*\. Left at \*\*Automatic\*\*, it is the first of the subscriptions she may use that can answer now, so a message to her costs nothing beyond your plan\. With no such subscription, it is Auto mode when that is on and you allow it to her, else the first provider you allow her that can run Claude Code; left at Automatic, she never runs on one you did not tick \(a provider you choose yourself under \*\*Tia runs on\*\* is used even when it is not ticked\)\. When none you allow her can run her, she says so and where to tick one \(Settings → Tia → "Providers she may use"\)\. On a provider billed by use she answers only within the daily limit for paid use you set there\. When every one of those subscriptions is at its limit, she says so, and when Hoprig knows it, the time the first one can be used again; she never moves by herself to a provider billed by use\. The chats she starts run on the providers you allow her; on a provider billed by use they cost money \(see below\)\./);
  assert.doesNotMatch(page, /even one you did not tick for her/);
  // No subscription: Auto mode only when on AND ticked for her, else the first ticked provider that serves Claude
  // Code, else none; none ticked that can, while one he left out could: readiness names the place to tick one.
  const tiaCode = flat(read('src/assistant/tia.mjs'));
  // A provider chosen under "Tia runs on" is taken when it serves Claude Code, ticked or not.
  assert.match(tiaCode, /const chosen = r\.runsOn && \(r\.runsOn === 'auto' \? autoOn : thinks\.includes\(r\.runsOn\)\) \? r\.runsOn : null;/);
  assert.match(tiaCode, /const runsOn = chosen \|\| \(firstFree/);
  assert.match(tiaCode, /: autoOn && allowed\.includes\('auto'\) \? 'auto' : allowed\.find\(\(n\) => thinks\.includes\(n\)\) \|\| null\);/);
  assert.match(tiaCode, /const noneAllowed = !runsOn && !subs\.length && thinks\.length > 0;/);
  assert.match(read('src/assistant/feature.mjs'), /code: 'none-allowed', problem: `None of the providers \$\{ASSISTANT_NAME\} may use can run her\. Tick one under Settings → \$\{ASSISTANT_NAME\} → "Providers she may use"/);
  assert.match(read('web/tia.js'), /h\('span\.field-label', 'Providers she may use'\)/);
  assert.doesNotMatch(page, /Auto mode or another provider you allow her, which can cost money/);
  assert.doesNotMatch(page, /billed by use by herself/);
  assert.doesNotMatch(page, /her own thinking runs on a provider you choose, and the chats she starts run on yours/);
  const ui = read('web/tia.js');
  assert.match(ui, /const NAME = 'Tia';/);
  assert.match(ui, /field\(`\$\{NAME\} runs on`, runs,/);
  assert.match(ui, /`Automatic \(now: \$\{/);
  const tia = flat(read('src/assistant/tia.mjs'));
  assert.match(tia, /Automatic \(the saved value null\): the first subscription that can answer now/);
  assert.match(tia, /const subs = real\.filter\(\(p\) => isSub\(p\) && p\.paid !== true && p\.signedIn !== false && servesTool\(p, 'claude'\) && allowed\.includes\(p\.name\)\);/);
  assert.match(tia, /const firstFree = subs\.find\(\(p\) => !atLimit\(p, now\)\);/);
  assert.doesNotMatch(tia, /\|\| thinks\[0\] \|\| null/);
  assert.match(tia, /const thinks = real\.filter\(\(p\) => servesTool\(p, 'claude'\)\)\.map\(\(p\) => p\.name\);/);
  const feature = read('src/assistant/feature.mjs');
  // A turn on a paid provider is held to the daily limit for paid use; none set: she does not answer.
  assert.match(feature, /const runsOnPaid = paidName\(tia\.runsOn, accounts\);/);
  assert.match(feature, /code: 'paid-no-cap', text: `\$\{ASSISTANT_NAME\} did not answer: to answer she would use \$\{on\}, which costs money, and you have not set a daily limit for paid use yet\.`/);
  // No known time: she says so instead of a time.
  assert.match(feature, /'Hoprig does not know yet when one can be used again\.'/);
  assert.match(feature, /if \(!tia\.runsOn && tia\.subsLimited\) return \{ ok: false, code: 'subs-limited'/);
  assert.match(feature, /can be used again at \$\{atWords\(until, now\)\}/);
  assert.match(feature, /\$\{ASSISTANT_NAME\} does not move to a paid provider by herself\.`;/);
});

test('README: the Providers picture and the Settings picture say only what they show', () => {
  const page = read('README.md');
  assert.ok(page.includes('<img src="docs/screenshots/accounts-desktop-light.webp" alt="The Providers page: a line that says 4 can work, 2 are at a limit and 3 need a sign-in, Refresh, the providers in groups with one button each, and the panel When an account reaches its limit"'));
assert.match(page, /<img src="docs\/screenshots\/settings-desktop-light\.webp" alt="Settings: one row per page, most with their current state in one line, and New sessions open beside them"/);
  const acc = read('web/accounts.js');
  // The number is the place in Auto mode's order, drawn only while Auto mode is on, and not for a provider billed by
  // use while pay-per-use is off. The demo's order is max, api; its api key goes straight to Anthropic, so it is
  // billed by use, and with no choice made pay-per-use follows the order (on): both are numbered, as the picture shows.
  assert.match(acc, /autoOn && place && !off \? h\('span\.order-n', \{ title: `\$\{ORDINAL\(place\)\} in Auto mode's order` \}, String\(place\)\) : null/);
  assert.match(acc, /const off = autoOn && place && leftOut\(a, payPerUse\);/);
  assert.match(acc, /export const leftOut = \(p, payPerUse\) => !payPerUse && isPaid\(p\);/);
  const demo = read('src/demo/index.mjs');
  assert.match(demo, /autoSwitch: \{ enabled: true, order: \['max', 'api'\], returnToPreferred: true,/);
  assert.doesNotMatch(demo, /payPerUse/);
  assert.match(demo, /writeProfile\('api', \{ label: 'API \(pay as you go\)', env: \{ ANTHROPIC_API_KEY: /);
  assert.match(read('src/autoswitch.mjs'), /payPerUse: typeof a\.payPerUse === 'boolean' \? a\.payPerUse : orderHasPaid\(order\),/);
  assert.match(read('src/profiles.mjs'), /if \(!env\.ANTHROPIC_BASE_URL\) return true;/);
  assert.match(acc, /bar\('5-hour limit', u\.fiveHour\), bar\('Weekly limit', u\.week\)/);
  assert.match(read('web/providerwords.js'), /label: a\.signinRefused \|\| \(a\.limited && a\.limited\.reason === 'auth'\) \? 'Sign in again' : 'Sign in'/);
  assert.match(acc, /'This plan does not report its usage\.'/);
  assert.match(read('src/demo/index.mjs'), /writeProfile\('max', \{ label: 'Claude Max'/);
  assert.match(read('web/sessiondefaults.js'), /title: 'New sessions'/);
});

test('README and RELEASING: every head cell of a table begins with a capital letter (a phone shows them as card labels)', () => {
  for (const f of ['README.md', 'RELEASING.md']) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      if (!/^\|[ :-]*-{3}/.test(l) || i === 0 || !lines[i - 1].startsWith('|')) return;
      for (const cell of lines[i - 1].split('|').slice(1, -1).map((c) => c.trim()).filter(Boolean)) {
        assert.ok(/^[A-Z`]/.test(cell), `${f}:${i}: head cell "${cell}"`);
      }
    });
  }
});

test('Not built: OpenCode question forms are drawn by the page', () => {
  assert.match(notBuilt(), /\*\*Not seen from a real model\*\*: OpenCode's own question forms \(the page has them; a real model never asked one in the tests\)\./);
  const ev = read('src/chat/engines/opencode-events.mjs');
  assert.match(ev, /a question to the owner is a form \(form\.created \/ replied \/ cancelled\)/);
  assert.match(ev, /A question to the owner \(OpenCode's form\) as the chat's question card/);
  // The code values: the form event is read and kept as a question the page answers.
  assert.match(ev, /if \(e\.type === 'form\.created' && d\.form\) return this\.#form\(d\.form\);/);
  assert.match(ev, /this\.asks\.set\(f\.id, \{ kind: 'form', keys \}\);/);
  assert.match(ev, /case 'form\.replied':\s+case 'form\.cancelled':/);
});

test('Not built: the Allow of a terminal session reads screens recorded from Claude Code 2.1.326', () => {
  assert.match(notBuilt(), /checked against screens recorded from real Claude Code 2\.1\.326; a later Claude Code that draws its permission dialog another way gets no answer from the page \(it sends you to the terminal\)\./);
  assert.match(read('src/server/screen.mjs'), /\(2\.1\.326; the real screens are in test\/server\/fixtures\/claude-screens\)/);
  assert.ok(fs.readdirSync(path.join(ROOT, 'test/server/fixtures/claude-screens')).length > 0);
  // The recorded permission dialog itself says which Claude Code drew it.
  assert.match(read('test/server/fixtures/claude-screens/perm-bash-38.txt'), /Claude Code v2\.1\.326\b/);
});

test('Do it on a git project works on a branch of its own; Accept leaves the branch, nothing is merged or pushed', () => {
  const what = flat(part('README.md', 'What it does'));
  assert.match(what, /\*\*Do it\*\* on a task starts a coding session with the task as its brief; on a git project it works on a branch of its own \(`work\/<task>`\) in its own copy of the project, so your folder is not changed\./);
  assert.match(what, /Accept leaves the branch for Go live, and nothing is merged or pushed\./);
  // The old sentence is gone from what is not built.
  assert.doesNotMatch(notBuilt(), /\*\*Do it\*\* starts its session in the project's own folder/);
  const doit = flat(read('src/work/doit.mjs'));
  // The code values: a git repository's run gets a worktree on work/<id> (unless he chose the folder itself), and the
  // chat opens in that worktree; a folder that is no git repository has no branch.
  assert.match(doit, /const bp = c\.inFolder === true \? null : await branchPlace\(id, dir\);/);
  assert.match(doit, /tree = await treeFor\(onBranch\.top, onBranch\.asked, \{ run \}\);/);
  assert.match(doit, /opened = await o\.chat\.open\(\{ dir: sdir, tool, profile: provider,/);
  assert.match(doit, /if \(!top\) return \{ why: 'not-git' \};/);
  assert.match(read('src/work/alone.mjs'), /export const branchOf = \(id\) => `work\/\$\{/);
  // Nothing in Do it pushes or merges, and Accept's release removes only the worktree: the branch stays.
  assert.doesNotMatch(doit, /'push'|'merge'/);
  const git = read('src/work/alonegit.mjs');
  const release = git.slice(git.indexOf('export async function releaseTree('), git.indexOf('\n}\n', git.indexOf('export async function releaseTree(')));
  assert.match(release, /'worktree', 'remove', t\.dir\]/);
  assert.doesNotMatch(release, /'branch', '-D'|'push'|'merge'/);
  assert.match(read('src/work/feature.mjs'), /tree = await sched\.runner\.released\(r\.item\);/);
});

test('Not built: Tia carries no Work run of hers on after a limit, answers no OK without a job, and Hoprig writes no note', () => {
  assert.match(notBuilt(), /\*\*Work, what is not there yet\*\*: Tia does not carry a Work run of hers on to another provider after a usage limit by herself, and she does not answer the OKs of a session of hers that no job follows\. Hoprig does not write a note into a session to take the option it recommends\./);
  const jobs = read('src/assistant/jobs.mjs');
  // A Work run at a usage limit ends its job (she reports it), and a Work run's OK is hers only while an active job follows it.
  assert.match(jobs, /if \(event\.reason === 'limit' && workOf\(job\.work\)\) return \{ state: 'stuck', log: `\$\{why\}; the run ended there` \};/);
  assert.match(jobs, /if \(!workOf\(j\.work\) \|\| !ACTIVE\.has\(j\.state\)\) continue;/);
  // The switch's own words promise neither.
  const help = /answersHers: `([^`]*)`/.exec(read('src/assistant/tia.mjs'))[1];
  assert.doesNotMatch(help, /usage limit|another provider|note/);
});

test('Not built: a submodule\'s own changes are not counted (git is read without looking inside it)', () => {
  assert.match(notBuilt(), /\*\*A submodule's own changes are not counted in the repository around it\*\*: Source Control and the project counts read git without looking inside a submodule's files \(its own settings could start programs\)\./);
  const g = read('src/gitread.mjs');
  assert.match(g, /--ignore-submodules=dirty: a submodule's own settings are not/);
  assert.match(g, /'submodule\.recurse=false'/);
  // The code value: every status and diff read gets --ignore-submodules=dirty in its git arguments.
  assert.match(g, /if \(NO_CONVERT\.has\(cmd\) \|\| cmd === 'status'\) rest\.splice\(at \+ 1, 0, '--ignore-submodules=dirty'\);/);
});

test('Not built: macOS lines, the Homebrew folder refusal and the process identity', () => {
  const nb = notBuilt();
  assert.match(nb, /Written for macOS and not run there: the refusal of a gateway program in a folder that Homebrew lets other users change\./);
  assert.match(nb, /is exact on Linux; on macOS and Windows it is written and tested with recorded answers of the system only\./);
  const gw = read('src/addons/localgateway.mjs');
  // A group-writable folder (Homebrew's, on a Mac) is accepted only on Linux for the owner's own group.
  assert.match(gw, /if \(\(st\.mode & 0o020\) && !sticky && !\(platform === 'linux' && st\.gid === gid\)\) return p;/);
  const id = read('src/procid.mjs');
  assert.match(id, /Linux {11}"L:<boot id>:<start>"[\s\S]*Exact, no clock involved/);
  assert.match(id, /macOS, Windows {2}"T:<epoch milliseconds of the start>"/);
});

test('RELEASING: the checks of a release are those of release.yml and release-notes.mjs', () => {
  const page = flat(read('RELEASING.md'));
  assert.match(page, /The workflow then checks that the tag is `v` and the version, that the changelog has its section \(`node tools\/release-notes\.mjs v0\.3\.3` does the same check on your computer\) and that the tag's commit is on main, runs the tests, makes the GitHub release with that changelog section as its notes, and publishes both packages to npm: `hoprig` and `hoprig-skill`, with provenance\./);
  assert.match(page, /`tools\/release-notes\.mjs` refuses a release whose heading still says "\(not released yet\)"/);
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /run: node tools\/release-notes\.mjs "\$TAG" --out/);
  assert.match(wf, /git merge-base --is-ancestor "\$\(git rev-parse "refs\/tags\/\$TAG\^\{commit\}"\)" origin\/main/);
  assert.match(wf, /- run: npm test/);
  assert.match(wf, /gh release create "\$TAG"/);
  assert.equal((wf.match(/npm publish --provenance --access public/g) || []).length, 2);
  assert.match(wf, /if: vars\.NPM_PUBLISH == 'on'/);
  assert.match(wf, /environment: npm/);
  assert.match(wf, /if \[ "\$GITHUB_REF" != "refs\/tags\/\$TAG" \]; then/);
  const notes = read('tools/release-notes.mjs');
  assert.match(notes, /if \(tag !== `v\$\{version\}`\)/);
  assert.match(notes, /\/\\\(not released yet\\\)\/i\.test\(lines\[at\]\)/);
  assert.match(notes, /if \(skillVersion !== version\)/);
  assert.match(read('.github/workflows/site.yml'), /run: node tools\/npx-held\.mjs site\/out/);
});

test('README: cloudflared is "the helper for the public link", as the Updates list names it', () => {
  const page = readme();
  assert.doesNotMatch(page, /tunnel helper/);
  assert.match(page, /- \*\*Updates\*\* of Hoprig, the coding tools and the helper for the public link \(cloudflared\) on one page, Manual by default\./);
  assert.match(page, /The helper for the public link \(cloudflared\) installs itself the first time\./);
  assert.match(page, /\*\*Settings → Version and updates\*\* is one page for Hoprig, Claude Code, OpenCode and the helper for the public link \(cloudflared\): each row shows the/);
  assert.match(page, /OpenCode when none of its sessions is open, the helper for the public link when the link is off\./);
  assert.match(page, /the helper for the public link, when Hoprig downloads it, is checked against its known SHA-256 before it is used \(one already on the computer's PATH, or installed with Homebrew on a Mac, is used as it is\)\./);
  assert.doesNotMatch(page, /the helper for the public link is checked against its known SHA-256/);
  const link = read('src/addons/publiclink.mjs');
  assert.ok(link.includes('if (got !== sha256) throw new Error('), 'a download is checked against its SHA-256');
  assert.ok(link.includes("if (platform === 'darwin' && hasBrew) return { kind: 'brew', argv: ['brew', 'install', 'cloudflared'] };"), 'Homebrew installs it on a Mac');
  assert.ok(read('src/addons/cloudflared.mjs').includes("return which('cloudflared', env, platform) ||"), 'one on PATH is taken first');
  assert.match(read('src/automation/updateitems.mjs'), /title: 'The helper for the public link \(cloudflared\)',/);
  assert.match(read('src/demo/updates.mjs'), /item\('cloudflared', 'The helper for the public link \(cloudflared\)'/);
  assert.match(read('web/updates.js'), /the coding tools and the helper for the public link \(cloudflared\)/);
  assert.match(read('src/addons/publiclink.mjs'), /A downloaded file is checked against its SHA-256 in CLOUDFLARED_SHA256 before it is used\./);
});

test('README: where Tia leads, a paid part starts by itself only at Hands off and within the daily limit, else a card', () => {
  const page = flat(part('README.md', 'Lead model: one model plans, others do the parts (Claude Code)'));
  assert.match(page, /Where Tia leads, a part on a provider billed by use starts by itself only at \*\*Hands off\*\* and only within the daily limit for paid use \(Settings → Tia\); with no limit set, or not enough of it left today, it is that card\./);
  assert.doesNotMatch(page, /Where Tia leads, a part starts by itself/);
  assert.doesNotMatch(page, /or none left today, it is that card/);
  // Only a part billed by use goes through Hands off and the limit; a limit of 0 or none is no limit, and a card.
  // Not enough left today: the ledger refuses the part's hold, and the part door turns that refusal into the card.
  const door = flat(read('src/models/partdoor.mjs'));
  assert.match(door, /const why = ledger\(\)\.take\(g\.hold, \{ id: hold, amount: \(t\) => partShare\(g\.hold, t, f\.atOnce\) \}\); if \(why\) \{ hold = null; short = why; g = \{ card: `the provider "\$\{provider\}" is billed by use, and \$\{why\}: the owner's OK comes first` \}; \}/);
  const spend = flat(read('src/assistant/spend.mjs'));
  assert.match(spend, /if \(!\(Number\.isFinite\(usd\) && usd \+ 1e-9 >= PART_MIN_USD\) \|\| t\.spent \+ t\.held \+ usd > cap \+ 1e-9\) return tooLittle\(cap, t\);/);
  assert.match(spend, /has too little left for another part/);
  const gate = flat(read('src/models/others.mjs'));
  assert.match(gate, /if \(paid && !ownerYes && !\(s\.byTia \? tia && tia\.level === 'handsoff' : paidOk\)\) return \{ card:/);
  assert.match(gate, /if \(paid && !ownerYes && s\.byTia\) \{ const cap = Number\.isFinite\(tia\.dailyCapUsd\) && tia\.dailyCapUsd > 0 \? tia\.dailyCapUsd : null;/);
  assert.match(gate, /return cap \? \{ ok: true, hold: cap \} : \{ card: `the provider "\$\{provider\}" is billed by use and no daily limit for paid use is set: the owner's OK comes first` \};/);
});

test('README: a terminal session is ended with End session, never Close, and its programs end first', () => {
  const page = readme();
  assert.match(page, /A move to another provider, a restart and \*\*End session\*\* end the programs in the terminal first, and only then start the new one or end it\./);
  assert.doesNotMatch(page, /\*\*Close\*\* end the programs/);
  const s = read('web/session.js');
  assert.match(s, /\{ value: 'kill', label: 'End session', sub: 'Stops everything running in it'/);
  assert.match(s, /ok: 'End session',/);
  assert.match(read('src/server/backends/tmux.mjs'), /async kill\(name(, \{ hold = null \} = \{\})?\) \{\s+await this\.#endPrograms\(/);
});

test('README: one name for Tia\'s limit, the label Settings → Tia draws, and no cap left', () => {
  const page = readme();
  assert.doesNotMatch(page, /daily cap|spending cap|daily spending cap|within that cap|that cap too/i);
  assert.match(page, /Within the \*\*Daily limit for paid use \(US \$\)\*\* you set in Settings → Tia \(empty at first\)/);
  assert.match(page, /Within a daily limit for paid use you set in Settings → Tia \(none at first\)/);
  assert.match(read('web/tia.js'), /h\('label\.field-label', \{ for: 'tia-daily-cap' \}, 'Daily limit for paid use \(US \$\)'\)/);
  assert.match(read('web/tia.js'), /placeholder: 'No limit'/);
});

test('README: the join line of a server uses a server address, not "hub"', () => {
  const page = read('README.md');
  assert.match(page, /`hoprig setup --hub` on the server; `hoprig join https:\/\/your-server <code>` on each computer/);
  assert.doesNotMatch(page, /your-hub/);
  assert.match(read('src/machines/cli.mjs'), /hoprig join https:\/\/<its address> CODE/);
});

test('README: the "Not built" list says a terminal session ends, never that it closes', () => {
  const page = readme();
  assert.match(page, /the ending of a terminal's programs before the session ends, the safe git reads\./);
  assert.doesNotMatch(page, /programs before it closes/);
  assert.match(read('web/session.js'), /\{ value: 'kill', label: 'End session',/);
  assert.match(read('src/server/backends/tmux.mjs'), /async kill\(name(, \{ hold = null \} = \{\})?\) \{\s+await this\.#endPrograms\(/);
});

test('README: a direct call to GitHub or GitLab that can change something stays yours at Full in her session', () => {
  const text = flat(part('README.md', 'Tia (experimental, off by default)'));
  assert.match(text, /even at Full a delete outside the session's own folder \(also as administrator\), a push or a merge into the main branch, a release, a pull request, a direct call to GitHub or GitLab \(`gh api`, `glab api`\) that can change something there, a deploy, a change to `project\.json` or to Hoprig's own files, and a line Hoprig cannot read stay yours/);
  const wall = read('src/wall.mjs');
  // The wall's kind for it, its card's title, and the reason it is left to the owner.
  assert.match(wall, /if \(\(head === 'gh' \|\| head === 'glab'\) && a === 'api' && \(rest\.some\(isGraphqlEndpoint\) \|\| apiWrites\(rest\)\)\) return 'api-write';/);
  assert.match(wall, /'api-write': 'A direct call to GitHub or GitLab',/);
  assert.match(wall, /'api-write': 'This calls GitHub or GitLab directly in a way that can change something there/);
  // At Full only a plain administrator act is lifted, so api-write stays held.
  assert.match(read('src/hook.mjs'), /const acts = \(held\.acts \|\| \[held\]\)\.filter\(\(a\) => a\.kind !== 'admin' \|\| a\.unsure\);/);
});

test('README: Allow in this session stops the asking for the rest of this session, as its button and help say', () => {
  const page = readme();
  assert.match(page, /\*\*Allow in this session\*\* \(stops the asking for that kind of call for the rest of this session; nothing is written to a settings file\)/);
  assert.doesNotMatch(page, /until the chat closes/);
  const asks = read('web/chat/asks.js');
  assert.match(asks, /`\$\{who\} does not ask again in this session for: \$\{ruleWords\(ev\.alwaysText\) \|\| 'this'\}`/);
  assert.match(asks, /'Allow all edits in this session' : 'Allow in this session'/);
  // A chat is not "closed": the session menu ends one with Archive.
  assert.match(read('web/chat/header.js'), /\{ value: 'archive', label: 'Archive', sub: 'It leaves Home; the conversation is kept and can be continued', icon: 'archive' \}/);
});

test('README: parts of Tia\'s Lead session that run at once share what is left of the daily limit, each holding its share', () => {
  const page = flat(part('README.md', 'Lead model: one model plans, others do the parts (Claude Code)'));
  assert.match(page, /it is that card\. Parts that run at once share what is left of that limit; each holds its share while it runs\./);
  const spend = flat(read('src/assistant/spend.mjs'));
  // The share: what is left and not held, divided among the parts that may still start beside it.
  assert.match(spend, /const free = Math\.max\(0, cap - t\.spent - t\.held\); const may = Number\.isInteger\(atOnce\) && atOnce > 0 \? Math\.max\(1, atOnce - \(t\.parts \|\| 0\)\) : 1; return Math\.floor\(\(free \/ may\) \* 100 \+ 1e-6\) \/ 100;/);
  const door = flat(read('src/models/partdoor.mjs'));
  // Taken as a hold at the start, given to the part as its budget, and replaced by its measured cost.
  assert.match(door, /amount: \(t\) => partShare\(g\.hold, t, f\.atOnce\)/);
  assert.match(door, /\.\.\.\(hold \? \{ budgetUsd: ledger\(\)\.heldFor\(hold\) \} : \{\}\)/);
  assert.match(door, /else ledger\(\)\.bind\(hold, `this\|chat:\$\{parts\.get\(id\)\.id\}`, 0, true\);/);
});

test('README: a later start of a part with no room in the daily limit starts nothing, holds nothing, and its chat says it could not start', () => {
  const page = flat(part('README.md', 'Lead model: one model plans, others do the parts (Claude Code)'));
  assert.ok(page.includes('A later start of a part (after it stopped for being idle, or after a restart) with no limit set any more, or no room left in it, starts nothing and holds nothing; when you send it a message, its chat says that Claude Code could not start, and why.'));
  assert.ok(read('src/chat/chat.mjs').includes('  wake() {\n    ensure(this).catch(() => {});\n  }'), 'a wake after a restart says nothing in the chat');
  const f = read('src/chat/feature.mjs');
  assert.ok(f.includes("throw Object.assign(new Error(why), { status: 409, code: 'start' });"), 'a refused later start throws, nothing is held');
  assert.ok(!f.includes('This part runs with a budget of $'), 'no start with a cent any more');
  assert.ok(f.includes('Every later one\n   * (after its idle stop, a restart for a setting, a restart of the dashboard)'), 'the later starts');
  const run = read('src/chat/run.mjs');
  assert.ok(run.includes("const budget = typeof budgetOf === 'function' ? budgetOf() : undefined;"), 'asked before the coding tool is started');
  assert.ok(run.indexOf('const budget = typeof budgetOf') < run.indexOf('session = chat.engine.open({'), 'before the process');
  assert.ok(read('src/chat/chat.mjs').includes("error: `${this.engine.label} could not start: ${e.message}`"), 'the chat says it could not start, and why');
});

test('README: a part started by your yes counts $0.50 until its turn reports a cost, and a part whose end Hoprig did not see keeps the rest of its budget counted', () => {
  const page = flat(part('README.md', 'Lead model: one model plans, others do the parts (Claude Code)'));
  assert.ok(page.includes('A part that starts by your yes on that card is counted in what Settings → Tia shows for today, but is never checked against the limit: it counts $0.50 until its chat reports what its turn cost, and when that turn ends without a reported cost, the $0.50 stays counted until the day ends.'));
  assert.ok(page.includes('When the dashboard stopped while a part ran, Hoprig did not see the part end and could not measure what it cost, so the rest of its budget stays counted until the day ends.'));
  const door = read('src/models/partdoor.mjs');
  // His yes: a tapped act (counted, never checked against the limit), bound to the part's chat.
  assert.ok(door.includes('if (rec.byTia) {\n        const tap = `part-'));
  assert.ok(door.includes('ledger().tapped(tap);\n        ledger().bind(tap, `this|chat:${parts.get(id).id}`, 0, true);'));
  const spend = read('src/assistant/spend.mjs');
  assert.ok(spend.includes('  /** A paid act ran from his tap on a card: counted in today\'s sum at once, never checked against the daily limit for paid use. */'));
  // Its $0.50 goes only when a turn that began after it ended at a higher figure: a turn with no reported cost leaves it.
  assert.ok(spend.includes('if (own && m.usd > from + 1e-9) return true;'));
  // His yes binds the part's chat as fresh: the $0.50 goes only when that chat's turn ended at a higher figure.
  assert.ok(spend.includes('return (looks.get(session) || []).some((m) => m.i > at && !m.working && m.usd > from + 1e-9);'));
  assert.ok(spend.includes('if (chat && (ranAfter(chat, i) || (fresh.has(e.id) && costAfter(chat, i)))) continue;'));
  assert.ok(spend.includes('export const HOLD_USD = 0.5;'), 'the $0.50');
  // His yes writes an owner's hold, and an unmeasured hold counts the $0.50 in today's sum.
  assert.ok(spend.includes("    this.#append({ at: this.now(), kind: 'hold', id: String(id).slice(0, 40), owner: true });"), 'his yes is a hold of his own');
  assert.ok(spend.includes('      held += HOLD_USD;\n      unmeasured++;'), 'an unmeasured hold counts $0.50');
  // A part whose end was not seen keeps the rest of its budget counted.
  assert.ok(spend.includes('    if (unseen) cut = true;'));
  assert.ok(spend.includes("...(rest > 0 ? { cut: rest, ...(unseen ? { why: 'unseen' } : {}) } : {})"));
  // What Settings → Tia shows for today: the counted $0.50 in its sentence with no limit set, and in the used figure with one.
  const tia = read('web/tia.js');
  assert.ok(tia.includes('if (!(sp && sp.cap)) return `Today: ${money(t.spent)} spent.${counted}'));
  assert.ok(tia.includes('const used = (t.spent || 0) + (t.held || 0);'));
  assert.ok(tia.includes('return `Today: ${money(t.spent)} spent.${counted}${parts}${cut}${unseen} ${money(used)} of your ${money(sp.cap)} daily limit is used.${full}`;'));
  // A hold no process end settled: the dashboard stopped while the part ran; the rest of its budget counts as unseen.
  assert.ok(read('src/chat/feature.mjs').includes('const l = settleChat(c, { unseen: true });'));
  assert.ok(read('web/tia.js').includes("'a part whose end Hoprig did not see (the dashboard stopped while it ran): Hoprig could not measure what it cost, so the rest of"));
});

test('README: the New session picture on a phone shows the recent projects, as the sheet draws them', () => {
  const page = read('README.md');
  assert.ok(page.includes('<img src="docs/screenshots/new-session-phone-light.webp" alt="New session on a phone: one line that names the computer, the App and the coding tool, with Change beside it, and the recent projects"'));
  const popup = read('web/newsession-popup.js');
  assert.ok(popup.includes("groupHead('Recent')"), 'the recent projects');
});

test('README: the usage-limit picture says one button in front and the other ways folded under Other ways', () => {
  const page = read('README.md');
  assert.ok(page.includes('<img src="docs/screenshots/limit-reached-desktop-light.webp" alt="A session at its usage limit, with one button to continue the same conversation on another provider and the other ways folded under Other ways"'));
  const lib = read('web/lib.js');
  assert.ok(lib.includes(': `Continue on ${p.label}${cost(p)}`);'), 'the button names the provider');
  assert.ok(lib.includes('const front = [...leads, ...(main && s.canSwitch ? [moves[shown.indexOf(main)]] : [])];'), 'one way in front');
  assert.ok(lib.includes("h('summary.limit-more-summary', { onclick: (e) => e.stopPropagation() }, 'Other ways', icon('chevronDown', { size: 16 })),"), 'the rest under Other ways');
});
}
