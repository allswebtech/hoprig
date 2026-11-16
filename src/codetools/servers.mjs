// The one server per computer that Hoprig runs for Codex (its app server) and for OpenCode (its server). Terminal
// sessions of these tools attach to it, so Hoprig sees what each of them does from the server's events (working,
// needs your OK, waiting) without reading their screens, and every session of a tool shares one store.
//
//   Codex      `codex app-server --listen ws://127.0.0.1:<port>` with a capability token (a file only Hoprig and
//              the server read). Every provider that serves Codex is one model-provider block given on its command
//              line; each block names its own key variable, set only in the server's environment. A terminal starts
//              `codex --remote … -c model_provider=<that provider>`: the server makes the calls, so the terminal's
//              process holds no key. (Checked with Codex 0.169: a thread's provider is the one its terminal names,
//              and the server tells every client of every thread's state.)
//   OpenCode   `opencode serve --hostname 127.0.0.1` with a password (OpenCode refuses every route without it). Its
//              providers are in a config file Hoprig writes (OPENCODE_CONFIG; the keys are "{env:…}" names, the
//              file holds no secret). Some of its routes return keys in full: Hoprig never passes them to a browser.
//
// A server is started on demand (the first terminal of the tool, or a list of its conversations), and stopped when
// no session uses it any more. When a provider was added or changed while sessions use the server, those sessions
// keep it and a new one on that provider starts on its own (its card then says "Live status: basic").
//
// State: <stateDir>/codetools/<tool>-server.json (pid, port, providers), the secret in <tool>-server.secret (0600).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { AUTH_VARS, listProfiles, servesTools } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { codex } from './codex.mjs';
import { opencode, NO_SELF_UPDATE } from './opencode.mjs';
import { KEY_VAR, endpointOf, providerModels, tomlString } from './providers.mjs';

export const SERVER_TOOLS = Object.freeze(['codex', 'opencode']);
const DESCRIPTOR = { codex, opencode };
const START_WAIT_MS = 60_000; // OpenCode fetches a small helper of its own on its very first start
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 90_000;

export const serverDir = () => path.join(stateDir(), 'codetools');
const stateFile = (tool) => path.join(serverDir(), `${tool}-server.json`);
const secretFile = (tool) => path.join(serverDir(), `${tool}-server.secret`);
const logFile = (tool) => path.join(serverDir(), `${tool}-server.log`);
const configFile = () => path.join(serverDir(), 'opencode-server.config.json');

const hash = (s, n = 6) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);

/** The id a provider has inside the tool's config: stable, a TOML bare key, never one the tool reserves. */
export const providerId = (name) => `hoprig_${slug(name)}_${hash(name)}`;
/** The variable that carries the provider's key in the server's environment. */
export const keyVarOf = (tool, name) => `${KEY_VAR[tool]}_${slug(name).toUpperCase()}_${hash(name).toUpperCase()}`;

/**
 * The providers the server of `tool` knows: every profile that serves the tool. A Codex sign-in is Codex's own
 * "openai" provider (the account in its folder); it needs no block and no key. `fp` changes when the provider does.
 */
export function serverProviders(tool, profiles = listProfiles()) {
  const out = [];
  for (const p of profiles) {
    if (!servesTools(p).includes(tool)) continue;
    const ep = endpointOf(p);
    if (!ep) {
      if (tool === 'codex') out.push({ name: p.name, label: p.label || p.name, id: 'openai', keyVar: null, signin: true, model: '', fp: 'signin' });
      continue;
    }
    if (!ep.key) continue;
    const shapes = Array.isArray(p.api) && p.api.length ? p.api : [];
    out.push({
      name: p.name, label: p.label || p.name, id: providerId(p.name), keyVar: keyVarOf(tool, p.name),
      base: ep.base, key: ep.key, model: ep.model, kind: p.kind, shapes,
      fp: hash(`${ep.base}\n${ep.key}\n${shapes.join(',')}\n${p.kind}`, 16),
    });
  }
  return out;
}

/** Codex: the model-provider block of one provider, as -c arguments (no key: only the name of its variable). */
export function codexBlockArgs(prov) {
  if (prov.signin) return [];
  const set = (k, v) => ['-c', `model_providers.${prov.id}.${k}=${tomlString(v)}`];
  return [...set('name', prov.label), ...set('base_url', `${prov.base}/v1`), ...set('env_key', prov.keyVar), ...set('wire_api', 'responses')];
}

