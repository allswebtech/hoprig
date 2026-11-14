// The dashboard as a systemd user service (Linux), so it starts with the machine and keeps running after you
// log out (with lingering on).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binFile } from '../../paths.mjs';
import { APP_NAME } from '../brand.mjs';
import { CARRIED_ENV } from './env.mjs';

export const UNIT = `${APP_NAME}.service`;

export { CARRIED_ENV };

export const unitDir = (env = process.env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');

// systemd treats "%" as a specifier and "$" as a variable in ExecStart; both are doubled. Inside double quotes,
// backslash and the quote itself are escaped.
const sdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
const envQuote = (k, val) => `"${k}=${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

/** The unit file text. Pure, so it can be tested. */
export function unitText({ node = process.execPath, bin = binFile(), env = process.env } = {}) {
  const lines = [
    `# Written by \`${APP_NAME} service install\`. Remove with \`${APP_NAME} service uninstall\`.`,
    '[Unit]',
    `Description=${APP_NAME} dashboard (Claude Code sessions)`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${sdQuote(node)} ${sdQuote(bin)} serve`,
  ];
  for (const k of CARRIED_ENV) if (env[k]) lines.push(`Environment=${envQuote(k, env[k])}`);
  lines.push(
    'Restart=on-failure',
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

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || (err && err.message) || '').trim() }),
    );
  });

async function lingerNote() {
  const user = os.userInfo().username;
  const r = await run('loginctl', ['show-user', user, '-p', 'Linger']);
  if (r.ok && /Linger=no/.test(r.out)) {
    return (
      '\nLingering is off, so the service stops when you log out and only starts when you log in.\n' +
      'To keep it running at all times, run this once yourself:\n\n' +
      `  sudo loginctl enable-linger ${user}\n`
    );
  }
  return '';
}

export async function service(sub) {
  const file = path.join(unitDir(), UNIT);
  switch (sub) {
    case 'install': {
      fs.mkdirSync(unitDir(), { recursive: true });
      fs.writeFileSync(file, unitText(), { mode: 0o644 });
      console.log(`Wrote ${file}`);
      for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', UNIT], ['--user', 'restart', UNIT]]) {
        const r = await run('systemctl', args);
        if (!r.ok) {
          console.error(`systemctl ${args.join(' ')} failed: ${r.err}`);
          return 1;
        }
      }
      console.log(`The dashboard service is enabled and running. See it with: ${APP_NAME} service status`);
      process.stdout.write(await lingerNote());
      return 0;
    }
    case 'uninstall': {
      await run('systemctl', ['--user', 'disable', '--now', UNIT]);
      try {
        fs.unlinkSync(file);
        console.log(`Removed ${file}`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        console.log('The service was not installed.');
      }
      await run('systemctl', ['--user', 'daemon-reload']);
      return 0;
    }
    case 'status': {
      const r = await run('systemctl', ['--user', 'status', UNIT, '--no-pager', '-n', '15']);
      console.log(r.out || r.err || 'not installed');
      process.stdout.write(await lingerNote());
      return r.ok ? 0 : 3;
    }
    default:
      console.error(`usage: ${APP_NAME} service install | uninstall | status`);
      return 2;
  }
}
