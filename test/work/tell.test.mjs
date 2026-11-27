// Being told (src/work/tell.mjs, tellmsg.mjs, tellsettings.mjs): off until turned on; one message per event, also
// across a restart and with two dashboards; at most one in the gap, the held ones as ONE; "waits for you" past the
// gap; quiet hours across midnight; a night down told once as one; a digest never with nothing new; a failed send
// tried again, three times at most. Messages go to a stand-in and once to a receiver of this test's own on a port
// of its own, never to a real service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-tell');
test.after(() => t.cleanup());
const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
const { inQuiet, ledgerFile, readLedger, teller } = await import('../../src/work/tell.mjs');
const { LINE_MAX, TITLE_MAX, digestMessage, digestTemplate, groupMessage, oneMessage } = await import('../../src/work/tellmsg.mjs');
const { cleanTell, tellOn, tellSettings } = await import('../../src/work/tellsettings.mjs');
const { cleanNotify, sendNotification } = await import('../../src/server/notify.mjs');

const M = 60_000;
const H = 60 * M;
let NOW = Date.parse('2026-11-19T12:00:00Z');
const place = { folder: path.join(t.root, 'workdata'), label: 'ai_brain/work' };
fs.mkdirSync(place.folder, { recursive: true });
const items = [];
const recs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
fs.mkdirSync(recs, { recursive: true });

let k = 0;
/** A run that finished `ago` ms before NOW (its task in review), or failed; `writer`: another dashboard's. */
function finish(title, { state = 'done', ago = M, writer = writerId(), reason = null } = {}) {
  k += 1;
  const item = `task-${k}`;
  const end = NOW - ago;
  writeRun(place, {
    v: 1, id: newRunId(new Date(end - 20 * M)), item, title, writer, by: 'owner', startedAt: new Date(end - 20 * M).toISOString(), endedAt: new Date(end).toISOString(),
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: null, conversation: null, message: null, brief: 'Do it',
    state, reason, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null,
  });
  items.push({ id: item, status: state === 'done' ? 'review' : 'open' });
  return item;
}
function start(title, ago) {
  k += 1;
  writeRun(place, {
    v: 1, id: newRunId(new Date(NOW - ago)), item: `task-${k}`, title, writer: writerId(), by: 'owner', startedAt: new Date(NOW - ago).toISOString(), endedAt: null,
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: null, conversation: null, message: null, brief: 'Do it',
    state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null,
  });
}
const clear = () => {
  fs.rmSync(path.join(place.folder, 'runs'), { recursive: true, force: true });
  items.length = 0;
  for (const f of fs.readdirSync(recs)) fs.rmSync(path.join(recs, f));
  fs.rmSync(ledgerFile(), { force: true });
};

let cfg = {};
const sent = [];
let answer = () => ({ sent: true });
const mk = () => teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, send: async (m) => {
  sent.push(m);
  return answer(m);
} });
/** Move the clock to `to` the way a running dashboard does: a tick every few minutes (a longer silence is a down time). */
const walk = async (a, to, step = 4 * M) => {
  while (NOW + step < to) {
    NOW += step;
    await a.tick();
  }
  NOW = to;
  await a.tick();
};
const on = (work) => (cfg = { work: { timeZone: 'UTC' }, server: { notify: { url: 'http://127.0.0.1:8211/t', work } } });

test('today\'s config gets none of it: a push address with no events list, and one with every event', async () => {
  clear();
  finish('Cart fix');
  for (const notify of [{ url: 'https://ntfy.example/t' }, { url: 'https://ntfy.example/t', events: ['waiting', 'attention', 'limit', 'ended', 'switched', 'automation'] }]) {
    cfg = { server: { notify } };
    assert.equal(tellOn(tellSettings(cfg)), false);
    sent.length = 0;
    assert.deepEqual(await mk().tick(), { off: true });
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(ledgerFile()), false, 'nothing written with everything off');
  }
  assert.equal(tellOn(tellSettings({ server: { work: { finished: true } } })), false, 'no push address: nowhere to tell');
});

