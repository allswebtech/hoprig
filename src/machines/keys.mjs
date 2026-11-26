// The SSH keys this dashboard keeps for computers added with a key file (Computers → Add a computer → by SSH, "a key
// file"): <configDir>/ssh-keys/<computer>, one file per computer, the folder mode 700 and each file mode 600. Nothing
// else in Hoprig holds a key's text: machines.json records only that a key is kept (`key: true`), and no route,
// log, error or Activity line ever carries it. A key is removed with its computer and after an add that failed.
//
// A key with a passphrase is refused: a dashboard has nobody to type one, and Hoprig never asks for one or keeps
// one. That is read from the key's own format here, without running a program. Text that is not a private key is
// refused too, and never quoted back (it may be a key of another kind, or a secret pasted into the wrong field).
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../paths.mjs';
import { keyedOptions } from './hostkeys.mjs';
import { machineName } from './names.mjs';
import { replaceFile } from '../replacefile.mjs';

export const keysDir = () => path.join(configDir(), 'ssh-keys');
const MAX = 16 * 1024;

export class KeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

const PASSPHRASE = 'This key is protected by a passphrase. Hoprig never asks for one or keeps one: use a key without a passphrase for this computer (make one with ssh-keygen -t ed25519 -N "" -f <file>), or a key name ssh already knows.';
const NOT_A_KEY = 'That is not a private SSH key. Paste the whole private key file, from the line "-----BEGIN" to the line "-----END", or pick the file.';
const PUBLIC = 'That is a public key (the .pub file). Paste or pick the private key: the file of the same name without .pub.';

/** The base64 body between a PEM's BEGIN and END lines of `label`, its header lines apart, or null. */
function pem(text, label) {
  const re = new RegExp(`^-----BEGIN ${label}-----\\n([\\s\\S]*?)\\n-----END ${label}-----\\n?$`);
  const m = re.exec(text);
  if (!m) return null;
  const lines = m[1].split('\n');
  const headers = lines.filter((l) => l.includes(':'));
  const body = lines.filter((l) => !l.includes(':') && l.trim()).join('');
  return /^[A-Za-z0-9+/=]+$/.test(body) ? { headers, body } : null;
}

/** OpenSSH's own format: "openssh-key-v1\0", then the cipher's name ("none" when there is no passphrase). */
function opensshCipher(b64) {
  const buf = Buffer.from(b64, 'base64');
  const magic = Buffer.from('openssh-key-v1\0', 'latin1');
  if (buf.length < magic.length + 4 || !buf.subarray(0, magic.length).equals(magic)) return null;
  const len = buf.readUInt32BE(magic.length);
  if (len < 1 || len > 64 || buf.length < magic.length + 4 + len) return null;
  const cipher = buf.subarray(magic.length + 4, magic.length + 4 + len).toString('latin1');
  return /^[a-z0-9@.-]+$/.test(cipher) ? cipher : null;
}

/**
 * The key as it will be kept (line ends made plain, one newline at the end), or a KeyError whose message says what to
 * do, in plain words and without any of the text.
 */
export function checkKey(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new KeyError('no-key', 'Paste the private key, or pick its file.');
  if (raw.length > MAX) throw new KeyError('not-a-key', NOT_A_KEY);
  const text = `${raw.replace(/\r\n?/g, '\n').trim()}\n`;
  if (/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+) AAAA/.test(text)) throw new KeyError('public-key', PUBLIC);
  const own = pem(text, 'OPENSSH PRIVATE KEY');
  if (own) {
    const cipher = opensshCipher(own.body);
    if (!cipher) throw new KeyError('not-a-key', NOT_A_KEY);
    if (cipher !== 'none') throw new KeyError('passphrase', PASSPHRASE);
    return text;
  }
  if (pem(text, 'ENCRYPTED PRIVATE KEY')) throw new KeyError('passphrase', PASSPHRASE);
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY']) {
    const p = pem(text, label);
    if (!p) continue;
    if (p.headers.some((h) => /^Proc-Type:\s*4,ENCRYPTED/i.test(h) || /^DEK-Info:/i.test(h))) throw new KeyError('passphrase', PASSPHRASE);
    return text;
  }
  throw new KeyError('not-a-key', NOT_A_KEY);
}

const nameOf = (name) => {
  const n = machineName(name);
  if (!n) throw new Error('not a computer name');
  return n;
};

/** Where computer `name`'s key is kept (whether or not it is there). */
export const keyFile = (name) => path.join(keysDir(), nameOf(name));
/** The host keys Hoprig keeps for that computer (hostkeys.mjs). */
export const knownHostsFile = (name) => path.join(keysDir(), `${nameOf(name)}.known_hosts`);

function ensureDir() {
  fs.mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(keysDir(), 0o700);
}

/** Keep `raw` (checked first) as computer `name`'s key: mode 600, written whole or not at all. Returns the file. */
export function keepKey(name, raw) {
  const text = checkKey(raw);
  ensureDir();
  const file = keyFile(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  replaceFile(tmp, file);
  return file;
}

export const hasKey = (name) => {
  try {
    return fs.statSync(keyFile(name)).isFile();
  } catch {
    return false;
  }
};

/** Forget computer `name`'s key and its kept host keys. Never throws for a file that is not there. */
export function dropKey(name) {
  for (const f of [keyFile(name), knownHostsFile(name)]) fs.rmSync(f, { force: true });
}

/** ssh's options for computer `m` (a stored machine): its kept key and host key, or none for one ssh knows by name. */
export const sshExtraOf = (m) => (m && m.key === true && machineName(m.name) ? keyedOptions({ keyFile: keyFile(m.name), knownHosts: knownHostsFile(m.name) }) : []);

/** A computer with a kept key got a new name: its key and host keys move with it (renamed in place, nothing copied). */
export function moveKey(from, to) {
  for (const [a, b] of [[keyFile(from), keyFile(to)], [knownHostsFile(from), knownHostsFile(to)]]) {
    try {
      fs.renameSync(a, b);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
