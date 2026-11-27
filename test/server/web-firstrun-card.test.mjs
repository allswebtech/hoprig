// Home on a new install: one card of two steps (web/firstrun.js) in place of the empty Home, with the words of the design;
// its step 1 is ticked when Claude Code is signed in already; the card is shown only while the computer has no session
// and the first run was not closed. The first chat's box (web/chat/firstchat.js) says what to make, until the first send.
import assert from 'node:assert/strict';
import test from 'node:test';
import { texts } from '../chat/fakedom.mjs';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });

const { FIRST_WORDS, firstRunCard, isFirstRun, signInStep } = await import('../../web/firstrun.js');
const { FIRST_PLACEHOLDER, FIRST_PLACEHOLDER_SHORT, doneFirstChat, isFirstChat, markFirstChat } = await import('../../web/chat/firstchat.js');

const out = { steps: [{ id: 'claude', done: false, action: { kind: 'claude-login', label: 'Sign in to Claude' } }, { id: 'tools', done: false }], done: 0, total: 2 };
const signed = { ...out, steps: [{ id: 'claude', done: true, action: null }, out.steps[1]] };
const words = (node) => texts(node).join(' | ');
const buttons = (node) => {
  const found = [];
  const walk = (n) => {
    if (!n || !n.children) return;
    if (n.tag === 'button' || n.tag === 'a') found.push(texts(n).join(' ').trim());
    n.children.forEach(walk);
  };
  walk(node);
  return found.filter(Boolean);
};

test('signed out: two steps, the words of the design, nothing else', () => {
  const card = firstRunCard(out, {});
  const text = words(card);
  assert.match(text, /Welcome to Hoprig/);
  assert.match(text, /Sign in to Claude/);
  assert.match(text, /Start your first chat/);
  assert.deepEqual(buttons(card).sort(), ['My own folder', 'New project', 'No Claude plan? Pay as you use', 'Sign in'], 'four things to press, and the close mark');
  for (const gone of ['Show all', 'of 3', 'Later', 'Tools for coding', 'optional', 'phone', 'Skills']) assert.ok(!text.includes(gone), gone);
  assert.deepEqual(Object.keys(FIRST_WORDS).sort(), ['own', 'paid', 'project', 'signIn', 'signInButton', 'signedIn', 'start', 'title']);
});

test('signed in already: step 1 says so and has no button; New project is the main button', () => {
  const card = firstRunCard(signed, {});
  const text = words(card);
  assert.match(text, /Signed in to Claude/);
  assert.doesNotMatch(text, /Pay as you use/);
  assert.ok(!buttons(card).includes('Sign in'));
  assert.ok(buttons(card).includes('New project') && buttons(card).includes('My own folder'));
  assert.deepEqual(signInStep(signed), { done: true, action: null });
  assert.equal(signInStep(out).action.kind, 'claude-login');
});

test('when it shows: only a new install with no session, not closed, not a hub', () => {
  const base = { onb: out, hub: false, dismissed: false, sessions: 0 };
  assert.equal(isFirstRun(base), true);
  assert.equal(isFirstRun({ ...base, sessions: 1 }), false, 'a chat exists: the card is gone');
  assert.equal(isFirstRun({ ...base, dismissed: true }), false, 'closed, or the first chat was made');
  assert.equal(isFirstRun({ ...base, hub: true }), false);
  assert.equal(isFirstRun({ ...base, onb: null }), false, 'nothing is known yet');
});

test('the first chat: a box that says what to make, until the first message is sent', () => {
  assert.equal(FIRST_PLACEHOLDER, 'Tell Claude what to make, for example: a web page with a clock');
  assert.equal(FIRST_PLACEHOLDER_SHORT, 'Tell Claude what to make', 'a box too narrow for the example keeps the first half');
  assert.ok(FIRST_PLACEHOLDER.startsWith(FIRST_PLACEHOLDER_SHORT));
  assert.equal(isFirstChat(), false);
  markFirstChat();
  assert.equal(isFirstChat(), true);
  doneFirstChat();
  assert.equal(isFirstChat(), false, 'a second chat is an ordinary one');
});
