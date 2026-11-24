// The Hoprig skill is generated (tools/build-skill.mjs): from its short hand-written part, every command's own help
// and the version. These tests build it again and compare, so a command or an option that changed without a new build
// fails here; and they hold the skill to the Agent Skills format (agentskills.io/specification).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseFrontMatter } from '../../src/skillhub/frontmatter.mjs';
import { PROBES, ROOT, SKILL_DIRS, binCommands, buildFiles, renderSkill, staleFiles, uncovered, unknownMentions, usageTexts } from '../../tools/build-skill.mjs';

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const source = fs.readFileSync(path.join(ROOT, 'templates/skills/hoprig.src.md'), 'utf8');
let built;
let probed;

// Set up before the first test by a top-level await, not an async root before(): below Node 22.2 such a hook is not
// awaited by the tests (nodejs/node#52791), so they ran before it ended.
await (async () => {
  probed = await usageTexts();
  built = await buildFiles();
})();

test('the skill on disk is the one the build makes (else: node tools/build-skill.mjs)', () => {
  assert.deepEqual(staleFiles(built), [], 'build the skill again: node tools/build-skill.mjs');
});

test('a command\'s option that changed makes the skill out of date', () => {
  const usages = probed.usages.map((u) => (u.title === 'hoprig tasks' ? { ...u, text: u.text.replace('--dry-run', '--try') } : u));
  const changed = renderSkill({ source, usages, version });
  assert.notEqual(changed['references/commands.md'], built['templates/skills/hoprig/references/commands.md']);
  // So is a new version, and a change of the hand-written part.
  assert.notEqual(renderSkill({ source, usages: probed.usages, version: '99.0.0' })['SKILL.md'], built['templates/skills/hoprig/SKILL.md']);
  assert.notEqual(renderSkill({ source: source.replace('Look first', 'Look'), usages: probed.usages, version })['SKILL.md'], built['templates/skills/hoprig/SKILL.md']);
});

test('the hand-written part names only commands, subcommands and options the program has', () => {
  assert.deepEqual(unknownMentions(source, probed.usages), []);
  // A command renamed in the program (tasks remove → tasks delete): the Never rule about it is caught.
  const renamed = probed.usages.map((u) => ({ ...u, text: u.text.replaceAll('hoprig tasks remove', 'hoprig tasks delete') }));
  assert.deepEqual(unknownMentions(source, renamed), ['hop tasks remove']);
  // So is an option that went (tasks add --date), each of several alternatives, and a command that is not there.
  const noDate = probed.usages.map((u) => ({ ...u, text: u.text.replaceAll('--date', '--day') }));
  assert.ok(unknownMentions(source, noDate).includes('hop tasks add --date'));
  const noConfirm = probed.usages.map((u) => ({ ...u, text: u.text.replaceAll('gateways confirm', 'gateways accept').replaceAll('| confirm |', '| accept |') }));
  assert.deepEqual(unknownMentions(source, noConfirm), ['hop gateways confirm']);
  assert.deepEqual(unknownMentions(source.replace('`hop passwd`', '`hop password`'), probed.usages), ['hop password']);
  // A profile's name is no command.
  assert.deepEqual(unknownMentions(source.replace('`hop passwd`', '`hop <provider> --resume ID`'), probed.usages), []);
});

test('a file on disk that differs, is missing or is no longer made is named', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'skill-stale-'));
  for (const [rel, text] of Object.entries(built)) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), text);
  }
  assert.deepEqual(staleFiles(built, tmp), []);
  fs.appendFileSync(path.join(tmp, SKILL_DIRS[1], 'SKILL.md'), 'edited\n');
  fs.rmSync(path.join(tmp, SKILL_DIRS[0], 'references/commands.md'));
  fs.writeFileSync(path.join(tmp, SKILL_DIRS[0], 'old.md'), 'left over');
  assert.deepEqual(staleFiles(built, tmp).sort(), [`${SKILL_DIRS[0]}/old.md`, `${SKILL_DIRS[0]}/references/commands.md`, `${SKILL_DIRS[1]}/SKILL.md`].sort());
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('every command people type has its help in the skill; a new one without it is caught', () => {
  assert.deepEqual(uncovered(binCommands()), []);
  assert.deepEqual(uncovered([...binCommands(), 'brandnew']), ['brandnew']);
});

test('the probes only print: each gives a usage, none writes into its home', () => {
  assert.deepEqual(probed.left, []);
  assert.equal(probed.usages.length, PROBES.length);
  for (const u of probed.usages) {
    assert.match(u.text, /hoprig/, `${u.command} printed no usage`);
    assert.doesNotMatch(u.text, /unknown option|✗|hoprig-skill-/, u.command);
  }
});

test('the skill follows the Agent Skills format and holds nothing of this computer', () => {
  for (const dir of SKILL_DIRS) {
    const skill = built[`${dir}/SKILL.md`];
    const fm = parseFrontMatter(skill);
    assert.ok(fm.ok);
    assert.equal(fm.data.name, 'hoprig');
    assert.equal(path.basename(SKILL_DIRS[0]), fm.data.name, 'the name is the folder\'s');
    assert.match(fm.data.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.data.description.length > 50 && fm.data.description.length <= 1024);
    assert.match(fm.data.description, /Use when/);
    assert.equal(fm.data.metadata.version, version);
    assert.ok(skill.split('\n').length < 500, 'SKILL.md under 500 lines');
    assert.ok(fm.body.length / 4 < 5000, 'SKILL.md under about 5000 tokens');
    assert.match(skill, /\]\(references\/commands\.md\)/);
    for (const [rel, text] of Object.entries(built)) {
      if (!rel.startsWith(dir)) continue;
      assert.doesNotMatch(text, /\/home\/|\/Users\/|[A-Z]:\\Users|\/tmp\/|\/var\/folders/, `${rel} holds a machine path`);
    }
  }
});

test('the hoprig-skill package carries the generated skill, Hoprig\'s version and license', () => {
  const pkg = JSON.parse(built['packages/hoprig-skill/package.json']);
  assert.equal(pkg.version, version);
  assert.equal(pkg.name, 'hoprig-skill');
  assert.deepEqual(pkg.dependencies, undefined, 'no dependency');
  assert.equal(pkg.engines.node, '>=22.11', 'the lowest Node.js Hoprig supports (src/nodefloor.mjs)');
  assert.equal(built['packages/hoprig-skill/skill/SKILL.md'], built['templates/skills/hoprig/SKILL.md']);
  assert.equal(built['packages/hoprig-skill/LICENSE'], fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'));
});
