// `hoprig skills update` and the Hoprig skill that comes with Hoprig: a newer bundled skill (the next version of Hoprig)
// reaches the copy installed from an older one, with the diff shown and a yes; Undo goes back; a copy the owner edited
// is never replaced without "--overwrite-local". No network: the bundled skill is copied from this package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fakeUi, sandbox } from './helpers.mjs';

const box = sandbox('skills-bundled');
test.after(() => box.cleanup());
const hub = await import('../../src/skillhub/hub.mjs');
const { recordFile } = await import('../../src/skillhub/store.mjs');
const { sha256 } = await import('../../src/skillhub/store.mjs');
const cli = await import('../../src/skillhub/cli.mjs');
const { PACKAGE_ROOT } = await import('../../src/skillhub/catalog.mjs');

const skills = path.join(box.claude, 'skills');
const installed = path.join(skills, 'hoprig');
const bundled = fs.readFileSync(path.join(PACKAGE_ROOT, 'templates/skills/hoprig/SKILL.md'), 'utf8');
const OLD = bundled.replace(/^## Never$/m, '## Never (as an older Hoprig said it)');

/** Make the installed copy look like the one an older Hoprig installed: its text, and its record. */
function makeOlder({ edited = false } = {}) {
  fs.writeFileSync(path.join(installed, 'SKILL.md'), OLD);
  const file = recordFile(skills); // the person's own skills: Hoprig's state folder
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rec = m.skills.hoprig;
  rec.files['SKILL.md'] = sha256(Buffer.from(OLD));
  rec.source.version = '0.0.1';
  fs.writeFileSync(file, JSON.stringify(m));
  if (edited) fs.appendFileSync(path.join(installed, 'SKILL.md'), '\nMy own line.\n');
}

// The tools a skill needs are asked of npm (their newest version, from the registry): the test hands in the answer, as
// the dashboard's feature tests do, so no registry is asked.
const toolRun = async () => ({ ok: true, code: 0, stdout: '1.0.0\n', stderr: '' });
const run = async (args, answers = []) => {
  const ui = fakeUi(answers);
  const code = await cli.main('skills', args, { ui, toolRun });
  return { code, text: ui.said.join('\n'), asked: ui.asked };
};

test('the bundled skill installs with its reference folder', async () => {
  const review = await hub.prepare('hoprig');
  hub.approve(review.id);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), bundled);
  assert.ok(fs.existsSync(path.join(installed, 'references', 'commands.md')));
  assert.equal((await hub.checkUpdates({}, { only: 'hoprig' }))[0].state, 'current');
});

test('a newer bundled skill: update available, the diff shown, installed on a yes, and Undo goes back', async () => {
  makeOlder();
  const check = await run(['update', 'hoprig', '--check']);
  assert.equal(check.code, 0);
  assert.match(check.text, /hoprig: update available/);
  assert.doesNotMatch(check.text, /EDITED HERE/);
  // A "no" changes nothing.
  const no = await run(['update', 'hoprig'], [false]);
  assert.equal(no.asked.length, 1);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), OLD);
  const yes = await run(['update', 'hoprig'], [true]);
  assert.equal(yes.code, 0, yes.text);
  assert.match(yes.text, /bundled with Hoprig/);
  assert.match(yes.text, /^\s*-## Never \(as an older Hoprig said it\)$/m);
  assert.match(yes.text, /^\s*\+## Never$/m);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), bundled);
  assert.equal((await hub.checkUpdates({}, { only: 'hoprig' }))[0].state, 'current');
  const undo = await run(['undo', 'hoprig']);
  assert.equal(undo.code, 0);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), OLD);
  // Forward again.
  assert.equal((await run(['undo', 'hoprig'])).code, 0);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), bundled);
});

test('a copy the owner edited is not replaced, even on a yes, until --overwrite-local; Undo brings the edit back', async () => {
  makeOlder({ edited: true });
  const editedText = fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
  const check = await run(['update', 'hoprig', '--check']);
  assert.match(check.text, /EDITED HERE: changed SKILL\.md/);
  const yes = await run(['update', 'hoprig'], [true, true]);
  assert.notEqual(yes.code, 0);
  assert.match(yes.text, /edited here/i);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), editedText, 'the edited copy stays');
  const forced = await run(['update', 'hoprig', '--overwrite-local'], [true, true]);
  assert.equal(forced.code, 0, forced.text);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), bundled);
  assert.equal((await run(['undo', 'hoprig'])).code, 0);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), editedText, 'the edited version was kept for undo');
});

test('from an older install of SKILL.md alone, the change to SKILL.md and the owner\'s edit are shown, not sunk below the new file', async () => {
  // What Hoprig installed before the skill had a references folder: SKILL.md only; the owner then added a line.
  fs.rmSync(path.join(installed, 'references'), { recursive: true, force: true });
  fs.writeFileSync(path.join(installed, 'SKILL.md'), `${OLD}\nMy own line.\n`);
  const file = recordFile(skills); // the person's own skills: Hoprig's state folder
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.skills.hoprig.files = { 'SKILL.md': sha256(Buffer.from(OLD)) };
  m.skills.hoprig.source.version = '0.0.1';
  fs.writeFileSync(file, JSON.stringify(m));
  const before = fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
  const r = await run(['update', 'hoprig', '--overwrite-local'], [false, false]);
  const diff = r.text.slice(r.text.indexOf('What changed:'), r.text.indexOf('----- SKILL.md'));
  assert.match(diff, /\*\*\* changed: SKILL\.md/);
  assert.match(diff, /^\s*-My own line\.$/m, 'the line the update takes away is shown');
  assert.match(diff, /^\s*-## Never \(as an older Hoprig said it\)$/m);
  assert.match(diff, /\+\+\+ added: references\/commands\.md/);
  assert.ok(diff.indexOf('changed: SKILL.md') < diff.indexOf('added: references/commands.md'));
  assert.match(diff, /… \d+ more lines of references\/commands\.md/);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), before, 'a "no" changes nothing');
});
