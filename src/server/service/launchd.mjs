// The dashboard as a launchd agent (macOS): a plist in ~/Library/LaunchAgents, loaded into the user's GUI domain,
// so it starts when you log in and restarts if it crashes. No admin rights needed.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binFile, stateDir } from '../../paths.mjs';
import { APP_NAME } from '../brand.mjs';
import { carried, swapBetween } from './env.mjs';

// "local." is the prefix launchd convention keeps for agents that no vendor ships.
export const LABEL = `local.${APP_NAME}.dashboard`;

// The watcher: a job that runs `hoprig keep` every minute (src/keeper/keep.mjs); it does nothing while the dashboard answers.
export const KEEP_LABEL = `local.${APP_NAME}.keeper`;
export const keepPlistFile = (home = os.homedir()) => path.join(agentDir(home), `${KEEP_LABEL}.plist`);

export const agentDir = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents');
export const plistFile = (home = os.homedir()) => path.join(agentDir(home), `${LABEL}.plist`);
export const logFile = () => path.join(stateDir(), 'dashboard.log');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s) => `<string>${xml(s)}</string>`;

/** The plist text. Pure, so it can be tested. */
export function plistText({ node = process.execPath, bin = binFile(), env = process.env, home = os.homedir(), log = logFile() } = {}) {
  const vars = carried(env).map(([k, v]) => `      <key>${xml(k)}</key>\n      ${str(v)}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- Written by \`${xml(APP_NAME)} service install\`. Remove with \`${xml(APP_NAME)} service uninstall\`. -->`,
    '<plist version="1.0">',
    '  <dict>',
    `    <key>Label</key>\n    ${str(LABEL)}`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    `      ${str(node)}`,
    `      ${str(bin)}`,
    `      ${str('serve')}`,
    '    </array>',
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    ...vars,
    '    </dict>',
    `    <key>WorkingDirectory</key>\n    ${str(home)}`,
    '    <key>RunAtLoad</key>\n    <true/>',
    // Always: started again after a crash and after a clean exit nobody asked for. The owner's stop takes the job out
    // of launchd (`launchctl bootout`), so a stop stays a stop.
    '    <key>KeepAlive</key>\n    <true/>',
    '    <key>ThrottleInterval</key>\n    <integer>3</integer>',
    // Interactive: the terminals run Claude for a person; launchd must not throttle them as background work.
    '    <key>ProcessType</key>\n    <string>Interactive</string>',
    // Like systemd's KillMode=process: stopping the agent stops the dashboard, not a tmux server it started.
    '    <key>AbandonProcessGroup</key>\n    <true/>',
    `    <key>StandardOutPath</key>\n    ${str(log)}`,
    `    <key>StandardErrorPath</key>\n    ${str(log)}`,
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The watcher's plist text. Pure. */
export function keepPlistText({ node = process.execPath, bin = binFile(), env = process.env, home = os.homedir(), log = logFile() } = {}) {
  const vars = carried(env).map(([k, v]) => `      <key>${xml(k)}</key>\n      ${str(v)}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- Written by \`${xml(APP_NAME)} service install\`. Remove with \`${xml(APP_NAME)} service uninstall\`. -->`,
    '<plist version="1.0">',
    '  <dict>',
    `    <key>Label</key>\n    ${str(KEEP_LABEL)}`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    `      ${str(node)}`,
    `      ${str(bin)}`,
    `      ${str('keep')}`,
    '    </array>',
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    ...vars,
    '    </dict>',
    `    <key>WorkingDirectory</key>\n    ${str(home)}`,
    '    <key>RunAtLoad</key>\n    <false/>',
    '    <key>StartInterval</key>\n    <integer>60</integer>',
    `    <key>StandardOutPath</key>\n    ${str(log)}`,
    `    <key>StandardErrorPath</key>\n    ${str(log)}`,
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The files install writes, as the product would write them now (the carried variables stay those of the files there). */
export function files({ home = os.homedir(), node, bin, env = process.env } = {}) {
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  const opts = { env, home, ...(node ? { node } : {}), ...(bin ? { bin } : {}) };
  const swap = (f, text) => swapBetween(read(f), text, '<key>EnvironmentVariables</key>', '<key>WorkingDirectory</key>');
  return [
    { file: plistFile(home), text: swap(plistFile(home), plistText(opts)) },
    { file: keepPlistFile(home), text: swap(keepPlistFile(home), keepPlistText(opts)) },
  ];
}

const domain = () => `gui/${process.getuid()}`;

/** launchctl argv for each step (the modern bootstrap/bootout interface). */
export const launchctlArgs = {
  load: (file) => ['bootstrap', domain(), file],
  unload: () => ['bootout', `${domain()}/${LABEL}`],
  unloadKeeper: () => ['bootout', `${domain()}/${KEEP_LABEL}`],
  loadKeeper: (file) => ['bootstrap', domain(), file],
  status: () => ['print', `${domain()}/${LABEL}`],
  // -k: the running agent is ended first, then started again.
  restart: () => ['kickstart', '-k', `${domain()}/${LABEL}`],
};

const runReal = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || (err && err.message) || '').trim() }),
    );
  });

