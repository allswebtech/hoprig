// The dashboard's commands, called by the launcher's bin script: serve, passwd, service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { generatePassword, hashPassword } from './auth.mjs';
import { DEFAULT_HOST, DEFAULT_PORT, createServer, hasPassword } from './server.mjs';
import { isLoopback } from './security.mjs';
import { notePassword, passwordProblem } from './strength.mjs';
import { firstPassword, passwordFileFrom, publicUrlSettings, resolveListen } from './serveopts.mjs';
import { APP_NAME } from './brand.mjs';
import { service } from './service/index.mjs';

const A = APP_NAME;
const USAGE = `usage:
  ${A} serve [--host H] [--port P] [--password-file F]
                                       start the dashboard (default ${DEFAULT_HOST}:${DEFAULT_PORT}; HOST and PORT in the
                                       environment also work; with no password set yet, F gets a new one)
  ${A} passwd                          set the dashboard password (asked twice, not shown)
  ${A} passwd --generate <file>        write a random password to <file> (mode 600) and use it
  ${A} service install|uninstall|status   run the dashboard in the background from login
                                       (systemd on Linux, launchd on macOS, Task Scheduler on Windows)
`;

/** Read a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const done = (fn) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stdout.write('\n');
      fn();
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    }
    input.on('data', onData);
  });
}

async function setPassword(password) {
  const hash = await hashPassword(password);
  saveConfig({ server: { passwordHash: hash } });
  notePassword(password, hash); // whether it is strong enough for the public link (only the result is kept)
  // A new password logs every browser out.
  try {
    fs.unlinkSync(path.join(stateDir(), 'web-sessions.json'));
  } catch {
    /* none yet */
  }
}

async function passwd(args) {
  if (args[0] === '--generate') {
    const file = args[1];
    if (!file) {
      console.error(`usage: ${A} passwd --generate <file>`);
      return 2;
    }
    const target = path.resolve(file);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      console.error(`${target} is a folder; give a file name`);
      return 2;
    }
    const pw = generatePassword();
    fs.writeFileSync(target, pw + '\n', { mode: 0o600 });
    fs.chmodSync(target, 0o600); // writeFileSync keeps the mode of a file that already existed
    await setPassword(pw);
    console.log(`New dashboard password written to ${target}`);
    return 0;
  }
  if (args.length) {
    process.stderr.write(USAGE);
    return 2;
  }
  // While the public link is on, the page can be reached from anywhere: no weak password then.
  const weak = (pw) => {
    const why = loadConfig().publicLink?.on === true ? passwordProblem(pw) : null;
    if (why) console.error(`The public link is on, so the password must be strong: ${why}. Nothing changed. Or: ${A} passwd --generate <file>`);
    return !!why;
  };
  if (!process.stdin.isTTY) {
    // Piped in (e.g. from a password manager): the first line is the password, no confirmation.
    let text = '';
    for await (const c of process.stdin) text += c;
    const pw = text.split(/\r?\n/)[0];
    if (pw.length < 8) {
      console.error('Use at least 8 characters.');
      return 1;
    }
    if (weak(pw)) return 1;
    await setPassword(pw);
    console.log('Dashboard password set.');
    return 0;
  }
  const a = await askHidden('New dashboard password: ');
  if (a.length < 8) {
    console.error('Use at least 8 characters.');
    return 1;
  }
  if (weak(a)) return 1;
  const b = await askHidden('Again: ');
  if (a !== b) {
    console.error('The two did not match; nothing changed.');
    return 1;
  }
  await setPassword(a);
  console.log('Dashboard password set. Every browser that was logged in has to log in again.');
  return 0;
}

function parseServeArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = (name) => {
      const m = a.startsWith(`${name}=`) ? a.slice(name.length + 1) : args[++i];
      if (m === undefined) throw new Error(`${name} needs a value`);
      return m;
    };
    if (a === '--host' || a.startsWith('--host=')) out.host = val('--host');
    else if (a === '--port' || a.startsWith('--port=')) {
      const p = Number(val('--port'));
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('--port must be 1-65535');
      out.port = p;
    } else if (a === '--password-file' || a.startsWith('--password-file=')) out.passwordFile = val('--password-file');
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

