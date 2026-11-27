// The dashboard as a systemd user service (Linux), so it starts with the machine and keeps running after you
// log out (with lingering on).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binFile } from '../../paths.mjs';
import { APP_NAME } from '../brand.mjs';
import { CARRIED_ENV, carried, swapBetween } from './env.mjs';

export const UNIT = `${APP_NAME}.service`;
// Runs `hoprig keep` when systemd gives up on the dashboard (src/keeper/keep.mjs).
export const KEEP_UNIT = `${APP_NAME}-keep.service`;

export { CARRIED_ENV };

export const unitDir = (env = process.env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');

// systemd treats "%" as a specifier and "$" as a variable in ExecStart; both are doubled. Inside double quotes,
// backslash and the quote itself are escaped.
const sdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
const envQuote = (k, val) => `"${k}=${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

/** The unit file text. Pure, so it can be tested. */
export function unitText({ node = process.execPath, bin = binFile(), env = process.env, locales = undefined } = {}) {
  const lines = [
    `# Written by \`${APP_NAME} service install\`. Remove with \`${APP_NAME} service uninstall\`.`,
    '[Unit]',
    `Description=${APP_NAME} dashboard (Claude Code sessions)`,
    'After=network-online.target',
    'Wants=network-online.target',
    // 5 failed starts within 60 s is a crash loop: systemd stops trying and hands over to the keeper.
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    `OnFailure=${KEEP_UNIT}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${sdQuote(node)} ${sdQuote(bin)} serve`,
  ];
  for (const [k, v] of carried(env, locales)) lines.push(`Environment=${envQuote(k, v)}`);
  lines.push(
    // Always: a clean exit that nobody asked for (a SIGTERM from outside) is started again too. A stop by the owner
    // (`hoprig stop` = systemctl stop) stays a stop.
    'Restart=always',
    'RestartSec=3',
    // When the dashboard is the first to use tmux, the tmux server starts inside this service. KillMode=process
    // stops only the dashboard on restart or stop, so the tmux server and every Claude session keep running.
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

/** The keeper's unit text: one run of `hoprig keep --failed`. Pure. */
export function keepUnitText({ node = process.execPath, bin = binFile(), env = process.env, locales = undefined } = {}) {
  const lines = [
    `# Written by \`${APP_NAME} service install\`. Remove with \`${APP_NAME} service uninstall\`.`,
    '[Unit]',
    `Description=${APP_NAME} keeper (looks after the dashboard when systemd has given up on it)`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${sdQuote(node)} ${sdQuote(bin)} keep --failed`,
  ];
  for (const [k, v] of carried(env, locales)) lines.push(`Environment=${envQuote(k, v)}`);
  lines.push('TimeoutStartSec=300', '');
  return lines.join('\n');
}

/** The files install writes, as the product would write them now. The carried variables stay those of the files there. */
export function files({ env = process.env, node, bin } = {}) {
  const dir = unitDir(env);
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  const opts = { env, ...(node ? { node } : {}), ...(bin ? { bin } : {}) };
  const main = path.join(dir, UNIT);
  const keeper = path.join(dir, KEEP_UNIT);
  return [
    { file: main, text: swapBetween(read(main), unitText(opts), 'Environment=', '\nRestart=') },
    { file: keeper, text: swapBetween(read(keeper), keepUnitText(opts), 'Environment=', '\nTimeoutStartSec=') },
  ];
}

// `env` is the caller's: set-up passes its own (sys.env), so the systemctl and loginctl it means are the ones started.
const runReal = (cmd, args, env = process.env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, env }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || (err && err.message) || '').trim() }),
    );
  });

async function lingerNote(run, env) {
  const user = os.userInfo().username;
  const r = await run('loginctl', ['show-user', user, '-p', 'Linger'], env);
  if (r.ok && /Linger=no/.test(r.out)) {
    return (
      '\nLingering is off, so the service stops when you log out and only starts when you log in.\n' +
      'To keep it running at all times, run this once yourself:\n\n' +
      `  sudo loginctl enable-linger ${user}\n`
    );
  }
  return '';
}

/**
 * `env`: the environment systemctl and loginctl run with and the unit file is written from (default: this process's).
 * `lingerNote: false`: no "run this once yourself" paragraph after an install (set-up runs that step itself, linger.mjs).
 * `run(cmd, args, env)` → { ok, out, err }: how systemctl and loginctl are started (tests hand in a stand-in).
 */
export async function service(sub, { run = runReal, env = process.env, lingerNote: sayLinger = true } = {}) {
  const file = path.join(unitDir(env), UNIT);
  switch (sub) {
    case 'install': {
      fs.mkdirSync(unitDir(env), { recursive: true });
      fs.writeFileSync(file, unitText({ env }), { mode: 0o644 });
      fs.writeFileSync(path.join(unitDir(env), KEEP_UNIT), keepUnitText({ env }), { mode: 0o644 });
      console.log(`Wrote ${file}`);
      for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', UNIT], ['--user', 'restart', UNIT]]) {
        const r = await run('systemctl', args, env);
        if (!r.ok) {
          console.error(`systemctl ${args.join(' ')} failed: ${r.err}`);
          return 1;
        }
      }
      console.log(`The dashboard service is enabled and running. See it with: ${APP_NAME} service status`);
      if (sayLinger) process.stdout.write(await lingerNote(run, env));
      return 0;
    }
    case 'restart': {
      if (!fs.existsSync(file)) {
        console.error(`The service is not installed. Install it with: ${APP_NAME} service install`);
        return 3;
      }
      const r = await run('systemctl', ['--user', 'restart', UNIT], env);
      if (!r.ok) {
        console.error(`systemctl --user restart ${UNIT} failed: ${r.err}`);
        return 1;
      }
      console.log(`The dashboard service was restarted. See it with: ${APP_NAME} service status`);
      return 0;
    }
    case 'start':
    case 'stop': {
      if (!fs.existsSync(file)) {
        console.error(`The service is not installed. Install it with: ${APP_NAME} service install`);
        return 3;
      }
      // A unit the start limit has stopped is in the failed state: it is cleared first, or a start is refused.
      if (sub === 'start') await run('systemctl', ['--user', 'reset-failed', UNIT], env);
      const r = await run('systemctl', ['--user', sub, UNIT], env);
      if (!r.ok) {
        console.error(`systemctl --user ${sub} ${UNIT} failed: ${r.err}`);
        return 1;
      }
      console.log(sub === 'stop' ? `The dashboard service was stopped. It stays stopped until: ${APP_NAME} service start` : 'The dashboard service was started.');
      return 0;
    }
    // Hidden: the keeper has written the files again; systemd reads them.
    case 'reload': {
      const r = await run('systemctl', ['--user', 'daemon-reload'], env);
      return r.ok ? 0 : 1;
    }
    case 'uninstall': {
      await run('systemctl', ['--user', 'disable', '--now', UNIT], env);
      fs.rmSync(path.join(unitDir(env), KEEP_UNIT), { force: true });
      try {
        fs.unlinkSync(file);
        console.log(`Removed ${file}`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        console.log('The service was not installed.');
      }
      await run('systemctl', ['--user', 'daemon-reload'], env);
      return 0;
    }
    case 'status': {
      const r = await run('systemctl', ['--user', 'status', UNIT, '--no-pager', '-n', '15'], env);
      console.log(r.out || r.err || 'not installed');
      process.stdout.write(await lingerNote(run, env));
      return r.ok ? 0 : 3;
    }
    default:
      console.error(`usage: ${APP_NAME} service install | uninstall | status | start | stop | restart`);
      return 2;
  }
}