test('the settings are checked: each item on or off, the minutes and hours in range, quiet hours both or neither', () => {
  assert.deepEqual(cleanTell({ finished: true, gapMinutes: 0 }), { finished: true, gapMinutes: 0 });
  for (const bad of [{ finished: 'yes' }, { waitsMinutes: 0 }, { digestHours: 25 }, { quietFrom: '22:00' }, { quietFrom: '25:00', quietTo: '07:00' }, { quietFrom: '07:00', quietTo: '07:00' }, { other: true }]) {
    assert.throws(() => cleanTell(bad), Error, JSON.stringify(bad));
  }
  assert.equal(cleanNotify({ url: 'https://ntfy.example/t', work: { digest: true } }).work.digest, true);
  const s = tellSettings({ server: { notify: { url: 'x', work: { finished: 'bad' } } } });
  assert.equal(s.finished, false, 'a bad value read back is its default');
});

test('turned on, it starts from now; then one message per event, also after a restart', async () => {
  clear();
  finish('Old one', { ago: 2 * H });
  on({ finished: true, gapMinutes: 0 });
  sent.length = 0;
  await mk().tick();
  assert.equal(sent.length, 0, 'what finished before he turned it on is not told');
  NOW += M;
  finish('Cart fix');
  const a = mk();
  await a.tick();
  await a.tick();
  assert.deepEqual(sent, [{ title: 'Done: Cart fix', body: 'Open Work → Tasks to look at it and accept it.' }]);
  NOW += M;
  await mk().tick(); // a restart: a new teller on the same state folder
  assert.equal(sent.length, 1);
});

test('two dashboards on one Work folder: only the one that ran it tells', async () => {
  clear();
  on({ finished: true, gapMinutes: 0 });
  await mk().tick();
  sent.length = 0;
  NOW += M;
  finish('Not mine', { writer: '0123456789abcdef' });
  await mk().tick();
  assert.equal(sent.length, 0);
});

test('at most one in the gap; the held ones go as ONE that names them', async () => {
  clear();
  on({ finished: true, failed: true, gapMinutes: 10 });
  await mk().tick();
  sent.length = 0;
  NOW += M;
  finish('First');
  const a = mk();
  await a.tick();
  assert.equal(sent.length, 1);
  NOW += M;
  finish('Second');
  finish('Third', { state: 'failed', reason: 'The run ended in an error: the tests failed' });
  await a.tick();
  assert.equal(sent.length, 1, 'held inside the gap');
  await walk(a, NOW + 8 * M, M);
  assert.equal(sent.length, 1, 'still inside the gap');
  await walk(a, NOW + M, M);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, '1 done, 1 failed');
  assert.equal(sent[1].body, 'Open Work → Tasks to look at them.\nSecond and Third');
});

test('fifty finishing in one burst: one message, and it names them truthfully', async () => {
  clear();
  on({ finished: true, gapMinutes: 10 });
  await mk().tick();
  sent.length = 0;
  NOW += M;
  for (let i = 0; i < 50; i++) finish(`Task number ${i + 1}`);
  await mk().tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '50 done');
  assert.match(sent[0].body.split('\n')[1], /^Task number \d+, .* and \d+ more$/);
  const [, shown, more] = /^(.*) and (\d+) more$/.exec(sent[0].body.split('\n')[1]);
  assert.equal(shown.split(', ').length + Number(more), 50);
});

test('down for a night with twelve events: exactly one message when it is back', async () => {
  clear();
  on({ finished: true, failed: true, gapMinutes: 10 });
  await mk().tick();
  sent.length = 0;
  NOW += 10 * H;
  for (let i = 0; i < 9; i++) finish(`Night task ${i + 1}`, { ago: (i + 1) * 30 * M });
  for (let i = 0; i < 3; i++) finish(`Broken ${i + 1}`, { state: 'stopped', ago: (i + 1) * 40 * M, reason: 'Stopped at the time limit (30 minutes); what it had done so far is kept' });
  const a = mk();
  await a.tick();
  await a.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'While it was off: 9 done, 3 stopped');
  assert.ok(sent[0].title.length <= TITLE_MAX);
});

