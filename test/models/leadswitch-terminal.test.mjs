// "Lead model" in New session → Options for a TERMINAL session of Claude Code: shown off, with one plain line why
// (Hoprig cannot see what a part costs there, nor count it in the daily limit for paid use), the way another coding
// tool shows it off. An App session keeps the switch as it was. Nothing is asked of the server for a switch shown off.
// Driven in the page tests' stand-in for the browser's document.
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
const { optionsFor } = await import('../../web/newsession-options.js');
const settle = () => new Promise((r) => setTimeout(r, 20));
const flag = (el, k) => el[k] === true || (el[k] === undefined && el.getAttribute(k) !== null);
const where = { profiles: [], recommended: 'team' };
const st = (o = {}) => ({ tool: 'claude', profile: '', permissionMode: '', effort: '', model: '', conversation: 'new', plain: false, ...o });
const leadOf = (nodes) => nodes.filter(Boolean).flatMap((n) => byClass(n, 'lead-switch'))[0] || null;

test('a terminal session of Claude Code: "Lead model" shown off, with one plain line why', async () => {
  asked.length = 0;
  const s = st({ lead: true }); // even a choice carried over is not shown on: a terminal cannot carry it
  const nodes = optionsFor({ st: s, where, run: 'claude', info: null, toolName: 'Claude Code', onplain: () => {} });
  const lead = leadOf(nodes);
  assert.ok(lead, 'the switch is shown');
  assert.ok(texts(lead).join(' ').includes(LEAD_LABEL));
  const box = lead.querySelector('input');
  assert.equal(flag(box, 'disabled'), true, 'off: it cannot be turned on here');
  assert.equal(flag(box, 'checked'), false, 'never shown on');
  assert.equal(byClass(lead, 'lead-line')[0].textContent, LEAD_TERMINAL, 'the one line why');
  assert.equal(byClass(lead, 'lead-others')[0].children.length, 0, 'no "Use other providers" under a switch shown off');
  await settle();
  assert.equal(asked.filter((u) => /\/api\/models\/(lead|others)/.test(u)).length, 0, 'nothing asked for a switch shown off');
});

test('the line says what is missing in plain words, and an App session keeps the switch', () => {
  assert.match(LEAD_TERMINAL, /App session/);
  assert.match(LEAD_TERMINAL, /cost/);
  assert.match(LEAD_TERMINAL, /daily limit/);
  assert.doesNotMatch(LEAD_TERMINAL, /agent|subagent|hook|transcript|token|flag/i, 'no tool\'s inside word');
  const lead = leadOf(optionsFor({ st: st(), where, run: 'chat', info: null, toolName: 'Claude Code', onplain: () => {} }));
  assert.ok(lead, 'the App has the switch');
  assert.equal(flag(lead.querySelector('input'), 'disabled'), false, 'and it can be turned on');
  assert.notEqual(byClass(lead, 'lead-line')[0].textContent, LEAD_TERMINAL);
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
  assert.match(readme, /A terminal session shows the switch off: Hoprig cannot see what each part of a terminal session costs, so it cannot show or count its money in the daily limit for paid use as it does in the App\./);
  assert.match(read('site/content/changelog.md'), /\*\*Lead model is shown off for a terminal session, with one line why\.\*\*/);
});
