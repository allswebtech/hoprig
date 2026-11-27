// Work and the Operator said the same "what needs you now" for two different lists, so a newcomer could not tell the
// pages apart. Each page has one line of its own now, said the same wherever the page is named: Work's Today is what
// is due and what waits for your yes; the Operator is what stopped or is about to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const WORK = 'what is due, and what waits for your yes';

test('Work and the Operator each say what they list, in words of their own, wherever the page is named', () => {
  const work = /intro: '([^']*)'/.exec(read('web/work.js').slice(read('web/work.js').indexOf("title: 'Work'")))[1];
  assert.match(work, new RegExp(WORK.replace(/,/g, ',?')), work);
  assert.doesNotMatch(work, /needs you now/, 'Work\'s page');
  assert.doesNotMatch(read('web/operator.js'), /export const INTRO/, 'the Operator has no page and no intro line any more');
  const readme = read('README.md').replace(/\n\s*/g, ' ');
  assert.match(readme, /\*\*Work\*\*: your tasks, and its \*\*Today\*\* tab that lists what is due this week, what waits for your yes/);
  assert.match(readme, /\*\*Operator\*\*: what stopped or is about to, from everything Hoprig watches/);
  assert.match(read('docs/WORK.md'), /one screen \(Today\) for what is due and what waits for\s+your yes/);
  assert.match(read('docs/OPERATOR.md'), /^# Operator: what stopped or is about to\n/);
  assert.match(read('site/content/changelog.md'), /\*\*Operator: one page that says what stopped or is about to\.\*\*/);
});

