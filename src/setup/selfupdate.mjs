// `hoprig update`: update hoprig itself, the way it was installed.
//   git checkout   git pull --ff-only, then npm install in that folder (new or changed dependencies)
//   npm (global)   npm install -g <the package source: see PACKAGE_SOURCE in paths.mjs>; with npm 12 and newer
//                  also `npm rebuild node-pty` in the installed folder, because that npm does not run the terminal
//                  module's install script in a global install (the new package.json allows exactly that module)
//   anything else  (installed from a tarball or a copied folder) we say how to reinstall instead of guessing
import fs from 'node:fs';
import path from 'node:path';
import { APP, appRoot, appVersion } from './checks.mjs';
import { PACKAGE_SOURCE } from '../paths.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { capture, compareVersions, npmArgv, npmMajor, npmSourceFlags, showCommand, stream } from './system.mjs';

/** 'git' | 'npm' | 'other', from the folder hoprig runs from. */
export function installKind(root = appRoot()) {
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* keep */
  }
  return /[\\/]node_modules[\\/]hoprig$/.test(real) ? 'npm' : 'other';
}

/**
 * npm's global folder that holds `root` (…/lib/node_modules/hoprig; on Windows …\\node_modules\\hoprig), or null
 * when `root` is not laid out like one. The installer puts hoprig into ~/.local when npm's own global folder
 * belongs to the system; an update has to go to the same place, not to npm's default one.
 */
export function globalPrefix(root, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const modules = p.dirname(root);
  if (p.basename(modules) !== 'node_modules') return null;
  const up = p.dirname(modules);
  if (platform === 'win32') return up;
  return p.basename(up) === 'lib' ? p.dirname(up) : null;
}

/**
 * The commands for each kind: [{ argv, cwd, ifFails? }]. `npm` is npm's major version (system.mjs: npmMajor). A
 * step with `ifFails` does not stop the update: its text is shown instead.
 */
export function updatePlan(kind, root = appRoot(), platform = process.platform, npm = null) {
  if (kind === 'git') {
    return [
      { argv: ['git', '-C', root, 'pull', '--ff-only'], cwd: root },
      { argv: npmArgv(['install', '--omit=dev', '--no-audit', '--no-fund'], platform), cwd: root },
    ];
  }
  if (kind === 'npm') {
    const prefix = globalPrefix(root, platform);
    const steps = [{ argv: npmArgv(['install', '-g', ...(prefix ? ['--prefix', prefix] : []), ...npmSourceFlags(PACKAGE_SOURCE, npm), PACKAGE_SOURCE], platform), cwd: undefined }];
    if (npm >= 12) steps.push({ argv: npmArgv(['rebuild', 'node-pty'], platform), cwd: root, ifFails: `The terminal module was not built. See why and the command that fixes it: ${APP} doctor` });
    return steps;
  }
  return [];
}

/** The newest hoprig on npm, or null (offline, or not published). */
export async function publishedVersion(platform = process.platform) {
  const r = await capture(npmArgv(['view', APP, 'version'], platform), { env: withoutSecrets(process.env), timeout: 30_000 });
  const v = r.ok ? r.stdout.trim() : '';
  return /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

export async function selfUpdate(args = [], { write = (s) => process.stdout.write(s), run = stream } = {}) {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  if (args.some((a) => !['--dry-run', '-n'].includes(a))) {
    write(`usage: ${APP} update [--dry-run]\n`);
    return 2;
  }
  const root = appRoot();
  const kind = installKind(root);
  const current = appVersion();
  write(`${APP} ${current} runs from ${root} (${{ git: 'a git checkout', npm: 'an npm install', other: 'a copied folder or tarball' }[kind]}).\n`);
  if (kind === 'other') {
    write(`It cannot update itself from here. Install again the way you did first (see docs/INSTALL.md), for example:\n  curl -fsSL <install.sh address> | sh\n`);
    return 1;
  }
  if (kind === 'npm') {
    const latest = await publishedVersion();
    if (!latest) {
      write(`Could not find ${APP} on npm (offline, or not published yet). Nothing changed.\n`);
      return 1;
    }
    if (compareVersions(latest, current) <= 0) {
      write(`${current} is the newest version. Nothing to do.\n`);
      return 0;
    }
    write(`Version ${latest} is available.\n`);
  }
  const plan = updatePlan(kind, root, process.platform, kind === 'npm' ? await npmMajor() : null);
  for (const step of plan) {
    write(`${dryRun ? 'would run' : 'running'}: ${showCommand(step.argv)}\n`);
    if (dryRun) continue;
    // npm runs install scripts and git may run the checkout's hooks: no secret reaches them (../secretenv.mjs).
    const r = await run(step.argv, { cwd: step.cwd, env: withoutSecrets(process.env), onLine: (l) => write(`  ${l}\n`) });
    if (!r.ok && step.ifFails) {
      write(`${step.ifFails}\n`);
      continue;
    }
    if (!r.ok) {
      write(`That did not succeed (exit code ${r.code}). Nothing else was run.\n`);
      return 1;
    }
  }
  if (dryRun) {
    write('Dry run: nothing was changed.\n');
    return 0;
  }
  write(`Updated. If the dashboard runs in the background, restart it: ${APP} service install\n`);
  return 0;
}
