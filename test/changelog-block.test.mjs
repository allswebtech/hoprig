// The unreleased block of the changelog (site/content/changelog.md, from "## 0.3.3" to the next "## ") was put in
// order: a fact told twice now stands once, contradictions were mended, parts moved. That must lose no fact. So this
// test holds the block's bold lead-ins as they were before (written here as data), and a lead-in that is gone must
// name the item that now holds its fact and a few words of that fact that stand there. The older blocks are history:
// the text after the block is held by its hash, so not one character of them changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(path.join(ROOT, 'site/content/changelog.md'), 'utf8').replace(/\r\n?/g, '\n');
const at = text.indexOf('\n## 0.3.3 ');
const end = text.indexOf('\n## ', at + 1);
const block = text.slice(at, end);
/** Each item of the block by its bold lead-in: the lead-in, and the item's whole line. */
const items = new Map([...block.matchAll(/^- \*\*(.+?)\*\*.*$/gm)].map((m) => [m[1], m[0]]));

/** The block's bold lead-ins before it was put in order (217). */
const BEFORE = [
  "The upkeep no longer touches a project.",
  "Restore brings no project by itself.",
  "`hoprig sync` and `hoprig drop` are commands.",
  "`hoprig rm <name>` asks before it deletes a profile",
  "Bypass permissions needs a switch in Settings.",
  "Automations moved into Work → Schedules.",
  "The dashboard looks at more by itself.",
  "Ctrl+B in a session's terminal on the page goes to the program",
  "An App session asks its provider for a short title, once.",
  "What you delete in the App goes to a trash for 30 days",
  "Tia does nothing by herself after the update.",
  "Tia asks before she uses a provider billed by use, until you set a daily cap.",
  "A chat of the App tells Hoprig how it stopped.",
  "The dashboard writes one small file when it starts:",
  "Hoprig notes how its own work went, on this computer only.",
  "Being told is off until you turn it on.",
  "The Operator's look reads more, and keeps one small file.",
  "Missions are off after the update",
  "Hoprig needs Node.js 22.11 or newer.",
  "A mission's choices, the looks and your corrections are off after the update.",
  "Installing or updating a gateway, and a Fix, need your confirmation that names the computer.",
  "A gateway's start also gets `HOST=127.0.0.1`",
  "Which computer has what, on the Workspace page.",
  "Drop a project from the page.",
  "Only your own page may do what is yours.",
  "Groups on the page.",
  "Tia knows the workspace.",
  "A project can name what its sessions need to read, and you say yes on each computer.",
  "Each computer has a label and a file of its own in the AI brain",
  "The map keeps itself between two computers.",
  "A clone that was cut off is cloned again.",
  "Push my other branches",
  "Set-up has one path for the workspace",
  "The brain's memory folders",
  "The credentials folder can be a private repository of its own, when you choose it",
  "Where a push of the credentials goes is asked of git itself",
  "Credential links.",
  "`hoprig drop <name>` takes a project off this computer, safely.",
  "What a drop removes without asking is three things, decided in one place",
  "Projects that were on the computer before Hoprig can be brought into the layout, in three steps that move, change and delete nothing of what was there.",
  "The originals go only by your own command.",
  "Before a first push you see what it would take.",
  "The coding tool's conversations and memory of each old folder come along:",
  "The box you write in works like the desktop app's.",
  "Keys.",
  "Delete for a terminal's earlier conversations.",
  "A long conversation opens at once.",
  "The session list stays at the left",
  "A session is named as Claude Code names it",
  "Delete, with a trash.",
  "The diff pane.",
  "Rewind and branch, in Claude Code's words.",
  "The `/` menu lists the commands by name, as Claude Code's",
  "`!` runs a shell command.",
  "A permission card has a third answer where Claude Code offers it: Always allow in this project.",
  "Shift+Tab goes through the modes in Claude Code's order",
  "Lead model.",
  "What it costs is said where you switch it on:",
  "Who did what.",
  "Use other providers",
  "A card answered late starts nothing.",
  "A Yes never starts a part by itself.",
  "The card by keyboard.",
  "Tia does Work.",
  "Voice typing",
  "What a card shows is exactly what is sent.",
  "Her answers come with cards.",
  "A card shows what is so now.",
  "Her messages read like a chat:",
  "\"What needs me\" reads the Operator's list",
  "A choice she shows while a job wakes her also comes as a push",
  "A daily spending cap for providers billed by use.",
  "Five things more she can do:",
  "What is yours stays yours, at every level.",
  "A start you did not ask for does not happen.",
  "The same start twice is one start",
  "\"What Tia can do, and what she cannot\"",
  "Operator: one page that says what needs you now.",
  "Nothing happens until you tap.",
  "Tia can do four steps by herself, by rules you switch on.",
  "Her limits, and her record.",
  "A provider that stops the work is said, with what helps.",
  "Tia can decide, by one short call (off until you turn it on).",
  "A place that could not be read is said",
  "Each computer's room for new work.",
  "The New session sheet says the room.",
  "Tia starts new work where there is room, on the computers you chose.",
  "\"Start new work on … until this computer is calm.\"",
  "A mission's choices can go through \"Tia decides\" (off until you turn it on).",
  "Tia can look into what nobody can explain (off until you turn it on).",
  "Tia can keep your corrections (off until you turn it on).",
  "Tia reads the same list",
  "Check this provider.",
  "A provider's model map can reach every session, where you turn it on.",
  "What is left, only as measured.",
  "\"Wait until\" names a time only when the tool or the provider named one",
  "A session you ran with Claude Code yourself, outside Hoprig, is seen too.",
  "Claude Code's own settings can send every provider to one address.",
  "Plans.",
  "Plan with AI.",
  "`hoprig tasks plans`",
  "The bundled skill `plan-work`",
  "A task can repeat",
  "Run by AI at a time.",
  "Schedules live in Work.",
  "Progress is read, never told by a model.",
  "An estimate only from what was measured.",
  "Being told, by code.",
  "Tia answers from the same lines.",
  "Put together, checked, live on your tap.",
  "A project's commands run only after your yes on this computer.",
  "By itself only where you typed it.",
  "True after a crash.",
  "A restart waits for work in progress.",
  "A goal becomes a plan, and sessions she starts do the plan.",
  "Off twice.",
  "A check owns \"done\", and a reviewer that did not write it reads every task.",
  "A task's tests run in the box, by themselves.",
  "Your press on a task: \"Run the tests in the box\".",
  "A session of hers has the file tools only:",
  "Your limits hold:",
  "Accept stays yours",
  "`hoprig box run`",
  "When there is no box, nothing runs.",
  "What is inside is a list, never the disk minus a list:",
  "`hoprig box check`",
  "Per system.",
  "What it costs,",
  "What it does not promise",
  "A token for a script or another product",
  "A task from a token is someone else's words.",
  "Webhooks",
  "`hoprig project new <name> --brief <file>`",
  "The skill fits the work to the project.",
  "Your own defaults",
  "Learn skills, off until you turn it on.",
  "What a draft may not hold.",
  "Masking secrets and scanning a skill stay fast on a very long line.",
  "A better text for a skill arrives as a proposal, and waits for your tap.",
  "PHP + database",
  "Suggested, never ticked.",
  "The PHP a project asks for.",
  "Java is found, never installed.",
  "Set-up never opens a server to the network.",
  "How to reach it, in place of a link nobody can open.",
  "The dashboard keeps running after you log out.",
  "One closing list: \"Still yours to do\".",
  "After an update through the installer the dashboard runs the new version.",
  "A gateway that Hoprig starts listens on this computer only",
  "Add-ons install with the npm of the Node that Hoprig runs on",
  "A dashboard that cannot say where it listens is never called running on a server.",
  "`hoprig doctor` on a server fails a gateway that Hoprig started and that listens beyond this computer",
  "At the desktop, a server reason that an earlier run over ssh saved is named",
  "The Install sheet of an add-on shows on the page.",
  "Smaller things.",
  "Add a server with its key file.",
  "Install Hoprig there from the page.",
  "Each computer's Health.",
  "A gateway on a computer, from the page.",
  "One rule for where a gateway listens.",
  "A first password is shown once.",
  "Open its page.",
  "Install, update and a Fix are your own press.",
  "What still needs a terminal on the server:",
  "Installing the service again, or an update, no longer leaves the old dashboard serving.",
  "The background task is made for your account by its SID",
  "Programs that winget installed are found without a new sign-in:",
  "Hoprig learns from its own work.",
  "A way round stays on the computer.",
  "Sending is your choice.",
  "The test suite cannot touch the computer it runs on.",
  "A test sees only what is its own.",
  "Keys you know.",
  "Tabs",
  "Replace across files",
  "Match Whole Word takes a word of any script",
  "A search can no longer hold the dashboard.",
  "The Explorer",
  "Windows behave as on a desktop",
  "Keys of its own",
  "The bar says what needs you",
  "Touch",
  "Two tabs on one desktop",
  "The skill without Hoprig: `npx hoprig-skill --claude`",
  "The skill is made from the commands themselves",
  "`hoprig skills update`",
  "A release is a tag on a commit of main",
  "What a coding tool asks you is shown as the tool asked it.",
  "A file dropped or pasted on a session's terminal types its path",
  "A session's terminal on the page behaves like a terminal.",
  "A large paste arrives whole or not at all.",
  "Reconnecting ends.",
  "On a phone",
  "`hoprig service restart`",
  "Updates → Restart now.",
  "`hoprig serve` never leaves a second dashboard beside the first.",
  "A session that waits while a command it started still runs says so.",
  "One conversation, one card.",
  "In bypass mode a delete is answered by itself only in the session's own folder.",
  "Every model picker shows the provider's own models.",
  "\"Open in terminal\" twice opens one terminal.",
  "\"Bring up to date\" says why it could not.",
  "Windows: a program is found by the file Windows can start.",
  "A help word after a command only prints help.",
  "`/exit` just exits.",
  "Shift+Enter opens a new line in a session's terminal.",
  "A shell command of an OpenCode chat that the delete scan cannot judge is a card.",
  "Remove on the main dashboard no longer says it could not revoke a token that it did revoke.",
  "A new project needs no global git identity.",
  "A project's example `.env` is not copied when the project has another `.env` file already",
  "A file that differs only by its line endings is said as that",
  "A dashboard with many open sessions answers while it starts.",
  "In bypass mode Hoprig no longer allows a delete by itself when it would take away Hoprig's own settings, its state, its hook or its installed program, or a folder above one of them.",
  "Allow and Do not allow keep the keyboard's focus.",
  "A project with a file name that is not UTF-8 is copied on every Node.js.",
  "`hoprig doctor --offline` on Linux starts no package manager.",
  "`hoprig doctor` checks the port the dashboard really uses.",
];

