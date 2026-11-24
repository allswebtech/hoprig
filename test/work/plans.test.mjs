// Plans (src/work/plans.mjs, planview.mjs): a plan file and its note written and read strictly, a planning tool's own
// files in the plans folder never taken for Work's, tasks put into a plan and taken out, the timeline and what waits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork, write } from './helpers.mjs';

const t = tempWork('work-plans');
test.after(() => t.cleanup());
const P = await import('../../src/work/plans.mjs');
const V = await import('../../src/work/planview.mjs');
const { viewItem } = await import('../../src/work/model.mjs');

const folder = path.join(t.root, 'work');
fs.mkdirSync(folder, { recursive: true });
const place = { folder, label: 'ai_brain/work', file: path.join(folder, 'tasks.json') };
const made = { at: '2026-11-18T09:00:00.000Z', how: 'hand' };
const plan = (over = {}) => ({ v: 1, id: 'faster-site', title: 'Make the site faster', goal: 'The home page loads in two seconds.', projects: ['shop'], milestones: [{ id: 'images', title: 'Images small', date: '2026-12-02' }], note: null, made, status: 'active', ...over });

test('a plan is written atomically and read back strictly; a bad one is refused before anything is written', () => {
  P.writePlan(place, plan(), { projects: ['shop'] });
  const file = path.join(folder, 'plans', 'faster-site.json');
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(plan(), null, 2)}\n`);
  assert.deepEqual(P.readPlan(place, 'faster-site'), plan());
  assert.ok(P.isPlanFile(file));
  // Each rule of the check refuses, and nothing is written.
  const refused = [
    [{ extra: 1 }, /not a field of a plan/],
    [{ goal: 'two\nlines' }, /one line/],
    [{ title: 'ab' }, /3 to 200/],
    [{ title: 'Faster​ site' }, /cannot be seen/],
    [{ projects: ['nope'] }, /not a project of the workspace/],
    [{ milestones: [{ id: 'm', title: 'Images', date: '2026-02-30' }] }, /not a date/],
    [{ milestones: [{ id: 'm', title: 'One', date: null }, { id: 'm', title: 'Two', date: null }] }, /one id/],
    [{ note: 'other.md' }, /note is the Markdown file of its own name/],
    [{ status: 'paused' }, /status is one of/],
    [{ made: { at: 'yesterday', how: 'hand' } }, /when and how/],
  ];
  for (const [over, re] of refused) {
    assert.throws(() => P.writePlan(place, plan({ id: 'refused-one', ...over }), { projects: ['shop'] }), re, JSON.stringify(over));
    assert.equal(fs.existsSync(path.join(folder, 'plans', 'refused-one.json')), false);
  }
});

test('a file that says it is a plan and does not pass is named, a planning tool\'s own files are passed over', () => {
  write(folder, {
    'plans/broken.json': JSON.stringify({ ...plan(), id: 'broken', goal: '' }),
    'plans/other-name.json': JSON.stringify({ ...plan(), id: 'not-its-name' }),
    'plans/roadmap.json': '{"phases":[1,2,3]}', // a planning tool's own
    'plans/launch.md': '# Launch notes\n<b>its own</b>\n', // a planning tool's prose note: no plan names it
    'plans/garbage.json': '{not json',
  });
  const { plans, unreadable } = P.listPlans(place);
  assert.deepEqual(plans.map((p) => p.id), ['faster-site']);
  assert.deepEqual(unreadable.map((u) => u.name), ['broken.json', 'other-name.json']);
  assert.equal(P.isNoteFile(path.join(folder, 'plans', 'launch.md')), false);
  assert.equal(P.readPlan(place, 'broken'), null);
  assert.equal(P.readPlan(place, '../x'), null);
  // A new plan's id: its title and a mark of the moment it is made; never a name a file there has, nor a plan id a task
  // still names.
  const at = '2026-11-18T10:00:00.000Z';
  const id = P.newPlanId(place, 'Launch', { at });
  assert.match(id, /^launch-[0-9a-f]{6}$/);
  assert.notEqual(P.newPlanId(place, 'Launch', { at: '2026-11-18T10:00:00.001Z' }), id, 'another moment, another id');
  fs.writeFileSync(path.join(folder, 'plans', `${id}.md`), '# A planning tool\'s note of that name\n');
  assert.equal(P.newPlanId(place, 'Launch', { at }), `${id}-2`);
  assert.equal(P.newPlanId(place, 'Launch', { at, items: [{ id: 'a', plan: `${id}-2` }] }), `${id}-3`);
  assert.match(P.newPlanId(place, 'वेबसाइट', { at }), /^plan-[0-9a-f]{6}$/);
  assert.match(P.newPlanId(place, 'A very long title that goes on and on beyond forty characters', { at }), /^a-very-long-title-that-goes-on-an-[0-9a-f]{6}$/);
});

test('a link in the plans folder is no plan, and no plan file is written through one', () => {
  const box = path.join(t.root, 'linked');
  fs.mkdirSync(path.join(box, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(t.root, 'outside.json'), `${JSON.stringify({ ...plan(), id: 'evil' }, null, 2)}\n`);
  fs.symlinkSync(path.join(t.root, 'outside.json'), path.join(box, 'plans', 'evil.json'));
  const p2 = { folder: box, label: 'x' };
  assert.equal(P.readPlan(p2, 'evil'), null);
  assert.equal(P.isPlanFile(path.join(box, 'plans', 'evil.json')), false);
  assert.throws(() => P.writePlan(p2, plan({ id: 'evil' }), { projects: ['shop'] }), /not a plain file/);
});

test('a research note: plain Markdown, http and https links only, nothing hidden, no HTML; it is Work\'s only beside its plan', () => {
  const ok = '# Research\n\n- The images are large (`public/img`).\n- See [the guide](https://example.com/guide) and https://example.org.\n\n```html\n<img src="a.png">\n```\n';
  assert.equal(P.checkNoteText(ok), ok.trim());
  const refused = [
    ['Read [this](javascript:alert(1))', /not a web address/, 'link'],
    ['Look at <javascript:alert(1)>', /HTML/, 'html'], // an autolink starts as a tag does
    ['[x]: data:text/html,hi', /not a web address/, 'link'],
    ['A file: [readme](README.md)', /not a web address/, 'link'],
    ['Hidden javascript:void(0) here', /"javascript:"/, 'link'],
    ['Some <script>alert(1)</script> here', /HTML/, 'html'],
    ['An <img src=x onerror=y> here', /HTML/, 'html'],
    ['<!-- a comment -->', /HTML/, 'html'],
    ['Zero​width', /cannot be seen/, 'hidden'],
    ['Turned ‮around', /direction/, null],
    ['x'.repeat(P.NOTE_MAX + 1), /16,000 characters/, 'too-big'],
  ];
  for (const [text, re, code] of refused) {
    assert.throws(() => P.checkNoteText(text), (e) => re.test(e.message) && (code === null || e.details.code === code), text.slice(0, 40));
  }
  const p = plan({ id: 'with-note', note: 'with-note.md' });
  P.writePlan(place, p, { projects: ['shop'] });
  fs.writeFileSync(path.join(folder, 'plans', 'with-note.md'), P.noteText(P.checkNoteText(ok)));
  assert.equal(P.readNote(place, p), ok.trim());
  assert.ok(P.isNoteFile(path.join(folder, 'plans', 'with-note.md')));
  // A note changed by hand to hold HTML is no longer a note of Work's (a save leaves it alone) and is not shown.
  fs.writeFileSync(path.join(folder, 'plans', 'with-note.md'), '<b>bold</b>\n');
  assert.equal(P.isNoteFile(path.join(folder, 'plans', 'with-note.md')), false);
  assert.equal(P.readNote(place, p), null);
  // A note an editor saved with a tab, CRLF line ends or one more final newline is shown, and is Work's for a save too:
  // the page and a save agree on every file.
  fs.writeFileSync(path.join(folder, 'plans', 'with-note.md'), '# Research\r\n\r\n-\tLarge images.\r\n\r\n');
  assert.equal(P.readNote(place, p), '# Research\n\n-    Large images.');
  assert.equal(P.isNoteFile(path.join(folder, 'plans', 'with-note.md')), true);
  assert.equal(P.planFileKind(path.join(folder, 'plans', 'with-note.md')), 'note');
  // A lone carriage return reads differently in different viewers: neither shown nor Work's.
  fs.writeFileSync(path.join(folder, 'plans', 'with-note.md'), '# Research\r- one\n');
  assert.equal(P.readNote(place, p), null);
  assert.equal(P.planFileKind(path.join(folder, 'plans', 'with-note.md')), 'broken');
});

test('a note\'s code is a fenced block whose fence lines start at the first column; nothing else is code', () => {
  // Such a block keeps what is in it out of the checks, with backticks or tildes; a "<" that starts no tag is text.
  for (const ok of [
    '```html\n<img src="a.png">\n```',
    '~~~\n<b>x</b>\n~~~~',
    '````md\n```\n<b>x</b>\n````',
    'Before.\n\n```\n<?x?> <!X> <![CDATA[ y ]]> <!-- z --> </a>\n```\n\n~~~js\nif (a <b) {}\n~~~\n\nAfter.',
    'a < b, <3 and <= are text',
    '- step\n  ```\n  plain\n  ```',
  ]) assert.doesNotThrow(() => P.checkNoteText(ok), ok);
  const refused = [
    ['```x`\n<b>bold</b>', 'html'], // a backtick in the info string: no fence
    ['```\n<b>a</b>\n``` not a close\n```\n<img src=x>', 'html'], // a closing fence has nothing after it
    ['~~~\n<b>a</b>\n```\n<img src=x>', 'fence'], // another fence's marks do not close it: never closed
    ['```\n<b>x</b>', 'fence'], // a fence never closed
    ['\\`<img src=x>`', 'html'],
    ['`one <img src=x>', 'html'],
    // Inline code is no code here: viewers read code spans each in its own way.
    ['Use `<img src=x>` here.', 'html'],
    ['Use ``a ` <b>`` here.', 'html'],
    ['a `b\nc` <img src=x onerror=alert(1)> `d', 'html'], // a code span over a line end
    ['<div\n`<img src=x onerror=alert(1)>`', 'html'],
    ['a <? ` ?> <img src=x onerror=alert(1)> `', 'html'],
    // A processing instruction, a declaration, CDATA and a comment, outside a fence.
    ['Then <?x?> here', 'html'],
    ['Then <!X> here', 'html'],
    ['Then <![CDATA[ x ]]> here', 'html'],
    ['Then <!-- x --> here', 'html'],
    // A fence that is indented, or in a list or a quote, is no fence here.
    ['Steps:\n  ```\n  <i>x</i>\n  ```', 'html'],
    ['- step\n  ```\n  <i>x</i>\n  ```', 'html'],
    ['> ```\n> <i>x</i>\n> ```', 'html'],
    // After such a fence a viewer may be in a block this does not see: a fence at the first column is no code either.
    ['- a\n  ```\n  y\n```\nz\n```\n<img src=x>\n```', 'html'],
    ['x\n\n  ```\ny\n```\n<img src=x>\n```', 'html'],
    // A line that ends the block for some viewers and not for others.
    ['```\nx\n  ```\n<img src=x>\n```', 'fence'],
    ['```\nx\n```~~~\n<img src=x>\n```', 'fence'],
    // A start a viewer of the file reads otherwise: an indented first line (no fence in the file), front matter.
    ['    ```\n<img src=x>\n```', 'html'],
    ['---\n```\n---\n<img src=x>\n```', 'html'],
  ];
  for (const [text, code] of refused) assert.throws(() => P.checkNoteText(text), (e) => e.details.code === code, text);
  // The refusal tells how to write it.
  assert.throws(() => P.checkNoteText('Use `<img src=x>` here.'), /has HTML in it \("<img src=x>` here\."\).*a fenced code block of its own.*at the start of the line.*write &lt; for the "<"/);
});

