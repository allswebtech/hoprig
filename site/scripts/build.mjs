#!/usr/bin/env node
// The site's build, in one list of steps: `npm run build` runs this file, and the site's tests build with the same
// function, so a fresh clone (no site/public/, no out/) gets what the site gets and the two can never drift.
//   public  fills site/public/ (git-ignored: icons, the link picture, brand files, screenshots, the story's pictures)
//   next    next build (into $SITE_NEXT_DIST when it is set, else out/)
//   after   the twins, llms.txt, sitemap, robots, CNAME and every page's policy (scripts/after-build.mjs)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterBuild } from './after-build.mjs';
import { fillPublic } from './public.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const STEPS = ['public', 'next', 'after'];

/**
 * Runs the build's steps in order (all of them unless `steps` names fewer) and returns the exported folder.
 * `dist` is a folder inside site/ of the caller's own (a test's); `quiet` keeps Next's output for the error instead.
 */
export async function buildSite({ root = path.resolve(SITE, '..'), dist = process.env.SITE_NEXT_DIST, steps = STEPS, quiet = false } = {}) {
  const site = path.join(root, 'site');
  const out = path.join(site, dist || 'out');
  for (const step of steps) {
    if (step === 'public') fillPublic({ root, out: path.join(site, 'public') });
    else if (step === 'next') {
      const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...(dist ? { SITE_NEXT_DIST: dist } : {}) };
      const r = spawnSync(process.execPath, [path.join(site, 'node_modules/next/dist/bin/next'), 'build'], { cwd: site, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 600_000, stdio: quiet ? 'pipe' : 'inherit' });
      if (r.status !== 0) throw new Error(`next build failed (${r.status ?? r.signal ?? r.error?.message}):\n${(r.stdout || '').slice(-3000)}\n${(r.stderr || '').slice(-3000)}`);
    } else if (step === 'after') await afterBuild({ root, out });
    else throw new Error(`no build step ${step}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSite().then((out) => console.log(`site: built into ${path.relative(process.cwd(), out) || '.'}`), (e) => {
    console.error(`site: ${e.message}`);
    process.exit(1);
  });
}
