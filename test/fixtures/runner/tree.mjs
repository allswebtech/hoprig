// A test file for test/seal.test.mjs: what the ps stand-in and the /proc listing show a test. SEAL_OTHER_PID is a tmux
// server the seal's own test started OUTSIDE this file's tree (on a made-up socket of its own); this file starts one of
// its own on another made-up socket, then prints which of the two each way of looking sees, and ends its own server
// by its socket name. It does nothing for the seal itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Only the runner's stand-in is asked: without it this file looks at nothing (a run without the stand-ins then fails
// the seal's test, and the computer's own ps is never started).
const psFound = process.env.PATH.split(path.delimiter).map((d) => path.join(d, 'ps')).find((f) => fs.existsSync(f));
const standIn = !!psFound && path.dirname(psFound) === process.env.HOPRIG_TEST_TRAPS;

test('looks at the process table', () => {
  const socket = `seal-own-${process.pid}`;
  spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', 'sleep 60']);
  try {
    const own = Number(spawnSync('tmux', ['-L', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).stdout.trim());
    const other = Number(process.env.SEAL_OTHER_PID);
    if (!standIn) { console.log('TREE {"standIn":false}'); return; }
    const ps = new Set(spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').map((l) => Number(l.trim().split(/\s+/)[0])).filter(Boolean));
    const proc = new Set(fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number));
    const byPid = spawnSync('ps', ['-o', 'pid=', '-p', String(other)], { encoding: 'utf8' });
    console.log(`TREE ${JSON.stringify({ own: own > 0, psOwn: ps.has(own), psOther: ps.has(other), psSelf: ps.has(process.pid), procOwn: proc.has(own), procOther: proc.has(other), byPidOther: byPid.stdout.trim(), byPidStatus: byPid.status })}`);
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
