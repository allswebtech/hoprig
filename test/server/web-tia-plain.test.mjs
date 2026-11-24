// Tia's page for a person who is not a programmer: the subtitle, three asks to press in the empty chat, and in
// Settings → Tia one short line per level with the full texts under a closed "More". Nothing is taken away.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HELP, LEVELS } from '../../src/assistant/tia.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

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
const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');

test('the subtitle and the three asks are plain words', () => {
  // Paid use without his tap is possible at Hands off within the daily limit: the line never promises she always asks.
  assert.equal(tia.SUBTITLE, 'Tell Tia what you want done, in your own words. She asks you before anything risky, and before paid use unless you chose Hands off with a daily limit for it (Settings → Tia).');
  assert.doesNotMatch(tia.SUBTITLE, /risky or paid/);
  assert.match(src, /intro: SUBTITLE,/);
  assert.deepEqual(tia.EXAMPLES, ['What needs me?', 'What is running?', 'Start a new project']);
});

test('each level has one short line; the full text of the chosen one is under a closed "More"', () => {
  assert.ok(HELP.levelShort, 'no short lines');
  for (const l of LEVELS) assert.ok(HELP.levelShort[l] && HELP.levelShort[l].split(' ').length <= 20, l);
  assert.match(src, /levelSeg, levelLines, fold\('tia-level-more', 'What each level means', levelHelp\)/);
});

test('nothing is taken away: Lead model, her model, the limits, the cap and "runs on" are all still drawn', () => {
  for (const part of ['modelSlot', 'leadSlot', "field('Answers per job'", "field('Minutes per job'", "'Daily limit for paid use (US $)'", 'field(`${NAME} runs on`', "'Providers she may use'"]) assert.ok(src.includes(part), part);
  assert.match(src, /fold\('tia-advanced', 'Advanced',\s*modelSlot,\s*leadSlot,/);
});

test('her card for archiving a chat says Archive and what it does, as the App\'s Archive does', () => {
  const p = tia.plainCard({ tool: 'send_to_chat', input: { session: 'chat:01234567-89ab-cdef-0123-456789abcdef', close: true }, lines: [] }, { chat: () => 'the chat shop' });
  assert.equal(p.question, 'Archive the chat shop?');
  assert.ok(p.notes.includes('It stops if it is working and leaves the list. Its conversation is kept: continue it from Archived in the list of sessions.'), p.notes.join(' '));
  assert.doesNotMatch([p.question, ...p.notes].join(' '), /\bClose\b/);
});
