// The host key of a computer added with a kept key (keys.mjs): read once with ssh-keyscan, shown to the owner as its
// SHA256 print, kept only after he confirms that print, and from then on the only key ssh accepts for that computer.
//
// Its own known-hosts file beside the key (<configDir>/ssh-keys/<computer>.known_hosts), one line under one fixed
// alias: every ssh to that computer runs with HostKeyAlias=<ALIAS>, UserKnownHostsFile=<that file> and
// StrictHostKeyChecking=yes, so a changed key stops ssh itself, and the owner's own ~/.ssh/known_hosts is neither
// read nor written for it. A computer added by a name ssh already knows keeps ssh's own known-hosts, as before.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replaceFile } from '../replacefile.mjs';

export const ALIAS = 'hoprig-computer';
// The kinds of host key, in the order ssh prefers them; the first one the computer offers is the one shown and kept.
const KINDS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The SHA256 print of a key blob (base64), as ssh shows it: "SHA256:" and unpadded base64. */
export const fingerprint = (b64) => `SHA256:${crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')}`;

/** The key kind written inside the blob itself, or null (a line whose blob does not say its own kind is not taken). */
function blobKind(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 4) return null;
  const n = buf.readUInt32BE(0);
  return n > 0 && n < 64 && buf.length >= 4 + n ? buf.subarray(4, 4 + n).toString('latin1') : null;
}

/** The host keys in ssh-keyscan's output (or a known-hosts file): [{ kind, b64, print }], best kind first. */
export function parseKeys(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [, kind, b64] = t.split(/\s+/);
    if (!KINDS.includes(kind) || !B64.test(b64 || '') || blobKind(b64) !== kind) continue;
    if (!out.some((k) => k.b64 === b64)) out.push({ kind, b64, print: fingerprint(b64) });
  }
  return out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

/**
 * Ask `host`:`port` for its host key with ssh-keyscan (found the way ssh is: `bin` on the given PATH). Resolves
 * { ok: true, key: { kind, b64, print } } or { ok: false, message } in plain words. Never logs in.
 */
export function scanHostKey(host, port, { bin = 'ssh-keyscan', env = process.env, spawnImpl = spawn, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawnImpl(bin, ['-T', '10', '-p', String(port), '-t', KINDS.filter((k) => !k.startsWith('ecdsa-sha2-nistp3') && !k.startsWith('ecdsa-sha2-nistp5')).map((k) => (k.startsWith('ecdsa') ? 'ecdsa' : k.replace(/^ssh-/, ''))).join(','), '--', host], { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (e) {
      return resolve({ ok: false, message: `The host key of ${host} could not be read (${e.message}).` });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => (out = (out + c).slice(-64 * 1024)));
    child.stderr.on('data', (c) => (err = (err + c).slice(-8 * 1024)));
    child.on('error', (e) => (err += `\n${e.message}`));
    child.on('close', () => {
      clearTimeout(timer);
      const [key] = parseKeys(out);
      if (key) return resolve({ ok: true, key });
      const why = err.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop();
      resolve({ ok: false, message: `${host} did not show a host key on port ${port}${why ? ` (${why.slice(0, 200)})` : ''}. Check the address and the port, and that the computer is on.` });
    });
  });
}

/** Keep `key` as the one host key of this computer: the file is written whole, mode 600. */
export function keepHostKey(file, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${ALIAS} ${key.kind} ${key.b64}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  replaceFile(tmp, file);
}

/** The kept host key, or null when there is none. */
export function keptHostKey(file) {
  try {
    return parseKeys(fs.readFileSync(file, 'utf8'))[0] || null;
  } catch {
    return null;
  }
}

/** ssh's options for a computer with a kept key and a kept host key. */
export const keyedOptions = ({ keyFile, knownHosts }) => [
  '-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
  '-o', `HostKeyAlias=${ALIAS}`, '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
];

/** Did ssh stop because the host key is not the kept one? */
export const hostKeyRefused = (stderr) => /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (ED25519|ECDSA|RSA) host key is known/i.test(String(stderr || ''));
