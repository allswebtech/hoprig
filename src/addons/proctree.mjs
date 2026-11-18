// How two processes are related, where the system lets us read it (Linux, macOS): a parent, a process group, a chain
// of parents. A gateway the owner defined is only the process its add-on started, and the program that answers on its
// port may be that process's child or grandchild (a wrapper script that runs node without exec), or still in its
// process group after the wrapper ended (a script that starts the server in the background).
import fs from 'node:fs';
import { capture } from '../setup/system.mjs';

/** Fields 4 on of /proc/<pid>/stat (after the name, which may hold spaces and ")"), or null. */
function statFields(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ').slice(1); // [ppid, pgrp, …]
}

async function psField(pid, field) {
  return Number((await capture(['ps', '-o', `${field}=`, '-p', String(pid)], { timeout: 5000 })).stdout.trim()) || null;
}

/** The parent of `pid` where it can be read (Linux, macOS), else null. */
export async function parentOf(pid) {
  try {
    if (process.platform === 'linux') return Number(statFields(pid)[0]) || null;
    if (process.platform === 'darwin') return await psField(pid, 'ppid');
  } catch {
    /* gone */
  }
  return null;
}

/** The process group of `pid` where it can be read (Linux, macOS), else null. */
export async function groupOf(pid) {
  try {
    if (process.platform === 'linux') return Number(statFields(pid)[1]) || null;
    if (process.platform === 'darwin') return await psField(pid, 'pgid');
  } catch {
    /* gone */
  }
  return null;
}

/**
 * Is `pid` the process `root`, one of its descendants (up to 16 parents up), or in the process group that `root`
 * leads? true, false, or null when it cannot be read here (Windows, a process gone meanwhile).
 */
export async function belongsTo(pid, root) {
  if (!pid || !root) return null;
  if (pid === root) return true;
  if ((await groupOf(pid)) === root) return true;
  let p = pid;
  for (let i = 0; i < 16; i++) {
    const up = await parentOf(p);
    if (up === null) return i === 0 ? null : false; // the first parent unreadable: not known; later: the chain ended
    if (up === root) return true;
    if (up <= 1) return false;
    p = up;
  }
  return false;
}
