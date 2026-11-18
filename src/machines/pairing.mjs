// Pairing: how another dashboard gets a token for this computer.
//
//  - Over SSH, the other dashboard runs `hoprig pair --json` here. Being able to log in by SSH is the proof,
//    so that command makes a token at once and prints it with the address of this dashboard (pairInfo).
//  - By address, `hoprig pair` (or the page) shows a short one-time code. The other dashboard sends it to
//    POST /api/pair/claim and gets a token back. A code lives 10 minutes, works once, is compared in constant
//    time and the claims are rate-limited like the login.
//
// Codes live in <stateDir>/pair-codes.json (onetime.mjs): the CLI makes them and the running server checks them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { knock } from '../knock.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { OneTimeStore } from './onetime.mjs';
import { hostName } from '../paths.mjs';

export const API_VERSION = 1;
export const CODE_TTL_MS = 10 * 60_000;
const DEFAULT_PORT = 7433; // the dashboard's default (src/server/server.mjs)
// 32 letters and digits that cannot be mistaken for each other (no I, O, 0, 1): 8 of them are 40 bits.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
})();

const codes = new OneTimeStore('pair-codes', { salt: 'pair' });

/** "k7qm 4xp2", "K7QM-4XP2" -> "K7QM4XP2"; null when it cannot be a code. */
export function normalizeCode(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const s = v.toUpperCase().replace(/[\s-]/g, '');
  return s.length === CODE_LEN && [...s].every((ch) => ALPHABET.includes(ch)) ? s : null;
}

const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** A fresh code's characters (8 of ALPHABET; 256 % 32 = 0, so no bias) and how it is shown (XXXX-XXXX). */
export function makeCode() {
  const raw = [...crypto.randomBytes(CODE_LEN)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return { raw, shown: showCode(raw) };
}

/** A new code. Returns { id, code (shown as XXXX-XXXX), expires }. */
export function createCode({ now = Date.now() } = {}) {
  const { raw, shown } = makeCode();
  const { id, expires } = codes.add(raw, CODE_TTL_MS, { now });
  return { id, code: shown, expires };
}

/**
 * Use a code: the id it was made with when it is right and unexpired (it then stops working), else null. `by`
 * (the claiming computer's name) is noted so `hoprig pair` can say who used it.
 */
export const claimCode = (input, by = '', { now = Date.now() } = {}) => codes.take(normalizeCode(input), by, { now });

/** 'pending' | { claimedBy } | 'expired' for the code made with id `id`. */
export function codeStatus(id, { now = Date.now() } = {}) {
  const s = codes.status(id, { now });
  return typeof s === 'string' ? s : { claimedBy: s.usedBy };
}

export const cancelCode = (id) => codes.cancel(id);

const WILDCARD = new Set(['', '0.0.0.0', '::', '[::]']);

/**
 * Where this computer's dashboard listens, as seen from this computer (the running one's own record first, else the
 * config): the SSH tunnel ends here. A dashboard on
 * every address is reached on 127.0.0.1; one bound to a single address is reached on that address.
 */
export function rawDashboardAddress(cfg = loadConfig(), running = runningDashboard()) {
  const s = cfg.server || {};
  // The dashboard running now knows its real address (it may have been started with --host/--port).
  const port = running ? running.port : Number.isInteger(s.port) && s.port > 0 && s.port < 65536 ? s.port : DEFAULT_PORT;
  const host = running ? running.host : typeof s.host === 'string' ? s.host.trim() : '127.0.0.1';
  return { host, port };
}

export function dashboardAddress(cfg = loadConfig(), running = runningDashboard()) {
  const { host, port } = rawDashboardAddress(cfg, running);
  return { host: WILDCARD.has(host) ? '127.0.0.1' : host === 'localhost' ? '127.0.0.1' : host.replace(/^\[|\]$/g, ''), port };
}

/**
 * What the dashboard's address says: "open", "closed" or "silent" (no answer in time), as knock.mjs tells them.
 * (Whether it is this dashboard, the other side finds out when it connects.)
 */
export const answers = ({ host, port }, timeoutMs = 3000) => knock({ host, port }, timeoutMs);

/** Does something listen there? */
export async function listening(addr, timeoutMs) {
  return (await answers(addr, timeoutMs)) === 'open';
}

/** What this computer tells another dashboard about itself. Shared by `pair --json` and GET /api/machine. */
export const machineInfo = () => ({
  api: API_VERSION,
  version: VERSION,
  hostname: hostName(),
  platform: process.platform,
  arch: process.arch,
  release: os.release(),
});

/** `hoprig pair --json`: a fresh token for `name`, plus how to reach this dashboard. */
export async function pairInfo(name, { createToken }) {
  const addr = dashboardAddress();
  const { id, token } = createToken(name);
  return { hoprig: 'pair', ...machineInfo(), host: addr.host, port: addr.port, running: await listening(addr), token, tokenId: id };
}
