#!/usr/bin/env node
// Stands in for ssh in tests: no network login, no real remote. It writes how it was called to $FAKE_SSH_LOG,
// then either
//   -N -L 127.0.0.1:L:host:R ... target   forwards local port L to host:R (a real TCP forward, like ssh -L),
//   -N -R 127.0.0.1:P:host:L ... target   the reverse: the "hub" (this same computer) listens on P and forwards to
//                                          host:L, bound to 127.0.0.1 like sshd's default (GatewayPorts no), or
//   ... target COMMAND                     runs COMMAND with /bin/sh here, with SHELL=$FAKE_SSH_SHELL (the "login
//                                          shell" of the fake remote user).
// $FAKE_SSH_MODE: "auth" fails like a refused key, "hostkey" like an unknown host key, "die-after-ms:N" makes a
// tunnel exit after N ms (to test reconnecting), "gateway-yes" binds a reverse port on every address like sshd with
// GatewayPorts yes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\n');
const mode = process.env.FAKE_SSH_MODE || '';
if (mode === 'auth') {
  process.stderr.write('user@host: Permission denied (publickey,password).\n');
  process.exit(255);
}
if (mode === 'hostkey') {
  process.stderr.write('Host key verification failed.\n');
  process.exit(255);
}

// A computer added with a kept key (src/machines/hostkeys.mjs): with $FAKE_HOSTKEY ("<kind> <blob>", the made-up
// server's host key) the file named by UserKnownHostsFile must hold that key, as ssh's StrictHostKeyChecking=yes
// demands; with $FAKE_SSH_ACCEPT_KEY (a file) the -i key must have its contents, else the login is refused.
const opt = (k) => {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-o' && args[i + 1].startsWith(`${k}=`)) return args[i + 1].slice(k.length + 1);
  return null;
};
const known = opt('UserKnownHostsFile');
if (known && process.env.FAKE_HOSTKEY) {
  const kept = fs.existsSync(known) ? fs.readFileSync(known, 'utf8').trim().split(/\s+/).slice(1).join(' ') : '';
  if (kept !== process.env.FAKE_HOSTKEY.trim()) {
    process.stderr.write(kept ? '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n' : 'No ED25519 host key is known for hoprig-computer and you have requested strict checking.\nHost key verification failed.\n');
    process.exit(255);
  }
}
const ki = args.indexOf('-i');
if (ki >= 0 && process.env.FAKE_SSH_ACCEPT_KEY) {
  const given = fs.existsSync(args[ki + 1]) ? fs.readFileSync(args[ki + 1], 'utf8') : null;
  if (given !== fs.readFileSync(process.env.FAKE_SSH_ACCEPT_KEY, 'utf8') || opt('IdentitiesOnly') !== 'yes') {
    process.stderr.write('alex@box2: Permission denied (publickey).\n');
    process.exit(255);
  }
}

const dd = args.indexOf('--');
const rest = dd >= 0 ? args.slice(dd + 1) : args;
const l = args.indexOf('-L') >= 0 ? args.indexOf('-L') : args.indexOf('-R');
const reverse = args.indexOf('-R') >= 0;
if (args.includes('-N') && l >= 0) {
  const [, lport, rhost, rport] = /^127\.0\.0\.1:(\d+):\[?([^\]]+?)\]?:(\d+)$/.exec(args[l + 1]) || [];
  const server = net.createServer((c) => {
    const up = net.connect({ host: rhost, port: Number(rport) });
    c.pipe(up).pipe(c);
    const end = () => {
      c.destroy();
      up.destroy();
    };
    c.on('error', end);
    up.on('error', end);
  });
  server.on('error', (e) => {
    process.stderr.write(reverse ? `Error: remote port forwarding failed for listen port ${lport}\n` : `bind [127.0.0.1]:${lport}: ${e.message}\nCould not request local forwarding.\n`);
    process.exit(255);
  });
  server.listen(Number(lport), reverse && mode === 'gateway-yes' ? '0.0.0.0' : '127.0.0.1');
  const m = /^die-after-ms:(\d+)$/.exec(mode);
  if (m) {
    setTimeout(() => {
      process.stderr.write('Connection to host closed by remote host.\n');
      process.exit(255);
    }, Number(m[1]));
  }
  const bye = () => process.exit(0);
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
} else {
  const command = rest[1];
  if (!command) {
    process.stderr.write('fake ssh: no command\n');
    process.exit(255);
  }
  const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit', env: { ...process.env, SHELL: process.env.FAKE_SSH_SHELL || '/bin/sh' } });
  child.on('exit', (code) => process.exit(code ?? 1));
}
