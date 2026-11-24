// Home's fold (web/homefold.js, web/home.js): the sessions of "Waiting for your next message" that have waited for
// more than 6 hours stand under one line, newest first. Never one with a background command, a card, or of another
// group. The rule is one function, its age from statusAt, else activity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { FOLD_AFTER_MS, foldLine, foldsAway, splitWaiting, waitedFor } = await import('../../web/homefold.js');
const NOW = 1_800_000_000_000;
const H = 3600_000;
const waiting = (age, extra = {}) => ({ name: `s${age}`, kind: 'claude', status: 'waiting', statusAt: NOW - age, ...extra });

test('the rule: older than 6 hours folds, 6 hours exactly does not', () => {
  assert.equal(FOLD_AFTER_MS, 6 * H);
  assert.equal(foldsAway(waiting(6 * H), NOW), false, 'at the edge it still stands among the others');
  assert.equal(foldsAway(waiting(6 * H + 1), NOW), true, 'a moment later it is folded');
  assert.equal(foldsAway(waiting(2 * H), NOW), false);
  assert.equal(foldsAway(waiting(30 * H), NOW), true);
});

test('the age comes from statusAt, else activity; an unknown age never folds', () => {
  assert.equal(foldsAway({ kind: 'claude', status: 'waiting', statusAt: NOW - H, activity: NOW - 9 * H }, NOW), false, 'the state time wins');
  assert.equal(foldsAway({ kind: 'claude', status: 'waiting', activity: NOW - 9 * H }, NOW), true, 'no state time: the last activity');
  assert.equal(foldsAway({ kind: 'claude', status: 'waiting' }, NOW), false, 'no time at all: not folded');
});

test('a session with a background command or a card is never in the fold', () => {
  assert.equal(foldsAway(waiting(9 * H, { bgCommands: 1 }), NOW), false, 'a command of its own still runs');
  assert.equal(foldsAway(waiting(9 * H, { bgCommands: 0 }), NOW), true);
  assert.equal(foldsAway(waiting(9 * H, { askCard: { kind: 'notice' } }), NOW), false, 'a card asks him something');
});

test('a finished session folds; a session of another group never does', () => {
  assert.equal(foldsAway({ kind: 'claude', status: 'ended', statusAt: NOW - 9 * H }, NOW), true, 'Finished is in the waiting group');
  for (const s of [
    { kind: 'claude', status: 'attention', statusAt: NOW - 9 * H },
    { kind: 'claude', status: 'working', statusAt: NOW - 9 * H },
    { kind: 'claude', status: 'waiting', limit: { text: 'x' }, statusAt: NOW - 9 * H },
    { kind: 'shell', status: 'shell', statusAt: NOW - 9 * H },
  ]) assert.equal(foldsAway(s, NOW), false, `${s.status}${s.limit ? ' with a limit' : ''}`);
});

test('the split keeps the recent ones in place and puts the old ones newest first', () => {
  const list = [waiting(H), waiting(20 * H), waiting(7 * H), waiting(9 * H, { bgCommands: 2 }), waiting(48 * H)];
  const { recent, old } = splitWaiting(list, NOW);
  assert.deepEqual(recent.map((s) => s.name), [`s${H}`, `s${9 * H}`]);
  assert.deepEqual(old.map((s) => s.name), [`s${7 * H}`, `s${20 * H}`, `s${48 * H}`]);
});

test('the line and the time it has waited, in plain words', () => {
  assert.equal(foldLine(12), '12 sessions have waited for more than 6 hours');
  assert.equal(foldLine(1), '1 session has waited for more than 6 hours');
  assert.equal(waitedFor(waiting(7 * H + 5), NOW), '7 h');
  assert.equal(waitedFor(waiting(30 * H), NOW), '1 day', 'the unit of the card\'s "1 day ago", in a word he knows');
  assert.equal(waitedFor(waiting(50 * H), NOW), '2 days');
});

test('scrolled to, the fold line stays below the sticky page head', () => {
  const css = fs.readFileSync(new URL('../../web/page-home.css', import.meta.url), 'utf8');
  const head = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(head, /\.pagehead \{\s*position: sticky; top: 0;[^}]*min-height: 56px/, 'the head the margin is for');
  const m = /\.home-fold \{[^}]*scroll-margin-top: calc\((\d+)px \+ env\(safe-area-inset-top\)\)/.exec(css);
  assert.ok(m, '.home-fold has a scroll-margin-top');
  assert.ok(Number(m[1]) >= 80, 'more than the one-line head (73 px measured at 1440 px)');
  const phone = /@media \(max-width: (\d+)px\) \{ \.home-fold \{ scroll-margin-top: calc\((\d+)px/.exec(css);
  assert.ok(phone && Number(phone[1]) >= 390 && Number(phone[2]) >= 120, 'more than the two-line head on a phone (115 px measured at 390 px)');
});

test('the card and the End sheet say one time in one unit', async () => {
  const { ago } = await import('../../web/lib.js');
  const t = Date.now();
  for (const back of [7 * H, 30 * H, 50 * H]) {
    const s = { name: 'x', status: 'waiting', statusAt: t - back };
    assert.equal(ago(t - back), `${waitedFor(s, t)} ago`, `${back / H} h`);
  }
});

test('Home folds only its waiting group, under that line with Show', () => {
  const src = fs.readFileSync(new URL('../../web/home.js', import.meta.url), 'utf8');
  assert.match(src, /id === 'waiting' \? splitWaiting\(mine\)/);
  assert.match(src, /foldLine\(old\.length\)/);
  assert.match(src, /foldOpen \? 'Hide' : 'Show'/);
  assert.match(src, /m\.sessions\.map\(\(s\) => foldsAway\(s\)\)/, 'a session that crosses 6 hours is drawn again');
  assert.match(fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), /<link rel="stylesheet" href="page-home.css">/);
});