test('an HTML tag is refused wherever it starts, also where a backtick stands in or after it', () => {
  for (const text of [
    'See <img src="https://track.example/p.png?project=shop" alt="`"> and `x`.',
    'Read <a title="`" href="javascript:alert(document.cookie)">the report`',
    'The report: <a title="`" href="javascript:alert(document.cookie)">open it`\n\nLogo <img src="https://track.example/p.png?project=shop" alt="`"> here`.',
    'x <img src=x onerror="fetch(1)" title="`"> y`',
    'x <img src=x onerror="fetch(1)"\ntitle="`"> y`',
    'x <img src=x onerror=alert(1) alt="<"> y',
    'x </a\n> y',
    '`<a href="`">`',
    'if x <y and `z>`',
    'x <a\n\nhref="`">`',
    'See <https://example.org/`x`> now.',
    '<https://example.com>',
  ]) assert.throws(() => P.checkNoteText(text), (e) => e.details.code === 'html' && /has HTML in it/.test(e.message), text);
  assert.doesNotThrow(() => P.checkNoteText('a < b and `c > d`'));
  // A long line is read quickly (no slow backtracking).
  const started = performance.now();
  for (const text of ['x' + ' '.repeat(15000), 'x\n' + ' '.repeat(15000) + 'y', 'x\n' + '- '.repeat(7000), 'x\n' + '1. '.repeat(5000), 'x\n' + '>'.repeat(15000), `[&${'a'.repeat(15000)}](https://example.com/)`]) P.checkNoteText(text);
  assert.ok(performance.now() - started < 2000, 'quickly');
});

