#!/usr/bin/env node
// Stands in for the real launcher in tests, so no real Claude Code session (and no quota) is ever used.
// It prints how it was called, registers a run record the way the launcher does, then echoes what it is sent.
// Sending "LIMIT" makes it print a real Claude Code usage-limit line ("MENU": with the menu Claude Code may open at a
// limit under it); "SLOW x" makes it "work" for 1.5 s before it answers (status working → waiting, like the hooks
// report), and every answer becomes the run's lastMessage.
import readline from 'node:readline';
import { createRun, removeRun, updateRun } from '../../../src/runs.mjs';

const [profile, ...args] = process.argv.slice(2);
const i = args.indexOf('--resume');
const sessionId = i >= 0 ? args[i + 1] : '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b';
const { file } = createRun({ profile, cwd: process.cwd(), carryArgs: ['--verbose'] });
updateRun(file, { sessionId, status: 'waiting', lastMessage: 'Ready when you are.' });
process.stdout.write(`FAKE-LAUNCH profile=${profile} args=${JSON.stringify(args)} cwd=${process.cwd()}\n`);
process.stdout.write('colors: \x1b[38;2;255;100;0mTRUECOLOR\x1b[0m box: ╭─╮ emoji: 🙂 wide: 漢字\n');

const bye = () => {
  removeRun(file);
  process.exit(0);
};
process.on('SIGHUP', bye);
process.on('SIGTERM', bye);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'LIMIT') process.stdout.write("  ⎿  You've hit your 5-hour limit · resets 5pm (UTC)\n");
  else if (line === 'MENU') process.stdout.write("  ⎿  You've hit your 5-hour limit · resets 5pm (UTC)\n\n  What do you want to do?\n  ❯ 1. Stop and wait for limit to reset\n    2. Switch to extra usage\n");
  else if (line.startsWith('SLOW ')) {
    updateRun(file, { status: 'working' });
    setTimeout(() => {
      process.stdout.write(`GOT: ${line}\n`);
      updateRun(file, { status: 'waiting', lastMessage: `Done: ${line.slice(5)}` });
    }, 1500);
  } else {
    process.stdout.write(`GOT: ${line}\n`);
    updateRun(file, { lastMessage: `GOT: ${line}` });
  }
}).on('close', bye);
