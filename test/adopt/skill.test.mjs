// The skill adopt-projects stops where the owner decides: after the look (which projects, and not one he still works
// in) and between the dry run and the real apply (a second yes, after he has seen the dry run's lines).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const text = fs.readFileSync(new URL('../../skills/adopt-projects/SKILL.md', import.meta.url), 'utf8');
const step = (n) => {
  const m = new RegExp(`\\n${n}\\. \\*\\*[\\s\\S]*?(?=\\n\\d+\\. \\*\\*|$)`).exec(text);
  assert.ok(m, `step ${n}`);
  return m[0].replace(/\s+/g, ' ');
};

test('after the look the session waits for his choice before any plan', () => {
  assert.match(step(2), /wait for his answer\*\*: do not plan a project he has not chosen, or one he is still working in/);
});

test('the dry run is shown and a second yes comes before the real apply', () => {
  const s = step(5);
  const dry = s.indexOf('--dry-run');
  const yes = s.indexOf('wait for his answer');
  const real = s.indexOf('`hoprig adopt apply <name> --name');
  assert.ok(dry >= 0 && yes > dry && real > yes, s);
  assert.match(s, /show him its lines/);
});
