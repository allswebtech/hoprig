#!/usr/bin/env node
// Stands in for ssh-keyscan in tests: no network. Prints "<host> <kind> <blob>" for the host key in $FAKE_HOSTKEY
// ("<kind> <blob>", the made-up "server"'s key), writes how it was called to $FAKE_SSH_LOG, and with
// $FAKE_KEYSCAN_MODE=none prints nothing (no sshd there), as the real one does.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(['ssh-keyscan', ...args]) + '\n');
const host = args[args.length - 1];
if (process.env.FAKE_KEYSCAN_MODE === 'none' || !process.env.FAKE_HOSTKEY) {
  process.stderr.write(`${host}: Connection refused\n`);
  process.exit(1);
}
process.stdout.write(`# ${host}:22 SSH-2.0-OpenSSH_9.6\n${host} ${process.env.FAKE_HOSTKEY}\n`);
