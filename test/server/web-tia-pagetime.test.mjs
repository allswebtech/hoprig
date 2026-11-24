// The time a subscription can be used again (feature.mjs subsLimitedLine, chosenLimitedLine) is written the way the
// page writes its other times: the server sends the words it wrote for that time beside the moment (atOf), and the
// page puts the moment in its own clock form (web/tia.js pageTime), as its other times (when()).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const tia = await import('../../web/tia.js');
const feature = await import('../../src/assistant/feature.mjs');
const pageClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

test('the server sends the words it wrote for the time, and the moment', () => {
  assert.equal(typeof feature.atOf, 'function', 'the server sends no moment beside its time words');
  const now = new Date(2026, 10, 22, 10, 0).getTime();
  const until = new Date(2026, 10, 22, 21, 5).getTime();
  const at = feature.atOf(until, now);
  assert.deepEqual(at, { atText: '21:05', until });
  const line = feature.subsLimitedLine({ names: ['one'], first: 'one', until }, { profiles: [{ name: 'one', label: 'Plan one' }] }, now);
  assert.ok(line.includes(`can be used again at ${at.atText}.`), line);
  assert.deepEqual(feature.atOf(null, now), {}, 'no time known: nothing to rewrite');
});

test('the page writes that time in its own clock form, with the day when it is not today', () => {
  assert.equal(typeof tia.pageTime, 'function', 'the page shows the server\'s 24-hour time as it came');
  const now = new Date(2026, 10, 22, 10, 0).getTime();
  const today = new Date(2026, 10, 22, 21, 5).getTime();
  const text = 'Plan one has reached its limit, so Tia cannot answer now. Plan one can be used again at 21:05. Tia does not move to a paid provider by herself.';
  assert.equal(tia.pageTime(text, { atText: '21:05', until: today }, now), text.replace('21:05', pageClock(today)));
  const tomorrow = new Date(2026, 10, 23, 9, 0).getTime();
  const t2 = 'It can be used again at 09:00 on Mon, 23 Nov.';
  const day = new Date(tomorrow).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  assert.equal(tia.pageTime(t2, { atText: '09:00 on Mon, 23 Nov', until: tomorrow }, now), `It can be used again at ${pageClock(tomorrow)} on ${day}.`);
  // A line with no time words (an older dashboard, another notice) is shown as it came.
  assert.equal(tia.pageTime('No provider can run Tia.', {}, now), 'No provider can run Tia.');
  assert.equal(tia.pageTime(text, { atText: '07:00', until: today }, now), text, 'words not in the line: nothing is changed');
});

test('the banner and both kinds of notice draw their line through it; readiness and the notice carry the moment', () => {
  const web = fs.readFileSync(path.join(ROOT, 'web', 'tia.js'), 'utf8');
  assert.match(web, /h\('span', `\$\{pageTime\(o\.ready\.problem, o\.ready\)\} `, bannerLink\(o\.ready\)\)/);
  assert.match(web, /h\('span', pageTime\(e\.text, e\)\)\);/);
  assert.match(web, /h\('div\.tia-notice-body', h\('span', pageTime\(e\.text, e\)\),/);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'assistant', 'feature.mjs'), 'utf8');
  assert.match(src, /code: 'subs-limited', until: tia\.subsLimited\.until, other: tia\.subsLimited\.other === true, \.\.\.atOf\(tia\.subsLimited\.until\)/);
  assert.match(src, /code: 'chosen-limited', until: tia\.chosenLimited\.until, \.\.\.atOf\(tia\.chosenLimited\.until\)/);
  assert.match(src, /\.\.\.\(ready\.atText \? \{ atText: ready\.atText, until: ready\.until \} : \{\}\)/);
});
