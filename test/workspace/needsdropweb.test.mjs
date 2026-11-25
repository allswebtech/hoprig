// The drop from the Workspace page (dropweb.mjs) of a project that another project here names in its "needs": the
// sheet asks the terminal's own question first (dropcli.mjs QUESTION.needed), and only his press of that very answer
// sends `needed: true`; no press stops before anything is done. A need added between the sheet and the press makes
// the check change: nothing is dropped and the fresh check, with the question, comes back. Local bare repositories
// only (dropfix.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropWorld, getOn } from './dropfix.mjs';

const w = await dropWorld('needed-page');
test.after(() => w.cleanup());
const [A] = w.computers;
const { pageDrop } = await import('../../src/workspace/dropweb.mjs');
const { QUESTION } = await import('../../src/workspace/dropcli.mjs');
const page = pageDrop({ ctx: () => A.ctx, share: async () => ({ done: false }) });
const blogNeeds = (needs) => fs.writeFileSync(path.join(A.projects, 'blog', 'project.json'), JSON.stringify({ name: 'blog', repos: [], memories: {}, needs }, null, 2) + '\n');

test('the sheet asks "blog needs shop" in the terminal\'s words; only his press of that answer drops it', async () => {
  assert.equal((await getOn(A, ['shop'])).code, 0);
  assert.equal((await getOn(A, ['blog'])).code, 0);
  blogNeeds(['shop']);
  const c = await page.check('shop', { ticket: true });
  assert.match(c.ticket, /^[0-9a-f]{64}$/, JSON.stringify(c));
  const q = c.questions.find((x) => x.ask === 'needed');
  assert.ok(q, `a question about the need: ${JSON.stringify(c.questions)}`);
  assert.deepEqual(q.by, ['blog']);
  assert.equal(q.words, QUESTION.needed('shop'));
  assert.equal(q.words, 'Drop shop all the same?');
  assert.equal(q.why, QUESTION.neededWhy('shop', ['blog']));
  assert.equal(q.why, 'blog needs shop: it names it in "needs" and its sessions read it.');
  assert.equal(q.later, 'Without it here, a session there cannot read it until  hoprig get shop  brings it back.');
  assert.ok(!c.questions.some((x) => x.ask === 'confirm'), 'never taken for the typed-name question');
  // No press: stopped at that question, nothing removed, a fresh check with the question again.
  const no = await page.drop(c.ticket, {});
  assert.equal(no.result, 'stopped', JSON.stringify(no));
  assert.ok(fs.existsSync(A.shop), 'no press removes nothing');
  assert.ok(no.check.questions.some((x) => x.ask === 'needed'));
  // His press of that very answer: dropped.
  const yes = await page.drop(no.check.ticket, { needed: true });
  assert.equal(yes.result, 'dropped', JSON.stringify(yes));
  assert.ok(!fs.existsSync(A.shop));
});

test('a need added between the sheet and the press: the check changed, nothing is dropped, the question comes back', async () => {
  assert.equal((await getOn(A, ['shop'])).code, 0);
  blogNeeds([]);
  const c = await page.check('shop', { ticket: true });
  assert.ok(!c.questions.some((x) => x.ask === 'needed'), JSON.stringify(c.questions));
  blogNeeds(['shop']);
  // Even a press that says yes to it cannot answer a question the sheet never showed.
  const r = await page.drop(c.ticket, { needed: true });
  assert.equal(r.result, 'changed', JSON.stringify(r));
  assert.ok(fs.existsSync(A.shop), 'nothing is dropped');
  assert.ok(r.check.questions.some((x) => x.ask === 'needed' && x.by.includes('blog')), 'the fresh check asks it');
  // The other way: the need went away between the sheet and the press.
  blogNeeds([]);
  const r2 = await page.drop(r.check.ticket, { needed: true });
  assert.equal(r2.result, 'changed', JSON.stringify(r2));
  assert.ok(fs.existsSync(A.shop));
  const ok = await page.drop(r2.check.ticket, {});
  assert.equal(ok.result, 'dropped', JSON.stringify(ok));
});
