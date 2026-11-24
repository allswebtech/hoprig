// A delete or a removal waits for a person's yes: hoprig rm, tokens revoke, machines rm, workspace forget. Without a
// terminal (a script, or a coding tool that read the command in a file) and without --yes, nothing is done. The skill
// that tells a coding tool to ask first is not loaded everywhere, so the rule is in the command itself.
import readline from 'node:readline';

/** One line from the person; null on Ctrl+C or the end of the input. */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    const finish = (v) => {
      if (answered) return;
      answered = true;
      rl.close();
      resolve(v);
    };
    rl.on('SIGINT', () => finish(null));
    rl.on('close', () => finish(null));
    rl.question(question, (a) => finish(a.trim()));
  });
}

/**
 * Resolves null when the person said yes (or `yes`, from --yes, was given), else the exit code after saying that
 * nothing was done: 2 without a terminal, 1 for a "no". `command` ("hoprig rm"), `act` ('Deleting the profile "sub"'),
 * `question` (asked with "(y/N)" after it), `done` ("deleted": "nothing was deleted").
 */
export async function needsYes({ yes, command, act, question, done }) {
  if (yes) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`${command}: nothing was ${done}. ${act} needs a yes: run it in a terminal, or add --yes.`);
    return 2;
  }
  if (/^y/i.test((await ask(`${question} (y/N) `)) || '')) return null;
  console.log(`Nothing was ${done}.`);
  return 1;
}
