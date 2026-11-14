// Everything this dashboard runs over SSH: the arguments, and the remote commands for pairing, installing and
// revoking. Always BatchMode: a dashboard has nobody to type a password or accept a host key, so those fail with
// a clear message instead of hanging.
//
// A trap on many machines: node (and with it hoprig) is on PATH only in a login + interactive shell, for
// example when nvm is loaded from ~/.bashrc, which returns early for non-interactive shells. So every remote
// hoprig command is tried plainly first, then through the user's own shell as `$SHELL -lic '...'`.
import { INSTALL_SCRIPT_URL } from '../paths.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

/** ssh arguments for the tunnel: local 127.0.0.1:localPort -> remoteHost:remotePort as seen from the target. */
export function tunnelArgs({ target, localPort, remoteHost, remotePort }) {
  const rh = remoteHost.includes(':') ? `[${remoteHost}]` : remoteHost;
  return [...SSH_OPTS, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${localPort}:${rh}:${remotePort}`, '--', target];
}

/**
 * ssh arguments for a reverse tunnel (`hoprig join`): port `hubPort` on the hub's 127.0.0.1 leads back to this
 * computer's dashboard at localHost:localPort. The hub's sshd binds it to its loopback only while GatewayPorts is
 * "no", sshd's default (join.mjs checks it). ExitOnForwardFailure: a port the hub cannot give means a failed try.
 */
export function reverseArgs({ target, hubPort, localHost = '127.0.0.1', localPort }) {
  const lh = localHost.includes(':') ? `[${localHost}]` : localHost;
  return [...SSH_OPTS, '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:${hubPort}:${lh}:${localPort}`, '--', target];
}

/** ssh arguments to run one command on the target. `--` ends ssh's options; the target never starts with "-". */
export const commandArgs = (target, command) => [...SSH_OPTS, '-T', '--', target, command];

/** Single-quote for a POSIX shell (and fish). Only used on values that were validated already. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The ways to run `hoprig <args>` there, in order: plain, then the user's login + interactive shell. */
export function remoteVariants(args) {
  const cmd = ['hoprig', ...args].map((a) => (/^[A-Za-z0-9._@=:/-]+$/.test(a) ? a : shq(a))).join(' ');
  return [cmd, `$SHELL -lic ${shq(cmd)}`];
}

/**
 * Run ssh. Resolves { code, stdout, stderr, timedOut }; never rejects for a failing command. `onLine` gets output
 * lines as they come (stdout and stderr both). `input` is a file whose contents become the remote stdin; `stdin` a
 * text that does (how a token travels: never on a command line, where `ps` would show it).
 */
export function runSsh(args, { sshBin = 'ssh', spawnImpl = spawn, timeoutMs = 30_000, onLine, input, stdin, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawnImpl(sshBin, args, { stdio: [input || stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], env });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false });
    }
    // Split into lines per stream; \r too, so progress bars show as they move.
    const splitter = () => {
      let rest = '';
      return (chunk) => {
        rest += chunk.toString('utf8');
        const parts = rest.split(/\r?\n|\r/);
        rest = parts.pop();
        for (const l of parts) onLine(l);
      };
    };
    child.stdout.on('data', (c) => {
      stdout = (stdout + c.toString('utf8')).slice(-256 * 1024);
    });
    child.stderr.on('data', (c) => {
      stderr = (stderr + c.toString('utf8')).slice(-64 * 1024);
    });
    if (onLine) {
      child.stdout.on('data', splitter());
      child.stderr.on('data', splitter());
    }
    if (stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    } else if (input) {
      const src = fs.createReadStream(input);
      src.on('error', () => child.stdin.end());
      child.stdin.on('error', () => {});
      src.pipe(child.stdin);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
    });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    };
    child.on('close', finish);
    // After a timeout, do not wait for the pipes: something ssh started may still hold them open.
    child.on('exit', (code) => timedOut && finish(code));
  });
}

/** Why ssh itself failed (exit 255), in words the user can act on. */
export function sshFailure(target, stderr) {
  const s = String(stderr || '');
  if (/Permission denied/i.test(s)) return { code: 'ssh-auth', message: `SSH could not log in to ${target} without a password. Set up a key once: ssh-copy-id ${target}` };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) {
    return { code: 'ssh-hostkey', message: `${target}'s host key is not known yet (or changed). Connect once by hand to check and accept it: ssh ${target}` };
  }
  if (/remote port forwarding failed|administratively prohibited/i.test(s)) {
    return { code: 'ssh-forward', message: `${target} did not open the port for this computer (${lastLine(s)}). Its sshd must allow forwarding (AllowTcpForwarding yes, the default).` };
  }
  if (/Could not resolve hostname/i.test(s)) return { code: 'ssh-resolve', message: `No computer called "${target}" was found. Check the name, or add it to ~/.ssh/config.` };
  if (/Connection refused|timed out|No route to host|Network is unreachable|Connection closed/i.test(s)) {
    return { code: 'ssh-unreachable', message: `${target} cannot be reached by SSH (${lastLine(s)}).` };
  }
  return { code: 'ssh-failed', message: `SSH to ${target} failed: ${lastLine(s) || 'no reason given'}` };
}

