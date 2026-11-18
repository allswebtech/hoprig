// The item model: read tolerantly, checked strictly on a write, keys kept where they are, the planning tool's file
// spoken in its own words, and Today worked out from the items.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FIXTURE } from './helpers.mjs';
import { addItem, checkBrief, editItem, withoutHidden, likelyOwnerId, needsOwnerId, removeItem, setKey, setStatus, todayIn, viewItem, rawItems, plannerShape } from '../../src/work/model.mjs';
import { todayView } from '../../src/work/today.mjs';

const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const ctx = { today: '2026-11-17', ownerId: 'alex', projects: ['shop', 'blog'] };

test('a planning-tool item reads as Work: owner as who, own items removable, unknown values plain', () => {
  const items = rawItems(fixture()).map((x) => viewItem(x, ctx));
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by['trial-ends'].by, 'me', 'the owner id reads as "me"');
  assert.equal(by['tm-filing'].by, 'lawyer');
  assert.equal(by['npm-pub'].by, 'ai');
  assert.equal(by['call-a003'].removable, true);
  assert.equal(by['trial-ends'].removable, false, 'made from a plan note');
  assert.equal(by['tm-filing'].removable, false, 'no source: from a plan');
  assert.equal(by['partner-demo'].days, -5);
  assert.equal(by['call-a003'].date, null);
  assert.equal(by['call-a003'].note, 'Ask which screens they tested.\nThen book the next call.');
  assert.equal(by['old-quote'].doneAt, '2026-11-12');
  const odd = viewItem({ id: 'x-1', title: 5, status: 'someday', kind: 'idea', date: '2026-02-30', priority: 'urgent' }, ctx);
  assert.deepEqual([odd.title, odd.status, odd.kind, odd.date, odd.priority], ['x-1', 'open', 'task', null, 'normal']);
});

test('a write is checked strictly: each bad value is refused and nothing changes', () => {
  const doc = fixture();
  const before = JSON.stringify(doc);
  const refuse = (fn, re) => {
    assert.throws(fn, (e) => e.status === 400 && re.test(e.message), re.source);
    assert.equal(JSON.stringify(doc), before, 'nothing changed');
  };
  refuse(() => addItem(doc, { title: 'ok' }, ctx), /3 to 200/);
  refuse(() => addItem(doc, { title: 'x'.repeat(201) }, ctx), /3 to 200/);
  refuse(() => addItem(doc, { title: 'two\nlines' }, ctx), /one line/);
  refuse(() => addItem(doc, { date: '2026-11-20' }, ctx), /needs a title/);
  refuse(() => addItem(doc, { title: 'Fine title', date: '2026-02-30' }, ctx), /not a date/);
  refuse(() => addItem(doc, { title: 'Fine title', date: '20.11.2026' }, ctx), /not a date/);
  refuse(() => addItem(doc, { title: 'Fine title', priority: 'urgent' }, ctx), /priority/);
  refuse(() => addItem(doc, { title: 'Fine title', kind: 'idea' }, ctx), /kind/);
  refuse(() => addItem(doc, { title: 'Fine title', by: 'Somebody Else' }, ctx), /who does it/);
  refuse(() => addItem(doc, { title: 'Fine title', project: 'elsewhere' }, ctx), /not a project of the workspace/);
  refuse(() => addItem(doc, { title: 'Fine title', project: '../etc' }, ctx), /folder name/);
  refuse(() => addItem(doc, { title: 'Fine title', note: 'n'.repeat(2001) }, ctx), /2000/);
  refuse(() => addItem(doc, { title: 'Fine title', approx: 'yes' }, ctx), /true or false/);
  refuse(() => addItem(doc, { title: 'Fine title', status: 'done' }, ctx), /not a field/);
  refuse(() => addItem(doc, { title: 'Fine title', id: 'chosen' }, ctx), /not a field/);
  refuse(() => addItem(doc, { title: 'Fine title', source: 'alex' }, ctx), /not a field/);
  refuse(() => editItem(doc, 'call-a003', {}, ctx), /nothing to change/);
  refuse(() => editItem(doc, 'call-a003', { status: 'later' }, ctx), /status/);
  refuse(() => editItem(doc, 'call-a003', { title: null }, ctx), /title must be text/);
  refuse(() => editItem(doc, '../x', { title: 'Fine title' }, ctx), /not an item id/);
  assert.throws(() => editItem(doc, 'no-such', { title: 'Fine title' }, ctx), (e) => e.status === 404);
  assert.throws(() => setStatus(doc, 'call-a003', 'open', ctx), (e) => e.status === 409, 'already open');
  assert.throws(() => setStatus(doc, 'call-a003', 'finished', ctx), (e) => e.status === 400);
  assert.equal(JSON.stringify(doc), before);
});

