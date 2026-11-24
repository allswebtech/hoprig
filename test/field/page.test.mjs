// The field reports' page parts (web/field.js) in the page tests' stand-in DOM (test/chat/fakedom.mjs), with a
// stand-in for the dashboard's answers: what "ask each time" shows on Home, the names a screen reader hears, and the
// keyboard's focus after a choice on Settings → Field reports. Made-up values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
globalThis.window.dispatchEvent ||= () => true; // savedMark tells the Settings list
let answer = null;
const asked = [];
globalThis.fetch = async (u, o = {}) => {
  asked.push({ u, body: o.body ? JSON.parse(o.body) : undefined });
  const data = typeof answer === 'function' ? answer(u, o) : answer;
  return { status: 200, ok: true, json: async () => data };
};
const { fieldLines } = await import('../../web/field.js');
const { registeredSettingsPages } = await import('../../web/registry.js');
const all = (n, ok) => (n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const T = '2026-03-01T10:00:00Z';
const text = (i) => `{\n  "format": 1,\n  "id": "${String(i).padStart(16, '0')}"\n}\n`;
const view = (o = {}) => ({
  settings: { sendTo: 'https://reports.example.com/in', choice: 'ask', choiceAt: T, choiceFor: 'https://reports.example.com/in', ownNetwork: false, copyDir: '' },
  choice: 'ask', question: false, reports: [], notRead: 0, waiting: [], twice: [], ...o,
});

test('"ask each time" on Home: one line for all that wait, each report folded, the rest counted; every button names its report', async () => {
  // All in one minute, two kinds: the names must still tell each report apart.
  const waiting = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`.repeat(16), kind: i % 2 ? 'drop' : 'get', kindWords: i % 2 ? 'hoprig drop' : 'hoprig get', time: `2026-03-01T10:00:0${i}Z`, text: text(i) }));
  const twice = [
    { key: 'drop:git-not-pushed', kind: 'drop', class: 'git-not-pushed', count: 2, last: T, kindWords: 'hoprig drop', words: 'a repository had commits that were not pushed', help: 'h', command: null, draft: true },
    { key: 'get:signin-needed', kind: 'get', class: 'signin-needed', count: 2, last: T, kindWords: 'hoprig get', words: 'a sign-in was needed', help: 'h', command: null, draft: true },
    { key: 'doctor:other', kind: 'doctor', class: 'other', count: 2, last: T, kindWords: 'hoprig doctor', words: 'something went wrong that Hoprig has no name for yet', help: 'h', command: null, draft: false },
  ];
  answer = view({ waiting, twice });
  const box = fieldLines();
  await settle();
  const banners = byClass(box, 'field-wait');
  assert.equal(banners.length, 1, 'one line, not one banner per report');
  assert.match(texts(banners[0]).join(''), /7 field reports wait for your answer/);
  const folds = all(box, (n) => n.tag === 'details');
  assert.equal(folds.length, 5, 'at most five shown');
  assert.ok(folds.every((d) => !d.attrs.open), 'each one folded: the page keeps its own job');
  assert.match(texts(banners[0]).join(''), /2 more wait/);
  assert.match(texts(folds[0]).join(''), /"id": "0000000000000000"/, 'the whole text is one press away');
  assert.match(texts(folds[0]).join(''), /id 00000000/, 'the fold names its report by its id too');
  const buttons = all(box, (n) => n.tag === 'button');
  const named = (label) => buttons.filter((b) => texts(b).join('') === label).map((b) => b.attrs['aria-label']);
  for (const label of ['Send', 'Don\'t send']) {
    const names = named(label);
    assert.equal(names.length, 5);
    assert.equal(new Set(names).size, 5, `${label}: each names its own report`);
    assert.ok(names.every((n) => /the report of hoprig (get|drop) at /.test(n)), names[0]);
  }
  const drafts = named('Make a skill draft of this');
  assert.deepEqual(drafts, ['Make a skill draft of: a repository had commits that were not pushed', 'Make a skill draft of: a sign-in was needed'], 'no draft for "other"; each names its line');
});

test('Settings → Field reports: after a choice the focus stays on the chosen radio, and the radio group has a name', async () => {
  answer = view();
  const page = registeredSettingsPages().find((p) => p.id === 'field');
  const [box] = page.render();
  document.body.append(box);
  await settle();
  const group = all(box, (n) => n.attrs && n.attrs.role === 'radiogroup')[0];
  assert.equal(group.attrs['aria-labelledby'], 'field-choice');
  const label = all(box, (n) => n.attrs && n.attrs.id === 'field-choice')[0];
  assert.equal(texts(label).join(''), 'Send them?', 'the group\'s name is the question alone');
  const radio = (v) => all(box, (n) => n.tag === 'input' && n.attrs.type === 'radio' && n.value === v)[0];
  answer = () => view({ choice: 'always', settings: { ...view().settings, choice: 'always' } });
  const always = radio('always');
  always.focus();
  always.listeners.change({ target: always });
  await settle();
  assert.deepEqual(asked.at(-1).body, { choice: 'always' });
  const now = document.activeElement;
  assert.notEqual(now, document.body, 'the focus did not fall to the page');
  assert.equal(now.tag, 'input');
  assert.equal(now.value, 'always');
  assert.ok(box.contains(now), 'the radio of the new paint');
  box.remove();
});
