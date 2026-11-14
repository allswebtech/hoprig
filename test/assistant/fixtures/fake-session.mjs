#!/usr/bin/env node
// A stand-in for the launcher in Tia's dashboard tests: no real Claude Code, no quota. It registers a run record
// like the launcher, prints how it was called, and when it was started with a first message (after "--") it
// "works" on it for a moment: status working, then waiting with "Done: <message>" as its last message, and the
// message saved to TASK.txt in its folder. Lines typed into it are echoed ("GOT: …").
import fs from 'node:fs';
import readline from 'node:readline';
import { createRun, removeRun, updateRun } from '../../../src/runs.mjs';

const [profile, ...args] = process.argv.slice(2);
const r = args.indexOf('--resume');
const sessionId = r >= 0 ? args[r + 1] : `5e551011-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`;
const dd = args.indexOf('--');
const prompt = dd >= 0 ? args.slice(dd + 1).join(' ') : null;
const { file } = createRun({ profile, cwd: process.cwd(), carryArgs: [] });
updateRun(file, { sessionId, status: prompt ? 'working' : 'waiting', lastMessage: 'Ready.' });
process.stdout.write(`FAKE-SESSION profile=${profile} args=${JSON.stringify(args)}\n`);
if (prompt) {
  setTimeout(() => {
    // Under another name first: whoever waits for TASK.txt to exist must never find it still empty.
    fs.writeFileSync('TASK.txt.part', prompt);
    fs.renameSync('TASK.txt.part', 'TASK.txt');
    process.stdout.write(`Done: ${prompt}\n`);
    updateRun(file, { status: 'waiting', lastMessage: `Done: ${prompt}` });
  }, 2500);
}
const bye = () => {
  removeRun(file);
  process.exit(0);
};
process.on('SIGHUP', bye);
process.on('SIGTERM', bye);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  process.stdout.write(`GOT: ${line}\n`);
  updateRun(file, { lastMessage: `GOT: ${line}` });
}).on('close', bye);