/** A lead-in that is gone: the items that now hold its fact, each with words of that fact that stand there. */
const MOVED = {
  'Nothing happens until you tap.': [
    { item: "While Tia's rules, Tia decides and her looks are off, nothing happens until you tap.", words: 'A step is something Hoprig already does elsewhere, with the same checks' },
  ],
  'Tia can decide, by one short call (off until you turn it on).': [
    { item: 'Tia can decide, by one short call.', words: 'asks a model one short question with a closed list of prepared steps' },
    { item: 'Tia does nothing by herself after the update.', words: 'and so are **Tia acts by herself** and **Tia decides**. All of them are off after a new install too' },
  ],
  'A mission\'s choices can go through "Tia decides" (off until you turn it on).': [
    { item: 'A mission\'s choices can go through "Tia decides".', words: 'the switch **Also a mission\'s choices** sends the choice points of her missions' },
    { item: 'A mission\'s choices, the looks and your corrections are off after the update.', words: 'They are off after a new install too. With the three switches off nothing of them starts or is written.' },
  ],
  'Tia can look into what nobody can explain (off until you turn it on).': [
    { item: 'Tia can look into what nobody can explain.', words: 'she starts ONE look per such item' },
    { item: 'A mission\'s choices, the looks and your corrections are off after the update.', words: 'They are off after a new install too. With the three switches off nothing of them starts or is written.' },
  ],
  'Tia can keep your corrections (off until you turn it on).': [
    { item: 'Tia can keep your corrections.', words: 'With **Tia keeps your corrections** on, a small record is written' },
    { item: 'A mission\'s choices, the looks and your corrections are off after the update.', words: 'They are off after a new install too. With the three switches off nothing of them starts or is written.' },
  ],
  'Schedules live in Work.': [
    { item: 'Work → Schedules lists your schedules and your repeating tasks together.', words: 'A schedule can name the computer it runs on' },
    { item: 'Automations moved into Work → Schedules.', words: 'Your schedules run as before, on this computer' },
  ],
  'Off twice.': [
    { item: 'Two switches.', words: 'A mission starts only while the master switch and the project\'s own switch are both on' },
    { item: 'Missions are off after the update', words: 'with their master switch and every project\'s own switch, as after a new install' },
  ],
  'Operator: one page that says what needs you now.': [
    { item: 'Operator: one page that says what stopped or is about to.', words: 'From what Hoprig already watches it lists, in this order' },
  ],
  'Tia can do four steps by herself, by rules you switch on.': [
    { item: 'Tia can do five steps by herself, by rules you switch on.', words: 'continue a session that stopped at a usage limit on the next provider of your order' },
  ],
  // One name for her limit: "daily limit for paid use", as the field is labelled.
  'Tia asks before she uses a provider billed by use, until you set a daily cap.': [
    { item: 'Tia asks before she uses a provider billed by use, until you set a daily limit for paid use.', words: 'Now each of those is a card until you set **Daily limit for paid use (US $)** under Settings → Tia' },
  ],
  'A daily spending cap for providers billed by use.': [
    { item: 'A daily limit for paid use, for providers billed by use.', words: 'Settings → Tia, beside the level; none until you set one.' },
  ],
  // Doubles joined: each fact stands once, in the entry of its feature.
  'Being told is off until you turn it on.': [
    { item: 'Being told, by code.', words: 'Every item is off after an install and after an update, and your push address goes on working as before' },
  ],
  '"What needs me" reads the Operator\'s list': [
    { item: 'Tia reads the same list', words: 'when you ask "What needs me?", beside your tasks and the sessions that wait for you, and names each one' },
  ],
  'A gateway that Hoprig starts listens on this computer only': [
    { item: 'One rule for where a gateway listens.', words: 'the gateway gets `HOST=127.0.0.1` and its definition\'s own words for it' },
    { item: 'A gateway\'s start also gets `HOST=127.0.0.1`', words: 'A gateway that already runs is not restarted by the update' },
  ],
  "In bypass mode Hoprig no longer allows a delete by itself when it would take away Hoprig's own settings, its state, its hook or its installed program, or a folder above one of them.": [
    { item: "In bypass mode a delete is answered by itself only in the session's own folder.", words: "Nor is a delete that would take away Hoprig's own settings, its state, its hook or its installed program, or a folder above one of them" },
  ],
};

