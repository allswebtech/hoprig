// The keeper of a go-live command's output file while something the command left in the background (a server started
// with `server &`) still writes into it (src/ship/runcmd.mjs). The file is already removed from the folder; this small
// process holds it (fd 3) and empties it whenever it is past its limit, so what such a server prints never fills the
// disk. It ends when no process of the command's group is left. It reads and runs nothing else.
//
// argv: the process group, the limit in bytes. Started detached, so a restart of the dashboard does not end it.
import fs from 'node:fs';

const FD = 3;
const group = Number(process.argv[2]);
const limit = Number(process.argv[3]);
if (!Number.isInteger(group) || group <= 1 || !(limit > 0)) process.exit(2);

const gone = () => {
  try {
    process.kill(-group, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
};

setInterval(() => {
  if (gone()) process.exit(0);
  try {
    // The writers opened it for appending: after the file is emptied their next write lands at its start again.
    if (fs.fstatSync(FD).size > limit) fs.ftruncateSync(FD, 0);
  } catch {
    process.exit(0);
  }
}, 50);
