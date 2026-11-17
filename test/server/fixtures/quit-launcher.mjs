#!/usr/bin/env node
// Stands in for the launcher and its coding tool where text typed into a running session matters. Like Claude Code it
// reads its terminal raw and asks for bracketed paste, so what arrives is what was typed, byte for byte: each message
// (up to an Enter outside a paste) goes as a JSON line to <cwd>/got.jsonl. It writes a run record that says it waits;
// when a file named QUIT appears in its folder it removes its record and ends at once, as the real launcher does when
// its coding tool ends: the terminal is back at its own shell. A file named STOP stops it (as Ctrl-Z would): its record
// stays and still says it waits, but the shell has the terminal in front.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRun, removeRun, updateRun } from '../../../src/runs.mjs';
import { applyLaunch } from '../../../src/launchfile.mjs';

applyLaunch();
const [profile] = process.argv.slice(2);
const { file } = createRun({ profile, cwd: process.cwd(), carryArgs: [] });
updateRun(file, { sessionId: crypto.randomUUID(), status: 'waiting', lastMessage: 'Ready when you are.', stopAt: Date.now() });
const bye = () => {
  removeRun(file);
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* no terminal */
  }
  process.stdout.write('\x1b[?2004l');
  process.exit(0);
};
process.on('SIGHUP', bye);
process.on('SIGTERM', bye);
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004hSTANDIN-READY\r\n');

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  for (;;) {
    // An Enter (CR) ends a message unless it is inside a bracketed paste.
    let i = -1;
    let inPaste = false;
    for (let j = 0; j < buf.length; j++) {
      if (buf.startsWith('\x1b[200~', j)) inPaste = true;
      else if (buf.startsWith('\x1b[201~', j)) inPaste = false;
      else if (buf[j] === '\r' && !inPaste) {
        i = j;
        break;
      }
    }
    if (i < 0) break;
    const msg = buf.slice(0, i);
    buf = buf.slice(i + 1);
    fs.appendFileSync(path.join(process.cwd(), 'got.jsonl'), `${JSON.stringify(msg)}\n`);
    process.stdout.write(`GOT ${msg.length}\r\n`);
  }
});
const quit = path.join(process.cwd(), 'QUIT');
const stop = path.join(process.cwd(), 'STOP');
setInterval(() => {
  if (fs.existsSync(quit)) {
    fs.rmSync(quit, { force: true });
    bye();
  }
  if (fs.existsSync(stop)) {
    fs.rmSync(stop, { force: true });
    process.kill(process.pid, 'SIGSTOP');
  }
}, 30);
