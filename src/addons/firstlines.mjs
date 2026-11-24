#!/usr/bin/env node
// A gateway's output on its way to its log, for a gateway whose definition names the line of its first password
// (gateways.mjs firstPassword). Run by localgateway.mjs start() as:
//
//   node firstlines.mjs <log file> <marker> <program> [arguments…]
//
// It starts the program (in its own process group, which Hoprig's Stop ends as one), appends every line it prints to
// the log (mode 600), except a line that holds the marker, and hands the first lines (that one included) to Hoprig on
// its own output, which Hoprig reads only while the start runs and keeps only in memory. Later lines go to the log
// only. It ends with the program's own exit code.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const FIRST_LINES = 20;

/** Does `line` hold the definition's marker (case does not matter)? */
export const holdsMarker = (line, marker) => Boolean(marker) && String(line).toLowerCase().includes(String(marker).toLowerCase());

/** In memory only: a start's first lines for its page, given out once, gone after `heldMs` (ten minutes). */
export class FirstLines {
  constructor({ now = Date.now, heldMs = 10 * 60_000 } = {}) {
    this.now = now;
    this.heldMs = heldMs;
    this.held = null;
  }

  keep(lines) {
    const list = (lines || []).map((l) => String(l).slice(0, 300)).filter(Boolean).slice(0, FIRST_LINES);
    this.held = list.length ? { at: this.now(), lines: list } : null;
  }

  waiting() {
    if (this.held && this.now() - this.held.at > this.heldMs) this.held = null;
    return this.held !== null;
  }

  /** The lines, once: [] after the first take, after ten minutes, or when there were none. */
  take() {
    if (!this.waiting()) return [];
    const { lines } = this.held;
    this.held = null;
    return lines;
  }
}

function main([log, marker, bin, ...args]) {
  process.stdout.on('error', () => {}); // Hoprig closed its end after the start: the log goes on
  const out = fs.openSync(log, 'a', 0o600);
  let shown = 0;
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    const line = (l) => {
      if (shown < FIRST_LINES) {
        shown += 1;
        try {
          process.stdout.write(`${l}\n`);
        } catch {
          /* closed */
        }
      }
      if (!holdsMarker(l, marker)) fs.writeSync(out, `${l}\n`);
    };
    stream.on('data', (c) => {
      const parts = (rest + c.toString('utf8')).split(/\r?\n/);
      rest = parts.pop();
      parts.forEach(line);
    });
    stream.on('end', () => rest && line(rest));
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => {
    fs.writeSync(out, `${bin} could not be started: ${e.code || e.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2));