async function serve(args) {
  let o;
  try {
    o = parseServeArgs(args);
  } catch (e) {
    console.error(`${A} serve: ${e.message}`);
    return 2;
  }
  // An unattended first start (a hosting panel, Docker): no password yet, but a file is named for it.
  const pwFile = passwordFileFrom({ flags: o });
  if (!hasPassword() && pwFile) {
    try {
      const r = await firstPassword(pwFile, { setPassword, generate: generatePassword });
      console.log(r.created ? `New dashboard password written to ${pwFile}` : `Dashboard password taken from ${pwFile}`);
    } catch (e) {
      console.error(`${A} serve: ${e.message}`);
      return 1;
    }
  }
  if (!hasPassword()) {
    console.error(`${A} serve: no dashboard password is set. Set one first:\n\n  ${A} passwd\n\nor, to generate one into a file:\n\n  ${A} passwd --generate ~/${A}-password.txt`);
    return 1;
  }
  if (process.env.HOPRIG_PUBLIC_URL) {
    const patch = publicUrlSettings(process.env.HOPRIG_PUBLIC_URL, loadConfig().server);
    if (patch) saveConfig({ server: patch });
    else if (!/^https:\/\//.test(process.env.HOPRIG_PUBLIC_URL.trim())) console.error(`${A} serve: HOPRIG_PUBLIC_URL must be an https:// address; ignored`);
  }
  let host;
  let port;
  try {
    ({ host, port } = resolveListen({ flags: o, server: loadConfig().server, defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT } }));
  } catch (e) {
    console.error(`${A} serve: ${e.message}`);
    return 2;
  }
  const app = createServer({ host, port, loginCheck: true });
  try {
    await app.listen(port, host);
  } catch (e) {
    console.error(`${A} serve: cannot listen on ${host}:${port}: ${e.message}`);
    return 1;
  }
  const urls = [];
  if (host === '0.0.0.0' || host === '::') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4') urls.push(`http://${a.address}:${port}/`);
    }
  } else urls.push(`http://${host.includes(':') ? `[${host}]` : host}:${port}/`);
  console.log(`${A} dashboard: ${urls.join('  ')}`);
  if (!isLoopback(host)) {
    console.log('Plain HTTP is not encrypted: use it only on a network you trust, or put it behind HTTPS (Tailscale, a reverse proxy).');
  }
  if (app.backend.kind === 'none') console.log(app.backend.message);
  else console.log(`Sessions run on the ${app.backend.kind} backend.${app.backend.capabilities.persistent ? '' : ' They end when this server stops.'}`);
  // Stop the server, then the backend: the pty backend ends its sessions cleanly (Claude gets SIGHUP and saves);
  // tmux sessions keep running. The timer is the backstop if something hangs. It must outlast a clean stop of the
  // built-in terminals (their programs get STOP_WAIT_MS, then the shell as long, then what ignored SIGHUP gets
  // SIGTERM): cut short before that last step, a nohup job would outlive the dashboard.
  const stop = () => {
    app.close()
      .then(() => app.backend.close())
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  // SIGTERM never arrives on Windows; there Ctrl+Break (SIGBREAK) and closing the console window (SIGHUP) do.
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.once(sig, stop);
  return null; // keep running
}

/** Entry point from the bin script. Returns an exit code, or null while the server runs. */
export async function main(command, args = []) {
  switch (command) {
    case 'serve':
      return serve(args);
    case 'passwd':
      return passwd(args);
    case 'service':
      if (args[0] === 'install' && !hasPassword()) {
        console.error(`Set a dashboard password first (${A} passwd).`);
        return 1;
      }
      return service(args[0]);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}
