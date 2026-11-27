// Page words on Providers, Home and Work for a first-time reader: the pay-per-use switch covers a sign-in billed by
// use too, so it is not named after API keys; a provider's check has no "endpoint"; the button to add a refusing
// computer again says the step, with no arrow; Home draws no empty folder line and says "it is working again"; Work
// says whose tasks are missing, names the button to press for an interrupted save, and its two places have two labels.
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
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener() {}, querySelector: () => null, body: new FakeElement('body') };
globalThis.location ??= { hostname: '127.0.0.1', pathname: '/', hash: '', origin: 'http://127.0.0.1' };
globalThis.window ??= { addEventListener() {} };
globalThis.fetch = () => new Promise(() => {});

const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const texts = (n) => (n instanceof FakeText ? [n.text] : typeof n === 'string' ? [n] : (n.children || []).flatMap(texts));

test('the pay-per-use switch is named for every provider billed by use, not after API keys', async () => {
  const acc = read('web/accounts.js');
  assert.match(acc, /toggle\('Also use pay-per-use providers', auto\.payPerUse === true,/);
  assert.doesNotMatch(acc, /pay-per-use API keys/);
  const { autoHelp, autoToast } = await import('../../web/accounts.js');
  const signIn = { label: 'Account', kind: 'claude-login', paid: true, inAuto: false };
  assert.match(autoHelp(signIn, false), /"Also use pay-per-use providers"/);
  assert.match(autoToast(signIn, true, { payPerUseTurnedOn: true }), /"Also use pay-per-use providers" is now on/);
  for (const f of ['docs/PROVIDERS.md', 'docs/OPERATOR.md', 'src/router.mjs', 'README.md']) assert.doesNotMatch(read(f), /pay-per-use API keys/, f);
});

test('a provider\'s check says "address", never "endpoint"', () => {
  const ph = read('web/providerhealth.js');
  assert.doesNotMatch(ph, /h\('p\.hint', '[^']*endpoint/);
  assert.match(ph, /'This is about the provider\\'s address, not about a model name:/);
});

test('the button to add a refusing computer again says the step, with no arrow in its words', async () => {
  const { wayLink } = await import('../../web/lib.js');
  const b = wayLink({ code: 'computer-not-allowed' });
  assert.equal(b.attrs.href, '#/computers/add');
  assert.equal(texts(b).join(''), 'Add a computer');
  assert.doesNotMatch(texts(b).join(''), /→/);
});

test('no button of the table of ways carries an arrow, in an error or on an Operator card', async () => {
  const { WAYS } = await import('../../web/errorways.js');
  const { wayLink } = await import('../../web/lib.js');
  const { placeLinks } = await import('../../web/operator-ways.js');
  for (const code of Object.keys(WAYS)) {
    assert.doesNotMatch(texts(wayLink({ code })).join(''), /→/, code);
    const links = placeLinks([code]);
    if (links) assert.doesNotMatch(texts(links).join(''), /→/, code);
  }
});

test('Home: no folder line for a session without a folder, and "it is working again"', async () => {
  const { folderWorthShowing, changedSince } = await import('../../web/sessionitem.js');
  assert.equal(folderWorthShowing({ name: 'shop' }), false);
  assert.equal(folderWorthShowing({ name: 'shop', short: '' }), false);
  assert.equal(folderWorthShowing({ name: 'shop', short: '~/src/shop' }), true);
  const was = { status: 'waiting', statusAt: 1, lastMessage: 'Which one?' };
  assert.equal(changedSince(was, { ...was, status: 'working' }), 'it is working again');
});

test('Work: "No tasks of your own yet" once (no second Add button), the button the interrupted save names, two places with two labels', async () => {
  const work = read('web/work.js');
  assert.doesNotMatch(work, /'No tasks yet\./);
  assert.equal(work.match(/'No tasks of your own yet\. /g).length, 1);
  assert.doesNotMatch(work, /Add your first task|label: 'Add a task'/, 'the page\'s own Add task is the one door');
  assert.match(work, /label: 'Drop the record'/);
  for (const f of ['src/work/planstore.mjs', 'src/work/resume.mjs']) assert.ok(read(f).includes('press "Drop the record" on the Work page, or run hoprig tasks save --drop-interrupted'), f);
  const { wayOf } = await import('../../web/errorways.js');
  assert.equal(wayOf({ code: 'interrupted' }).label, 'Work');
  assert.equal(wayOf({ code: 'work-place-gone' }).label, 'Work settings');
  assert.equal(wayOf({ code: 'owner-id' }).label, 'Work settings');
});
