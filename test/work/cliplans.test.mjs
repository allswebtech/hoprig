// hoprig tasks plans | plan <id>: the plans from a terminal, with --json; a proposal not answered yet is on Today.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-cliplans');
test.after(() => t.cleanup());
const { main } = await import('../../src/work/cli.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');
const { acceptProposal } = await import('../../src/work/planstore.mjs');
const { writeProposal, placeKey } = await import('../../src/work/proposals.mjs');
fs.mkdirSync(path.join(t.projects, 'shop'), { recursive: true });
t.repo(t.brain, { 'README.md': '# brain\n' });

async function work(...args) {
  let out = '';
  let err = '';
  const code = await main(args, { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`) });
  return { code, out, err, json: args.includes('--json') && out ? JSON.parse(out) : null };
}

test('plans and plan, with --json and as text; a refusal names what is wrong', async () => {
  let r = await work('plans');
  assert.equal(r.code, 0);
  assert.match(r.out, /no plans yet/);
  const place = resolvePlace({});
  const ctx = { today: '2026-11-18', ownerId: 'me', projects: ['shop'] };
  const a = await acceptProposal(place, {
    title: 'Make the shop faster', goal: 'Two seconds on a phone.', projects: ['shop'], note: '## Research\n- Big images.',
    milestones: [{ title: 'Images small', date: '2026-12-02' }],
    tasks: [
      { title: 'Measure the page', date: '2026-11-24', milestone: 0, by: 'ai', after: [], brief: 'Measure it.', check: null, project: null },
      { title: 'Shrink the images', date: null, milestone: 0, by: 'ai', after: [0], brief: null, check: null, project: null },
    ],
  }, ctx);
  r = await work('plans', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.plans.map((p) => [p.id, p.progress]), [[a.plan, { done: 0, all: 2 }]]);
  r = await work('plans');
  assert.match(r.out, new RegExp(`active\\s+0 of 2 done\\s+next \\d{4}-\\d{2}-\\d{2}\\s+${a.plan}\\s+Make the shop faster`));
  // A plan id longer than the others (up to 40 characters and its mark): every title still starts in one column.
  const b = await acceptProposal(place, {
    title: 'Move every shop page to the new layout and its colours', goal: 'One look everywhere.', projects: ['shop'], note: '', milestones: [],
    tasks: [{ title: 'List the pages', date: null, milestone: null, by: 'me', after: [], brief: null, check: null, project: null }],
  }, ctx);
  const cols = (await work('plans')).out.trim().split('\n').map((l) => l.indexOf(l.includes('Move every') ? 'Move every' : 'Make the shop'));
  assert.equal(new Set(cols).size, 1, `one column for the titles: ${cols}`);
  assert.ok(b.plan.length > 30);
  r = await work('plan', a.plan);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Goal: Two seconds on a phone\./);
  assert.match(r.out, /Images small {2}\(2026-12-02, 0 of 2 done\)/);
  assert.match(r.out, /shrink-the-images {2}Shrink the images {2}\(waits for measure-the-page\)/);
  assert.match(r.out, /Research note\n {2}## Research/);
  r = await work('plan', a.plan, '--json');
  assert.equal(r.json.plan.milestones[0].tasks.length, 2);
  assert.equal(r.json.note, '## Research\n- Big images.');
  r = await work('plan', 'no-such-plan', '--json');
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /no plan "no-such-plan"/);
  r = await work('plan');
  assert.equal(r.code, 2);
  assert.match(r.err, /plan needs the id of a plan/);
  r = await work('plans', '--dry-run');
  assert.equal(r.code, 2);

  // A proposal not answered yet waits on Today.
  writeProposal({ v: 1, id: '20261118-090000-01020304', place: placeKey(place), goal: 'Grow the blog', project: 'shop', also: [], tool: 'claude', provider: 'sub', model: null, effort: null, session: null, conversation: null, message: null, startedAt: '2026-11-18T09:00:00.000Z', endedAt: null, state: 'working', reason: null, answer: '', proposal: null, problem: null, cleaned: false });
  r = await work('today');
  assert.match(r.out, /Plans to look at \(on the dashboard's Work page\)\n {2}A session is planning: Grow the blog/);
});
