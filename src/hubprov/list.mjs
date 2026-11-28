// The hub's providers for its own other computers: what is shared, what is kept, and the list B gets.
//
// The state is two things in <configDir>/hubprov.json (mode 600): the one switch (on by default: "My other computers may
// use this computer's providers") and the names the owner keeps to this computer. A relay secret's hash per computer
// (for the computers reached over SSH) is kept there too; the secret itself is shown once, when it is made.
//
// The list holds names, labels, kinds, tools, model names and limit marks. Never a key, a token or an address.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { limitedProfiles, usableOrder } from '../autoswitch.mjs';
import { configDir } from '../paths.mjs';
import { kindOf, ownProfiles, publicProfile } from '../profiles.mjs';
import { replaceFile } from '../replacefile.mjs';
import { isSubscriptionToken } from '../secretenv.mjs';

export const hubprovFile = () => path.join(configDir(), 'hubprov.json');
export const RELAY_SECRET_RE = /^hpr_[A-Za-z0-9_-]{43}$/;
/** The one provider row a hub's subscription (a Claude sign-in or a setup token) becomes on another computer. */
export const SUBSCRIPTION_ROW = 'subscription';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/;
const MAP_RE = /^[A-Za-z0-9*][A-Za-z0-9._:/@+\-[\]*=,]{0,500}$/;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(hubprovFile(), 'utf8'));
    return {
      share: j.share !== false,
      keep: Array.isArray(j.keep) ? j.keep.filter((x) => typeof x === 'string') : [],
      secrets: j.secrets && typeof j.secrets === 'object' && !Array.isArray(j.secrets) ? j.secrets : {},
    };
  } catch {
    return { share: true, keep: [], secrets: {} };
  }
}
function save(s) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = hubprovFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  replaceFile(tmp, file);
}

export const sharing = () => load().share;
export function setSharing(on) {
  const s = load();
  s.share = on === true;
  save(s);
  return s.share;
}
export const keptNames = () => load().keep;
export const isKept = (name) => load().keep.includes(name);
export function setKept(name, on) {
  const s = load();
  s.keep = on ? [...new Set([...s.keep, name])] : s.keep.filter((x) => x !== name);
  save(s);
  return on === true;
}

const sha256hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
/** A relay secret for computer `machine`, shown once; only its hash is kept. A new one replaces the old. */
export function issueRelaySecret(machine) {
  const secret = 'hpr_' + crypto.randomBytes(32).toString('base64url');
  const s = load();
  s.secrets[machine] = sha256hex(secret);
  save(s);
  return secret;
}
export function revokeRelaySecret(machine) {
  const s = load();
  if (!(machine in s.secrets)) return false;
  delete s.secrets[machine];
  save(s);
  return true;
}
/** The computer a relay secret belongs to, or null. Compared in constant time against every hash. */
export function machineOfSecret(secret) {
  if (!RELAY_SECRET_RE.test(String(secret))) return null;
  const got = Buffer.from(sha256hex(secret), 'hex');
  let hit = null;
  for (const [name, hash] of Object.entries(load().secrets)) {
    const want = Buffer.from(String(hash), 'hex');
    if (want.length === got.length && crypto.timingSafeEqual(got, want) && !hit) hit = name;
  }
  return hit;
}

/** Which family of paths a provider's kind may pass through the relay: the API paths of that kind only. */
export const PATHS = {
  api: [['POST', /^\/v1\/messages$/], ['POST', /^\/v1\/messages\/count_tokens$/], ['GET', /^\/v1\/models$/]],
  openai: [['POST', /^\/v1\/responses$/], ['POST', /^\/v1\/chat\/completions$/], ['GET', /^\/v1\/models$/]],
};
export const pathAllowed = (kind, method, pathname) => (PATHS[kind] || []).some(([m, re]) => m === method && re.test(pathname));

/** A provider the hub may relay: a key or gateway of Claude's API or of OpenAI's (never a sign-in of any kind). */
export function relayable(p) {
  if (!p || !p.env) return false;
  if (p.env.CLAUDE_CODE_OAUTH_TOKEN || p.signin) return false;
  if (p.kind === 'api') {
    const key = p.env.ANTHROPIC_AUTH_TOKEN || p.env.ANTHROPIC_API_KEY || '';
    return !!key && !isSubscriptionToken(key) && !/[\r\n]/.test(key);
  }
  if (p.kind === 'openai') return !!p.env.OPENAI_API_KEY && !isSubscriptionToken(p.env.OPENAI_API_KEY) && !/[\r\n]/.test(p.env.OPENAI_API_KEY);
  return false;
}
const signsIn = (p) => p.kind === 'login' || p.kind === 'subscription';

const cleanModels = (p) => [p.env.ANTHROPIC_MODEL, p.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, p.env.OPENAI_MODEL].filter((m) => typeof m === 'string' && MODEL_RE.test(m));

/**
 * The list B gets: the providers this hub shares, as names, labels, kinds, tools, models and limit marks. A provider
 * the owner keeps to this computer is not in it; the hub's own sign-ins are ONE row. { sharing, providers: [...] }.
 */
export function buildList({ profiles = ownProfiles(), limited = limitedProfiles(), share = sharing(), keep = keptNames(), order = usableOrder() } = {}) {
  if (!share) return { sharing: false, providers: [] };
  const rows = [];
  for (const p of profiles) {
    if (keep.includes(p.name)) continue;
    if (relayable(p)) {
      const l = limited[p.name];
      rows.push({
        name: p.name, label: p.label, kind: p.kind, paid: p.paid === true,
        tools: publicProfile(p).tools, models: cleanModels(p), ...(MAP_RE.test(p.models || '') && p.models ? { map: p.models } : {}),
        limited: l ? { until: l.until, reason: l.reason } : null,
        // Where this provider stands in the hub's Auto order (null: not in it): the other computer's Auto mode follows it after its own.
        place: order.includes(p.name) ? order.indexOf(p.name) : null,
      });
    }
  }
  const subs = keep.includes(SUBSCRIPTION_ROW) ? [] : profiles.filter(signsIn);
  if (subs.length && !rows.some((r) => r.name === SUBSCRIPTION_ROW)) {
    rows.push({ name: SUBSCRIPTION_ROW, label: 'Claude subscription', kind: 'subscription', paid: false, tools: ['claude'], models: [], signin: true, limited: null });
  }
  return { sharing: true, providers: rows };
}

/** The kind a relay uses for a provider, from its environment. */
export const relayKind = (p) => (p ? kindOf(p.env, {}) : '');