test('a link whose words show a web address leads to that address\'s site, so a viewer of the repository is not misled', () => {
  for (const ok of ['[https://example.com/a](https://example.com/b)', '[www.example.com](https://example.com/)', '[README.md](https://example.com/x/README.md)', '[the guide](https://example.com/guide)', 'See https://example.com plainly.']) {
    assert.doesNotThrow(() => P.checkNoteText(ok), ok);
  }
  for (const text of [
    '[https://bank.example/login](https://evil.example/login)',
    '[www.bank.example](https://evil.example)',
    '[log in at https://bank.example](https://evil.example)',
    '[https://bank.example [secure]](https://evil.example)',
    'Go to [https://bank.example][r].\n\n[r]: https://evil.example',
    'Go to [https://bank.example].\n\n[https://bank.example]: https://evil.example',
  ]) assert.throws(() => P.checkNoteText(text), (e) => e.details.code === 'link' && /another address/.test(e.message), text);
});

test('a link\'s words are read as a viewer shows them: a code span, an escape or emphasis hides no address', () => {
  for (const text of [
    '[`https://bank.example/`](https://evil.example/)',
    '[`https://bank.example/\n`](https://evil.example/)',
    '[https\\://bank.example/](https://evil.example/)',
    '[https://bank\\.example/](https://evil.example/)',
    '[http**s**://bank.example/](https://evil.example/)',
    '[_https://bank.example/_](https://evil.example/)',
    'x `a\nb` [https://bank.example/](https://evil.example/) `', // a code span over a line end hides no link
    '`[https://bank.example](https://evil.example)`', // inline code is no code here: a link in it is read
  ]) assert.throws(() => P.checkNoteText(text), (e) => e.details.code === 'link' && /show another address than the one it leads to \("(https:\/\/|www\.)bank\.example/.test(e.message), text);
  for (const ok of ['[https://my_host.example/](https://my_host.example/a)', '[` https://example.com `](https://example.com/x)']) {
    assert.doesNotThrow(() => P.checkNoteText(ok), ok);
  }
});

test('a link\'s words hold no entity: a character written by its name or number is refused, in plain text it is kept', () => {
  for (const text of [
    '[https&#58;//bank.example/](https://evil.example/)',
    '[https&#x3A;//bank.example/](https://evil.example/)',
    '[https&colon;//bank.example/](https://evil.example/)',
    '[www&#46;bank.example](https://evil.example/)',
    '[`https&#58;//bank.example`](https://evil.example/)',
    // An invisible character written as an entity.
    '[https:&#8203;//bank.example/](https://evil.example/)',
    '[https:&ZeroWidthSpace;//bank.example/](https://evil.example/)',
    '[https:/&shy;/bank.example/](https://evil.example/)',
    '[https:&#x2060;//bank.example/](https://evil.example/)',
    '[www&#8203;.bank.example](https://evil.example/)',
    '[Fish &amp; chips](https://example.com/menu)',
    'Go to [our&#8203;shop][r].\n\n[r]: https://example.com/',
  ]) assert.throws(() => P.checkNoteText(text), (e) => e.details.code === 'link' && /by its name or number \("&[#A-Za-z0-9]+;"\): write the character itself/.test(e.message), text);
  for (const ok of ['A word&#8203;break, fish &amp; chips, https&#58;//bank.example in plain text', '[Fish & chips](https://example.com/menu)']) {
    assert.doesNotThrow(() => P.checkNoteText(ok), ok);
  }
});

test('tasks go into a plan and come out; what they wait for is checked, and a ring is refused', () => {
  const doc = { items: [
    { id: 'measure', title: 'Measure it', status: 'open' },
    { id: 'shrink', title: 'Shrink the images', status: 'open' },
    { id: 'approve', title: 'Approve them', status: 'open' },
  ] };
  const p = plan();
  P.putInPlan(doc, 'shrink', { plan: p, milestone: 'images', after: ['measure'] });
  P.putInPlan(doc, 'approve', { plan: p, milestone: null, after: ['shrink'] });
  assert.deepEqual(doc.items[1], { id: 'shrink', title: 'Shrink the images', status: 'open', plan: 'faster-site', milestone: 'images', after: ['measure'] });
  assert.throws(() => P.putInPlan(doc, 'measure', { plan: p, after: ['approve'] }), /wait for each other for ever: measure → approve → shrink → measure/);
  assert.throws(() => P.putInPlan(doc, 'measure', { plan: p, after: ['measure'] }), /does not wait for itself/);
  assert.throws(() => P.putInPlan(doc, 'measure', { plan: p, after: ['nope'] }), /not a task of the list/);
  assert.throws(() => P.putInPlan(doc, 'measure', { plan: p, milestone: 'other' }), /not a milestone of this plan/);
  assert.equal(doc.items[0].plan, undefined, 'a refused change changed nothing');
  P.takeOutOfPlan(doc, 'approve');
  assert.deepEqual(doc.items[2], { id: 'approve', title: 'Approve them', status: 'open', after: ['shrink'] });
  assert.throws(() => P.takeOutOfPlan(doc, 'approve'), /in no plan/);
});

test('a plan\'s view: milestones with their tasks in order, progress, the next date, what waits, the timeline by week', () => {
  const raw = [
    { id: 'measure', title: 'Measure it', status: 'done', date: '2026-11-20', plan: 'faster-site', milestone: 'images', doneAt: '2026-11-19' },
    { id: 'shrink', title: 'Shrink the images', status: 'open', date: '2026-11-26', plan: 'faster-site', milestone: 'images', after: ['measure'] },
    { id: 'approve', title: 'Approve them', status: 'open', date: '2026-11-25', plan: 'faster-site', after: ['shrink'], by: 'me' },
    { id: 'later', title: 'Write it up', status: 'open', date: null, plan: 'faster-site', milestone: 'images' },
    { id: 'gone', title: 'Old idea', status: 'dropped', date: '2027-03-01', plan: 'faster-site' },
    { id: 'other', title: 'Not in it', status: 'open', date: '2026-11-21' },
  ];
  const items = raw.map((x, at) => viewItem(x, { today: '2026-11-21', at }));
  const v = V.planView(plan(), items, '2026-11-21');
  assert.deepEqual(v.milestones[0].tasks.map((x) => x.id), ['measure', 'shrink', 'later']);
  assert.deepEqual(v.loose.map((x) => x.id), ['approve', 'gone']);
  assert.deepEqual(v.progress, { done: 1, all: 4 });
  assert.equal(v.next, '2026-11-25');
  assert.deepEqual(v.milestones[0].tasks[1].waits, [], 'measure is done: shrink waits for nothing');
  assert.deepEqual(v.loose[0].waits.map((w) => w.id), ['shrink'], 'approve waits for shrink');
  const weeks = v.timeline.weeks;
  assert.deepEqual(weeks.map((w) => w.start), ['2026-11-16', '2026-11-23', '2026-11-30', '2027-03-01']);
  assert.deepEqual(weeks[1].entries.map((e) => e.id), ['approve', 'shrink']);
  assert.equal(weeks[2].entries[0].kind, 'milestone');
  assert.equal(weeks[3].gap, 12);
  assert.ok(weeks[0].now);
  assert.deepEqual(v.timeline.undated.map((e) => e.id), ['later']);
  assert.deepEqual(weeks[1].entries.map((e) => [e.id, e.late]), [['approve', false], ['shrink', false]]);
  // Later: today in a week with nothing due is listed all the same (past and future split plainly), an open task
  // whose date is past is late, and a milestone without a date is in the row of what has no date.
  const later = V.planView({ ...plan(), milestones: [...plan().milestones, { id: 'someday', title: 'Someday', date: null }] }, items, '2026-12-09');
  const lw = later.timeline.weeks;
  assert.deepEqual(lw.map((w) => [w.start, w.gap, w.now, w.entries.length]), [['2026-11-16', 0, false, 1], ['2026-11-23', 0, false, 2], ['2026-11-30', 0, false, 1], ['2026-12-07', 0, true, 0], ['2027-03-01', 11, false, 1]]);
  assert.deepEqual(lw[1].entries.map((e) => [e.id, e.late]), [['approve', true], ['shrink', true]]);
  assert.equal(lw[0].entries.find((e) => e.id === 'measure').late, false, 'a done task is never late');
  assert.deepEqual(later.timeline.undated.map((e) => [e.kind, e.id]), [['task', 'later'], ['milestone', 'someday']]);
  // Today before or after every date: its week comes first or last.
  assert.deepEqual(V.planView(plan(), items, '2026-11-02').timeline.weeks.slice(0, 2).map((w) => [w.start, w.now, w.gap]), [['2026-11-02', true, 0], ['2026-11-16', false, 1]]);
  assert.deepEqual(V.planView(plan(), items, '2027-03-20').timeline.weeks.slice(-2).map((w) => [w.start, w.now, w.gap]), [['2027-03-01', false, 12], ['2027-03-15', true, 1]]);
  // The list's view of every item says what it waits for too.
  const waits = V.withWaits(items).find((x) => x.id === 'approve').waits;
  assert.equal(waits[0].title, 'Shrink the images');
});
