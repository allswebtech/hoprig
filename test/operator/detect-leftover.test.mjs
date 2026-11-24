import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLeftover } from '../../src/operator/detect/leftover.mjs';
import { NOW, ago } from './fixtures/cases.mjs';

const tmux = (pid, socket, min, extra = {}) => ({ what: 'tmux', pid, socket, startedAt: ago(min), clients: 0, parentAlive: false, panes: [{ command: 'bash', children: 0 }], proc: `L:${pid}:900`, ...extra });

test('four tmux servers left behind for hours are four items, each to end by its identity', () => {
  const board = { port: 7400, leftovers: [tmux(4101, 'test-a', 190), tmux(4102, 'test-b', 185), tmux(4103, 'test-c', 180), tmux(4104, 'test-d', 175)] };
  const items = detectLeftover(board, { now: NOW });
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.subject), ['tmux server test-a', 'tmux server test-b', 'tmux server test-c', 'tmux server test-d']);
  assert.equal(items[0].recommended, 'end');
  // The identity goes with the target: the end act refuses a target without it ("cannot be named exactly").
  assert.deepEqual(items[0].target, { pid: 4101, startedAt: ago(190), what: 'tmux', socket: 'test-a', proc: 'L:4101:900', temp: false }, 'no temporary folder in the fixture: not a test\'s');
  assert.ok(items[0].facts.includes('process 4101, running for 3 h 10 min'), items[0].facts.join('|'));
});

test('a young one, one with a client, or one whose parent lives is not a leftover', () => {
  const board = { leftovers: [tmux(1, 'young', 9), tmux(2, 'watched', 60, { clients: 1 }), tmux(3, 'owned', 60, { parentAlive: true })] };
  assert.deepEqual(detectLeftover(board, { now: NOW }), []);
});

test('a tmux server that runs a program, whose shell has a child of any name, or whose panes could not be read, is at work: never offered for ending', () => {
  const sh = (command, children = 0) => ({ command, children });
  const board = { leftovers: [
    tmux(1, 'work', 60, { panes: [sh('bash'), { command: 'claude', children: null }] }),
    tmux(2, 'job', 60, { panes: [{ command: 'sleep', children: null }] }),
    tmux(3, 'unread', 60, { panes: null }),
    tmux(5, 'subshell', 60, { panes: [sh('bash', 1)] }),
    tmux(6, 'second', 60, { panes: [sh('bash'), sh('zsh', 2)] }),
    tmux(7, 'unknown', 60, { panes: [sh('bash', null)] }),
    tmux(8, 'oldshape', 60, { panes: ['bash'] }),
    tmux(4, 'idle', 60, { panes: [sh('-zsh'), sh('bash')] }),
  ] };
  const items = detectLeftover(board, { now: NOW });
  assert.deepEqual(items.map((i) => i.subject), ['tmux server idle']);
  assert.ok(items[0].facts.includes('its shells run nothing (2 panes, no child process)'), items[0].facts.join('|'));
  assert.match(items[0].why, /^Its shells run nothing/);
  assert.doesNotMatch(items[0].why, /only holds memory|Nothing but a shell/);
});

test('a dashboard on another port than the configured one', () => {
  const board = { port: 7400, leftovers: [
    { what: 'dashboard', pid: 5001, port: 7931, startedAt: ago(45) },
    { what: 'dashboard', pid: 5002, port: 7400, startedAt: ago(45) },
  ] };
  const items = detectLeftover(board, { now: NOW });
  assert.deepEqual(items.map((i) => i.subject), ['dashboard on port 7931']);
});

test('no source gives nothing', () => {
  assert.deepEqual(detectLeftover({ leftovers: null }, { now: NOW }), []);
});