test('quiet hours across midnight hold everything; it goes as one at their end', async () => {
  assert.equal(inQuiet({ quietFrom: '22:00', quietTo: '07:00' }, Date.parse('2026-11-19T23:30:00Z'), 'UTC'), true);
  assert.equal(inQuiet({ quietFrom: '22:00', quietTo: '07:00' }, Date.parse('2026-11-19T06:59:00Z'), 'UTC'), true);
  assert.equal(inQuiet({ quietFrom: '22:00', quietTo: '07:00' }, Date.parse('2026-11-19T07:00:00Z'), 'UTC'), false);
  assert.equal(inQuiet({ quietFrom: '22:00', quietTo: '07:00' }, Date.parse('2026-11-19T17:00:00Z'), 'Asia/Kolkata'), true, '22:30 there');
  clear();
  NOW = Date.parse('2026-11-19T21:50:00Z');
  on({ finished: true, waits: true, gapMinutes: 10, quietFrom: '22:00', quietTo: '07:00' });
  const a = mk();
  await a.tick();
  sent.length = 0;
  for (const at of ['22:30', '23:30', '00:30', '06:30']) {
    await walk(a, Date.parse(`2026-11-${at < '12' ? '20' : '19'}T${at}:00Z`));
    finish(`At ${at}`);
    await a.tick();
  }
  await walk(a, Date.parse('2026-11-20T06:59:00Z'));
  assert.equal(sent.length, 0, 'nothing in quiet hours');
  await walk(a, Date.parse('2026-11-20T07:00:30Z'), M);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '4 done');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('"waits for you" after 15 minutes, past the gap, once per wait', async () => {
  clear();
  on({ finished: true, waits: true, gapMinutes: 10 });
  const rec = (askAt) => fs.writeFileSync(path.join(recs, 'w.json'), JSON.stringify({ runId: 'w', pid: 4242, cwd: path.join(t.projects, 'alpha'), sessionId: null, status: 'attention', startedAt: NOW - H, statusAt: askAt, askAt }));
  const a = mk();
  await a.tick();
  sent.length = 0;
  NOW += M;
  finish('Just now');
  await a.tick();
  assert.equal(sent.length, 1, 'a finished one opens the gap');
  rec(NOW - 14 * M);
  await a.tick();
  assert.equal(sent.length, 1, '14 minutes: not yet');
  NOW += 2 * M;
  await a.tick();
  assert.equal(sent.length, 2, '16 minutes, inside the gap: told all the same');
  assert.deepEqual(sent[1], { title: 'A session in alpha waits for you', body: 'Open it on the dashboard and answer (waiting 16 min).' });
  NOW += M;
  await a.tick();
  assert.equal(sent.length, 2, 'the same wait is told once');
  rec(NOW - 20 * M + 1);
  await a.tick();
  assert.equal(sent.length, 3, 'a new question is a new wait');
});

test('a digest every N hours while work runs, never one with nothing new', async () => {
  clear();
  on({ digest: true, digestHours: 4 });
  const a = mk();
  await a.tick();
  sent.length = 0;
  NOW += 4 * H;
  await a.tick();
  assert.equal(sent.length, 0, 'nothing ran, nothing ended: no digest');
  start('Long job', 30 * M);
  finish('Quick job', { ago: 10 * M });
  NOW += 4 * H;
  // The running job is now 4 h 30 old; the quick one ended 4 h 10 ago, before the last digest's time: not new as
  // done, but its task is still in review, so it still waits for him.
  await a.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Work: 1 waits for you, 1 running');
  assert.match(sent[0].body, /^Open Work → Tasks to look at what waits for you\.\nRunning: Long job, no estimate yet$/);
  NOW += 4 * H;
  await a.tick();
  assert.equal(sent.length, 1, 'the same running job and nothing ended: nothing new, no digest');
});

test('a receiver that fails: tried again after 1, 5 and 30 minutes, then given up once', async () => {
  clear();
  on({ finished: true, gapMinutes: 0 });
  const logs = [];
  const a = teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, log: (l) => logs.push(l), send: async (m) => {
    sent.push({ ...m, at: NOW });
    return answer(m);
  } });
  await a.tick();
  sent.length = 0;
  answer = () => ({ sent: false, error: 'the receiver answered 500' });
  try {
    NOW += M;
    finish('Flaky');
    const t0 = NOW;
    await a.tick();
    await walk(a, NOW + 60 * M, M);
    assert.deepEqual(sent.map((m) => (m.at - t0) / M), [0, 1, 6, 36]);
    assert.equal(readLedger().held.length, 0);
    assert.equal(logs.filter((l) => /given up/.test(l)).length, 1);
  } finally {
    answer = () => ({ sent: true });
  }
});

test('a receiver down for a minute and a half: the message still arrives', async () => {
  clear();
  on({ finished: true, gapMinutes: 10 });
  const arrived = [];
  const back = NOW + 2 * M;
  const a = teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, send: async (m) => {
    if (NOW < back) return { sent: false, error: 'timed out' };
    arrived.push(m.title);
    return { sent: true };
  } });
  await a.tick();
  try {
    NOW += 30_000;
    finish('Through the outage', { ago: 0 });
    await walk(a, NOW + 20 * M, 30_000);
    assert.deepEqual(arrived, ['Done: Through the outage']);
  } finally {
    answer = () => ({ sent: true });
  }
});