/** Codex's app server command line (after the program). */
export function codexServerArgs(provs, { port, tokenFile }) {
  const first = provs.find((p) => !p.signin);
  return [
    'app-server', ...codex.noSelfUpdate.args,
    // Its own default would be OpenAI's account: a terminal then asks to sign in before anything else.
    ...(first ? ['-c', `model_provider=${tomlString(first.id)}`] : []),
    ...provs.flatMap(codexBlockArgs),
    '--listen', `ws://127.0.0.1:${port}`, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
  ];
}

/** OpenCode's config for its server: one provider per Hoprig provider, keys by variable name only. */
export function opencodeServerConfig(provs, modelsOf = () => []) {
  const providers = {};
  for (const p of provs) {
    const pkg = (p.shapes.length ? p.shapes.includes('messages') : p.kind !== 'openai') ? '@opencode/ai/providers/anthropic-compatible' : '@opencode/ai/providers/openai-compatible';
    const ids = [...new Set([p.model, ...modelsOf(p)].filter((m) => typeof m === 'string' && /^[A-Za-z0-9._:/@+\-[\]]{1,120}$/.test(m)))].slice(0, 200);
    providers[p.id] = { name: p.label, package: pkg, settings: { baseURL: `${p.base}/v1`, apiKey: `{env:${p.keyVar}}` }, models: Object.fromEntries(ids.map((id) => [id, { name: id }])) };
  }
  return { $schema: 'https://opencode.ai/config.json', ...NO_SELF_UPDATE.config, providers };
}

/** The environment of a tool's process: the caller's, without any provider key or server secret of any tool. */
export function cleanEnv(base = process.env) {
  const env = { ...base };
  for (const k of [...AUTH_VARS, 'OPENCODE_PASSWORD', 'OPENCODE_CONFIG', 'HOPRIG_CODEX_WS', 'HOPRIG_RUN_FILE']) delete env[k];
  for (const k of Object.keys(env)) if (/^ANTHROPIC_/.test(k) || /^HOPRIG_(CODEX|OPENCODE)_KEY/.test(k)) delete env[k];
  return env;
}

export function serverEnv(tool, provs, base = process.env) {
  const env = { ...cleanEnv(base), ...DESCRIPTOR[tool].noSelfUpdate.env };
  for (const p of provs) if (p.keyVar) env[p.keyVar] = p.key;
  return env;
}

// ---- the running server ----

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

export function readServer(tool) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(tool), 'utf8'));
    const secret = fs.readFileSync(secretFile(tool), 'utf8').trim();
    return s && Number.isInteger(s.port) && secret ? { ...s, secret } : null;
  } catch {
    return null;
  }
}