/**
 * Lead-ins that came into the block after BEFORE was written and are gone again: a step in between that a later
 * entry changed (a person who updates from 0.3.2 gets only the end), a double, or a lead-in reworded. Each names the
 * item that now holds its fact and words of that fact.
 */
const LATER = {
  'With Hands-off on, more commands are found to be yours.': [
    { item: 'A command of yours is found behind the program that runs it.', words: 'behind a variable written in quotes (`VAR="a b" sudo …`)' },
  ],
  'What is new to see:': [
    { item: 'A switch that lets Hoprig answer for you.', words: 'Turn Hands-off on for a project (Settings → Hands-off) or a session (its menu)' },
  ],
  'Ending a stuck session needs a tick per project.': [
    { item: 'Tia can decide, by one short call.', words: 'a step that ends a session is offered only where you ticked **Tia may end a stuck session in this project**' },
  ],
  "Without a daily spending cap, Tia's rules spend nothing.": [
    { item: 'Tia asks before she uses a provider billed by use, until you set a daily limit for paid use.', words: 'With no limit set, the limit rule and **Tia decides** do not move a session onto a provider paid per use and do not type into a session on one' },
  ],
  'Auto mode counts as free of charge where its order holds no provider billed by use.': [
    { item: 'Tia asks before she uses a provider billed by use, until you set a daily limit for paid use.', words: 'only when every provider she may use is one (Auto mode counts as one when its order holds one)' },
  ],
  'The daily limit says what it counted.': [
    { item: 'A daily limit for paid use, for providers billed by use.', words: 'Its card names what was counted today, and a start counted at $0.50 stays counted until the day ends.' },
  ],
  'Plan with AI opens on your default provider': [
    { item: 'Plan with AI.', words: 'It opens on your default provider, also before a project is chosen' },
  ],
  'Old waiting sessions are folded, and "Close them…" ends the ones you tick.': [
    { item: 'Old waiting sessions are folded, and "End them…" ends the ones you tick.', words: 'one button says the number ("End 5 sessions")' },
  ],
};

