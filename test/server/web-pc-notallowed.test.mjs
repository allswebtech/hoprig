// One computer's page when that computer no longer lets this dashboard in (state unauthorised): it says what the
// Computers list says ("Not allowed any more") with the computer's own sentence and the button to Computers, never
// the offline steps ("cannot be reached", "It does not answer.").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const all = (n) => [n, ...(n.children || []).flatMap(all)];
const src = fs.readFileSync(new URL('../../web/pc.js', import.meta.url), 'utf8');
const pc = await import('../../web/pc.js');

test('not allowed any more: the list\'s words, the computer\'s sentence and the button to Computers', () => {
  assert.equal(typeof pc.notAllowedCard, 'function');
  const sentence = 'Old box no longer lets this dashboard in. Add it again here: Computers → Add a computer.';
  const card = pc.notAllowedCard('Old box', sentence);
  const words = texts(card).join(' ');
  assert.match(words, /Not allowed any more/);
  assert.ok(words.includes(sentence), 'the sentence from m.error');
  assert.doesNotMatch(words, /cannot be reached|does not answer|switched on/);
  const way = all(card).find((n) => n.tag === 'a' && texts(n).join('') === 'Add a computer');
  assert.ok(way, 'the computer-not-allowed button');
  assert.equal(way.href ?? way.attrs.href, '#/computers/add', 'the step that lets it in again, not the list that offers nothing');
  // Its Advanced page cannot load from a computer that refuses us: no link to it.
  assert.ok(!all(card).some((n) => n.tag === 'a' && /advanced/.test(String(n.href ?? (n.attrs && n.attrs.href) ?? ''))), 'no Advanced link');
  assert.doesNotMatch(words, /on that computer\'s Computers page/);
  // Without a sentence: still true words, never empty.
  assert.match(texts(pc.notAllowedCard('Old box', '')).join(' '), /no longer lets this dashboard in\. Add it again here: Computers → Add a computer\./);
});

test('not allowed any more: the line under each tab says what cannot be read, never load, checks or programs', () => {
  const refused = { machine: 'oldbox', machineLabel: 'Old box', status: 'unauthorised' };
  const online = { machine: 'oldbox', machineLabel: 'Old box', status: 'online' };
  for (const part of pc.PARTS) {
    const line = pc.partText(part, refused);
    assert.notEqual(line, part.text, `${part.title}: its usual line promises what cannot be read`);
    assert.doesNotMatch(line, /load, memory, disks|Its checks \(with a Fix|The programs running on it/, part.title);
    assert.equal(pc.partText(part, online), part.text, `${part.title} of a computer that answers is unchanged`);
    assert.equal(pc.partText(part, null), part.text, `${part.title} before the list arrives is unchanged`);
  }
  // Overview points to Advanced, where Rename and Remove from this list still work; Advanced says what is left there.
  assert.match(pc.partText(pc.PARTS[0], refused), /open Advanced/);
  assert.match(pc.partText(pc.PARTS.find((p) => p.id === 'advanced'), refused), /taking it off this list/);
  // Advanced's lists say why they are empty: it refuses us, not "does not answer".
  assert.equal(pc.unreadWords('Old box', refused), 'Cannot be read: Old box no longer lets this dashboard in.');
  assert.equal(pc.unreadWords('Old box', online), 'Cannot be read while Old box does not answer.');
  // The page draws that line, and draws it again when the state arrives after the first paint.
  assert.match(src, /h\('p\.cp-parttext', partText\(part, entry\(\)\)\)/);
  assert.match(src, /notAllowed\(entry\(\)\) !== refused/);
  assert.match(src, /unreadWords\(ctx\.label\(\), ctx\.entry\(\)\)/);
});

test('the Overview picks that card for the state unauthorised, before the offline steps', () => {
  assert.match(src, /if \(m\.status === 'unauthorised'\) return notAllowedCard\(ctx\.label\(\), m\.error\);/);
});