test('a ledger cut short or removed starts anew without telling again', async () => {
  clear();
  on({ finished: true, gapMinutes: 0 });
  finish('Told before');
  await mk().tick();
  fs.writeFileSync(ledgerFile(), '{"v":1,"se');
  sent.length = 0;
  await mk().tick();
  assert.equal(sent.length, 0);
});

test('every message fits a lock screen: a title of 50 at most, a first line of 90 at most, no path', () => {
  const long = 'A very long task title that goes on and on about the checkout page and its tests';
  const msgs = [
    oneMessage({ what: 'finished', title: long }), oneMessage({ what: 'live', title: long }),
    oneMessage({ what: 'failed', title: long, state: 'failed', reason: `The run ended in an error: ${'x'.repeat(300)}` }),
    oneMessage({ what: 'failed', title: long, state: 'stopped', reason: 'Stopped at the time limit' }),
    oneMessage({ what: 'waits', project: 'a-project-with-a-long-name-for-sure', minutes: 16 }),
    groupMessage(Array.from({ length: 7 }, (_, i) => ({ what: i % 2 ? 'finished' : 'failed', title: `${long} ${i}` })), { off: true }),
    digestMessage(digestTemplate({ done: [{ title: long, tokens: 5 }], failed: [], running: [{ title: long, basis: { count: 3 }, eta: { past: false, doneFrom: '2026-11-19T10:00:00Z', doneTo: '2026-11-19T11:00:00Z' } }], waiting: [{}], tokens: 5, unreported: 0, tz: 'UTC' })),
  ];
  for (const m of msgs) {
    assert.ok(m.title.length <= TITLE_MAX, m.title);
    assert.ok(m.body.split('\n')[0].length <= LINE_MAX, m.body);
    for (const l of m.body.split('\n')) assert.ok(l.length <= LINE_MAX, l);
    assert.doesNotMatch(`${m.title}\n${m.body}`, /\/home\/|\/Users\/|[A-Z]:\\/);
  }
  assert.equal(msgs[2].body.split('\n')[1].length <= 80, true);
});

test('a digest of 10 running and 14 done fits what the push channel keeps, and still counts them all', async () => {
  const { buildRequest } = await import('../../src/server/notify.mjs');
  const long = 'A long title of a task about the checkout page and its tests';
  const running = Array.from({ length: 10 }, (_, i) => ({ title: `${long} ${i}`, basis: { count: 3 }, eta: { past: false, doneFrom: '2026-11-19T10:00:00Z', doneTo: '2026-11-19T11:00:00Z' } }));
  const done = Array.from({ length: 14 }, (_, i) => ({ title: `${long} done ${i}`, tokens: 1000 }));
  const failed = [{ title: `${long} failed` }];
  const m = digestMessage(digestTemplate({ done, failed, running, waiting: [{}, {}], tokens: 14000, unreported: 0, tz: 'UTC' }));
  const r = buildRequest({ url: 'https://ntfy.example.invalid/t' }, { force: true, status: 'automation', session: 'work', title: m.title, message: m.body, url: '' });
  assert.equal(r.body, m.body, `cut on the way out (${m.body.length} characters)`);
  assert.equal(m.title, 'Work: 2 wait for you, 10 running');
  assert.match(m.body, /more running|10 running/);
  assert.match(m.body, /Done \(14\): /);
  assert.match(m.body, /Failed or stopped \(1\): /);
  assert.match(m.body.split('\n').at(-1), /^Used: 14,000 tokens$/);
});