test('titles and notes refuse control characters and direction marks; a line break in a note stays', () => {
  const doc = { items: [] };
  for (const [input, re] of [
    [{ title: 'Bell\u0007 rings' }, /control character/],
    [{ title: 'Pay \u202Eevil' }, /direction/],
    [{ title: 'Isolate \u2066x\u2069 here' }, /direction/],
    [{ title: 'Escape \u001b[31m red' }, /control character/],
    [{ title: 'A tab\tinside' }, /control character/],
    [{ title: 'Line\u2028separator' }, /line separator/],
    [{ title: 'Fine title', note: 'with \u0000 a null' }, /note has a control character/],
    [{ title: 'Fine title', note: 'turned \u202Daround' }, /note has a mark that turns/],
  ]) assert.throws(() => addItem(doc, input, ctx), (e) => e.status === 400 && re.test(e.message), JSON.stringify(input));
  assert.equal(doc.items.length, 0);
  const ok = addItem(doc, { title: 'Plain words, über and 東京', note: 'first line\r\nsecond line' }, ctx);
  assert.equal(ok.note, 'first line\nsecond line');
  assert.throws(() => editItem(doc, ok.id, { title: 'Now \u200Fwith a mark' }, ctx), /direction/);
});

test('an item from a plan can be dropped but not removed; one the owner added can be removed', () => {
  const doc = fixture();
  assert.throws(() => removeItem(doc, 'trial-ends', ctx), (e) => e.status === 409 && /plan \(plan-2026\.md\).*drop it/.test(e.message));
  assert.throws(() => removeItem(doc, 'tm-filing', ctx), (e) => e.status === 409);
  const r = setStatus(doc, 'trial-ends', 'drop', ctx);
  assert.equal(r.item.status, 'dropped');
  assert.equal(r.before, 'open');
  const gone = removeItem(doc, 'call-a003', ctx);
  assert.equal(gone.id, 'call-a003');
  assert.ok(!doc.items.some((x) => x.id === 'call-a003'));
});

test('done sets doneAt to today, any other status takes it away; the keys stay in their places', () => {
  const doc = fixture();
  const keysBefore = Object.keys(doc.items.find((x) => x.id === 'invoice-a002'));
  setStatus(doc, 'invoice-a002', 'done', ctx);
  const it = doc.items.find((x) => x.id === 'invoice-a002');
  assert.equal(it.doneAt, '2026-11-17');
  // doneAt goes after created and before the keys Work does not know, which keep their order.
  assert.deepEqual(Object.keys(it), ['id', 'date', 'approx', 'title', 'brands', 'kind', 'owner', 'status', 'source', 'note', 'client', 'created', 'doneAt', 'x-color', 'flags']);
  // A planning tool's file knows open, done and dropped, and counts only "open" as open work: waiting is written
  // as status "open" with Work's own key `state`, which Work reads back as the status.
  setStatus(doc, 'invoice-a002', 'waiting', ctx);
  assert.equal('doneAt' in it, false);
  assert.equal(it.status, 'open');
  assert.equal(it.state, 'waiting');
  assert.equal(viewItem(it, ctx).status, 'waiting');
  assert.deepEqual(Object.keys(it), [...keysBefore.slice(0, keysBefore.indexOf('status') + 1), 'state', ...keysBefore.slice(keysBefore.indexOf('status') + 1)]);
  for (const st of ['doing', 'review']) {
    setStatus(doc, 'invoice-a002', st, ctx);
    assert.deepEqual([it.status, it.state, viewItem(it, ctx).status], ['open', st, st]);
  }
  setStatus(doc, 'invoice-a002', 'open', ctx);
  assert.deepEqual(Object.keys(it), keysBefore, 'back to open: Work\'s key goes again');
  setStatus(doc, 'invoice-a002', 'dropped', ctx);
  assert.deepEqual([it.status, 'state' in it], ['dropped', false]);
  // In a Work file the status is written as it is.
  const own = { items: [{ id: 'a', title: 'Mine', by: 'me', status: 'open' }] };
  setStatus(own, 'a', 'waiting', ctx);
  assert.deepEqual(own.items[0], { id: 'a', title: 'Mine', by: 'me', status: 'waiting' });
});

