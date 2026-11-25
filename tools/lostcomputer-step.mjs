// One step of tools/lostcomputer.mjs that has no command of its own (the upkeep's real engines, the whole-computer
// check), run as a child process in a temporary home: the parent never switches its own environment to that home.
// argv: <step> <result file> [json argument]. The result is written as JSON into the result file.
//
// It refuses, like its parent, outside the suite's runner: without HOPRIG_TEST_TRAPS, in the account's own home, or
// in a home outside the temporary folder. Product files are imported only after that check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const within = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const home = process.env.HOME ? real(process.env.HOME) : '';
if (!process.env.HOPRIG_TEST_TRAPS || !home || home === real(os.userInfo().homedir) || !within(home, real(os.tmpdir()))) {
  process.stderr.write('lostcomputer-step runs only behind the test runner, in a temporary home: nothing was done.\n');
  process.exit(2);
}

const [step, out, arg] = process.argv.slice(2);
const S = await import('../src/automation/workspacesync.mjs');
let r;
if (step === 'sync') r = await S.realWorkspaceSync({ push: true });
else if (step === 'map') r = await S.realWorkspaceMap({ commit: true, push: true, memory: true });
else if (step === 'branches') r = await S.realWorkspaceBranches({ places: JSON.parse(arg) });
else if (step === 'check') r = await (await import('../src/workspace/leave.mjs')).leaveCheck({ cheap: false });
else {
  process.stderr.write(`unknown step: ${step}\n`);
  process.exit(2);
}
fs.writeFileSync(out, JSON.stringify(r));
