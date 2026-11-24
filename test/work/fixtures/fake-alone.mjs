#!/usr/bin/env node
// A stand-in for Claude Code in a run that ends by itself (src/work/alone.mjs): `-p <prompt> --output-format
// stream-json …`. What it does is chosen by a word in the prompt:
//   DO:commit   writes notes.txt, commits it, leaves draft.txt changed and not committed, ends well
//   DO:nothing  ends well with "Nothing to report."
//   DO:sleep    says it starts, then waits for ever (the time limit ends it)
//   DO:refuse   ends well, with a step that needed an OK refused (permission_denials)
//   DO:fail     ends in an error
//   DO:movemain moves the branch main to its own HEAD (git update-ref) and says there is nothing to report
//   DO:ignoreterm  ignores SIGTERM and waits for ever
//   DO:escape   ignores SIGTERM, and starts a process in a group of its own that holds the output for 20 s
// It writes its arguments and pid to $FAKE_ALONE_ARGS when that is set, and the escaped process's pid to $FAKE_ALONE_PIDS.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_ALONE_ARGS) fs.appendFileSync(process.env.FAKE_ALONE_ARGS, `${JSON.stringify({ args, cwd: process.cwd(), pid: process.pid })}\n`);
// As Claude Code's parser does: an argument that starts with "-" and is no option it knows is refused. The prompt is
// the argument after -p when there is one, else what comes on stdin.
const VALUED = ['--output-format', '--permission-mode', '--model', '--effort'];
const FLAGS = ['-p', '--verbose', '--allow-dangerously-skip-permissions'];
let given = null;
for (let i = 0; i < args.length; i++) {
  if (VALUED.includes(args[i])) i++;
  else if (FLAGS.includes(args[i])) continue;
  else if (args[i].startsWith('-')) {
    process.stderr.write(`error: unknown option '${args[i].slice(0, 40)}'\n`);
    process.exit(1);
  } else if (given === null) given = args[i];
}
const prompt = given ?? (() => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
})();
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const text = (t) => say({ type: 'assistant', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', message: { content: [{ type: 'text', text: t }] } });
const result = (o) => say({ type: 'result', subtype: 'success', is_error: false, session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...o });
say({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

if (prompt.includes('DO:commit')) {
  fs.writeFileSync('notes.txt', 'written by the run\n');
  execFileSync('git', ['add', 'notes.txt']);
  execFileSync('git', ['commit', '-q', '-m', 'Add the notes']);
  fs.writeFileSync('draft.txt', 'not committed\n');
  text('I added the notes and left a draft.');
  result({ result: 'I added the notes and left a draft.' });
} else if (prompt.includes('DO:nothing')) {
  text('Nothing to report.\nThe build is green.');
  result({ result: 'Nothing to report.\nThe build is green.' });
} else if (prompt.includes('DO:sleep')) {
  text('Starting the long job.');
  setInterval(() => {}, 1 << 30);
} else if (prompt.includes('DO:movemain')) {
  fs.writeFileSync('moved.txt', 'x\n');
  execFileSync('git', ['add', 'moved.txt']);
  execFileSync('git', ['commit', '-q', '-m', 'Moved']);
  execFileSync('git', ['update-ref', 'refs/heads/main', 'HEAD']);
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1']);
  text('Nothing to report.');
  result({ result: 'Nothing to report.' });
} else if (prompt.includes('DO:ignoreterm')) {
  process.on('SIGTERM', () => {});
  text('Starting.');
  setInterval(() => {}, 1 << 30);
} else if (prompt.includes('DO:escape')) {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  if (process.env.FAKE_ALONE_PIDS) fs.appendFileSync(process.env.FAKE_ALONE_PIDS, `${c.pid}\n`);
  c.unref();
  process.on('SIGTERM', () => {});
  text('Starting the long job.');
  setInterval(() => {}, 1 << 30);
} else if (prompt.includes('DO:refuse')) {
  text('I could not run the tests: the command needed an OK.');
  result({ result: 'I could not run the tests: the command needed an OK.', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm test' } }] });
} else {
  say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'something broke' });
  process.exitCode = 1;
}