test('a message reaches a real receiver as the product sends it (a local one on this lane\'s port)', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      got.push({ title: req.headers.title, body: b });
      res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(8211, '127.0.0.1', r));
  try {
    const m = oneMessage({ what: 'finished', title: 'Cart fix' });
    const r = await sendNotification({ url: 'http://127.0.0.1:8211/t', format: 'ntfy' }, { force: true, status: 'automation', title: m.title, message: m.body, session: 'work' });
    assert.equal(r.sent, true);
    assert.deepEqual(got, [{ title: 'Done: Cart fix', body: 'Open Work → Tasks to look at it and accept it.' }]);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('a task still in review a week later is not told again when the ledger forgets it', async () => {
  clear();
  NOW = Date.parse('2026-11-20T12:00:00Z');
  on({ finished: true, gapMinutes: 0 });
  const a = mk();
  await a.tick();
  sent.length = 0;
  NOW += M;
  finish('Waits a long time');
  await a.tick();
  assert.equal(sent.length, 1);
  await walk(a, NOW + 9 * 24 * H, 6 * H);
  assert.equal(sent.length, 1, 'told once, in nine days of it waiting in review');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a clock set back an hour holds a message for the gap only, not for the hour', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ finished: true, gapMinutes: 10 });
  const a = mk();
  await a.tick();
  sent.length = 0;
  NOW += M;
  finish('Before');
  await a.tick();
  assert.equal(sent.length, 1);
  NOW -= 60 * M;
  finish('After set back', { ago: 0 });
  await walk(a, NOW + 11 * M, M);
  assert.equal(sent.length, 2, 'sent within the gap of 10 minutes');
  assert.equal(sent[1].title, 'Done: After set back');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('turned off for hours, or the push address removed, and on again: it starts from now, nothing is told as "while it was off"', async () => {
  for (const off of [{ finished: false, failed: false, gapMinutes: 10 }, null]) {
    clear();
    NOW = Date.parse('2026-11-19T12:00:00Z');
    on({ finished: true, failed: true, gapMinutes: 10 });
    const a = mk();
    await a.tick();
    sent.length = 0;
    if (off) on(off);
    else cfg = { work: { timeZone: 'UTC' }, server: { notify: { work: { finished: true, failed: true, gapMinutes: 10 } } } };
    for (let i = 0; i < 6; i++) {
      NOW += 30 * M;
      if (i < 3) finish(`While off ${i + 1}`, { state: i % 2 ? 'failed' : 'done', ago: 0 });
      await a.tick();
    }
    on({ finished: true, failed: true, gapMinutes: 10 });
    NOW += M;
    await a.tick();
    assert.equal(sent.length, 0, off ? 'items off' : 'no push address');
    NOW += M;
    finish('After it is on');
    await a.tick();
    assert.deepEqual(sent.map((m) => m.title), ['Done: After it is on']);
  }
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a schedule\'s run that ends well is told once as finished, pointing to Activity', async () => {
  clear();
  NOW = Date.parse('2026-11-20T12:00:00Z');
  on({ finished: true, gapMinutes: 0 });
  const a = mk();
  await a.tick();
  sent.length = 0;
  NOW += M;
  writeRun(place, {
    v: 1, id: newRunId(new Date(NOW - 30 * M)), item: 'nightlytidy', title: 'Nightly tidy', writer: writerId(), by: 'schedule', startedAt: new Date(NOW - 30 * M).toISOString(), endedAt: new Date(NOW - M).toISOString(),
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null, session: null, conversation: null, message: null, brief: 'Tidy',
    state: 'done', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null, branch: 'work/nightlytidy', schedule: 'nightlytidy',
  });
  await walk(a, NOW + 30 * M, M);
  assert.deepEqual(sent, [{ title: 'Done: Nightly tidy', body: 'Open Work → Activity to look at what it did.' }]);
});

test('down for 30 hours: what ended early in the down time is told too, in the one message', async () => {
  clear();
  NOW = Date.parse('2026-11-20T12:00:00Z');
  on({ finished: true, failed: true, gapMinutes: 10 });
  await mk().tick();
  sent.length = 0;
  NOW += 30 * H;
  finish('Early in the down time', { ago: 28 * H, state: 'failed', reason: 'The run ended in an error: the tests failed' });
  finish('Late in the down time', { ago: 2 * H });
  const a = mk();
  await walk(a, NOW + 30 * M, 2 * M);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'While it was off: 1 done, 1 failed');
  assert.match(sent[0].body, /Early in the down time/);
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a task accepted the next evening is told as accepted, also when its run ended more than a day before', async () => {
  clear();
  NOW = Date.parse('2026-11-20T12:00:00Z');
  on({ live: true, gapMinutes: 0 });
  const a = mk();
  finish('Accepted late', { ago: 25 * H });
  await a.tick();
  sent.length = 0;
  NOW += M;
  items[items.length - 1].status = 'done';
  await a.tick();
  NOW += M;
  await a.tick();
  assert.deepEqual(sent.map((m) => m.title), ['Accepted: Accepted late']);
});

test('a task accepted and left done is told as accepted once, also when the ledger\'s eight days have passed', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ live: true, gapMinutes: 0 });
  const a = mk();
  finish('Cart fix', { ago: 2 * H });
  await a.tick();
  sent.length = 0;
  NOW += M;
  items[items.length - 1].status = 'done';
  await a.tick();
  await walk(a, NOW + 9 * 24 * H);
  assert.deepEqual(sent.map((m) => m.title), ['Accepted: Cart fix'], 'told once in nine days of it staying done');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a task accepted is not told again after Work\'s list could not be read for nine days', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ live: true, gapMinutes: 0 });
  let unread = false;
  const a = teller({ cfg: () => cfg, place: () => { if (unread) throw new Error('no list'); return place; }, items: () => items, now: () => NOW, alive: () => true, send: async (m) => {
    sent.push(m);
    return answer(m);
  } });
  finish('Cart fix', { ago: 2 * H });
  await a.tick();
  sent.length = 0;
  NOW += M;
  items[items.length - 1].status = 'done';
  await a.tick();
  unread = true;
  await walk(a, NOW + 9 * 24 * H);
  unread = false;
  await walk(a, NOW + 20 * M);
  assert.deepEqual(sent.map((m) => m.title), ['Accepted: Cart fix'], 'told once, not again when the list came back');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a stop between "about to be sent" and "sent": the next start sends it once more, and only once', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ finished: true, gapMinutes: 0 });
  const first = mk();
  await first.tick();
  sent.length = 0;
  // The first teller's send never comes back: the dashboard stopped in the middle of it.
  const cut = [];
  const stopped = teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, send: (m) => {
    cut.push(m);
    return new Promise(() => {});
  } });
  finish('Cart fix', { ago: 0 });
  NOW += M;
  stopped.tick();
  for (let i = 0; i < 200 && !cut.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(cut.map((m) => m.title), ['Done: Cart fix'], 'it was on its way');
  assert.equal(readLedger().pending.length, 1, 'noted as about to be sent');
  // The next start: sent once more, then never again.
  const next = mk();
  NOW += M;
  await next.tick();
  await walk(next, NOW + 30 * M);
  assert.deepEqual(sent.map((m) => m.title), ['Done: Cart fix'], 'once after the restart, once only');
  assert.equal(readLedger().pending.length, 0);
  // Without a stop nothing is sent twice: a third start sends nothing.
  sent.length = 0;
  await walk(mk(), NOW + 30 * M);
  assert.deepEqual(sent, []);
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a message cut off twice by a stop is dropped, not sent for ever', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ finished: true, gapMinutes: 0 });
  await mk().tick();
  sent.length = 0;
  const hang = () => teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, send: (m) => {
    sent.push(m);
    return new Promise(() => {});
  } });
  finish('Cart fix', { ago: 0 });
  for (let k = 0; k < 2; k++) {
    NOW += M;
    const n = sent.length;
    hang().tick();
    for (let i = 0; i < 200 && sent.length === n; i++) await new Promise((r) => setTimeout(r, 10));
  }
  NOW += M;
  await walk(mk(), NOW + 30 * M);
  assert.deepEqual(sent.map((m) => m.title), ['Done: Cart fix', 'Done: Cart fix'], 'the first try and the one after the stop; none after the second stop');
  assert.equal(readLedger().pending.length, 0);
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a digest keeps the gap and names what was held, so nothing is told twice', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ finished: true, digest: true, digestHours: 4, gapMinutes: 10 });
  const a = mk();
  await a.tick();
  sent.length = 0;
  start('Long job', 0);
  await walk(a, Date.parse('2026-11-19T15:58:00Z'), M);
  finish('First', { ago: 0 });
  await a.tick();
  NOW += M;
  finish('Second', { ago: 0 });
  await a.tick();
  await walk(a, Date.parse('2026-11-19T16:30:00Z'), M);
  const at = sent.map((m) => m.title);
  assert.equal(at[0], 'Done: First');
  assert.equal(at.length, 2, at.join(' / '));
  assert.match(at[1], /^Work: /, 'the digest, after the gap');
  assert.match(sent[1].body, /Second/);
  assert.equal(sent.filter((m) => /Second/.test(`${m.title}\n${m.body}`)).length, 1, 'Second is told once');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('back after a down time with work running: one message, not one plus a digest', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ finished: true, digest: true, digestHours: 4, gapMinutes: 10 });
  await mk().tick();
  sent.length = 0;
  NOW += 10 * H;
  start('Long job', 30 * M);
  finish('Night one', { ago: 3 * H });
  finish('Night two', { ago: 2 * H });
  const a = mk();
  await walk(a, NOW + 30 * M, M);
  assert.deepEqual(sent.map((m) => m.title), ['While it was off: 2 done']);
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a digest whose send fails is tried again, and the next one is not silenced', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ digest: true, digestHours: 4 });
  const a = mk();
  await a.tick();
  sent.length = 0;
  start('Long job', 0);
  answer = () => ({ sent: false, error: 'the receiver answered 503' });
  try {
    await walk(a, Date.parse('2026-11-19T16:00:00Z'), 10 * M);
    assert.equal(sent.length, 1, 'tried at 16:00');
    answer = () => ({ sent: true });
    await walk(a, Date.parse('2026-11-19T16:05:00Z'), M);
    assert.equal(sent.length, 2, 'tried again a minute later, and sent');
    await walk(a, Date.parse('2026-11-20T00:01:00Z'), 10 * M);
    // 20:00 is the same running job with nothing new: none, as before; the one of 16:00 counted as sent.
    assert.equal(sent.length, 2);
  } finally {
    answer = () => ({ sent: true });
  }
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('at the end of quiet hours only what is still true goes', async () => {
  clear();
  NOW = Date.parse('2026-11-19T22:30:00Z');
  on({ finished: true, waits: true, gapMinutes: 10, quietFrom: '22:00', quietTo: '07:00' });
  const a = mk();
  await a.tick();
  sent.length = 0;
  NOW = Date.parse('2026-11-19T23:00:00Z');
  const item = finish('Cart fix', { ago: 0 });
  const rec = path.join(recs, 'q.json');
  fs.writeFileSync(rec, JSON.stringify({ runId: 'q', pid: 4242, cwd: path.join(t.projects, 'alpha'), sessionId: null, status: 'attention', startedAt: NOW - H, statusAt: NOW, askAt: NOW }));
  await walk(a, Date.parse('2026-11-19T23:30:00Z'), 5 * M);
  // He answers the session and accepts the task at 23:40.
  NOW = Date.parse('2026-11-19T23:40:00Z');
  fs.rmSync(rec);
  items.find((x) => x.id === item).status = 'done';
  await walk(a, Date.parse('2026-11-20T07:10:00Z'), 10 * M);
  assert.equal(sent.some((m) => /waits for you|look at (it|them)/.test(m.body + m.title)), false, sent.map((m) => m.title).join(' / '));
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('what is due goes before the digest waits for Tia\'s words; a stop waits for the sends', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  cfg = { work: { timeZone: 'UTC' }, server: { notify: { url: 'http://127.0.0.1:8211/t', work: { finished: true, waits: true, digest: true, digestHours: 4, gapMinutes: 0, tiaWords: true } } } };
  let release;
  const slow = new Promise((r) => (release = r));
  const a = teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, word: () => slow, closeWaitMs: 2000, send: async (m) => {
    sent.push(m);
    return { sent: true };
  } });
  await a.tick();
  sent.length = 0;
  start('Long job', 0);
  await walk(a, NOW + 4 * H - M, 4 * M);
  NOW += M;
  // Due on the same tick: a session that has waited 16 minutes, and a run that ended (the digest names it).
  fs.writeFileSync(path.join(recs, 'j.json'), JSON.stringify({ runId: 'j', pid: 4242, cwd: path.join(t.projects, 'alpha'), sessionId: null, status: 'attention', startedAt: NOW - H, statusAt: NOW - 16 * M, askAt: NOW - 16 * M }));
  finish('Due now', { ago: 0 });
  const ticking = a.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent.map((m) => m.title), ['A session in alpha waits for you'], 'sent while the wording is still asked');
  const closing = a.close();
  let closed = false;
  closing.then(() => (closed = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(closed, false, 'close waits for the tick in flight');
  release(null);
  await ticking;
  await closing;
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /^Work: /);
  assert.match(sent[1].body, /Done \(1\): Due now/, 'the run that ended is in the digest, not lost');
  fs.rmSync(path.join(recs, 'j.json'));
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a ledger that cannot be written is logged once, not at every tick', async () => {
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  on({ finished: true, gapMinutes: 0 });
  fs.mkdirSync(ledgerFile(), { recursive: true });
  const logs = [];
  const a = teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, log: (l) => logs.push(l), send: async () => ({ sent: true }) });
  try {
    for (let i = 0; i < 10; i++) {
      NOW += 30_000;
      await a.tick();
    }
    assert.equal(logs.length, 1, logs.join('\n'));
    const st = a.status();
    assert.equal(st.ok, false, 'Settings is told it cannot keep its record');
    assert.ok(st.since && st.error, JSON.stringify(st));
    NOW += H;
    await a.tick();
    assert.equal(logs.length, 2, 'again after an hour');
  } finally {
    fs.rmSync(ledgerFile(), { recursive: true, force: true });
  }
  NOW += M;
  await a.tick();
  assert.deepEqual(a.status(), { ok: true }, 'writable again: the notice goes');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a long project name is shortened, not the words that say it waits', () => {
  const m = oneMessage({ what: 'waits', project: 'a-very-long-project-folder-name-here-x', minutes: 16 });
  assert.ok(m.title.length <= TITLE_MAX, m.title);
  assert.match(m.title, /^A session in a-very-long.*… waits for you$/);
  const g = groupMessage([{ what: 'waits', project: 'a-very-long-project-folder-name-here-x' }, { what: 'waits', project: 'beta' }]);
  assert.match(g.body.split('\n')[1], /^a session in a-very-long.*… and a session in beta$/);
});

