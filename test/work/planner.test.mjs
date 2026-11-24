// A planning tool's file (deadlines.json, items with owner and brands) used by Work as it is: Work says so and asks
// for "your id in this file" (filled with the id the file uses most) before it writes a new item; a status that tool
// does not know is written as "open" with Work's own `state`, so that tool still counts the item as open work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE, tempWork } from './helpers.mjs';

const t = tempWork('work-planner');
test.after(() => t.cleanup());
const { main } = await import('../../src/work/cli.mjs');
const { loadConfig } = await import('../../src/config.mjs');
t.repo(t.brain, { 'README.md': '# brain\n', 'work/deadlines.json': fs.readFileSync(FIXTURE, 'utf8') });
const file = path.join(t.brain, 'work', 'deadlines.json');

async function tasks(...args) {
  let out = '';
  let err = '';
  const code = await main(args, { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`) });
  return { code, out, err };
}

test('a planner file: the owner\'s id is asked first, then new items are written in its words', async () => {
  const before = fs.readFileSync(file, 'utf8');
  let r = await tasks('add', 'Renew the domain');
  assert.equal(r.code, 1);
  assert.match(r.err, /this Work list is kept in a planning file\. First type your name or initials, as that file uses them, in Settings → Work → "Your id in a planning file"\. New items then get the same form\./);
  assert.doesNotMatch(r.err, /in that tool/, 'the field is in this dashboard, not in the planning tool');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written with a word that tool does not know');
  r = await tasks('owner');
  assert.match(r.out, /this file does not use it; it uses "alex" most: hoprig tasks owner alex/);
  r = await tasks('owner', 'alex');
  assert.equal(r.code, 0, r.err);
  assert.equal(loadConfig().work.ownerId, 'alex');
  r = await tasks('add', 'Renew the domain', '--json');
  assert.equal(r.code, 0, r.err);
  const added = JSON.parse(fs.readFileSync(file, 'utf8')).items.find((x) => x.id === 'renew-the-domain');
  assert.equal(added.owner, 'alex');
  assert.equal(added.source, 'alex');
  assert.equal('by' in added, false);
});

test('a planner file: waiting, review and doing are written as open with Work\'s state, and read back', async () => {
  for (const st of ['waiting', 'review', 'doing']) {
    const r = await tasks('edit', 'renew-the-domain', '--status', st);
    assert.equal(r.code, 0, r.err);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')).items.find((x) => x.id === 'renew-the-domain');
    assert.deepEqual([raw.status, raw.state], ['open', st], 'the planning tool counts it as open work');
    const list = JSON.parse((await tasks('list', '--json')).out).items;
    assert.equal(list.find((x) => x.id === 'renew-the-domain').status, st, 'Work reads its own state back');
  }
  await tasks('done', 'renew-the-domain');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')).items.find((x) => x.id === 'renew-the-domain');
  assert.deepEqual([raw.status, 'state' in raw], ['done', false]);
});