/** sha256 of the text after the block (from "\n## 0.3.2 " to the file's end, line ends as "\n") before. */
const OLDER = 'cf47fa9a07bc6ff41e98937d0694cf7a55fbb57a79c42d9820f14f8ebeca6b94';

test('the unreleased block is found', () => {
  assert.ok(at >= 0 && end > at, 'a block "## 0.3.3 …" followed by an older "## " block');
  assert.equal(BEFORE.length, 217);
});

test('every lead-in of the block before still stands, or its fact stands in a named item', () => {
  const lost = [];
  for (const lead of BEFORE) {
    if (items.has(lead)) continue;
    const to = MOVED[lead];
    if (!to) { lost.push(`"${lead}": gone, and no item is named that holds its fact`); continue; }
    for (const { item, words } of to) {
      if (!items.has(item)) lost.push(`"${lead}": its fact is said to be in "${item}", which is not an item of the block`);
      else if (!items.get(item).includes(words)) lost.push(`"${lead}": "${item}" does not say "${words}"`);
    }
  }
  assert.deepEqual(lost, [], `facts lost from the block (lead-ins before: ${BEFORE.length}, now: ${items.size})`);
});

test('a lead-in named as moved is really gone, so the list of moves stays true', () => {
  for (const lead of Object.keys(MOVED)) {
    assert.ok(BEFORE.includes(lead), `"${lead}" was a lead-in before`);
    assert.ok(!items.has(lead), `"${lead}" stands again: take it out of the list of moves`);
  }
});

