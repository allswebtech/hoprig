// "Lead model" shown off with one plain line why (Hoprig cannot see what a part costs in a terminal, nor count it in
// the daily limit for paid use). New session does not ask for Lead any more. Driven in the page tests' stand-in for the
// browser's document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byClass, texts } from '../chat/fakedom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
globalThis.location ||= { hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost', origin: 'http://localhost' };
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.history ||= { replaceState() {} };
const asked = [];
globalThis.fetch = async (u) => {
  asked.push(String(u));
  return { ok: true, status: 200, json: async () => ({ can: true, line: 'Uses running and recording on haiku.', providers: [], tools: [], models: [], source: 'endpoint' }) };
};
const { LEAD_LABEL, LEAD_TERMINAL, leadSwitch } = await import('../../web/leadswitch.js');
const settle = () => new Promise((r) => setTimeout(r, 20));
const flag = (el, k) => el[k] === true || (el[k] === undefined && el.getAttribute(k) !== null);

test('the line says what is missing in plain words', () => {
  assert.match(LEAD_TERMINAL, /App session/);
  assert.match(LEAD_TERMINAL, /cost/);
  assert.match(LEAD_TERMINAL, /daily limit/);
  assert.doesNotMatch(LEAD_TERMINAL, /agent|subagent|hook|transcript|token|flag/i, 'no tool\'s inside word');
});

test('New session asks for no Lead: a start leaves it out, the chat\'s Lead chip and Settings hold it', () => {
  assert.doesNotMatch(read('web/newsession-options.js'), /leadSwitch|LEAD_/);
  assert.doesNotMatch(read('web/newsession-start.js'), /\blead:|st\.lead|leadTouched/);
});

test('leadSwitch with `off`: shown off whatever it is given, and its line', () => {
  const n = leadSwitch({ value: true, off: 'Not here.', onchange: () => {}, onothers: () => {}, others: ['alpha'] });
  const box = n.querySelector('input');
  assert.equal(flag(box, 'disabled'), true);
  assert.equal(flag(box, 'checked'), false);
  assert.equal(byClass(n, 'lead-line')[0].textContent, 'Not here.');
});

test('the README and the changelog say a terminal session shows it off, and why', () => {
  const readme = read('README.md').replace(/\n\s*/g, ' ');
  assert.match(readme, /A terminal session has no Lead: Hoprig cannot see what each part of a terminal session costs, so it cannot show or count its money in the daily limit for paid use as it does in the App\./);
  assert.match(read('site/content/changelog.md'), /\*\*Lead model is shown off for a terminal session, with one line why\.\*\*/);
});
