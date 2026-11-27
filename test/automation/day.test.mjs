// End to end with fakes: one realistic day of the automations, driven tick by tick on a fake clock, with a fake
// deck that behaves like Claude sessions (typing makes Claude work; the test says when a reply ends or fails).
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAutomation } from '../../src/automation/index.mjs';
import { claude, fakeCtx, fakeDeck, fakeItem, shell, tmpDir } from './helpers.mjs';

const day = (h, m = 0, s = 0) => new Date(2026, 5, 2, h, m, s).getTime(); // Tuesday 2 June 2026
const SID = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;

test('a day with the automations', async () => {
  const t = tmpDir('day');
  let clock = day(6);
  const deck = fakeDeck([shell('scratch', { activity: day(6) })]);
  const find = (name) => deck.cards.find((c) => c.name === name);
  deck.onSend = (name) => Object.assign(find(name), { status: 'working', failure: null, statusAt: clock });
  let started = 0;
  deck.onStart = (name, o) => {
    started++;
    deck.cards.push(claude(name, { cwd: o.dir, profile: { name: o.profile }, status: 'waiting', statusAt: clock, stopAt: null, runId: `run${started}`, sessionId: o.sessionId || SID(started + 2), carryArgs: o.carryArgs || [] }));
  };
  const finish = (name) => Object.assign(find(name), { status: 'waiting', stopAt: clock, statusAt: clock });
  const fail = (name, error) => Object.assign(find(name), { status: 'attention', failure: { at: clock, error, text: 'API Error' }, statusAt: clock });

  // Yesterday the dashboard knew one session; the computer was switched off overnight (built-in terminals).
  fs.mkdirSync(path.join(t.dir, 'automation'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'automation', 'restore.json'), JSON.stringify({
    lastTickAt: day(0) - 3600_000,
    sessions: { 'api-work': { name: 'api-work', cwd: '/api', profile: 'api', sessionId: SID(1), carryArgs: ['--model', 'opus'], goneAt: null, shellSince: null } },
  }));
  const automation = {
    retry: { enabled: true },
    idle: { shells: true, shellHours: 2 },
    updates: { claude: 'notify' },
    schedules: {
      enabled: true, lateHours: 2,
      list: [
        { id: 'morning1', label: 'Morning checks', enabled: true, since: day(5), when: { kind: 'daily', time: '07:00' }, action: { type: 'start', dir: '/proj', profile: 'auto', prompt: 'morning checks' } },
        { id: 'evening1', label: 'Summary', enabled: true, since: day(5), when: { kind: 'weekly', time: '18:00', days: [2] }, action: { type: 'send', session: 'api-work', text: 'write the summary' } },
      ],
    },
  };
  // The old setting "notify" (read once into Settings → Version and updates: Manual, with a notification).
  const cc = fakeItem('claude', { title: 'Claude Code', info: { installed: '2.1.0', latest: '2.2.0', method: 'native', updateAvailable: true, canUpdate: true }, update: () => assert.fail('manual mode never updates') });
  const f = fakeCtx({ deck, automation, stateDir: t.dir, now: () => clock, updateItems: [cc] });
  let a = createAutomation(f.ctx);
  const at = async (h, m = 0, s = 0) => {
    clock = day(h, m, s);
    await a.tick();
  };

  try {
    // 06:00 the service starts: the lost session comes back resumed, nothing typed; one look for updates.
    await at(6, 0);
    assert.deepEqual(deck.started, [{ dir: '/api', profile: 'api', mode: 'move', sessionId: SID(1), carryArgs: ['--model', 'opus'], name: 'api-work' }]);
    assert.deepEqual(deck.sent, []);
    assert.equal(cc.calls.info, 1);
    await at(6, 5);

    // 07:00 the morning schedule starts a session on Auto; its first message goes as soon as it waits.
    await at(7, 0, 10);
    assert.equal(deck.started.length, 2);
    assert.deepEqual(deck.started[1], { dir: '/proj', profile: 'auto', mode: 'new' });
    const proj = 's2';
    await at(7, 0, 15);
    assert.deepEqual(deck.sent, [[proj, 'morning checks']]);

    // From the phone: "then A, then B".
    await a.api.changeQueue(proj, 'add', { text: 'A' });
    await a.api.changeQueue(proj, 'add', { text: 'B' });
    await at(7, 5);
    assert.equal(deck.sent.length, 1, 'Claude is still working');
    clock = day(7, 10); finish(proj);
    await at(7, 10, 5);
    assert.deepEqual(deck.sent.at(-1), [proj, 'A']);

    // A fails with an overloaded server: one retry a minute later, then the queue goes on.
    clock = day(7, 20); fail(proj, 'overloaded');
    await at(7, 20, 30);
    assert.equal(deck.sent.length, 2, 'no message into an error; the retry waits a minute');
    await at(7, 21, 0);
    assert.deepEqual(deck.sent.at(-1), [proj, 'Continue from where you stopped.']);
    clock = day(7, 30); finish(proj);
    await at(7, 30, 5);
    assert.deepEqual(deck.sent.at(-1), [proj, 'B']);
    clock = day(7, 40); finish(proj);
    await at(7, 40, 5);
    assert.equal(deck.sent.length, 4, 'queue empty');

    // 08:10 the idle shell (quiet since 06:00) is closed; the proj session has waited 30 minutes.
    await at(8, 10, 5);
    assert.deepEqual(deck.killed, ['scratch']);

    // Noon: the 6-hourly look finds the same version: no second message.
    await at(12, 0, 5);
    assert.equal(cc.calls.info, 2);

    // 12:30 the owner pauses everything; the 18:00 schedule waits; at 18:30 it runs, 30 minutes late.
    a.api.changeSettings({ paused: true });
    await at(18, 0, 10);
    assert.equal(deck.sent.length, 4);
    a.api.changeSettings({ paused: false });
    await at(18, 30, 0);
    await at(18, 30, 5);
    assert.deepEqual(deck.sent.at(-1), ['api-work', 'write the summary']);
    clock = day(18, 50); finish('api-work');

    // 19:00 the owner closes the proj session.
    await deck.kill(proj);
    await at(19, 0);
    await at(19, 5);

    // 23:00 the service restarts; the built-in terminals ended with it.
    await a.close();
    deck.cards = [];
    clock = day(23);
    a = createAutomation(f.ctx);
    await at(23, 0);
    await at(23, 0, 5);
    assert.deepEqual(deck.started.slice(2), [{ dir: '/api', profile: 'api', mode: 'move', sessionId: SID(1), carryArgs: ['--model', 'opus'], name: 'api-work' }], 'only the session the owner did not close');
    assert.equal(deck.sent.length, 5, 'a restart sends nothing');
    assert.deepEqual(f.config().updates, { mode: 'manual', notify: true }, 'the old setting moved once');
    assert.equal(f.config().automation.updates, undefined);

    assert.deepEqual(f.notes.map((n) => n.title), [
      'Claude Code 2.2.0 is available',
    ]);
    const log = a.activity.recent(100).reverse();
    assert.deepEqual(log.map((e) => `${e.automation}:${e.outcome.split(':')[0]}`), [
      'restore:ok', 'updates:told the owner', 'schedules:ok', 'queue:ok', 'queue:ok', 'retry:ok', 'queue:ok',
      'idle:ok', 'updates:nothing new', 'schedules:ok', 'updates:nothing new' /* 18:30, six hours on */, 'queue:ok', 'restore:ok',
    ]);
    assert.equal(cc.calls.info, 3, '06:00, 12:00 and 18:30; none while paused, none at the restart (6 hours not over)');
    assert.match(log.find((e) => e.automation === 'schedules' && /Summary/.test(e.did)).did, /ran 30 minutes late/);
  } finally {
    await a.close();
    t.cleanup();
  }
});
