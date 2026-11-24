// A made-up big machine for the size budgets: 100 sessions, 200 repositories, 10 computers, with long names and
// something wrong in many places at once.

import { NOW, ago, session } from './cases.mjs';

const long = (s, n) => `${s}-${'x'.repeat(n)}`.slice(0, n);
const GiB = 1024 ** 3;

export function bigSources() {
  const sessions = Array.from({ length: 100 }, (_, i) => session({
    name: long(`session-${i}`, 60),
    provider: long(`provider-${i % 5}`, 40),
    state: ['working', 'waiting', 'attention', 'ended'][i % 4],
    asks: i % 4 === 2 ? ['main', `agent${i}`] : [],
    askType: i % 4 === 2 ? 'permission' : null,
    askAt: i % 4 === 2 ? ago(30) : null,
    progressAt: ago(i % 3 ? 45 : 1),
    statusAt: ago(30),
    toolNow: i % 3 ? { name: 'Bash', since: ago(45) } : null,
    limit: i % 10 === 0 ? { at: ago(20), text: long("You've hit your weekly limit", 120), resetsAt: '2026-03-12T09:00:00Z' } : null,
    // A provider stop of the session's own (a lost sign-in) on some, of one of its agents (a refused model name) on others.
    stop: i % 10 === 5 ? { at: ago(15), reason: 'auth', text: long('Invalid API key · Fix external API key', 120) } : null,
    agents: Array.from({ length: 3 }, (_, j) => ({ id: `ag${i}${j}`, label: long('Check the shop page', 60), state: 'working', limit: null,
      stop: i % 10 === 7 && j === 0 ? { at: ago(10), reason: 'model', text: long("API Error: 400 Ambiguous model 'relay-large'", 120) } : null })),
  }));
  const repos = Array.from({ length: 200 }, (_, i) => ({
    name: long(`example/repository-${i}`, 60), path: `p${i}/code/r${i}`, project: `p${i}`, branch: long('feature-branch', 40), upstream: 'origin/main',
    behind: i % 3, ahead: i % 2, dirty: i % 5, fetchedAt: ago(60),
  }));
  return {
    sessions: () => sessions,
    work: () => ({ open: 140, plans: 12, runs: Array.from({ length: 60 }, (_, i) => ({ id: `r-${i}`, title: long('A task with a long title', 90), state: ['running', 'failed', 'done'][i % 3], endedAt: ago(i + 1), reason: long('a reason', 100) })) }),
    providers: () => Array.from({ length: 8 }, (_, i) => ({ name: long(`provider-${i}`, 40), signedIn: i !== 3, usage: { fiveHour: { pct: 80 + i, resetsAt: ago(-60) }, week: { pct: 90 + i, resetsAt: ago(-3000) }, at: ago(1) } })),
    gateways: () => Array.from({ length: 3 }, (_, i) => ({ name: `gate${i}`, port: 20000 + i, running: true, answers: i !== 1 })),
    live: () => ({ local: { status: 200 }, link: { on: true, status: 530, since: ago(10) } }),
    computers: () => Array.from({ length: 10 }, (_, i) => ({ name: long(`computer-${i}`, 40), online: i % 2 === 0 })),
    repos: () => repos,
    changes: () => Array.from({ length: 20 }, (_, i) => ({ where: 'brain', commit: `${i}`.padStart(12, 'a'), at: ago(i + 1), by: 'the upkeep', files: i, subject: long('Upkeep', 100) })),
    schedules: () => Array.from({ length: 30 }, (_, i) => ({ name: long(`schedule-${i}`, 40), on: i % 2 === 0 })),
    machine: () => ({ cpus: 4, load1: 9.5, memTotal: 16 * GiB, memAvailable: 1 * GiB, disks: [{ mount: '/', usedPct: 91 }], tmp: { usedPct: 88 } }),
    leftovers: () => Array.from({ length: 12 }, (_, i) => ({ what: 'tmux', pid: 9000 + i, socket: `sock-${i}`, startedAt: ago(200), clients: 0, parentAlive: false, panes: [{ command: 'bash', children: 0 }] })),
  };
}
export { NOW };