export const basicAuth = (password) => `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

/** Does the server answer? Codex: its readiness route; OpenCode: its info route with the password. */
export async function healthy(tool, s, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const r = tool === 'codex'
      ? await fetchImpl(`http://127.0.0.1:${s.port}/readyz`, { signal: AbortSignal.timeout(2000) })
      : await fetchImpl(`http://127.0.0.1:${s.port}/api/info`, { headers: { authorization: basicAuth(s.secret) }, signal: AbortSignal.timeout(2000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` while holding the tool's server lock (a folder: creating one is atomic everywhere). */
async function withLock(tool, fn) {
  fs.mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
  const lock = `${stateFile(tool)}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A holder that died (a terminal closed under its launcher) leaves the lock behind: it is free again.
      try {
        const owner = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        const old = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
        if (old || (Number.isInteger(owner) && owner > 0 && !alive(owner))) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* gone meanwhile, or its pid not written yet */
      }
      if (Date.now() > until) throw new Error('another start of this server is still busy');
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** The runs (terminal sessions) attached to the tool's server; `except`: a run id to leave out (one that is ending). */
export const serverUsers = (tool, { except = null, runs = listRuns() } = {}) => runs.filter((r) => r.tool === tool && r.server === true && r.runId !== except);

async function stopLocked(tool) {
  const s = readServer(tool);
  if (s && alive(s.pid)) {
    const kill = (sig) => {
      try {
        process.kill(-s.pid, sig); // started detached: its own process group, with its helpers
      } catch {
        try { process.kill(s.pid, sig); } catch { /* gone */ }
      }
    };
    kill('SIGTERM');
    for (let i = 0; i < 50 && alive(s.pid); i++) await sleep(100);
    if (alive(s.pid)) kill('SIGKILL');
  }
  for (const f of [stateFile(tool), secretFile(tool), ...(tool === 'opencode' ? [configFile()] : [])]) fs.rmSync(f, { force: true });
}

/** Stop the tool's server now. */
export const stopServer = (tool) => withLock(tool, () => stopLocked(tool));

/**
 * Stop the server when no session uses it. `idleMs`: and it was not asked for during that long (a list of
 * conversations starts it too). Returns true when it was stopped.
 */
export function stopIfUnused(tool, { except = null, idleMs = 0, now = Date.now() } = {}) {
  if (!readServer(tool)) return Promise.resolve(false);
  return withLock(tool, async () => {
    const s = readServer(tool);
    if (!s) return false;
    if (serverUsers(tool, { except }).length) return false;
    if (idleMs && now - (s.usedAt || s.startedAt || 0) < idleMs) return false;
    await stopLocked(tool);
    return true;
  });
}

/**
 * The tool's server, started when it does not run. `need`: the provider a session wants. Resolves to
 * { ok: true, server: { tool, pid, port, url, secret, providers } } or { ok: false, why }.
 */
export function ensureServer(tool, { need = null, base = process.env, fetchImpl = globalThis.fetch, profiles = listProfiles(), spawnImpl = spawn } = {}) {
  if (!SERVER_TOOLS.includes(tool)) return Promise.resolve({ ok: false, why: `no server for ${tool}` });
  const bin = DESCRIPTOR[tool].binPath();
  if (!fs.existsSync(bin)) return Promise.resolve({ ok: false, why: `${DESCRIPTOR[tool].name} is not installed` });
  const provs = serverProviders(tool, profiles);
  return withLock(tool, async () => {
    const s = readServer(tool);
    if (s && alive(s.pid) && (await healthy(tool, s, { fetchImpl }))) {
      const has = !need || provs.some((p) => p.name === need && (s.providers || []).some((q) => q.name === p.name && q.fp === p.fp));
      if (has) {
        writeState(tool, { ...s, usedAt: Date.now() });
        return { ok: true, server: publicServer(tool, s) };
      }
      if (serverUsers(tool).length) return { ok: false, why: 'the server was started before this provider was added or changed, and other sessions use it' };
    }
    await stopLocked(tool);
    return start(tool, provs, { bin, base, fetchImpl, spawnImpl });
  });
}

const publicServer = (tool, s) => ({
  tool, pid: s.pid, port: s.port, secret: s.secret, providers: s.providers || [],
  url: tool === 'codex' ? `ws://127.0.0.1:${s.port}` : `http://127.0.0.1:${s.port}`,
});

function writeState(tool, s) {
  const { secret, ...rest } = s;
  const tmp = `${stateFile(tool)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rest) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, stateFile(tool));
}

async function start(tool, provs, { bin, base, fetchImpl, spawnImpl }) {
  const port = await freePort();
  const secret = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(secretFile(tool), secret, { mode: 0o600 });
  const env = serverEnv(tool, provs, base);
  let args;
  if (tool === 'codex') {
    args = codexServerArgs(provs, { port, tokenFile: secretFile(tool) });
  } else {
    const models = new Map();
    await Promise.all(provs.map(async (p) => models.set(p.name, await providerModels({ name: p.name, kind: p.kind, env: keyEnv(p), api: p.shapes }, { fetchImpl }).catch(() => []))));
    fs.writeFileSync(configFile(), JSON.stringify(opencodeServerConfig(provs, (p) => models.get(p.name) || []), null, 2) + '\n', { mode: 0o600 });
    Object.assign(env, { OPENCODE_PASSWORD: secret, OPENCODE_CONFIG: configFile() });
    args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
  }
  const log = fs.openSync(logFile(tool), 'w', 0o600);
  let child;
  try {
    child = spawnImpl(DESCRIPTOR[tool].binPath(), args, { env, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  } finally {
    fs.closeSync(log);
  }
  child.on?.('error', () => {});
  child.unref?.();
  const s = { tool, pid: child.pid, port, secret, providers: provs.map((p) => ({ name: p.name, id: p.id, fp: p.fp })), startedAt: Date.now(), usedAt: Date.now() };
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    if (!alive(child.pid)) break;
    if (await healthy(tool, s, { fetchImpl })) {
      writeState(tool, s);
      return { ok: true, server: publicServer(tool, s) };
    }
    await sleep(250);
  }
  writeState(tool, s);
  await stopLocked(tool);
  return { ok: false, why: `${DESCRIPTOR[tool].name}'s server did not start (its log: ${logFile(tool)})` };
}

// providerModels reads a profile's endpoint from its variables: rebuild the few it needs.
const keyEnv = (p) => (p.kind === 'openai'
  ? { OPENAI_API_KEY: p.key, OPENAI_BASE_URL: p.base }
  : { ANTHROPIC_AUTH_TOKEN: p.key, ANTHROPIC_BASE_URL: p.base, ...(p.model ? { ANTHROPIC_MODEL: p.model } : {}) });
