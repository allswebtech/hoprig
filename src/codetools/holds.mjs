// Who uses the one server per computer of a coding tool (servers.mjs), so it is never stopped under them: the terminal
// sessions attached to it (their run records) and the dashboards whose open chats hold it.
import fs from 'node:fs';
import path from 'node:path';
import { listRuns } from '../runs.mjs';
import { alive, serverDir } from './servers.mjs';

// An open chat on the server holds it (src/chat/engines/served.mjs) by a file per dashboard process: a launcher that
// ends in another process then does not stop the server under the chat.
const holdFile = (tool, pid = process.pid) => path.join(serverDir(), `${tool}-held-${pid}`);
const holds = new Map(); // tool → how many chats of this process hold it

/** This process uses the tool's server (a chat): nobody stops it until release() is called. */
export function holdServer(tool) {
  const n = holds.get(tool) || 0;
  holds.set(tool, n + 1);
  if (!n) {
    try {
      fs.mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(holdFile(tool), String(process.pid), { mode: 0o600 });
    } catch {
      /* the in-process count still holds it against this process's own stops */
    }
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (holds.get(tool) || 1) - 1;
    holds.set(tool, left);
    if (!left) fs.rmSync(holdFile(tool), { force: true });
  };
}

/** The processes that hold the tool's server (alive ones; a file of a process that is gone is removed). */
function holders(tool) {
  let names = [];
  try {
    names = fs.readdirSync(serverDir()).filter((f) => f.startsWith(`${tool}-held-`));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    const pid = Number(f.slice(`${tool}-held-`.length));
    if (pid === process.pid ? holds.get(tool) > 0 : alive(pid)) out.push(pid);
    else fs.rmSync(path.join(serverDir(), f), { force: true });
  }
  return out;
}

/**
 * The users of the tool's server: the runs (terminal sessions) attached to it and the dashboards whose chats hold it.
 * `except`: a run id to leave out (one that is ending).
 */
export const serverUsers = (tool, { except = null, runs = listRuns() } = {}) => [
  ...runs.filter((r) => r.tool === tool && r.server === true && r.runId !== except),
  ...holders(tool).map((pid) => ({ runId: `chat-${pid}`, tool, server: true, chats: true })),
];