/** The useful lines of `launchctl print`: state, pid, last exit. */
export function summarizePrint(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(state|pid|last exit code|program|path|runs) = /.test(l))
    .join('\n');
}

/** `deps.run(cmd, args)` → { ok, out, err }: how launchctl is started (tests hand in a stand-in). */
export async function service(sub, { run = runReal } = {}) {
  const file = plistFile();
  switch (sub) {
    case 'install': {
      fs.mkdirSync(agentDir(), { recursive: true });
      fs.mkdirSync(path.dirname(logFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, plistText(), { mode: 0o644 });
      fs.writeFileSync(keepPlistFile(), keepPlistText(), { mode: 0o644 });
      console.log(`Wrote ${file}`);
      await run('launchctl', launchctlArgs.unload()); // a previous version, if loaded; failing here is fine
      await run('launchctl', launchctlArgs.unloadKeeper());
      const r = await run('launchctl', launchctlArgs.load(file));
      if (!r.ok) {
        console.error(`launchctl ${launchctlArgs.load(file).join(' ')} failed: ${r.err}`);
        return 1;
      }
      await run('launchctl', launchctlArgs.loadKeeper(keepPlistFile()));
      console.log(`The dashboard agent is loaded and starts at every login. Log: ${logFile()}`);
      console.log(`See it with: ${APP_NAME} service status`);
      return 0;
    }
    case 'restart': {
      if (!fs.existsSync(file)) {
        console.error(`The service is not installed. Install it with: ${APP_NAME} service install`);
        return 3;
      }
      const r = await run('launchctl', launchctlArgs.restart());
      if (!r.ok) {
        console.error(`launchctl ${launchctlArgs.restart().join(' ')} failed: ${r.err}`);
        return 1;
      }
      console.log(`The dashboard agent was restarted. See it with: ${APP_NAME} service status`);
      return 0;
    }
    case 'start': {
      if (!fs.existsSync(file)) {
        console.error(`The service is not installed. Install it with: ${APP_NAME} service install`);
        return 3;
      }
      // Already loaded is fine: a start of a running job changes nothing.
      const printed = await run('launchctl', launchctlArgs.status());
      if (!printed.ok) {
        const r = await run('launchctl', launchctlArgs.load(file));
        if (!r.ok) {
          console.error(`launchctl ${launchctlArgs.load(file).join(' ')} failed: ${r.err}`);
          return 1;
        }
      }
      console.log('The dashboard agent was started.');
      return 0;
    }
    case 'stop': {
      if (!fs.existsSync(file)) {
        console.error(`The service is not installed. Install it with: ${APP_NAME} service install`);
        return 3;
      }
      // Out of launchd, not killed: KeepAlive would start a killed job again within seconds.
      await run('launchctl', launchctlArgs.unload());
      console.log(`The dashboard agent was stopped. It stays stopped until: ${APP_NAME} service start`);
      return 0;
    }
    // Hidden: the keeper has written the files again; launchd loads them again.
    case 'reload': {
      await run('launchctl', launchctlArgs.unload());
      const r = await run('launchctl', launchctlArgs.load(file));
      return r.ok ? 0 : 1;
    }
    case 'uninstall': {
      await run('launchctl', launchctlArgs.unloadKeeper());
      fs.rmSync(keepPlistFile(), { force: true });
      await run('launchctl', launchctlArgs.unload());
      try {
        fs.unlinkSync(file);
        console.log(`Removed ${file}`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        console.log('The service was not installed.');
      }
      return 0;
    }
    case 'status': {
      const r = await run('launchctl', launchctlArgs.status());
      if (!r.ok) {
        console.log(fs.existsSync(file) ? `${file} exists but is not loaded.` : 'not installed');
        return 3;
      }
      console.log(`${LABEL}\n${summarizePrint(r.out)}\nlog: ${logFile()}`);
      return 0;
    }
    default:
      console.error(`usage: ${APP_NAME} service install | uninstall | status | start | stop | restart`);
      return 2;
  }
}
