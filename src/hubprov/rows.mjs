// The hub's providers as this computer's provider rows: a file the dashboard keeps (<state>/hub-rows.json, mode 600,
// no key in it: names, kinds, labels, limit marks and this dashboard's port), read by profiles.mjs in every process
// (the dashboard, a terminal's launcher, the router), so a session started from a terminal sees the same rows.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { replaceFile } from '../replacefile.mjs';
import { mintKey } from './localkeys.mjs';

const HUB_PREFIX = 'hub-';
export const hubRowName = (name) => `${HUB_PREFIX}${name}`.slice(0, 32);
export const rowsFile = () => path.join(stateDir(), 'hub-rows.json');

/** What the dashboard saves: { port, rows: [{ name, hubRow, label, kind, paid, signin, map, limited, hubLabel, offline }] }. */
export function saveRows(data) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const file = rowsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  replaceFile(tmp, file);
  cached = { at: 0, data: null };
}

let cached = { at: 0, data: null };
function load() {
  const now = Date.now();
  if (cached.data && now - cached.at < 1000) return cached.data;
  let data = { port: 0, rows: [] };
  try {
    const j = JSON.parse(fs.readFileSync(rowsFile(), 'utf8'));
    if (j && Array.isArray(j.rows)) data = j;
  } catch {
    /* none yet */
  }
  cached = { at: now, data };
  return data;
}

// One key per row for this process's own requests (the router): the session's own key is made at its start.
const routerKeys = new Map();
const routerKey = (row) => {
  let k = routerKeys.get(row);
  if (!k) {
    k = mintKey({ row, ttlMs: 24 * 3600_000 });
    routerKeys.set(row, k);
  }
  return k;
};

const baseOf = (data, r) => `http://127.0.0.1:${data.port || 0}/hub/p/${r.hubRow}`;

function toProfile(data, r) {
  const common = { name: r.name, label: r.label, prerun: '', models: r.map || '', mapSessions: false, paid: r.paid === true, api: r.kind === 'openai' ? ['responses', 'chat'] : ['messages'], tools: [], signin: '', hub: true, hubLabel: r.hubLabel || '', hubOffline: r.offline === true, limited: r.limited || null };
  if (r.signin) return { ...common, kind: 'login', env: {}, signinHere: true };
  return r.kind === 'openai'
    ? { ...common, kind: 'openai', env: { OPENAI_BASE_URL: `${baseOf(data, r)}/v1`, OPENAI_API_KEY: routerKey(r.hubRow) } }
    : { ...common, kind: 'api', env: { ANTHROPIC_BASE_URL: baseOf(data, r), ANTHROPIC_AUTH_TOKEN: routerKey(r.hubRow) } };
}

/** The source profiles.mjs reads: list(), read(name), sessionEnv(profile). */
export const hubRows = {
  list: () => {
    const d = load();
    return d.rows.map((r) => toProfile(d, r));
  },
  /** The rows the main computer's Auto mode uses, in its order: what this computer's Auto mode follows after its own. */
  autoNames: () => [...load().rows].filter((r) => Number.isInteger(r.place) && !r.signin).sort((a, b) => a.place - b.place).map((r) => r.name),
  read: (name) => {
    const d = load();
    const r = d.rows.find((x) => x.name === name);
    return r ? toProfile(d, r) : null;
  },
  /** The environment pieces for a session on a hub row: this computer's loopback address and its own key, never the hub's. */
  sessionEnv: (profile) => {
    const d = load();
    const r = d.rows.find((x) => x.name === profile.name);
    if (!r || r.signin) return {};
    const key = mintKey({ row: r.hubRow });
    return r.kind === 'openai' ? { OPENAI_BASE_URL: `${baseOf(d, r)}/v1`, OPENAI_API_KEY: key } : { ANTHROPIC_BASE_URL: baseOf(d, r), ANTHROPIC_AUTH_TOKEN: key };
  },
};
