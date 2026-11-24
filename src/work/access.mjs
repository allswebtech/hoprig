// Work for another program (docs/WORK.md, "Another program"): Work tokens, webhooks and their limits.
//
// All of it is kept in one file of Hoprig's config folder, work-access.json (mode 0600, written through a temporary
// file and a rename), never in the Work repository or the brain:
//   { v: 1, tokens: [{ id, name, hash, created }], webhooks: [{ id, token, url, events, secret, ownNetwork, answer,
//     created }], limits: { perMinute, perDay } }
// A token is kept as its SHA-256 only and shown once when it is made. A webhook's secret is kept as it is (an HMAC
// needs it) and never sent to the page after the one showing. A Work token has a prefix of its own ("hwt_"), so a
// machine token ("hop_") or Tia's ("tia_") is never taken for one, and back. The last use of each token is kept apart,
// in the state folder (work-token-use.json), as the machine tokens do it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir, stateDir } from '../paths.mjs';
import { tokenName } from '../machines/names.mjs';
import { createActivityLog } from '../automation/store.mjs';
import { checkHookUrl } from './hookaddr.mjs';

export const WORK_TOKEN_PREFIX = 'hwt_';
const TOKEN_RE = /^hwt_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** What a webhook can be told: a task done, a run's result ready, the task needs you. */
export const EVENTS = ['done', 'result', 'needs-you'];
export const LIMIT_DEFAULTS = { perMinute: 60, perDay: 100 };
const LIMIT_MAX = { perMinute: 10_000, perDay: 100_000 };
const MAX_TOKENS = 50;
const MAX_HOOKS = 50;
const TOUCH_EVERY_MS = 60_000; // a busy script must not write a file on every request

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const accessFile = () => path.join(configDir(), 'work-access.json');
const useFile = () => path.join(stateDir(), 'work-token-use.json');

const cleanToken = (t) => isObj(t) && ID_RE.test(t.id) && HASH_RE.test(t.hash) && typeof t.name === 'string';
const cleanHook = (h) => isObj(h) && ID_RE.test(h.id) && ID_RE.test(h.token) && typeof h.url === 'string' && HASH_RE.test(h.secret)
  && Array.isArray(h.events) && h.events.every((e) => EVENTS.includes(e));

function cleanLimits(l) {
  const out = { ...LIMIT_DEFAULTS };
  if (isObj(l)) for (const k of Object.keys(LIMIT_DEFAULTS)) if (Number.isInteger(l[k]) && l[k] >= 1 && l[k] <= LIMIT_MAX[k]) out[k] = l[k];
  return out;
}

/** The file as it stands: { tokens, webhooks, limits, bad }. `bad`: it is there and does not read (then nothing is trusted). */
function read() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(accessFile(), 'utf8'));
  } catch (e) {
    return { tokens: [], webhooks: [], limits: { ...LIMIT_DEFAULTS }, bad: e.code !== 'ENOENT' };
  }
  const tokens = isObj(raw) && Array.isArray(raw.tokens) ? raw.tokens.filter(cleanToken) : [];
  const live = new Set(tokens.map((t) => t.id));
  const webhooks = isObj(raw) && Array.isArray(raw.webhooks) ? raw.webhooks.filter((h) => cleanHook(h) && live.has(h.token)) : [];
  return { tokens, webhooks, limits: cleanLimits(isObj(raw) ? raw.limits : null), bad: !isObj(raw) };
}

function write(data) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = accessFile();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, tokens: data.tokens, webhooks: data.webhooks, limits: data.limits }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read, change, write: refused when the file is there and does not read (a write would lose what it holds). */
function change(fn) {
  const d = read();
  if (d.bad) throw fail(409, 'work-access.json in Hoprig\'s config folder does not read: fix or remove it first', 'access-file');
  const out = fn(d);
  write(d);
  return out;
}

// ---------- tokens ----------

const tooManyTokens = () => fail(409, `there are ${MAX_TOKENS} Work tokens already: revoke one first`, 'too-many');
const tooManyHooks = () => fail(409, `there are ${MAX_HOOKS} webhooks already: remove one first`, 'too-many');
/** Refused at once when no other token (`kind` "token") or webhook ("webhook") can be made: before the question too. */
export function checkRoom(kind) {
  const d = read();
  if (kind === 'token' && d.tokens.length >= MAX_TOKENS) throw tooManyTokens();
  if (kind === 'webhook' && d.webhooks.length >= MAX_HOOKS) throw tooManyHooks();
}

/** Make a Work token named `name`. → { id, name, created, token }: the token is shown once and never stored. */
export function createWorkToken(name, { now = Date.now() } = {}) {
  const clean = tokenName(name);
  if (!clean) throw fail(400, 'the name is 1 to 60 letters, digits, spaces or ._@()-', 'bad-name');
  return change((d) => {
    if (d.tokens.some((t) => t.name === clean)) throw fail(409, `a Work token is named "${clean}" already: choose another name`, 'name-taken');
    if (d.tokens.length >= MAX_TOKENS) throw tooManyTokens();
    const token = WORK_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomBytes(6).toString('hex');
    d.tokens.push({ id, name: clean, hash: sha256(token), created: now });
    return { id, name: clean, created: now, token };
  });
}

/** The entry a presented token belongs to, or null. Every hash is compared in constant time. */
export function verifyWorkToken(token, list = read().tokens) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const got = Buffer.from(sha256(token), 'hex');
  let found = null;
  for (const t of list) if (crypto.timingSafeEqual(got, Buffer.from(t.hash, 'hex')) && !found) found = t;
  return found;
}

