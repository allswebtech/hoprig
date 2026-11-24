// The commands bin/hoprig.mjs hands over: setup, doctor, claude, update. main() returns an exit code.
import { claudeInfo, claudeInstallVersion, claudeLoginStatus, claudeUpdate } from '../claudecode.mjs';
import { APP } from './checks.mjs';
import { doctor } from './doctor.mjs';
import { isUpdateDryRun, selfUpdate } from './selfupdate.mjs';
import { parseSetupArgs, setup } from './setup.mjs';

export const USAGE = `usage:
  ${APP} setup [--yes] [--dry-run] [--password-file FILE]   set everything up, step by step (safe to re-run)
  ${APP} doctor [--offline] [--json]                       check everything, change nothing
  ${APP} claude status | update | install <version|stable|latest>
                                                          the Claude Code installation
  ${APP} update [--dry-run]                                update ${APP} itself
`;

async function claude(args) {
  const [sub, ...rest] = args;
  const print = (l) => process.stdout.write(`  ${l}\n`);
  // A stray word is refused, not ignored: "claude update <anything>" updated Claude Code all the same.
  const stray = sub === 'install' ? rest.slice(1) : sub === 'update' ? rest : rest.filter((a) => a !== '--json');
  if (stray.length) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (sub === 'status' || sub === undefined) {
    const json = rest.includes('--json');
    const [info, login] = await Promise.all([claudeInfo(), claudeLoginStatus()]);
    if (json) {
      console.log(JSON.stringify({ ...info, loggedIn: login.loggedIn, authMethod: login.method }, null, 2));
      return info.installed ? 0 : 1;
    }
    if (!info.installed) {
      console.log(`Claude Code is not installed. Install it with: ${APP} claude install latest`);
      return 1;
    }
    console.log(`Claude Code ${info.installed} (${info.method}) at ${info.path}`);
    console.log(info.latest ? `Newest: ${info.latest}${info.updateAvailable ? `  →  update with: ${APP} claude update` : ' (up to date)'}` : 'Newest: unknown (offline?)');
    console.log(`Login: ${login.loggedIn === true ? `logged in (${login.method})` : login.loggedIn === false ? 'not logged in (claude auth login)' : `unknown (${login.reason})`}`);
    return 0;
  }
  if (sub === 'update') {
    const r = await claudeUpdate({ onLine: print });
    console.log(r.ok ? `Claude Code is now ${r.version}.` : 'The update did not succeed (see above).');
    return r.ok ? 0 : 1;
  }
  if (sub === 'install') {
    if (!rest[0]) {
      console.error(`usage: ${APP} claude install <version|stable|latest>     e.g. ${APP} claude install 2.1.89`);
      return 2;
    }
    const r = await claudeInstallVersion(rest[0], { onLine: print });
    if (!r.ok) {
      console.log('That did not succeed (see above).');
      return 1;
    }
    console.log(`Claude Code is now ${r.version}.`);
    if (/^\d/.test(rest[0])) {
      console.log('Note: Claude Code updates itself in the background. To stay on this version, set DISABLE_AUTOUPDATER to "1"');
      console.log('in the "env" of ~/.claude/settings.json (https://code.claude.com/docs/en/setup, "Disable auto-updates").');
    }
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

/**
 * A field report of a setup or an update (src/field), by its exit code alone; a dry run or a usage error makes none.
 * The restart of the service after an update is reported by "hoprig service install" (src/server/cli.mjs).
 */
/**
 * Whether the run is a dry run, read by the command's own parse (so "-n" counts as "--dry-run" does). A parse that
 * fails is a usage error: no report either.
 */
export function isDryRun(kind, args) {
  try {
    return kind === 'go-live' ? isUpdateDryRun(args) : parseSetupArgs(args).dryRun;
  } catch {
    return true;
  }
}

async function withReport(kind, args, run) {
  const startedAt = Date.now();
  const summary = {}; // set-up fills it: a server's set-up is its own kind, with its steps and class
  const code = await run(summary);
  if (!isDryRun(kind, args) && code !== 2) {
    const w = await import('../field/wire.mjs');
    if (kind === 'setup') w.reportSetup(summary, code, startedAt);
    else w.reportByCode(kind, code, startedAt, kind === 'go-live' ? 'install-failed' : 'other');
  }
  return code;
}

/** Entry point from the bin script: `command` is setup | doctor | claude | update. */
export async function main(command, args = []) {
  switch (command) {
    case 'setup':
      return withReport('setup', args, (summary) => setup(args, { summary }));
    case 'doctor':
      return doctor(args, { box: async () => (await import('../box/doctorline.mjs')).boxLine() });
    case 'claude':
      return claude(args);
    case 'update':
      return withReport('go-live', args, () => selfUpdate(args));
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}