test('a planning tool\'s file that does not use the owner\'s id yet: no word for "me" is written into it', () => {
  const doc = fixture();
  assert.equal(likelyOwnerId(doc), 'alex', 'the id it uses most');
  assert.equal(needsOwnerId(doc, 'me'), true);
  assert.equal(needsOwnerId(doc, 'alex'), false);
  const before = JSON.stringify(doc);
  assert.throws(() => addItem(doc, { title: 'Renew the domain' }, { ...ctx, ownerId: 'me' }), (e) => e.status === 409 && e.code === 'owner-id');
  assert.throws(() => editItem(doc, 'call-a003', { by: 'me' }, { ...ctx, ownerId: 'me' }), (e) => e.code === 'owner-id');
  assert.equal(JSON.stringify(doc), before, 'nothing changed');
  setStatus(doc, 'call-a003', 'done', { ...ctx, ownerId: 'me' }); // a status writes no word for "me"
  assert.equal(doc.items.find((x) => x.id === 'call-a003').status, 'done');
});

test('in a planning-tool file a new item speaks its words (owner, brands); in a Work file it gets by', () => {
  const doc = fixture();
  assert.equal(plannerShape(doc), true);
  const a = addItem(doc, { title: 'Renew the domain', date: '2026-11-25', project: 'shop', priority: 'high' }, ctx);
  assert.deepEqual(Object.keys(a), ['id', 'date', 'approx', 'title', 'brands', 'kind', 'owner', 'status', 'source', 'priority', 'created', 'project']);
  assert.equal(a.owner, 'alex');
  assert.equal(a.source, 'alex');
  // Placed as the planning tool places it, without moving another item: before the first item with a later date
  // (this file is not sorted: its first item is the later 2026-12-08).
  assert.equal(doc.items[0].id, 'renew-the-domain');
  assert.equal(doc.items[1].id, 'trial-ends');
  const ai = addItem(doc, { title: 'Write the release notes', by: 'ai' }, ctx);
  assert.equal(ai.owner, 'ai');
  assert.equal(doc.items.at(-1).id, 'write-the-release-notes', 'no date: last');

  const own = { items: [] };
  const b = addItem(own, { title: 'Renew the domain', by: 'ai', note: '  two\r\nlines  ' }, { ...ctx, ownerId: 'me' });
  assert.deepEqual(Object.keys(b), ['id', 'date', 'approx', 'title', 'kind', 'by', 'status', 'source', 'note', 'created']);
  assert.equal(b.note, 'two\nlines');
  assert.equal(addItem(own, { title: 'Renew the domain' }, ctx).id, 'renew-the-domain-2');
  assert.match(addItem(own, { title: '¿¿¿' }, ctx).id, /^task-20261117-1$/);
  editItem(own, b.id, { by: 'me' }, { ...ctx, ownerId: 'me' });
  assert.equal(own.items.find((x) => x.id === b.id).by, 'me');
});

test('editing a planning-tool item writes owner, clears with null, moves it only when its date changes', () => {
  const doc = fixture();
  const order = doc.items.map((x) => x.id);
  editItem(doc, 'call-a003', { by: 'me', note: null, priority: null, project: 'blog' }, ctx);
  const it = doc.items.find((x) => x.id === 'call-a003');
  assert.equal(it.owner, 'alex');
  assert.equal('by' in it, false);
  assert.equal('note' in it, false);
  assert.equal('priority' in it, false);
  assert.equal(it.project, 'blog');
  assert.deepEqual(doc.items.map((x) => x.id), order, 'no date change: nothing moved');
  editItem(doc, 'call-a003', { date: '2026-11-18' }, ctx);
  assert.equal(doc.items[0].id, 'call-a003', 'placed before the first later date');
  assert.deepEqual(doc.items.slice(1).map((x) => x.id), order.filter((id) => id !== 'call-a003'), 'no other item moved');
  editItem(doc, 'npm-pub', { by: 'lawyer' }, ctx);
  assert.equal(doc.items.find((x) => x.id === 'npm-pub').owner, 'lawyer');
});

