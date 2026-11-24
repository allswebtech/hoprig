// Where Tia cannot answer: the top banner has no Settings link when there is nothing to set (every subscription at its
// limit). Sent to the daily limit's field by "Set a daily limit for paid use", he finds its Save right under it (the
// panel's own save, nothing saved without his press); the long text of what counts is under "More".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], on: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.on[k] = fn;
  }
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
const branch = src.slice(src.indexOf("if (e.kind === 'notice') {"), src.indexOf("if (e.kind === 'done') {"));

test('the banner: no Settings link while every subscription is at its limit', () => {
  assert.equal(typeof tia.bannerLink, 'function');
  assert.equal(tia.bannerLink({ ok: false, code: 'subs-limited', problem: 'x' }), null);
  assert.equal(tia.bannerLink({ ok: false, problem: 'No provider can run Tia.' }).attrs.href, '#/settings/tia');
});

test('sent to the daily limit: a Save right under the field; the long text under "More"', () => {
  assert.equal(typeof tia.capSaveWanted, 'function');
  assert.equal(tia.capSaveWanted('#/settings/tia?show=tia-daily-cap'), true);
  assert.equal(tia.capSaveWanted('#/settings/tia'), false);
  assert.equal(tia.capSaveWanted('#/settings/tia?show=tia-daily-capx'), false);
  // The same save as the panel's, nothing saved without his press; the field, its Save, today's words, then "More".
  assert.match(src, /saveBar\('Save', saveAll\)/);
  assert.match(src, /'Daily limit for paid use \(US \$\)'\), cap, capSave, backSlot, spentLine, fold\('tia-cap-more', 'What counts against the limit', h\('p\.hint', v\.help\.dailyCapUsd\)\)\)/);
  assert.match(src, /placeholder: 'No limit'/);
});

test('after a Save the line under the field is drawn again: a limit just set is never "No daily limit"', () => {
  assert.equal(typeof tia.savedSpend, 'function', 'the line under the field is drawn once and never again');
  const before = { cap: null, today: { spent: 0, held: 0, unmeasured: 0 } };
  // The server's answer to the Save (the settings view, its spend read after the save).
  const answer = { spend: { cap: 5, today: { spent: 0, held: 0, unmeasured: 0 } } };
  assert.equal(tia.spentWords(tia.savedSpend(answer, before, 5)), 'Today: $0 spent. $0 of your $5.00 daily limit is used.');
  // An answer without spend: today's figures with the limit just saved; the limit emptied again says so.
  assert.doesNotMatch(tia.spentWords(tia.savedSpend({}, before, 5)), /No daily limit/);
  assert.match(tia.spentWords(tia.savedSpend({}, { cap: 5, today: { spent: 0, held: 0 } }, null)), /No daily limit/);
  // Both Saves go through saveAll, which draws the line again from the answer.
  const saveAll = src.slice(src.indexOf('const saveAll = async () => {'), src.indexOf('pollOverview();', src.indexOf('const saveAll = async () => {')));
  assert.match(saveAll, /const r = await api\(`\$\{A\}\/settings`/);
  assert.match(saveAll, /spentLine\.textContent = spentWords\(savedSpend\(r, sp, st\.dailyCapUsd\)\);/);
});
