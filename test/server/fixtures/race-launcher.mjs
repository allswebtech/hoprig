#!/usr/bin/env node
// Stands in for the launcher and its coding tool at the moment the tool ends. The parent keeps a run record that says
// it waits; its child (the tool) reads the terminal raw with bracketed paste on and appends every byte it gets to
// <cwd>/got.raw. When a file named QUIT appears the child ends as Claude Code does (bracketed paste off, cooked mode)
// and writes CHILD_EXITED; the parent then keeps its record for the milliseconds a file named WINDOW holds (none: 0),
// which makes the real launcher's moment between its tool's end and its own longer on purpose, and ends as the real
// launcher does (src/typinglock.mjs endRun: the record goes under the typing lock, the input is settled). With
// `--child` it is the tool alone, for the real launcher's claudeBin.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRun, updateRun } from '../../../src/runs.mjs';
import { applyLaunch } from '../../../src/launchfile.mjs';
import { endRun } from '../../../src/typinglock.mjs';

const at = (f) => path.join(process.cwd(), f);

if (process.argv[2] === '--child') {
  process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?2004hSTANDIN-READY\r\n');
  process.stdin.on('data', (d) => fs.appendFileSync(at('got.raw'), d));
  setInterval(() => {
    if (!fs.existsSync(at('QUIT'))) return;
    fs.rmSync(at('QUIT'), { force: true });
    process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?2004l');
    fs.writeFileSync(at('CHILD_EXITED'), String(Date.now()));
    process.exit(0);
  }, 10);
} else {
  applyLaunch();
  const { file } = createRun({ profile: process.argv[2], cwd: process.cwd(), carryArgs: [] });
  updateRun(file, { sessionId: crypto.randomUUID(), status: 'waiting', lastMessage: 'Ready.', stopAt: Date.now() });
  process.on('SIGINT', () => {});
  const child = spawn(process.execPath, [process.argv[1], '--child'], { stdio: 'inherit' });
  child.on('exit', () => {
    let windowMs = 0;
    try {
      windowMs = Number(fs.readFileSync(at('WINDOW'), 'utf8')) || 0;
    } catch {
      /* none */
    }
    setTimeout(() => endRun(file).then(() => process.exit(0)), windowMs);
  });
}
