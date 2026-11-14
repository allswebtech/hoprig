import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRuns } from '../../src/server/deck.mjs';
import { descendsFrom } from '../../src/server/platform.mjs';

// A process tree: 100 (pane shell) → 110 (launcher) ; 200 (other pane shell) → 210 (launcher)
const parents = { 110: 100, 100: 50, 50: 1, 210: 200, 200: 50, 999: 1 };
const parentOf = (pid) => parents[pid] ?? null;

test('ancestry', () => {
  assert.equal(descendsFrom(110, 100, parentOf), true);
  assert.equal(descendsFrom(100, 100, parentOf), true);
  assert.equal(descendsFrom(210, 100, parentOf), false);
  assert.equal(descendsFrom(999, 100, parentOf), false);
  assert.equal(descendsFrom(5, 100, () => null), true, 'no /proc: trust the pane id');
});

test('runs are matched to panes by pane id AND process ancestry, newest wins', () => {
  const panes = [{ id: '%1', pid: 100 }, { id: '%2', pid: 200 }, { id: '%3', pid: 300 }];
  const runs = [
    { runId: 'a', tmuxPane: '%1', pid: 110, startedAt: 1, status: 'working' },
    { runId: 'b', tmuxPane: '%1', pid: 110, startedAt: 2, status: 'waiting' },
    { runId: 'c', tmuxPane: '%2', pid: 110, startedAt: 3, status: 'working' }, // claims %2 but runs in %1's tree
    { runId: 'd', tmuxPane: '%2', pid: 210, startedAt: 1, status: 'ended' }, // ended runs do not count
    { runId: 'e', tmuxPane: null, pid: 210, startedAt: 1, status: 'working' },
  ];
  const m = matchRuns(panes, runs, parentOf);
  assert.equal(m.get('%1').runId, 'b');
  assert.equal(m.has('%2'), false);
  assert.equal(m.has('%3'), false);
});

test('pty terminals are matched by the run\'s termId alone; tmux and pty runs never cross', () => {
  const terms = [{ id: 'pty-aaaaaaaaaaaa', pid: 500 }, { id: 'pty-bbbbbbbbbbbb', pid: 600 }, { id: '%1', pid: 100 }];
  const runs = [
    { runId: 'p1', termId: 'pty-aaaaaaaaaaaa', tmuxPane: null, pid: 999, startedAt: 1, status: 'working' }, // ancestry not needed
    { runId: 'p2', termId: 'pty-aaaaaaaaaaaa', tmuxPane: null, pid: 998, startedAt: 2, status: 'waiting' }, // newer, after a respawn
    { runId: 'p3', termId: 'pty-bbbbbbbbbbbb', tmuxPane: null, pid: 997, startedAt: 3, status: 'ended' },
    { runId: 't1', termId: null, tmuxPane: '%1', pid: 110, startedAt: 1, status: 'working' },
    { runId: 'x', termId: '%1', tmuxPane: 'pty-bbbbbbbbbbbb', pid: 110, startedAt: 9, status: 'working' }, // ids of the other kind
  ];
  const m = matchRuns(terms, runs, parentOf);
  assert.equal(m.get('pty-aaaaaaaaaaaa').runId, 'p2');
  assert.equal(m.has('pty-bbbbbbbbbbbb'), false, 'ended runs do not count; a tmuxPane value is not a pty match');
  assert.equal(m.get('%1').runId, 't1', 'a termId never stands in for a tmux pane (which needs ancestry)');
});
