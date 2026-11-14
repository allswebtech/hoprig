// One-time secrets with a short life: pairing codes and sign-in links. Made by one process (the CLI), used by
// another (the running dashboard), so they live in a file under the state folder. Only a hash of each secret is
// kept; a secret works once, until it expires; every check compares against every entry in constant time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';

const KEEP = 20; // at most this many open secrets per kind; making one more drops the oldest

export class OneTimeStore {
  /** `name`: the file is <stateDir>/<name>.json. `salt` separates the kinds, so a pairing code never signs in. */
  constructor(name, { salt = name } = {}) {
    this.name = name;
    this.salt = salt;
  }

  get file() {
    return path.join(stateDir(), `${this.name}.json`);
  }

  hash(secret) {
    return crypto.createHash('sha256').update(`hoprig-${this.salt}:${secret}`).digest();
  }

  #read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { pending: Array.isArray(d.pending) ? d.pending : [], used: Array.isArray(d.used) ? d.used : [] };
    } catch {
      return { pending: [], used: [] };
    }
  }

  #write(d) {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  #prune(d, now) {
    return {
      pending: d.pending.filter((p) => p && p.expires > now).slice(-KEEP),
      used: d.used.filter((u) => u && u.at > now - 3600_000).slice(-KEEP),
    };
  }

  /** Remember `secret` until `ttlMs` from now. Returns { id, expires }. */
  add(secret, ttlMs, { now = Date.now() } = {}) {
    const id = crypto.randomBytes(6).toString('hex');
    const d = this.#prune(this.#read(), now);
    d.pending.push({ id, hash: this.hash(secret).toString('hex'), created: now, expires: now + ttlMs });
    this.#write(d);
    return { id, expires: now + ttlMs };
  }

  /**
   * Use a secret: its entry's id when it matches an open one (which is then gone for good), else null. `secret`
   * null (malformed input) still runs the comparisons, so a bad input takes as long as a wrong one. `by` is noted
   * for status().
   */
  take(secret, by = '', { now = Date.now() } = {}) {
    const d = this.#prune(this.#read(), now);
    const got = this.hash(secret ?? '\0');
    let hit = null;
    for (const p of d.pending) {
      const want = Buffer.from(String(p.hash), 'hex');
      if (want.length === got.length && crypto.timingSafeEqual(got, want) && secret !== null && !hit) hit = p;
    }
    if (hit) {
      d.pending = d.pending.filter((p) => p !== hit);
      d.used.push({ id: hit.id, by: String(by).slice(0, 60), at: now });
    }
    this.#write(d);
    return hit ? hit.id : null;
  }

  /** 'pending' | 'expired' | { usedBy } for the secret added with id `id`. */
  status(id, { now = Date.now() } = {}) {
    const d = this.#read();
    const u = d.used.find((x) => x.id === id);
    if (u) return { usedBy: u.by };
    return d.pending.some((p) => p.id === id && p.expires > now) ? 'pending' : 'expired';
  }

  cancel(id) {
    const d = this.#read();
    d.pending = d.pending.filter((p) => p.id !== id);
    this.#write(d);
  }
}
