// The commands bin/hoprig.mjs hands over: setup, doctor, claude, update. main() returns an exit code.
import { claudeInfo, claudeInstallVersion, claudeLoginStatus, claudeUpdate } from '../claudecode.mjs';
import { APP } from './checks.mjs';
import { doctor } from './doctor.mjs';
import { selfUpdate } from './selfupdate.mjs';
import { setup } from './setup.mjs';

const USAGE = `usage:
  ${APP} setup [--yes] [--dry-run] [--password-file FILE]   set everything up, step by step (safe to re-run)
  ${APP} doctor [--offline] [--json]                       check everything, change nothing
  ${APP} claude status | update | install <version|stable|latest>
                                                          the Claude Code installation
  ${APP} update [--dry-run]                                update ${APP} itself
`;

async function claude(args) {
  const [sub, ...rest] = args;
  const print = (l) => process.stdout.write(`  ${l}\n`);
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

/** Entry point from the bin script: `command` is setup | doctor | claude | update. */
export async function main(command, args = []) {
  switch (command) {
    case 'setup':
      return setup(args);
    case 'doctor':
      return doctor(args);
    case 'claude':
      return claude(args);
    case 'update':
      return selfUpdate(args);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}
