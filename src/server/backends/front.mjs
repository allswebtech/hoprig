// Which program a terminal has in front: the process group its terminal device hands typed bytes to (the
// foreground process group). Text typed for a coding tool by someone other than the owner (src/server/deck.mjs
// sendToTool) goes in only while the tool's own group is that one, so it never reaches the shell the terminal falls
// back to once the tool has ended. Read from the system at the moment it is asked:
//   Linux        /proc/<pid>/stat (no program is started: the check sits right before the typing)
//   macOS, BSD   ps -o pgid=,tpgid=
//   Windows      not known: ConPTY has no foreground process group (the built-in terminal knows its own child only)
import fs from 'node:fs';
import { runSync } from '../platform/common.mjs';

/** { pgrp, tpgid } of a /proc/<pid>/stat line; the name in parentheses may hold spaces and parentheses itself. */
export function parseStat(text) {
  const s = String(text);
  const end = s.lastIndexOf(')');
  if (end < 0) return null;
  // After the name: state ppid pgrp session tty_nr tpgid …
  const f = s.slice(end + 2).split(' ');
  const pgrp = Number(f[2]);
  const tpgid = Number(f[5]);
  return Number.isInteger(pgrp) && Number.isInteger(tpgid) ? { pgrp, tpgid } : null;
}

/**
 * { pgrp, tpgid } of process `pid` (tpgid: the foreground group of its terminal, -1 or 0 when it has none), or null
 * when the process is gone or this system cannot tell (Windows).
 */
export function groups(pid, { platform = process.platform, read = (p) => fs.readFileSync(p, 'utf8'), run = runSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || platform === 'win32') return null;
  if (platform === 'linux') {
    try {
      return parseStat(read(`/proc/${pid}/stat`));
    } catch {
      return null; // gone
    }
  }
  const out = run('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)]);
  const [pgrp, tpgid] = String(out || '').trim().split(/\s+/).map(Number);
  return Number.isInteger(pgrp) && Number.isInteger(tpgid) ? { pgrp, tpgid } : null;
}

/** An error of a terminal whose coding tool is not in front: nothing was typed. Plain words, 409. */
export function notInFront(message) {
  return Object.assign(new Error(message), { status: 409, code: 'not_in_front', details: { code: 'not_in_front' } });
}

/**
 * Whether the group `front.group` holds terminal `pid`'s device in front now (`pid`: the terminal's first process, its
 * shell). Throws notInFront when not; returns when it does, or when `front` names no group (nothing to check: the
 * caller's own rule decided).
 */
export function assertFront(pid, front, o) {
  if (!front || !Number.isInteger(front.group)) return;
  const g = groups(pid, o);
  if (!g || g.tpgid !== front.group) throw notInFront(FRONT_GONE);
}

/**
 * `when` ({ lines, test(screen), message }): type only while the screen's last `lines` lines pass `test`, looked at
 * right before the bytes go (the page's answer to a permission dialog: server.mjs). Throws a 409 with `message` when
 * they do not; returns when they do or when there is nothing to check.
 */
export function assertScreen(when, screen) {
  if (!when) return;
  if (!when.test(screen)) throw Object.assign(new Error(when.message || 'The screen changed. Nothing was typed'), { status: 409 });
}

export const FRONT_GONE = 'Nothing was typed: the coding tool is not the program in front in that terminal any more (it has ended, or another program runs there). Look at the session, start the coding tool again, then send it again';
