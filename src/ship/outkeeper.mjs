// The keeper of a go-live command's output file while something the command left in the background (a server started
// with `server &`) still writes into it (src/ship/runcmd.mjs). The file is already removed from the folder; this small
// process holds it (fd 3) and empties it whenever it is past its limit, so what such a server prints never fills the
// disk. It ends when nothing the command started is left: on Linux and macOS no process of the command's group; on
// Windows, which has no such group, nothing that descends from the command (src/cmdtree.mjs). The command has ended
// before the keeper starts, so there its pid says nothing (another process may have it now): one look at the processes
// at most every 30 s says, by parent and start, whether anything of it is left. It reads and runs nothing else.
//
// argv: the process group (Windows: the command's pid), the limit in bytes, and on Windows the command's start (epoch
// ms). Started detached, so a restart of the dashboard does not end it.
import fs from 'node:fs';

const FD = 3;
const group = Number(process.argv[2]);
const limit = Number(process.argv[3]);
const start = Number(process.argv[4]);
if (!Number.isInteger(group) || group <= 1 || !(limit > 0)) process.exit(2);

const gone = process.platform === 'win32' ? (await import('../cmdtree.mjs')).keeperGone({ pid: group, start: Number.isFinite(start) ? start : null }) : async () => {
  try {
    process.kill(-group, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
};

let asking = false;
setInterval(() => {
  try {
    // The writers opened it for appending: after the file is emptied their next write lands at its start again.
    if (fs.fstatSync(FD).size > limit) fs.ftruncateSync(FD, 0);
  } catch {
    process.exit(0);
  }
  if (asking) return;
  asking = true;
  gone().then((g) => (g ? process.exit(0) : (asking = false)), () => (asking = false));
}, 50);
