// Roles are files of the product, read strictly; with no decision door wired, the seam leaves the engine as it was.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FILE_TOOLS, ROLES_DIR, ROLE_NAMES, choiceOf, loadRoles, parseRole, takeOf, toolsFor } from '../../src/mission/roles.mjs';
import { mayDo } from '../../src/mission/seam.mjs';

test('the six roles ship as files and read strictly; each says what it is for, may touch, never does and how it is checked', () => {
  const roles = loadRoles();
  assert.deepEqual([...roles.keys()], ROLE_NAMES);
  for (const r of roles.values()) {
    for (const k of ['purpose', 'touch', 'never', 'check', 'text']) assert.ok(r[k], `${r.name}: ${k}`);
    assert.ok(r.allow.every((x) => FILE_TOOLS.includes(x)), `${r.name} has the file tools only: ${r.allow}`);
    assert.ok(['Read', 'Glob', 'Grep'].every((x) => r.allow.includes(x)), `${r.name} may look around in its folder`);
    assert.ok(['Bash', 'WebFetch', 'WebSearch', 'Task'].every((x) => r.deny.includes(x)), `${r.name} names what it never has: a shell, the network, a helper`);
    assert.match(r.text, /When a tool is refused, nobody can allow it/);
    assert.doesNotMatch(r.text, /git commit|Run one command/, `${r.name} is told of no command it cannot run`);
  }
  assert.equal(roles.get('reviewer').readonly, true);
  assert.deepEqual(roles.get('reviewer').allow, ['Read', 'Glob', 'Grep'], 'the reviewer cannot write');
  assert.ok(['Edit', 'Write'].every((x) => roles.get('reviewer').deny.includes(x)));
  for (const n of ['developer', 'tester', 'researcher', 'writer', 'ops']) {
    assert.deepEqual(roles.get(n).allow, [...FILE_TOOLS], n);
    assert.match(roles.get(n).text, /the dashboard itself commits what you changed/, `${n} is told who commits`);
  }
  assert.deepEqual(choiceOf(roles.get('developer')), { model: 'opus', effort: 'medium' }, 'the strong model writes code');
  assert.deepEqual(choiceOf(roles.get('writer')), { model: 'sonnet', effort: 'low' }, 'the fast model runs and records');
  assert.deepEqual(takeOf('tester'), { role: 'tester' });
  assert.deepEqual(takeOf('ai'), { role: 'developer' });
  assert.equal(takeOf('me').role, null, 'the owner\'s own task is never a session\'s');
  assert.match(takeOf('me').his, /only you can do it/);
  assert.equal(takeOf('social').role, null, 'nor one the plan gives to someone she is not');
  assert.equal(takeOf('reviewer').role, null, 'a plan\'s review task is not a work session: the mission reviews every task itself');
});

test('a broken role file is refused: an unknown key, a missing key, a reviewer that may write', () => {
  const good = fs.readFileSync(`${ROLES_DIR}/reviewer/ROLE.md`, 'utf8');
  assert.throws(() => parseRole(good.replace('readonly: yes', 'readonly: yes\nsudo: yes'), 'reviewer'), /unknown key "sudo"/);
  assert.throws(() => parseRole(good.replace(/^check: .*\n/m, ''), 'reviewer'), /has no "check"/);
  assert.throws(() => parseRole(good.replace('allow: Read', 'allow: Write,Read'), 'reviewer'), /may not write/);
  assert.throws(() => parseRole(good.replace('model-code: opus/medium', 'model-code: gpt/medium'), 'reviewer'), /model-code/);
  assert.throws(() => parseRole(good, 'developer'), /names another role/);
});

test('with no decision door the seam answers nothing, so the engine decides as before; a step the item lacks is his', async () => {
  const c = { kind: 'mission-sent-back', mission: 'm-20260101-abcdef', task: 'shop-1', title: 'A task', project: 'shop' };
  for (const door of [null, undefined, 'no']) assert.equal(await mayDo(c, door), null);
  const d = await mayDo(c, async () => ({ act: 'next-provider', by: 'Tia decides' }));
  assert.equal(d.ask, true, 'a task sent back twice has no step but his');
});

test('a role\'s session has its file\'s tools and no other: no test command, no git, whatever is asked for it', () => {
  for (const r of loadRoles().values()) {
    assert.deepEqual(toolsFor(r), r.allow, r.name);
    assert.deepEqual(toolsFor(r, { base: 'a'.repeat(40) }), r.allow, `${r.name}: a review's base adds no tool`);
    assert.ok(!toolsFor(r, ['npm', 'test']).some((x) => /npm|test|Bash/.test(x)), r.name);
  }
});

test('a role file that allows anything but the file tools is refused by name: a shell, a shell line, git, the network, a helper, another server\'s tool', () => {
  const good = fs.readFileSync(`${ROLES_DIR}/developer/ROLE.md`, 'utf8');
  for (const rule of [
    'Bash', 'Bash(git status:*)', 'Bash(git commit -m:*)', 'Bash(git diff)', 'Bash(pwd)', 'Bash(cat:*)', 'Bash(npm test)',
    'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'mcp__github__create_issue', 'Skill', 'PowerShell',
  ]) {
    assert.throws(() => parseRole(good.replace('allow: Read', `allow: ${rule},Read`), 'developer'), /has the file tools only/, rule);
  }
  // The file tools themselves, in any order, are a role.
  assert.deepEqual(parseRole(good.replace(/^allow: .*$/m, 'allow: Write,Read,Edit'), 'developer').allow, ['Write', 'Read', 'Edit']);
});
