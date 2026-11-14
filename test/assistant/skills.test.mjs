import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUILTIN_DIR, Skills, formatSkill, parseSkill } from '../../src/assistant/skills.mjs';

const write = (dir, name, text) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text);
};
const skill = (name, desc, tools = 'list_sessions', body = '## Procedure\n1. x') => `---\nname: ${name}\ndescription: ${desc}\nallowed-tools: ${tools}\n---\n${body}\n`;

test('the built-in pack loads cleanly and covers the main jobs', () => {
  const s = new Skills({ dirs: [{ dir: BUILTIN_DIR, source: 'built-in' }] });
  assert.deepEqual(s.problems, []);
  assert.deepEqual(s.all.map((x) => x.name).sort(), ['get-coding-done', 'handle-usage-limit', 'morning-status', 'triage-sessions']);
  for (const x of s.all) for (const h of ['## When to use', '## Procedure', '## Pitfalls', '## Verification', '## Examples']) assert.ok(x.body.includes(h), `${x.name}: ${h}`);
  assert.equal(s.find('fix the failing test in a project')[0].name, 'get-coding-done');
  assert.equal(s.find('a session hit its usage limit')[0].name, 'handle-usage-limit');
  assert.equal(s.find('morning status of my machines')[0].name, 'morning-status');
  assert.equal(s.find('what needs me')[0].name, 'triage-sessions');
});

test('find before create: the owner\'s skill wins over a built-in one of the same name', () => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-owner-'));
  try {
    write(owner, 'morning-status', skill('morning-status', 'My own morning routine.'));
    const s = new Skills({ dirs: [{ dir: owner, source: 'owner' }, { dir: BUILTIN_DIR, source: 'built-in' }] });
    assert.equal(s.get('morning-status').source, 'owner');
    assert.equal(s.get('triage-sessions').source, 'built-in');
    assert.match(s.index(), /- morning-status: My own morning routine\./);
  } finally {
    fs.rmSync(owner, { recursive: true, force: true });
  }
});

test('a skill naming an unknown tool, a wrong name or bad front matter is not loaded', () => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-owner-'));
  try {
    write(owner, 'shell-it', skill('shell-it', 'Runs things.', 'Bash list_sessions'));
    write(owner, 'mismatch', skill('other-name', 'x'));
    write(owner, 'nofront', 'no front matter');
    write(owner, 'ok-one', skill('ok-one', 'Fine.', 'list_sessions, read_session'));
    const s = new Skills({ dirs: [{ dir: owner, source: 'owner' }] });
    assert.deepEqual(s.all.map((x) => x.name), ['ok-one']);
    assert.deepEqual(s.get('ok-one').allowedTools, ['list_sessions', 'read_session']);
    const why = Object.fromEntries(s.problems.map((p) => [p.folder, p.problem]));
    assert.match(why['shell-it'], /unknown tools: Bash/);
    assert.match(why.mismatch, /differs from the folder name/);
    assert.match(why.nofront, /no front matter/);
  } finally {
    fs.rmSync(owner, { recursive: true, force: true });
  }
});

test('YAML list form of allowed-tools; format/parse round trip; save only into the owner folder, never over one', () => {
  const p = parseSkill('---\nname: a-b\ndescription: "Quoted: yes"\nallowed-tools:\n  - list_sessions\n  - read_session\n---\nbody');
  assert.deepEqual(p.allowedTools, ['list_sessions', 'read_session']);
  assert.equal(p.description, 'Quoted: yes');
  const round = parseSkill(formatSkill({ name: 'x-y', description: 'D: "q"', allowedTools: ['get_accounts'], body: 'B' }));
  assert.equal(round.description, 'D: "q"');
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-owner-'));
  try {
    const s = new Skills({ dirs: [{ dir: owner, source: 'owner' }] });
    s.save({ name: 'new-one', description: 'New.', body: '## Procedure\n1.', allowedTools: ['list_sessions'] });
    assert.equal(s.get('new-one').source, 'owner');
    assert.throws(() => s.save({ name: 'new-one', description: 'Again.', body: 'x', allowedTools: ['list_sessions'] }), /EEXIST/);
    const builtinOnly = new Skills({ dirs: [{ dir: BUILTIN_DIR, source: 'built-in' }] });
    assert.throws(() => builtinOnly.save({ name: 'z', description: 'z', body: 'z', allowedTools: ['list_sessions'] }), /no owner skills folder/);
  } finally {
    fs.rmSync(owner, { recursive: true, force: true });
  }
});