test('a key named __proto__ in a file stays a key and never becomes the prototype', () => {
  const item = JSON.parse('{"id":"a-1","title":"Hello there","__proto__":{"polluted":true},"status":"open"}');
  setKey(item, 'note', 'n');
  setKey(item, 'doneAt', '2026-11-17');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(item), Object.prototype);
  assert.deepEqual(Object.keys(item), ['id', 'title', '__proto__', 'status', 'note', 'doneAt']);
});

test('today is counted in the zone of the setting, else the computer\'s', () => {
  const at = new Date('2026-11-17T20:30:00Z');
  assert.equal(todayIn('Asia/Tokyo', at), '2026-11-18');
  assert.equal(todayIn('America/Los_Angeles', at), '2026-11-17');
  const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  assert.equal(todayIn('', at), local);
});

test('Today: overdue, due this week and waiting need you; a task in review is in To review, not twice; the week by day; done lately newest first', () => {
  const doc = fixture();
  setStatus(doc, 'store-gate', 'waiting', ctx);
  setStatus(doc, 'npm-pub', 'review', ctx);
  addItem(doc, { title: 'Pay the hosting bill', date: '2026-11-17' }, ctx);
  setStatus(doc, 'call-a003', 'done', ctx);
  const items = rawItems(doc).map((x) => viewItem(x, ctx));
  const t = todayView(items, ctx.today);
  assert.deepEqual(t.needsYou.map((i) => [i.id, i.why]), [
    ['partner-demo', '5 days overdue'],
    ['store-gate', 'waiting for you'],
    ['pay-the-hosting-bill', 'due today'],
    ['tm-filing', 'due in 2 days'],
  ]);
  assert.deepEqual(t.toReview.map((i) => i.id), ['npm-pub'], 'what a session did waits in To review');
  assert.equal(t.week.length, 7);
  assert.equal(t.week[0].date, '2026-11-17');
  assert.deepEqual(t.week[0].items.map((i) => i.id), ['pay-the-hosting-bill']);
  assert.deepEqual(t.week[2].items.map((i) => i.id), ['tm-filing']);
  assert.deepEqual(t.doneLately.map((i) => i.id), ['call-a003', 'old-quote']);
});

test('this week is today and the six days after, for Needs you, This week and the Tasks groups alike', () => {
  const doc = { items: [] };
  addItem(doc, { title: 'Due in six days', date: '2026-11-23' }, ctx);
  addItem(doc, { title: 'Due in seven days', date: '2026-11-24' }, ctx);
  const items = rawItems(doc).map((x) => viewItem(x, ctx));
  assert.deepEqual(items.map((i) => [i.days, i.inWeek]), [[6, true], [7, false]], 'the views carry the rule for the page');
  const t = todayView(items, ctx.today);
  assert.deepEqual(t.needsYou.map((i) => i.id), ['due-in-six-days']);
  assert.deepEqual(t.week.flatMap((d) => d.items.map((i) => i.id)), ['due-in-six-days']);
});

