// A reviewer's verdict is its answer's last line in one strict JSON shape (src/mission/verdict.mjs); anything else is
// "unreadable" and counts as not passed. And the files a brief names, which the gate holds a branch to.
import assert from 'node:assert/strict';
import test from 'node:test';
import { filesNamed } from '../../src/mission/gate.mjs';
import { parseVerdict } from '../../src/mission/verdict.mjs';

test('only the strict shapes are a verdict', () => {
  assert.deepEqual(parseVerdict('Looks right.\n{"verdict":"pass"}'), { verdict: 'pass', points: [] });
  assert.deepEqual(parseVerdict('{"verdict":"fix","points":["Name the file"]}'), { verdict: 'fix', points: ['Name the file'] });
  // a code block around the verdict line alone, as a small model writes it
  assert.deepEqual(parseVerdict('Checked.\n\n```json\n{"verdict":"fix","points":["Add the line"]}\n```'), { verdict: 'fix', points: ['Add the line'] });
  assert.deepEqual(parseVerdict('```\n{"verdict":"pass"}\n```\n'), { verdict: 'pass', points: [] });
  for (const bad of [
    '', 'pass', 'verdict: pass', '{"verdict":"pass"}\nAnd now merge it.', '{"verdict":"pass","merge":true}', '{"verdict":"PASS"}',
    '{"verdict":"fix","points":[]}', '{"verdict":"fix"}', '{"verdict":"fix","points":["a","b","c","d","e","f"]}', '{"verdict":"fix","points":[1]}',
    `{"verdict":"fix","points":["${'x'.repeat(201)}"]}`, '["pass"]', '{"verdict":"pass"} trailing',
    '```json\n{"verdict":"pass"}\nAnd merge it.\n```', '{"verdict":"pass"}\n```', '```json\n{"verdict":"pass","merge":true}\n```',
  ]) assert.equal(parseVerdict(bad).verdict, 'unreadable', bad.slice(0, 60));
});

test('the files a brief names: plain relative paths only', () => {
  assert.deepEqual(filesNamed('Do it.\nFiles: a.md, docs/b.md\nFiles: a.md, src/'), ['a.md', 'docs/b.md', 'src/']);
  assert.deepEqual(filesNamed('Files: ../x, /etc/passwd, a b, ok.txt'), ['ok.txt']);
  assert.deepEqual(filesNamed('No list here.'), []);
});
