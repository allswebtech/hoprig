// A gateway run as a service of this computer's user, so it comes back after a restart (Health → Gateways → Run as a
// service): a systemd user unit on Linux, a launchd agent on macOS, one plain sentence elsewhere. The page shows the
// file in full and the commands first (plan); the file is written and the commands run only on the owner's press
// (make), and taken away the same way (remove). On Linux a user service starts after a restart only with lingering on,
// which needs administrator rights once: lingerOf says whether it is on.
//
// Every program here (systemctl, launchctl, loginctl, sudo) runs through `run(argv)` (capture by default), so a test
// passes its own stand-in and nothing of the real system is reached.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_NAME } from '../server/brand.mjs';
import { capture, showCommand, which } from '../setup/system.mjs';
import { serverReason } from '../setup/server.mjs';
// A cycle (localgateway.mjs imports servicePid from here): only functions, called after both are loaded.
import { keepsLocal } from './localgateway.mjs';

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const unitName = (id) => `${APP_NAME}-gateway-${id}.service`;
export const agentLabel = (id) => `local.${APP_NAME}.gateway.${id}`;
const unitFile = (id, env, home) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', unitName(id));
const agentFile = (id, home) => path.join(home, 'Library', 'LaunchAgents', `${agentLabel(id)}.plist`);

/** Where its service listens: what every start of the gateway gets (localgateway.mjs listenRule), so all go one way. */
export function listenHere(addon) {
  if (typeof addon.listen === 'function') return addon.listen();
  // An add-on without words of its own: HOST where the rule keeps a gateway on this computer, as listenRule gives it.
  return keepsLocal({ reason: serverReason() }) ? { args: [], env: { HOST: '127.0.0.1' } } : { args: [], env: {} };
}

/** The gateway's program and arguments as the service runs it, or null when its program is not on this computer. */
export function programOf(addon, lookup = which) {
  const [bin, ...args] = addon.command();
  const file = path.isAbsolute(bin) ? bin : lookup(bin);
  if (!file) return null;
  return [file, ...args]; // command() holds the listen words already
}

// systemd reads "%" as a specifier and "$" as a variable in ExecStart; both doubled, quotes and backslashes escaped.
const sdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
const envLine = (k, v) => `Environment="${k}=${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * What making the service would do: { kind: 'systemd' | 'launchd', file, text, commands, undo } (commands: argv lists
 * run one after the other), or { kind: 'none', sentence } / { kind: 'missing', sentence }.
 */
export function servicePlan(addon, { platform = process.platform, env = process.env, home = os.homedir(), uid = process.getuid?.(), lookup = which } = {}) {
  if (!ID_RE.test(addon.id)) return { kind: 'none', sentence: 'That gateway cannot run as a service.' };
  const argv = programOf(addon, lookup);
  if (!argv) return { kind: 'missing', sentence: `${addon.title} is not installed on this computer: install it first.` };
  const vars = { PATH: env.PATH || '/usr/bin:/bin', ...listenHere(addon).env };
  if (platform === 'linux') {
    const unit = unitName(addon.id);
    const file = unitFile(addon.id, env, home);
    const text = [
      `# Written by ${APP_NAME} (Health → Gateways → Run as a service). Removed there too.`,
      '[Unit]',
      `Description=${addon.title} (a gateway, set up by ${APP_NAME})`,
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${argv.map(sdQuote).join(' ')}`,
      ...Object.entries(vars).map(([k, v]) => envLine(k, v)),
      // What it prints (a first password, where a gateway makes one) is not kept in the journal; its errors are.
      'StandardOutput=null',
      'StandardError=journal',
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      kind: 'systemd', unit, file, text,
      commands: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', unit]],
      undo: [['systemctl', '--user', 'disable', '--now', unit], ['systemctl', '--user', 'daemon-reload']],
    };
  }
  if (platform === 'darwin') {
    const label = agentLabel(addon.id);
    const file = agentFile(addon.id, home);
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '  <dict>',
      `    <key>Label</key>\n    <string>${xml(label)}</string>`,
      '    <key>ProgramArguments</key>',
      '    <array>',
      ...argv.map((a) => `      <string>${xml(a)}</string>`),
      '    </array>',
      '    <key>EnvironmentVariables</key>',
      '    <dict>',
      ...Object.entries(vars).map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`),
      '    </dict>',
      '    <key>RunAtLoad</key>\n    <true/>',
      '    <key>KeepAlive</key>\n    <dict>\n      <key>SuccessfulExit</key>\n      <false/>\n    </dict>',
      '  </dict>',
      '</plist>',
      '',
    ].join('\n');
    const domain = `gui/${uid}`;
    const target = `${domain}/${label}`;
    return { kind: 'launchd', label, domain, target, file, text, commands: [['launchctl', 'bootstrap', domain, file]], undo: [['launchctl', 'bootout', target]] };
  }
  return { kind: 'none', sentence: `On this system (${platform}) ${APP_NAME} cannot run a gateway as a service: start it from here when you need it.` };
}