/** True while token `id` is not revoked: read fresh, for a request that passed its check a moment ago. */
export const workTokenLive = (id) => read().tokens.some((t) => t.id === id);

function readUse() {
  try {
    const d = JSON.parse(fs.readFileSync(useFile(), 'utf8'));
    return isObj(d) ? d : {};
  } catch {
    return {};
  }
}
const lastWrite = new Map();
/** Note that token `id` was used: written at most once a minute per token. */
export function touchWorkToken(id, { now = Date.now() } = {}) {
  if (now - (lastWrite.get(id) || 0) < TOUCH_EVERY_MS) return;
  lastWrite.set(id, now);
  try {
    const use = readUse();
    use[id] = now;
    const live = new Set(read().tokens.map((t) => t.id));
    for (const k of Object.keys(use)) if (!live.has(k)) delete use[k];
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${useFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(use) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, useFile());
  } catch {
    /* only a convenience: never fail a request over it */
  }
}

/** What the page and the command show of the tokens: never the hash. */
export function listWorkTokens() {
  const use = readUse();
  return read().tokens.map((t) => ({ id: t.id, name: t.name, created: t.created || null, lastUsed: use[t.id] || null }));
}

/**
 * Revoke by id, or the token with that name; its webhooks go with it (a webhook belongs to one token). → the tokens
 * removed. Each revoke is a line in the Activity log, by the process that revoked it (the page or the command).
 */
export function revokeWorkToken(idOrName) {
  const gone = change((d) => {
    const out = d.tokens.filter((t) => t.id === idOrName || t.name === idOrName);
    const ids = new Set(out.map((t) => t.id));
    d.tokens = d.tokens.filter((t) => !ids.has(t.id));
    d.webhooks = d.webhooks.filter((h) => !ids.has(h.token));
    return out;
  });
  for (const t of gone) recordWork(`The Work token ${t.name} was revoked`);
  return gone.map((t) => ({ id: t.id, name: t.name }));
}

// ---------- webhooks ----------

const publicHook = (h, tokens) => ({
  id: h.id, token: h.token, tokenName: (tokens.find((t) => t.id === h.token) || {}).name || null, url: h.url,
  events: [...h.events], ownNetwork: h.ownNetwork === true, answer: h.answer === true, created: h.created || null,
});

/** A webhook's settings from the page, checked: { token, url, events, ownNetwork, answer } (the address's syntax only). */
export function checkHook(b, tokens = read().tokens) {
  if (!isObj(b)) throw fail(400, 'say what the webhook is');
  if (typeof b.token !== 'string' || !tokens.some((t) => t.id === b.token)) throw fail(400, 'choose the Work token whose tasks it is told about', 'no-token');
  const url = checkHookUrl(b.url).href;
  if (!Array.isArray(b.events) || !b.events.length || b.events.length > EVENTS.length || !b.events.every((e) => EVENTS.includes(e))) {
    throw fail(400, `choose one or more events: ${EVENTS.join(', ')}`, 'bad-events');
  }
  for (const k of ['ownNetwork', 'answer']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw fail(400, `${k} is true or false`);
  return { token: b.token, url, events: EVENTS.filter((e) => b.events.includes(e)), ownNetwork: b.ownNetwork === true, answer: b.answer === true };
}

/** Add a webhook (checked by checkHook first). → { webhook, secret }: the secret is shown this once. */
export function addWebhook(input, { now = Date.now() } = {}) {
  return change((d) => {
    const h = checkHook(input, d.tokens);
    if (d.webhooks.length >= MAX_HOOKS) throw tooManyHooks();
    const secret = crypto.randomBytes(32).toString('hex');
    const hook = { id: crypto.randomBytes(6).toString('hex'), ...h, secret, created: now };
    d.webhooks.push(hook);
    return { webhook: publicHook(hook, d.tokens), secret };
  });
}

export function removeWebhook(id) {
  return change((d) => {
    const gone = d.webhooks.filter((h) => h.id === id);
    d.webhooks = d.webhooks.filter((h) => h.id !== id);
    return gone.map((h) => ({ id: h.id, url: h.url }));
  });
}

export const listWebhooks = () => {
  const d = read();
  return d.webhooks.map((h) => publicHook(h, d.tokens));
};
/** The webhooks with their secrets: for the deliveries only (hooks.mjs), never for an answer. */
export const webhooksWithSecrets = () => read().webhooks.map((h) => ({ ...h, events: [...h.events] }));

// ---------- limits ----------

export const workLimits = () => read().limits;
export function setWorkLimits(b) {
  if (!isObj(b)) throw fail(400, 'give the limits');
  for (const k of Object.keys(b)) if (!(k in LIMIT_DEFAULTS)) throw fail(400, `"${String(k).slice(0, 30)}" is not a limit`);
  for (const [k, v] of Object.entries(b)) {
    if (!Number.isInteger(v) || v < 1 || v > LIMIT_MAX[k]) throw fail(400, `${k === 'perMinute' ? 'requests a minute' : 'tasks a day'} is a whole number from 1 to ${LIMIT_MAX[k]}`);
  }
  return change((d) => {
    d.limits = cleanLimits({ ...d.limits, ...b });
    return d.limits;
  });
}

/** True when there is anything of this part at all: without a token nothing of it runs (hooks.mjs). */
export const anyAccess = () => {
  const d = read();
  return d.tokens.length > 0;
};

/** One line in the Activity log (Automations → Activity), by "work". Never throws. */
export function recordWork(did, outcome = 'ok') {
  try {
    return createActivityLog(path.join(stateDir(), 'automation.log')).add({ automation: 'work', did, outcome });
  } catch {
    return null;
  }
}