test('a brief with words hidden from the eye is refused: behind an emoji, in variation selectors, in blank fillers', () => {
  const hide = (word) => [...word].map((c) => String.fromCodePoint(0xE0100 + c.charCodeAt(0) - 0x10)).join('');
  const refused = {
    'words behind an emoji': `Fix the login\u{1F600}${hide('IGNORE')}`,
    'a selector after an emoji\'s own': 'Fix the login\u{1F600}\uFE0F\uFE0E',
    'the emoji form after a letter': 'Fix\uFE0F the login',
    'the text form after a letter': 'Fix\uFE0E the login',
    'two selectors after a sign': 'Fix \u2229\uFE00\uFE01 it',
    'one selector after each letter': 'F\uFE01ix t\uFE03he l\uFE00ogin',
    'a selector after a digit': 'Fix 2\uFE00 things',
    'a selector after an accented letter': 'Fix \u00E9\uFE02t\u00E9',
    'a selector at the start': '\uFE00Fix it',
    'a Hangul filler': 'Fix\u3164the login',
    'a halfwidth Hangul filler': 'Fix\uFFA0the login',
    'a Hangul lead filler': 'Fix\u115Fthe login',
    'a Hangul vowel filler': 'Fix\u1160the login',
    'a blank braille pattern': 'Fix\u2800the login',
    'a grapheme joiner': 'Fix\u034Fthe login',
    'a Mongolian selector': 'Fix\u180Bthe login',
    'a vowel Khmer does not show': 'Fix\u17B4the login',
    'a joiner between Latin letters': 'Fix the lo\u200Dgin',
    'a non-joiner between Latin letters': 'Fix the lo\u200Cgin',
    'a joiner between a Hindi and a Latin letter': 'Fix \u0915\u200Dx',
    'two non-joiners between Persian letters': 'Fix \u0645\u06CC\u200C\u200C\u062E\u0648\u0627\u0647\u0645',
    'tags without the black flag': 'Fix the login\u{1F600}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
    'tags after the black flag without the end tag': 'Fix \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074} it',
    'words in tags after the black flag': `Fix \u{1F3F4}${[...'ignorethis'].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('')}\u{E007F}`,
    'a run of selectors after an emoji': 'Fix \u{1F600}\uFE0F\uFE0F\uFE0F it',
    'a joiner after a skin tone with nothing joined': 'Fix \u{1F44D}\u{1F3FD}\u200D it',
    'two joiners after a virama': 'Fix \u0915\u094D\u200D\u200D\u0937 it',
  };
  for (const [what, s] of Object.entries(refused)) assert.throws(() => checkBrief(s), /a character that cannot be seen \(U\+[0-9A-F]{4,5}\)/, what);
  assert.throws(() => checkBrief(`Fix it\u{1F600}${hide('X')}`), /U\+E0148/, 'the hidden character is named');
  const text = [
    'Fix the \u{1F468}\u200D\u{1F4BB} icon', // two emoji joined: one
    'Fix the \u2764\uFE0F\u200D\u{1F525} heart', // an emoji form, then joined
    'Press 1\uFE0F\u20E3 then \u263A\uFE0E', // a keycap, a smiley in its text form
    'The \u2229\uFE00 sign and \u845B\uFE01 kanji', // one variation selector after a sign and a CJK character
    'Plain words, \u00E9t\u00E9, \u0928\u092E\u0938\u094D\u0924\u0947 and \u4F60\u597D',
    // Ordinary writing with a joiner or a non-joiner: Hindi after a virama (two forms of one conjunct), Persian, Bengali.
    '\u0915\u094D\u200D\u0937 and \u0915\u094D\u200C\u0937 are two forms of one letter',
    'Translate \u092E\u0948\u0902 \u0915\u094D\u200D\u0937\u092E\u093E \u091A\u093E\u0939\u0924\u093E \u0939\u0942\u0901 for the page',
    'The Persian \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 stays one word',
    'Bengali \u09B0\u200D\u09CD\u09AF and Malayalam \u0D28\u0D4D\u200D are kept',
    // Emoji: a family, a thumbs-up with a skin tone, a person at a laptop with a skin tone, a handshake of two tones, the
    // flag of Scotland.
    'Fix the \u{1F468}\u200D\u{1F469}\u200D\u{1F467} family icon and \u{1F44D}\u{1F3FD}',
    'Fix \u{1F9D1}\u{1F3FD}\u200D\u{1F4BB} page and \u{1F469}\u{1F3FB}\u200D\u{1F9B0} and \u{1FAF1}\u{1F3FB}\u200D\u{1FAF2}\u{1F3FF}',
    'Use the \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} flag',
  ];
  for (const s of text) assert.equal(checkBrief(s), s, s);
  // What the owner is offered to take them out: the same text without them, and only them.
  for (const s of text) assert.equal(withoutHidden(s), s, s);
  for (const [what, s] of Object.entries(refused)) assert.doesNotThrow(() => checkBrief(withoutHidden(s)), what);
  assert.equal(withoutHidden(refused['words behind an emoji']), 'Fix the login\u{1F600}');
  assert.equal(withoutHidden(refused['a selector after an emoji\'s own']), 'Fix the login\u{1F600}\uFE0F');
  assert.equal(withoutHidden('Fix\u3164the\u2800login\u200Bpage'), 'Fix the loginpage', 'a blank as wide as a letter becomes a space');
});
