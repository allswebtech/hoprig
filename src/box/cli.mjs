// `hoprig box check` and `hoprig box run`: the box (docs/BOX.md) from the command line. main() returns an exit code:
// check 0 for a yes and 3 for a no; run the command's own code, 124 when its time ran out, 3 with one line why when
// nothing ran (no box, a wrong option).
import { DEFAULT_MAX_OUT, boxCheck, runBoxed } from './box.mjs';

export const USAGE = `usage:
  hoprig box check [--json]       whether this computer has a box: a command run with no network, without your
                                    home, seeing only the folders it is given (exit 0: yes, 3: no)
  hoprig box run [--write DIR]... [--read DIR]... -- <command...>
                                  run a command in the box: --write folders it may change, --read folders it may
                                    only read; the current folder must be inside one of them. Its output is printed
                                    when it ends (at most 1 MB); after 30 minutes it is stopped (exit 124)
`;
const RUN_MS = 30 * 60_000;
const NO = 3;

/** `--write DIR`, `--read DIR` (also `--write=DIR`) up to `--`, then the command. → { write, read, argv } or { why } */
export function parseRun(args) {
  const write = [];
  const read = [];
  let i = 0;
  for (; i < args.length && args[i] !== '--'; i++) {
    const m = /^--(write|read)(?:=(.*))?$/.exec(args[i]);
    if (!m) return { why: `unknown option: ${args[i]}` };
    let dir;
    if (m[2] !== undefined) dir = m[2];
    else {
      // The folder is the next word. A word that is "--" or another option means the folder was forgotten, not that
      // "--" is a folder (then the command after it was read as an unknown option).
      dir = args[++i];
      if (dir === undefined || dir === '--' || dir.startsWith('--')) return { why: `--${m[1]} needs a folder` };
    }
    if (!dir) return { why: `--${m[1]} needs a folder` };
    (m[1] === 'write' ? write : read).push(dir);
  }
  const argv = args.slice(i + 1);
  if (i >= args.length || !argv.length) return { why: 'the command comes after "--": hoprig box run --write . -- npm test' };
  return { write, read, argv };
}

/**
 * `runMs` is the time a run gets (30 minutes); `check` and `run` are the box's own. A test passes others as arguments,
 * never through a variable or a file.
 */
export async function main(args = [], { out = process.stdout, err = process.stderr, cwd = process.cwd(), runMs = RUN_MS, check = boxCheck, run = runBoxed } = {}) {
  const [sub, ...rest] = args;
  if (sub === 'check') {
    const json = rest.includes('--json');
    const bad = rest.find((a) => a !== '--json');
    if (bad !== undefined) {
      err.write(`hoprig box check: unknown option: ${bad}\n`);
      return NO;
    }
    const r = await check({ fresh: true });
    if (json) out.write(JSON.stringify({ ok: r.ok, kind: r.kind, why: r.why, step: r.step }) + '\n');
    else if (r.ok) out.write(`This computer has a box (${r.kind}): every trial of its self-test passed.\n`);
    else out.write(`This computer has no box: ${r.why}.${r.step ? `\nWhat would give it one: ${r.step}.` : ''}\n`);
    return r.ok ? 0 : NO;
  }
  if (sub === 'run') {
    const p = parseRun(rest);
    if (p.why) {
      err.write(`hoprig box run: ${p.why}\n`);
      return NO;
    }
    const { resolve } = await import('node:path');
    const write = p.write.map((d) => resolve(cwd, d));
    const read = p.read.map((d) => resolve(cwd, d));
    const r = await run(p.argv, { cwd, write, read, timeoutMs: runMs, maxOut: DEFAULT_MAX_OUT });
    if (r.code === null && !r.timedOut) {
      err.write(`hoprig box run: ${r.why}${r.step ? `\nwhat would give it one: ${r.step}` : ''}\n`);
      return NO;
    }
    out.write(r.out);
    if (r.dropped) err.write(`hoprig box run: ${r.dropped} more bytes of output were not kept (the limit is 1 MB)\n`);
    if (r.timedOut) {
      err.write(`hoprig box run: stopped after ${runMs >= 60_000 ? `${runMs / 60_000} minutes` : `${runMs / 1000} seconds`}, with every process it started\n`);
      return 124;
    }
    return r.code;
  }
  (sub === '--help' || sub === undefined ? out : err).write(USAGE);
  return sub === '--help' || sub === undefined ? 0 : 2;
}