/** Is the service made, and does it run? { made, active } (active: null where it cannot be told). */
export async function serviceState(plan, { run = capture } = {}) {
  if (plan.kind !== 'systemd' && plan.kind !== 'launchd') return { made: false, active: null };
  const made = fs.existsSync(plan.file);
  if (!made) return { made, active: false };
  if (plan.kind === 'systemd') return { made, active: (await run(['systemctl', '--user', 'is-active', plan.unit])).stdout.trim() === 'active' };
  return { made, active: null };
}

/**
 * The process the service of gateway `id` runs now, or null: no service made here (nothing is asked then), not running,
 * or it cannot be told. What listens on the gateway's port is the gateway when it is this process or its descendant
 * (localgateway.mjs ours): the service runs the program Hoprig wrote into its file, on the owner's press.
 */
export async function servicePid(id, { platform = process.platform, env = process.env, home = os.homedir(), uid = process.getuid?.(), run = capture } = {}) {
  if (!ID_RE.test(id)) return null;
  let r;
  let m;
  if (platform === 'linux') {
    if (!fs.existsSync(unitFile(id, env, home))) return null;
    r = await run(['systemctl', '--user', 'show', '--property=MainPID', '--value', unitName(id)]);
    m = r && r.ok ? /^(\d+)\s*$/.exec(r.stdout || '') : null;
  } else if (platform === 'darwin') {
    if (!fs.existsSync(agentFile(id, home))) return null;
    r = await run(['launchctl', 'print', `gui/${uid}/${agentLabel(id)}`]);
    m = r && r.ok ? /^\s*pid = (\d+)\s*$/m.exec(r.stdout || '') : null;
  }
  const pid = m ? Number(m[1]) : 0;
  return pid > 1 ? pid : null; // systemd says 0 for a service that does not run
}

/**
 * Start or stop a made service now (Health → Gateways → Start, Stop): through it, so it is the one copy that runs.
 * systemd: start or stop the unit (a stop is not a failure, so Restart=on-failure leaves it stopped). launchd: a job
 * killed by a signal has not exited successfully, so KeepAlive would start it again within seconds; Stop takes the
 * job out of launchd (bootout) and Start puts it back (bootstrap) and starts it (kickstart). Its file stays, so it
 * starts by itself again at the next login after a restart. → { ok } or { ok: false, error }.
 */
export async function serviceNow(plan, action, { run = capture } = {}) {
  let steps;
  if (plan.kind === 'systemd') steps = [['systemctl', '--user', action, plan.unit]];
  else if (plan.kind === 'launchd') {
    const loaded = Boolean((await run(['launchctl', 'print', plan.target]))?.ok);
    if (action === 'start') steps = [...(loaded ? [] : [['launchctl', 'bootstrap', plan.domain, plan.file]]), ['launchctl', 'kickstart', plan.target]];
    else steps = loaded ? [['launchctl', 'bootout', plan.target]] : []; // not loaded: it does not run
  } else return { ok: false, error: plan.sentence };
  for (const argv of steps) {
    const r = await run(argv);
    if (!r?.ok) return { ok: false, error: `${showCommand(argv)} did not work: ${((r && (r.stderr || r.stdout)) || 'no reason given').trim().split('\n').pop()}` };
  }
  return { ok: true };
}

/** Write the file and run the commands; { ok, lines } with what each command said. A second make changes nothing. */
export async function makeService(plan, { run = capture } = {}) {
  if (plan.kind !== 'systemd' && plan.kind !== 'launchd') return { ok: false, lines: [plan.sentence] };
  const same = (() => {
    try {
      return fs.readFileSync(plan.file, 'utf8') === plan.text;
    } catch {
      return false;
    }
  })();
  if (same && (await serviceState(plan, { run })).active !== false) return { ok: true, already: true, lines: [`${plan.file} is there already, unchanged.`] };
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.text, { mode: 0o644 });
  const lines = [`Wrote ${plan.file}`];
  for (const argv of plan.commands) {
    const r = await run(argv);
    lines.push(`${argv.join(' ')}: ${r.ok ? 'done' : (r.stderr || r.stdout || 'failed').trim().split('\n').pop()}`);
    if (!r.ok) return { ok: false, lines };
  }
  return { ok: true, lines };
}

/** Stop it, run the undo commands and remove the file. */
export async function removeService(plan, { run = capture } = {}) {
  if (plan.kind !== 'systemd' && plan.kind !== 'launchd') return { ok: false, lines: [plan.sentence] };
  const lines = [];
  for (const argv of plan.undo) {
    const r = await run(argv);
    lines.push(`${argv.join(' ')}: ${r.ok ? 'done' : 'nothing to stop'}`);
  }
  fs.rmSync(plan.file, { force: true });
  lines.push(`Removed ${plan.file}`);
  return { ok: true, lines };
}

/** Whether a user service here starts after a restart without a login: 'on', 'off' or null (cannot tell, not Linux). */
export async function lingerOf({ run = capture, platform = process.platform, user = os.userInfo().username } = {}) {
  if (platform !== 'linux') return null;
  const r = await run(['loginctl', 'show-user', user, '-p', 'Linger']);
  if (!r.ok) return null;
  return /Linger=yes/.test(r.stdout) ? 'on' : /Linger=no/.test(r.stdout) ? 'off' : null;
}

/** The administrator command that turns lingering on, as the page shows it. */
export const lingerCommand = (user = os.userInfo().username) => ['sudo', 'loginctl', 'enable-linger', user];
