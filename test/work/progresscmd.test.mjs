// `hoprig tasks progress [--json]` and GET /api/work/progress (src/work/cli.mjs, feature.mjs): both read the one
// progress function, so on the made-up history they say exactly what it says, and the text holds every number of
// the JSON.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tempWork } from './helpers.mjs';
import { makeHistory } from './pulsehome.mjs';

const t = tempWork('work-progresscmd');
test.after(() => t.cleanup());
const h = await makeHistory(t);
const { main } = await import('../../src/work/cli.mjs');
const { readProgress } = await import('../../src/work/pulse.mjs');
const { workFeature } = await import('../../src/work/feature.mjs');

const cfg = { work: { timeZone: 'UTC' } };
const cmd = async (...args) => {
  let out = '';
  let err = '';
  const code = await main(args, { cfg, out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`), now: () => h.NOW });
  return { code, out, err };
};

test('--json is the progress function\'s own answer', async () => {
  const r = await cmd('progress', '--json', '--since', '2026-11-10T00:00Z');
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  const want = await readProgress({ cfg, place: h.place, items: h.items, now: h.NOW, since: Date.parse('2026-11-10T00:00Z') });
  assert.deepEqual(j, JSON.parse(JSON.stringify(want)));
  assert.equal(j.counts.running, 5, 'four runs and one session\'s workflow');
  assert.equal(j.counts.failed, 1);
});

test('the text holds the line and every estimate with its basis', async () => {
  const r = await cmd('progress', '--since', '2026-11-10T00:00Z');
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse((await cmd('progress', '--json', '--since', '2026-11-10T00:00Z')).out);
  assert.ok(r.out.startsWith(j.line));
  for (const u of j.running) assert.ok(r.out.includes(u.basis.text), u.title);
  for (const u of j.running) if (u.eta.doneTo) assert.ok(r.out.includes(u.eta.text), u.title);
  assert.ok(r.out.includes('about 5 h 30 to 8 h 30, from 4 like it'));
  assert.ok(r.out.split('\n').every((l) => l.length <= 200));
});

test('a bad --since is refused with the way to write it; progress takes no id', async () => {
  const r = await cmd('progress', '--since', 'yesterday');
  assert.equal(r.code, 2);
  assert.match(r.err, /since is a time/);
  assert.equal((await cmd('progress', 'x')).code, 2);
  assert.match((await cmd('help')).out, /tasks progress/);
});

test('the route gives the same', async () => {
  const f = workFeature({ config: () => cfg, readJson: async () => ({}) }, { now: () => new Date(h.NOW) });
  const route = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/work/progress'));
  const q = new URLSearchParams('since=2026-11-10T00:00Z');
  const j = await route[2]({ headers: {} }, null, q);
  const c = JSON.parse((await cmd('progress', '--json', '--since', '2026-11-10T00:00Z')).out);
  assert.deepEqual(JSON.parse(JSON.stringify(j)), c);
  await assert.rejects(route[2]({ headers: { authorization: 'Bearer tia_x' } }, null, q), /owner's only/);
});

test('the digest says what the line and the command say: the same counts, names and estimates', async () => {
  const { digestTemplate, digestMessage } = await import('../../src/work/tellmsg.mjs');
  const j = JSON.parse((await cmd('progress', '--json', '--since', '2026-11-10T00:00Z')).out);
  const reported = j.done.filter((u) => u.tokens !== null);
  const tpl = digestTemplate({ done: j.done, failed: j.failed, running: j.running, waiting: j.waiting, tz: 'UTC', tokens: reported.reduce((n, u) => n + u.tokens, 0), unreported: j.done.length - reported.length });
  const m = digestMessage(tpl);
  assert.equal(m.title, `Work: ${j.counts.waiting} wait for you, ${j.counts.running} running`);
  assert.match(m.body, new RegExp(`Done \\(${j.counts.done}\\): `));
  assert.match(m.body, new RegExp(`Failed or stopped \\(${j.counts.failed}\\): Pay page`));
  // The running ones it names (as many as fit in what the push channel keeps, three at most), each with the same
  // "done by" times and basis count as the command; the rest are counted.
  const named = (m.body.match(/^Running: /gm) || []).length;
  assert.ok(named >= 1 && named <= 3, m.body);
  for (const u of j.running.slice(0, named)) {
    if (u.basis.count < 2) assert.match(m.body, new RegExp(`Running: ${u.title}, no estimate yet`));
    else {
      const [, a, b] = /done by about (\d\d:\d\d) to (\d\d:\d\d)/.exec(u.eta.text);
      assert.ok(m.body.includes(`Running: ${u.title}, done by about ${a} to ${b} (from ${u.basis.count} like it)`), u.title);
    }
  }
  assert.match(m.body, new RegExp(`And ${j.counts.running - named} more running`));
  assert.match(m.body, new RegExp(`Used: ${reported.reduce((n, u) => n + u.tokens, 0).toLocaleString('en-US')} tokens \\(${j.done.length - reported.length} did not report\\)`));
});

test('the digest arrives whole through the push channel: the made-up home over four hours and over nine days', async () => {
  const { digestTemplate, digestMessage } = await import('../../src/work/tellmsg.mjs');
  const { buildRequest } = await import('../../src/server/notify.mjs');
  for (const since of [h.NOW - 4 * 3_600_000, Date.parse('2026-11-10T00:00Z')]) {
    const p = await readProgress({ cfg, place: h.place, items: h.items, now: h.NOW, since });
    const reported = p.done.filter((u) => u.tokens !== null);
    const m = digestMessage(digestTemplate({ done: p.done, failed: p.failed, running: p.running, waiting: p.waiting, tz: 'UTC', tokens: reported.length ? reported.reduce((n, u) => n + u.tokens, 0) : null, unreported: p.done.length - reported.length }));
    const r = buildRequest({ url: 'https://ntfy.example.invalid/t' }, { force: true, status: 'automation', session: 'work', title: m.title, message: m.body, url: '' });
    assert.equal(r.body, m.body, `cut on the way out (${m.body.length} characters)`);
    const last = m.body.split('\n').at(-1);
    assert.match(last, /^Used: (not reported|[\d,]+ tokens( \(\d+ did not report\))?)$/);
  }
});

test('progress --help prints its own lines, each within 80 columns', async () => {
  const r = await cmd('progress', '--help');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^usage: hoprig tasks progress \[--since 12h\|<time>\]/);
  assert.doesNotMatch(r.out, /tasks add/);
  for (const l of r.out.trimEnd().split('\n')) assert.ok(l.length <= 80, l);
  assert.equal((await cmd('do', '--help')).code, 0);
  // With no command named, --help is the whole usage, as before.
  assert.match((await cmd('--help')).out, /tasks progress[\s\S]*tasks save/);
});

test('the digest the teller sends says what the command says over the same window', async () => {
  const path = await import('node:path');
  const { teller } = await import('../../src/work/tell.mjs');
  const { digestTemplate, digestMessage } = await import('../../src/work/tellmsg.mjs');
  const c = { work: { timeZone: 'UTC' }, server: { notify: { url: 'http://127.0.0.1:8212/t', work: { digest: true, digestHours: 2 } } } };
  const sent = [];
  // Two hours: the task in review ended three hours ago, before the window, and still waits for him.
  let at = h.NOW - 2 * 3_600_000;
  const a = teller({ cfg: () => c, place: () => h.place, items: () => h.items, now: () => at, file: path.join(t.root, 'told-parity.json'), send: async (m) => (sent.push(m), { sent: true }) });
  await a.tick(); // starts from now: the digest is due two hours on
  while (at < h.NOW) {
    at = Math.min(at + 4 * 60_000, h.NOW);
    await a.tick();
  }
  assert.equal(sent.length, 1, 'one digest at the end of its window');
  const j = JSON.parse((await cmd('progress', '--json', '--since', new Date(h.NOW - 2 * 3_600_000).toISOString())).out);
  const reported = j.done.filter((u) => u.tokens !== null);
  const want = digestMessage(digestTemplate({ done: j.done, failed: j.failed, running: j.running, waiting: j.waiting, tz: 'UTC', tokens: reported.length ? reported.reduce((n, u) => n + u.tokens, 0) : null, unreported: j.done.length - reported.length }));
  assert.deepEqual(sent[0], want);
  // The review that ended before the window still waits for him, in both.
  assert.ok(Date.parse(j.waiting.find((u) => u.why === 'review').endedAt) < h.NOW - 2 * 3_600_000);
  assert.equal(j.counts.waiting, 2);
  assert.match(sent[0].title, /^Work: 2 wait for you/);
});
