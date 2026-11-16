// Two words of the page said once and one way: a limit box never reads "API (pay as you go) (paid per use)", and a
// schedule's next run is always a day and the 24-hour clock, never "in 7 h 1 min" in one row and "Tue 08:30" in the
// next.
import assert from 'node:assert/strict';
import test from 'node:test';

// Just enough of a browser for the modules to load (the same stand-in as web.test.mjs).
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const buttons = (n) => (n instanceof FakeText ? [] : [...(n.tag === 'button' ? [n] : []), ...n.children.flatMap(buttons)]);

const { limitBox } = await import('../../web/lib.js');
const { nextRunText } = await import('../../web/automation.js');

test('limit box: "(paid per use)" once, not after a name that says it already', () => {
  const s = { name: 'w', canSwitch: true, limit: { text: 'limit reached' }, profile: { name: 'max' } };
  const words = buttons(limitBox(s, [
    { name: 'max', label: 'Claude Max', kind: 'subscription', limited: { until: 1 } },
    { name: 'api', label: 'API (pay as you go)', kind: 'api', paid: true },
    { name: 'key', label: 'Claude API', kind: 'api', paid: true },
    { name: 'tr', label: 'Paid gateway', kind: 'api', paid: false },
  ])).map((b) => texts(b).join(''));
  assert.deepEqual(words.sort(), ['Continue on API (pay as you go)', 'Continue on Claude API (paid per use)', 'Continue on Paid gateway']);
});

test('a schedule\'s next run: a day and the 24-hour clock, near or far', () => {
  const now = new Date(2026, 10, 16, 9, 0).getTime(); // a Monday, 09:00
  const at = (d, hh, mm) => new Date(2026, 10, d, hh, mm).getTime();
  assert.equal(nextRunText(at(16, 9, 30), now), 'today 09:30');
  assert.equal(nextRunText(at(16, 16, 1), now), 'today 16:01', 'seven hours away: still a clock time');
  assert.equal(nextRunText(at(17, 8, 30), now), 'tomorrow 08:30');
  assert.match(nextRunText(at(19, 18, 0), now), /^\S+ 18:00$/, 'this week: the weekday');
  assert.match(nextRunText(at(30, 7, 5), now), /^.*30.* 07:05$/, 'later: the date');
  assert.equal(nextRunText(at(15, 8, 30), now), 'yesterday 08:30', 'already past (a page left open): never "today"');
  assert.match(nextRunText(at(10, 8, 30), now), /^.*10.* 08:30$/);
  // On the computer's clock (its time zone from the server), whatever the browser's is: 07:30 UTC is 08:30 in
  // Berlin in November, and 13:00 in Kolkata.
  const utc = Date.UTC(2026, 10, 17, 7, 30);
  const base = Date.UTC(2026, 10, 16, 12, 0);
  assert.equal(nextRunText(utc, base, 'Europe/Berlin'), 'tomorrow 08:30');
  assert.equal(nextRunText(utc, base, 'Asia/Kolkata'), 'tomorrow 13:00');
  assert.equal(nextRunText(Date.UTC(2026, 10, 16, 23, 30), base, 'Asia/Kolkata'), 'tomorrow 05:00', 'the day is the computer\'s too');
  assert.equal(nextRunText(Date.UTC(2026, 10, 16, 23, 30), base, 'Europe/Berlin'), 'tomorrow 00:30');
  assert.equal(nextRunText(Date.UTC(2026, 10, 16, 22, 30), base, 'Europe/Berlin'), 'today 23:30');
  assert.equal(nextRunText(utc, base, 'Not/AZone'), nextRunText(utc, base), 'an unknown zone: the browser\'s clock');
});
