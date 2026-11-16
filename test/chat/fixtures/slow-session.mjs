#!/usr/bin/env node
// A stand-in for the launcher that starts as the real one does: its run record names the conversation of --resume
// (src/launch.mjs conversationOf) but has no reported one at first (status starting), which Claude Code reports only
// after the milliseconds written in <state>/slow-session-ms (0 when the file is absent), as when Claude Code's
// SessionStart hook comes late (a slow start, a question on the screen first).
// Lines typed into it are echoed ("GOT: …"). Another coding tool's launch starts with the tool's word (deck.mjs
// launchArgv: "opencode <provider> --resume <id>"), and its record carries that tool, as src/codetools/terminal.mjs does.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRun, removeRun, updateRun } from '../../../src/runs.mjs';

const given = process.argv.slice(2);
const tool = ['opencode', 'codex'].includes(given[0]) ? given.shift() : 'claude';
const [profile, ...args] = given;
const r = args.indexOf('--resume');
const sessionId = r >= 0 ? args[r + 1] : `5e551011-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`;
let slow = 0;
try {
  slow = Number(fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'slow-session-ms'), 'utf8')) || 0;
} catch {
  /* reports at once */
}
const { file } = createRun({ profile, cwd: process.cwd(), carryArgs: [], tool, conversation: r >= 0 ? sessionId : null });
process.stdout.write(`SLOW-SESSION tool=${tool} profile=${profile} slow=${slow} args=${JSON.stringify(args)}\n`);
const known = () => updateRun(file, { sessionId, status: 'waiting', lastMessage: 'Ready.' });
if (slow) setTimeout(known, slow);
else known();
const bye = () => {
  removeRun(file);
  process.exit(0);
};
process.on('SIGHUP', bye);
process.on('SIGTERM', bye);
readline.createInterface({ input: process.stdin }).on('line', (line) => process.stdout.write(`GOT: ${line}\n`)).on('close', bye);