test('a later lead-in that is gone names the item that holds its fact, and is really gone', () => {
  const lost = [];
  for (const [lead, to] of Object.entries(LATER)) {
    assert.ok(!BEFORE.includes(lead), `"${lead}" is in BEFORE: its row belongs in MOVED`);
    if (items.has(lead)) lost.push(`"${lead}" stands again: take it out of LATER`);
    for (const { item, words } of to) {
      if (!items.has(item)) lost.push(`"${lead}": its fact is said to be in "${item}", which is not an item of the block`);
      else if (!items.get(item).includes(words)) lost.push(`"${lead}": "${item}" does not say "${words}"`);
    }
  }
  assert.deepEqual(lost, []);
});

test('the older blocks are history: not one character of them changed', () => {
  assert.equal(createHash('sha256').update(text.slice(end)).digest('hex'), OLDER);
});

test('the lead-in about her rules counts them as the code has them, and its list names every rule', async () => {
  const { RULES } = await import('../src/operator/rules.mjs');
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const lead = [...items.keys()].find((l) => /^Tia can do \w+ steps by herself, by rules you switch on\.$/.test(l));
  assert.ok(lead, 'the lead-in "Tia can do … steps by herself, by rules you switch on." stands');
  assert.equal(lead, `Tia can do ${WORDS[RULES.length]} steps by herself, by rules you switch on.`);
  // One part of the item for each rule, in the rules' own order (src/operator/rules.mjs).
  const said = { limit: 'continue a session that stopped at a usage limit', gateway: 'restart a gateway that open sessions go through', link: 'restart the public link', leftover: "end a test's left-over processes", elsewhere: 'start her new work on a computer you chose that has room' };
  assert.deepEqual(RULES.map((r) => r.id), Object.keys(said), 'a rule was added or taken away: say it in the item');
  for (const [id, w] of Object.entries(said)) assert.ok(items.get(lead).includes(w), `the item names the rule ${id}`);
});

test("the Operator's parts are named in the block as the page heads them", () => {
  // The page's section headings (web/operator.js: h('h2.op-h', '…')); the page cannot be imported without a browser.
  const heads = [...fs.readFileSync(path.join(ROOT, 'web/operator.js'), 'utf8').matchAll(/h\('h2\.op-h', '([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(heads.includes('Done by you') && heads.includes('Done by Tia'), heads.join(', '));
  const named = [...block.matchAll(/one line under \*\*([^*]+)\*\*/g)].map((m) => m[1]);
  assert.ok(named.length >= 2, 'the block says where a step is written');
  for (const n of named) assert.ok(heads.includes(n), `"${n}" is a part of the Operator page (${heads.join(', ')})`);
});

test('an unreleased heading says so, and RELEASING.md says who writes the date there', () => {
  const head = text.slice(at + 1, text.indexOf('\n', at + 1));
  assert.match(head, /^## \d+\.\d+\.\d+ \((not released yet|\d{1,2} [A-Z][a-z]+ \d{4})\)$/);
  if (!head.includes('(not released yet)')) return;
  // The date is the releaser's step; the release check (tools/release-notes.mjs) refuses the heading until it is done.
  const steps = fs.readFileSync(path.join(ROOT, 'RELEASING.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(steps, /`## <version> \(not released yet\)`: in the same commit as the version, write the release date in its place/);
});