const lastLine = (s) => String(s).trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) || '';

const notFound = (r) => r.code === 127 || /command not found|: not found|No such file or directory|Unknown command: hoprig/i.test(r.stderr);
const tooOld = (r) => /is neither a command nor a profile/.test(r.stdout + r.stderr);

/** The last stdout line that is a JSON object with hoprig === kind. Login shells may print other lines. */
export function findJson(stdout, kind) {
  const lines = String(stdout).split(/\r?\n/).reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.hoprig === kind) return o;
    } catch {
      /* not it */
    }
  }
  return null;
}

/**
 * Run `hoprig <args>` on the target, plain first and then through the login shell. Resolves
 *   { ok: true, result, variant }                   the command ran (exit 0)
 *   { ok: false, code, message, tried }             ssh-*, not-installed, too-old, failed, timeout
 */
export async function runHoprig(target, args, opts = {}) {
  const tried = [];
  for (const cmd of remoteVariants(args)) {
    const r = await runSsh(commandArgs(target, cmd), opts);
    tried.push(cmd);
    if (r.timedOut) return { ok: false, code: 'timeout', message: `${target} did not answer in time.`, tried };
    if (r.code === 255) return { ok: false, ...sshFailure(target, r.stderr), tried };
    if (r.code === 0) return { ok: true, result: r, variant: cmd };
    if (tooOld(r)) return { ok: false, code: 'too-old', message: `The Hoprig on ${target} is too old for this. Update it there: hoprig update`, tried };
    if (notFound(r)) continue;
    return { ok: false, code: 'failed', message: `Hoprig on ${target} failed: ${lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code}`}`, tried };
  }
  return { ok: false, code: 'not-installed', message: `${target} has no Hoprig (or the hoprig command is not on its PATH).`, tried };
}

/** Pair over SSH: `hoprig pair --json --name <hub>` there. Resolves { ok, info } or the failure. */
export async function pairOverSsh(target, hubName, opts = {}) {
  const r = await runHoprig(target, ['pair', '--json', '--name', hubName], opts);
  if (!r.ok) return r;
  const info = findJson(r.result.stdout, 'pair');
  if (!info || typeof info.token !== 'string' || !Number.isInteger(info.port)) {
    return { ok: false, code: 'failed', message: `Hoprig on ${target} gave an answer this dashboard does not understand. Update both to the same version.` };
  }
  return { ok: true, info };
}

/** Best effort, when a machine is removed: revoke this dashboard's token there. */
export async function revokeOverSsh(target, tokenId, opts = {}) {
  if (!/^[0-9a-f]{12}$/.test(String(tokenId))) return { ok: false, code: 'failed', message: 'no token id' };
  return runHoprig(target, ['tokens', 'revoke', tokenId], { timeoutMs: 20_000, ...opts });
}

/** https URL without characters a shell would act on inside double quotes. */
const SAFE_URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#%+=&@-]+$/;

/**
 * Where the installer comes from: an https URL (fetched there with curl) or a file on this computer (sent over
 * the SSH connection). Returns { kind: 'url' | 'file', value } or null when none is usable.
 */
export function installSource(v) {
  if (typeof v !== 'string' || !v) return null;
  if (SAFE_URL_RE.test(v)) return { kind: 'url', value: v };
  if (v.startsWith('/') && fs.existsSync(v)) return { kind: 'file', value: v };
  return null;
}

/** The one line to install hoprig by hand on that computer (a command only: the page offers to copy it). */
export const installHint = (src) =>
  `curl -fsSL ${src && src.kind === 'url' ? src.value : INSTALL_SCRIPT_URL} | sh`;

/**
 * Run the installer there, through the user's login shell so it sees their usual PATH (an nvm Node included).
 * `--yes` because there is no terminal to answer questions in. Output lines go to onLine as they come.
 */
export function installOverSsh(target, src, { onLine, timeoutMs = 20 * 60_000, ...opts } = {}) {
  const inner = src.kind === 'url' ? `curl -fsSL --proto =https ${src.value} | sh -s -- --yes` : 'sh -s -- --yes';
  return runSsh(commandArgs(target, `$SHELL -lic "${inner}"`),{ ...opts, onLine, timeoutMs, input: src.kind === 'file' ? src.value : undefined });
}