test('the changelog says what is true of a help word, and the Operator\'s step by the page\'s word', () => {
  const log = read('site/content/changelog.md');
  const line = log.split('\n').find((l) => l.startsWith('- **A help word after a command only prints help.**'));
  assert.ok(line, 'the line about the help word');
  assert.match(line, /after any command, or after any of its subcommands/);
  assert.match(line, /`hoprig service uninstall help` turned the background dashboard off/);
  assert.doesNotMatch(line, /`help` anywhere counts for/, 'the old rule, which no longer holds');
  assert.doesNotMatch(log, /suggested step/, 'the page says "recommended"');
  assert.match(log, /each rule does its item's recommended step/);
});

test('a proposal for a tool description or a part of Tia\'s instructions says where it is kept and when it stops applying', async () => {
  const page = read('web/skillproposals.js');
  assert.match(page, /the part "\$\{p\.label \|\| p\.name\}" of Tia's instructions/);
  assert.match(page, /Accept keeps the new text in Hoprig\\'s settings, not in its code\./);
  assert.match(page, /label: 'Remove'/);
  assert.doesNotMatch(page, /A tool\\'s description is part of Hoprig\\'s code, so it is not changed here/, 'the old rule');
  const { STALE_WHY } = await import('../src/assistant/accepted.mjs');
  assert.equal(STALE_WHY, "no longer applies: Hoprig's own text changed since it was measured");
  const { SECTION_NAMES, TARGET_IDS } = await import('../src/assistant/prompt.mjs');
  for (const id of TARGET_IDS) assert.ok(SECTION_NAMES[id], id);
  const docs = read('docs/SKILLS.md');
  assert.match(docs, /## Proposals for Tia\n/);
  assert.match(docs.replace(/\n/g, ' '), /no longer applies: Hoprig's own text changed since it was measured", with \*\*Remove\*\*/);
  const log = read('site/content/changelog.md');
  assert.match(log, /- \*\*A better tool description or part of Tia's instructions is accepted with one tap too, and undone\.\*\*/);
  // The released 0.3.3 block keeps the old rule as history; the unreleased block (the first "## ") never says it.
  const first = log.indexOf('\n## ');
  const unreleased = log.slice(first, log.indexOf('\n## ', first + 1));
  assert.match(unreleased, /^\n## \d+\.\d+\.\d+ \((?:not released yet|\d{1,2} [A-Z][a-z]+ \d{4})\)\n/, 'the first block is the newest one: not released yet, or dated on the day of its release');
  assert.doesNotMatch(unreleased, /A proposal for a tool's description is never accepted by a tap/, 'the old rule');
});

test('the weekly look says it also looks for new skills from the hubs and only tells, wherever it is named', () => {
  const page = read('web/skillhub.js');
  const words = 'Once a week, look for updates of your skills and for new skills from the reviewed hubs that fit your projects. It only tells you; nothing is added without you.';
  assert.ok(page.includes(words), 'the switch\'s words');
  assert.match(page, /toggle\('Look for updates and new skills once a week'/);
  assert.match(page, /groupHead\('Worth adding'/);
  assert.doesNotMatch(page, /it never installs\./, 'the old words');
  const flat = (t) => t.replace(/\n\s*/g, ' ');
  assert.match(flat(read('docs/SKILLS.md')), /Hermes Agent's tools are Python functions of its own runtime and are not carried over/);
  assert.match(flat(read('README.md')), /\*\*Skills worth adding\*\*: once a week, when you turn it on, new skills from the reviewed skill collections/);
  assert.match(read('site/content/changelog.md'), /\*\*The weekly look also finds new skills that fit your projects, and only offers them\.\*\*/);
});

test('Improve Tia says what it does, what it costs and that nothing changes without you, in the same words everywhere', async () => {
  const page = read('web/tiaimprove.js');
  const { WHAT, PAID_LINE, SUB_LINE, resultWords, weeklyWords } = await import('../web/tiaimprovewords.js');
  assert.equal(WHAT, 'Hoprig tries rewordings of Tia\'s skills, tool descriptions and instructions, measures each with her tests, and shows you only the ones that do measurably better. Nothing changes until you accept one, and every change has Undo.');
  assert.equal(PAID_LINE, 'This counts against your daily limit for paid use.');
  assert.match(SUB_LINE, /uses that subscription's limits/);
  for (const w of ['Start a round', 'Stop', 'Run a round every week', 'Improve Tia']) assert.ok(page.includes(`'${w}'`), w);
  assert.equal(resultWords({ proposals: ['a', 'b'], tried: [] }), '2 better versions are waiting in Skills → Proposals');
  assert.equal(resultWords({ proposals: [], tried: [] }), 'No version did better this time');
  const weekly = weeklyWords({ label: 'Paid X', paid: true }, { usd: 1.25 }, 6);
  assert.match(weekly, /on Paid X, about \$1\.25 at most each time \(the cap above\), within your daily limit for paid use/);
  assert.match(weekly, /Off until you switch it on\.$/);
  const flat = (f) => read(f).replace(/\n\s*/g, ' ');
  assert.ok(flat('docs/SKILLS.md').includes(WHAT), 'docs/SKILLS.md says it the same way');
  assert.ok(flat('README.md').includes(WHAT), 'README.md says it the same way');
  assert.match(flat('docs/SKILLS.md'), /counts against your daily limit for paid use/);
  assert.match(read('site/content/changelog.md'), /^- \*\*Improve Tia, by your press\.\*\* .*Her code and her safety rules are never changed by it\. A weekly round is off until you switch it on\.$/m);
  assert.match(read('web/tia.js'), /import\('\.\/tiaimprove\.js'\)\.then\(\(m\) => m\.improveTia\(slot, \{ isAlive \}\)\)/, 'Settings → Tia mounts the part');
});

test('New project\'s two boxes and the project\'s "Fits its technology" say the same words on the page and in the guides', () => {
  const page = read('web/newproject.js');
  const fitWords = 'Add skills that fit its technology: text-only skills from your own and from the reviewed catalog go in by themselves, with Undo; anything else waits for you.';
  assert.ok(page.includes(`export const FIT_WORDS = '${fitWords}'`), 'the box\'s words, exactly');
  assert.ok(page.includes("h('strong', 'Add the New Project skill')"));
  const skills = read('web/skillhub.js');
  assert.ok(skills.includes("'Fits its technology'") && skills.includes("toggle('Add skills that fit this project\\'s technology'"));
  for (const w of ['Already yours', 'Added by itself', 'Waiting for you']) assert.ok(skills.includes(`'${w}'`), w);
  const doc = read('docs/SKILLS.md').replace(/\n\s*/g, ' ');
  assert.ok(doc.includes(`**${fitWords}**`), 'the guide quotes the box');
  for (const w of ['**Already yours**', '**Added by itself**', '**Waiting for you**', '**Fits its technology**', "**Add skills that fit this project's technology**", '`GET /api/skillhub/fit?project=<dir>`', '`POST /api/skillhub/fit/choice`']) assert.ok(doc.includes(w), w);
  const readme = read('README.md').replace(/\n\s*/g, ' ');
  assert.ok(readme.includes('**Add the New Project skill**, ticked; `--no-skill` leaves it out'));
  assert.match(read('site/content/changelog.md'), /^- \*\*Every new project gets the New Project skill, and skills that fit its technology\.\*\*/m);
});
