// A guard of the test run for the real home of whoever runs the tests. Every test process gets a home of its own
// (HOME, USERPROFILE, APPDATA, LOCALAPPDATA inside the run's temporary folder: tools/test.mjs), but a test that builds
// a child's environment by hand and leaves USERPROFILE out sends that child to the real profile on Windows (Node and
// every program there take the home from USERPROFILE, then from the system). So the runner looks at the real
// profile's Hoprig and coding-tool folders before and after the run, and a run that changed anything there fails,
// naming each path and the test files that were running when it was written.
//
// On for Windows. Elsewhere only with HOPRIG_TEST_HOME_GUARD=1: on a computer where the person's own dashboard and
// coding tools run, they write these folders all the time, and the run would fail for their work.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Whether the guard runs here. */
export const guardOn = (env = process.env, platform = process.platform) => platform === 'win32' || env.HOPRIG_TEST_HOME_GUARD === '1';

/**
 * The real profile's folders and files a test must never write, from the environment the runner itself started with.
 * Hoprig's own folders and .gitconfig first; .claude/projects (years of conversations, very many files) last and as a
 * place of its own, so it never uses up what the others may read.
 */
export function realPlaces(env = process.env) {
  const home = env.USERPROFILE || env.HOME;
  const out = [];
  if (home) out.push(join(home, '.config', 'hoprig'), join(home, '.local', 'state', 'hoprig'));
  if (env.APPDATA) out.push(join(env.APPDATA, 'hoprig'));
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'hoprig'));
  if (home) {
    out.push(join(home, '.gitconfig'), join(home, '.claude.json'), join(home, '.claude'), join(home, '.config', 'opencode'),
      join(home, '.local', 'share', 'opencode'), join(home, '.claude', 'projects'));
  }
  return [...new Set(out)];
}

// A place with very many entries is read up to this many; past it, only what was read is compared. Each place has its
// own count, so a big one leaves the others whole.
export const MAX_ENTRIES = 50_000;

/** Every path under `places` → "kind size mtime" (a missing place → absent). A place inside another is read as its own. */
export function snapshot(places, { max = MAX_ENTRIES } = {}) {
  const out = new Map();
  const own = new Set(places);
  for (const place of places) {
    let left = max;
    const walk = (p) => {
      if (left-- <= 0) return;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        out.set(p, 'dir');
        let names = [];
        try {
          names = readdirSync(p);
        } catch {
          return;
        }
        for (const n of names.sort()) {
          const c = join(p, n);
          if (!own.has(c)) walk(c);
        }
      } else out.set(p, `${st.isSymbolicLink() ? 'link' : 'file'} ${st.size} ${st.mtimeMs}`);
    };
    walk(place);
  }
  return out;
}

/** The paths that were made, changed or removed between two snapshots, each with what happened. */
export function changes(before, after) {
  const out = [];
  for (const [p, v] of after) {
    if (!before.has(p)) out.push(`made: ${p}`);
    else if (before.get(p) !== v && v !== 'dir') out.push(`changed: ${p}`);
  }
  for (const p of before.keys()) if (!after.has(p)) out.push(`removed: ${p}`);
  return out.sort();
}

/**
 * The test files that were running when `path` was last written: those whose first and last result (`runs`: file →
 * { from, to } in epoch ms, from tools/test-guard.mjs) are around its time. [] when it cannot be told (a removed path).
 */
export function writtenDuring(path, runs, slack = 2000) {
  let at;
  try {
    at = lstatSync(path).mtimeMs;
  } catch {
    return [];
  }
  return Object.entries(runs || {}).filter(([, r]) => r && r.from - slack <= at && at <= r.to + slack).map(([f]) => f).sort();
}