test('a failure\'s message keeps 80 of the tool\'s own words, after the product\'s lead-in is taken off', async () => {
  const { workUnits } = await import('../../src/work/pulse.mjs');
  clear();
  finish('Pay page', { state: 'failed', reason: 'The run ended in an error: the tests in checkout failed because the payment stand-in did not answer within the time it was given' });
  const u = (await workUnits({ place, cfg: {}, alive: () => true })).units.find((x) => x.title === 'Pay page');
  const why = oneMessage({ what: 'failed', title: u.title, state: 'failed', reason: u.reason }).body.split('\n')[1];
  assert.ok(why.length > 70 && why.length <= 80, why);
  assert.match(why, /^The tests in checkout failed because the payment stand-in did not answer/);
});

test('a failure\'s message points to what Activity has: why, not "start it again"', () => {
  const f = oneMessage({ what: 'failed', title: 'Pay page', state: 'failed', reason: 'the tests failed' });
  assert.equal(f.body.split('\n')[0], 'Open Work → Activity to see why.');
});

test('on an ntfy receiver a cut title ends in "...", and a worded title in another script arrives encoded, as it was worded', async () => {
  const { buildRequest } = await import('../../src/server/notify.mjs');
  const m = oneMessage({ what: 'finished', title: 'Fix the cart total when a coupon is applied twice' });
  const r = buildRequest({ url: 'https://ntfy.example.invalid/t' }, { force: true, status: 'automation', session: 'work', title: m.title, message: m.body });
  assert.equal(r.format, 'ntfy');
  assert.match(r.headers.Title, /\.\.\.$/);
  assert.doesNotMatch(r.headers.Title, /\?/);
  clear();
  NOW = Date.parse('2026-11-19T12:00:00Z');
  cfg = { work: { timeZone: 'UTC' }, server: { notify: { url: 'https://ntfy.example.invalid/t', work: { digest: true, digestHours: 4, tiaWords: true } } } };
  const worded = { title: 'काम: 1 चल रहा है', body: 'x' };
  const a = teller({ cfg: () => cfg, place: () => place, items: () => items, now: () => NOW, alive: () => true, word: async () => worded, send: async (x) => {
    sent.push(x);
    return { sent: true };
  } });
  await a.tick();
  sent.length = 0;
  start('Long job', 0);
  await walk(a, NOW + 4 * H, 10 * M);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, worded.title, 'her wording, not the plain digest');
  const h = buildRequest(cfg.server.notify, { force: true, status: 'automation', session: 'work', title: sent[0].title, message: sent[0].body }).headers.Title;
  assert.match(h, /^(=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/);
  assert.ok(h.split(' ').every((w) => w.length <= 75), 'each encoded word within 75 characters');
  const back = h.split(' ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
  assert.equal(back, worded.title, 'it decodes to the title, no question marks');
  NOW = Date.parse('2026-11-20T12:00:00Z');
});

test('a group message names each task once: a name that came twice says so, the count in the title stays per event', () => {
  const evs = [
    { what: 'finished', title: 'Nightly', schedule: true },
    { what: 'finished', title: 'Add the cart' },
    { what: 'finished', title: 'Nightly', schedule: true },
    { what: 'failed', state: 'failed', title: 'Pay page' },
  ];
  const m = groupMessage(evs, { off: true });
  assert.equal(m.title, 'While it was off: 3 done, 1 failed');
  const names = m.body.split('\n')[1];
  assert.equal(names, 'Nightly (2×), Add the cart and Pay page');
  assert.equal(names.split('Nightly').length, 2, 'Nightly is named once');
});
