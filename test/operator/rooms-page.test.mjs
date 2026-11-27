// The Operator page's "Computers" part (web/operator-rooms.js): what one computer's line says, read by someone who
// is not a programmer: the room in one word, load against processors, free memory, why, or since when not reached.
import assert from 'node:assert/strict';
import test from 'node:test';

// The page's modules look at the document when they load: the least of one, as page.test.mjs gives it.
globalThis.Node ??= class {};
const el = () => ({ style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, addEventListener() {}, append() {}, appendChild() {}, replaceChildren() {}, querySelector: () => null, querySelectorAll: () => [] });
globalThis.document ??= { createElement: el, createElementNS: el, createTextNode: () => ({}), getElementById: () => null, querySelector: () => null, addEventListener: () => {}, visibilityState: 'visible', body: el(), head: el(), documentElement: el() };
const { roomWords, ROOM_WORDS, LOOK_SENTENCE } = await import('../../web/operator-rooms.js');

test('a computer with room, a full one, one not reached and one never reached', () => {
  const free = roomWords({ name: 'box2', label: 'Box 2', reached: true, room: 'free', why: 'it has room for new work', cpus: 8, load1: 1.2, memFreePct: 63 });
  assert.deepEqual([free.word, free.head, free.numbers, free.why, free.since], ['Has room', 'Box 2', 'load 1.2 on 8 CPUs, 63 % memory free', 'Has room for new work.', null]);
  const full = roomWords({ name: 'box3', label: 'Box 3', reached: true, room: 'full', why: 'It is full: its load is 2.5 per CPU.', cpus: 4, load1: 10, memFreePct: 8 });
  assert.equal(full.word, 'Full');
  assert.equal(full.why, 'It is full: its load is 2.5 per CPU.');
  const gone = roomWords({ name: 'box2', label: 'Box 2', reached: false, room: 'unknown', why: 'it was not reached', seenAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  assert.equal(gone.word, 'Not known');
  assert.match(gone.since, /^Did not answer; last answered at \d\d:\d\d UTC \(5 min ago\)\.$/);
  assert.equal(gone.numbers, null, 'no figures that would look fine');
  assert.equal(roomWords({ name: 'box2', reached: false, asked: true, room: 'unknown', why: 'it was not reached', seenAt: null }).since, 'Did not answer when asked.');
  assert.equal(roomWords({ name: 'box2', reached: false, asked: false, room: 'unknown', why: 'it was not reached', seenAt: null }).since, 'Not asked yet.');
  // A computer that answered but refused is never told as one that did not answer (the hub's state, hub.mjs).
  const said = (state) => roomWords({ name: 'box3', reached: false, asked: true, room: 'unknown', why: 'it was not reached', seenAt: new Date(Date.now() - 60_000).toISOString(), state }).since;
  // The words the Computers page and the computer's own page say for that state, with the step that mends it.
  assert.match(said('unauthorised'), /no longer lets this dashboard in\. Add it again here: Computers → Add a computer\.$/);
  assert.match(said('too-old'), /too old .*update it there/);
  assert.match(said('hostkey'), /host key changed.*under Computers/);
  for (const st of ['unauthorised', 'too-old', 'hostkey']) assert.doesNotMatch(said(st), /did not answer/i, st);
  // Its badge names the state as the Computers page does; one that did not answer stays "Not known".
  const badge = (state) => roomWords({ name: 'box3', reached: false, asked: true, room: 'unknown', why: 'it was not reached', state }).word;
  assert.equal(badge('unauthorised'), 'Not allowed any more');
  assert.equal(badge('offline'), 'Not known');
  assert.equal(badge(null), 'Not known');
  assert.match(said(null), /^Did not answer; last answered at/);
  const old = roomWords({ name: 'this', label: 'This computer', here: true, reached: true, room: 'unknown', why: 'its last answer is 7 minutes old' });
  assert.equal(old.why, 'Its last answer is 7 minutes old.');
  assert.deepEqual(Object.keys(ROOM_WORDS).sort(), ['busy', 'free', 'full', 'unknown']);
  assert.equal(LOOK_SENTENCE, 'Look at my other computers too');
});

test('the hold line says its time in the page\'s one clock, UTC with its zone named, as the overload card does', async () => {
  const { heldWords } = await import('../../web/operator-rooms.js');
  const { detectMachine } = await import('../../src/operator/detect/machine.mjs');
  const since = '2026-03-02T22:51:00.000Z';
  const now = Date.parse('2026-03-02T23:00:00Z');
  const line = heldWords({ label: 'Box 2', since }, now);
  assert.match(line, /^Tia's new work starts on Box 2 since 22:51 UTC, until this computer/);
  const [it] = detectMachine({ machine: { cpus: 4, load1: 8, memTotal: 16, memAvailable: 8, disks: [], tmp: null }, elsewhereHeld: { to: 'box2', label: 'Box 2', since } });
  assert.ok(it.facts.some((f) => f.includes('Box 2 since 22:51 UTC')), 'the card and the line say the same time');
});

test('after "Start new work on Box 2" the Computers part is read again at once, so its hold line and Undo are there', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../../web/operator.js', import.meta.url), 'utf8');
  const tap = page.slice(page.indexOf('async function tap('), page.indexOf('async function load('));
  assert.match(tap, /if \(alive\) load\(\)/, 'the row reads the list again after every act, the hold one too');
});

test('how the hold ends and where its Undo is are said in visible words, on the card and on the hold line, not only on hover', async () => {
  const { heldWords } = await import('../../web/operator-rooms.js');
  const { detectMachine } = await import('../../src/operator/detect/machine.mjs');
  const { ACTS } = await import('../../src/operator/item.mjs');
  const [it] = detectMachine({ machine: { cpus: 4, load1: 8, memTotal: 16, memAvailable: 8, disks: [], tmp: null }, elsewhere: { name: 'box2', label: 'Box 2' } });
  assert.equal(it.why, 'Start new work on Box 2 until this computer has been calm for 10 minutes (2 hours at most). Undo is under Computers.');
  assert.ok(it.facts.includes('Box 2 has room for Tia\'s new work; nothing that runs moves'), 'that nothing that runs moves is said in a visible line');
  assert.match(heldWords({ label: 'Box 2', since: '2026-03-02T10:00:00Z' }, Date.parse('2026-03-02T10:05:00Z')), /calm for 10 minutes \(2 hours at most\)\. Undo ends it at once\.$/);
  assert.equal(ACTS.elsewhere.undo, 'Its Undo under Computers ends it at once.', 'the hint reads "Undo: Its Undo under …", no word twice');
});

test('one word for one thing on the Operator screen: the Computers line says CPUs, as the overload card does', async () => {
  const { roomOf } = await import('../../src/operator/room.mjs');
  const { detectMachine } = await import('../../src/operator/detect/machine.mjs');
  const r = roomOf({ reading: { cpus: 8, load1: 14.4, memTotal: 16, memAvailable: 8, disk: null }, at: 1000, now: 2000 });
  const line = roomWords({ name: 'this', here: true, reached: true, room: r.room, why: r.why, cpus: 8, load1: 14.4, memFreePct: 50 });
  const [card] = detectMachine({ machine: { cpus: 8, load1: 14.4, memTotal: 16, memAvailable: 8, disks: [], tmp: null } });
  const words = [line.numbers, line.why, ...r.facts, ...card.facts].join(' ');
  assert.ok(!/processor/.test(words), words);
  assert.match(words, /on 8 CPUs/);
});

test('with a label of 40 characters, the longest he can give, the card is whole: its why ends with the Undo, no line is cut', async () => {
  const { detectMachine } = await import('../../src/operator/detect/machine.mjs');
  const label = 'The build box upstairs in the office 123';
  assert.equal(label.length, 40);
  const machine = { cpus: 8, load1: 14.4, memTotal: 16, memAvailable: 8, disks: [], tmp: null };
  const [free] = detectMachine({ machine, elsewhere: { name: 'box2', label } });
  assert.match(free.why, /Undo is under Computers\.$/, free.why);
  assert.ok(free.why.includes(label));
  const [held] = detectMachine({ machine, elsewhereHeld: { to: 'box2', label, since: '2026-03-02T10:00:00.000Z' } });
  for (const line of [...free.facts, ...held.facts]) assert.ok(!line.endsWith('…') && line.includes(label) === line.includes('box upstairs'), line);
  assert.ok(free.facts.some((f) => f.startsWith(`${label} has room`)), free.facts.join('\n'));
  assert.ok(held.facts.some((f) => f.includes(`${label} since 10:00 UTC`)), held.facts.join('\n'));
});
