// The gateways Hoprig knows, as data: the ones it ships (SHIPPED, the only place that names them) and the ones the
// owner defined himself in config.json, under "gateways" → "defined" (next to what keys.mjs keeps there about
// sharing). Each is turned into an add-on by localgateway.mjs.
//
// A gateway the owner defines is a program Hoprig will run. It is added by him: `hoprig gateways add` in his terminal
// (with the dashboard's password), or the page's Add a gateway behind a confirmation that shows the exact program and
// arguments (src/addons/gatewayroutes.mjs). Never by Tia's tools (src/assistant/door.mjs refuses its route, and her
// settings route has no "gateways"); the command refuses a shell a coding tool or the dashboard started. A program of
// the owner's user that sets out to can still write config.json itself: these steps guard against mistakes and the
// assistant, not against that.
//
// Every definition is checked strictly, when it is added and again whenever it is read (a hand-edited file):
//   id         lower-case letters, digits and "-", starting with a letter; not a shipped one, another add-on's, a word
//              the routes use, or another definition's
//   title      a short name: letters (any script), digits, spaces and . _ ( ) + -; not another gateway's
//   port       1024 to 65535, not the dashboard's, the router's or another gateway's; when it is added, also not one
//              where something answers already (checkNew)
//   npm | bin  EITHER an npm package name (checked as npm checks one, and never starting with "-") with an optional
//              plain program name, OR a program. A program is pinned when it is added (pinProgram): a plain name is
//              looked up on PATH once, links are followed, and what is kept is the real path of the file with its
//              sha256. The file and every folder above it may be changed only by the owner or the system, and it is
//              not inside the workspace, where sessions write. A start runs exactly that file, and refuses once its
//              contents differ from the fingerprint (localgateway.mjs): what runs is what the owner confirmed. After
//              an update of the program he confirms it again (confirmProgram: `hoprig gateways confirm`, or the page),
//              which keeps the definition, its sharing and other computers' keys.
//   typed      the program as the owner wrote it when he added it (a name on PATH, or a link): kept beside the pinned
//              file. When that file is gone or differs (an update moved the link to a new versioned folder), confirm
//              looks it up again and shows the file it leads to now; nothing is pinned again without his yes.
//   args       words of a fixed alphabet (letters, digits and . _ = : , @ / + -), at least one holding PORT
//   dashboard, summary, homepage (https), profile { name, label, token }, words { what, choice, add, key }: optional
// Nothing of it is ever passed through a shell.
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { knock } from '../knock.mjs';
import { listProfiles } from '../profiles.mjs';
import { DEFAULT_ROUTER_PORT } from '../routerstate.mjs';
import { which } from '../setup/system.mjs';
import { workspaceDir } from '../workspace/layout.mjs';
import { changeableByOthers, executable, fileSha256, insideWorkspace, localGateway, notExecutable, typedProgram } from './localgateway.mjs';

// The version of the shipped gateway that Install puts into Hoprig's own folder (the one this Hoprig is tested with).
// The one place that names it; Update installs the newest from npm instead.
export const GATEWAY_PIN = '1.0.11';

export const SHIPPED = [
  // A self-hosted AI gateway (https://github.com/allswebtech/trouteai, MIT). You add providers in its own dashboard
  // (OpenAI, Gemini, OpenRouter, local models and more); it offers them through one Anthropic-compatible API, which is
  // what Claude Code speaks. Its command line (from `trouteai --help`, version 1.0.11): `trouteai` starts it (dashboard
  // and API on one port, default 20017; --port, --host, --data-dir say where), `trouteai update` updates it,
  // `trouteai config`, `trouteai reset-password`, `trouteai key create` and `trouteai uninstall` are its other commands.
  // It is an npm package. Install puts it into Hoprig's own folder (`own`): a copy that is on the computer already
  // (npm install -g) is used until then. The listen words below are for 1.0.11 and newer, which listen on this computer
  // only by default; the older copy listened on every address.
  {
    id: 'trouteai',
    title: 'TRouteAI',
    summary: 'A self-hosted AI gateway. Add any provider in its dashboard (OpenAI, Gemini, OpenRouter, local models…) and Claude Code can use them all as one more provider.',
    homepage: 'https://github.com/allswebtech/trouteai',
    npm: 'trouteai',
    // Install puts the package into Hoprig's own folder at this version (codetools/npmtool.mjs); only a shipped one has it.
    own: { pin: GATEWAY_PIN },
    // The parts whose install scripts its README allows (npm install -g trouteai --allow-scripts=tls-client-node,koffi
    // --loglevel=error): each builds a helper program. Names only; Hoprig adds the flags (localgateway.mjs installFlags).
    allowScripts: ['tls-client-node', 'koffi'],
    bin: 'trouteai',
    port: 20017,
    args: ['--port', 'PORT'],
    // Its accounts, keys and logs: a folder of its own in the home of the user it runs as.
    dataDir: '.trouteai',
    // Where the dashboard listens on this computer only (or the computer is a server): these arguments keep the gateway
    // there too. A flag outranks its environment (HOST) and its data folder's .env.
    localOnly: ['--host', '127.0.0.1'],
    version: ['--version'],
    dashboard: '/',
    profile: { name: 'api', label: 'API via TRouteAI', token: 'ANTHROPIC_AUTH_TOKEN' },
    words: {
      what: 'TRouteAI is a free gateway that runs on this computer. You add OpenAI, Gemini, OpenRouter or a local model in its own page, and Claude Code uses them through it.',
      choice: 'OpenAI, Gemini, OpenRouter or a local model, translated for Claude Code by TRouteAI, a free gateway on this computer.',
      add: 'Open TRouteAI and add your provider there (OpenAI, Gemini, OpenRouter, a local model…).',
      key: 'In TRouteAI, create an API key.',
    },
    // The old names of the one compatibility list: what 0.2.6's page reads for this gateway in GET /api/accounts
    // (`<state>` and `defaults.<state>`, `<via>` on each provider). They are sent beside the new ones, so a page left
    // open across an update (a phone's saved page too) keeps working until it is reloaded.
    oldNames: { state: 'trouteai', via: 'viaTrouteai' },
  },
];

// Ids a definition may not take: the other add-ons (index.mjs; a test keeps this in step), the words the routes use
// after /gateway/ and /api/gateways/, and the ways of the accounts route's `via`.
export const NOT_IDS = ['public-link', 'm', 'all', 'use', 'add', 'keys', 'defined', 'api', 'openai'];

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
// A title is only ever shown as text: letters of any script (with their marks), digits, spaces and a few signs.
const TITLE_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._()+-]{0,39}$/u;
const ARG_RE = /^[A-Za-z0-9._=:,@/+-]{1,200}$/;
const PLAIN_BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const NPM_PART_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DASHBOARD_RE = /^\/[A-Za-z0-9._~/-]{0,100}$/;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LABEL_RE = /^[^\x00-\x1f\x7f]{1,60}$/; // eslint-disable-line no-control-regex
const TEXT_RE = /^[^\x00-\x1f\x7f]{1,300}$/; // eslint-disable-line no-control-regex
const TOKENS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const KEYS = ['id', 'title', 'summary', 'homepage', 'npm', 'bin', 'sha256', 'typed', 'port', 'args', 'localOnly', 'dashboard', 'firstPassword', 'profile', 'words', 'dataDir'];
// Where a gateway keeps its own data (accounts, keys, logs), as a folder under the home of the user it runs as: the move
// to an ordinary user (src/setup/movegateway.mjs) copies it. Plain folder names only, never a way out of the home.
export const DATA_DIR_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,4}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const WORDS = ['what', 'choice', 'add', 'key'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Why `name` is not an npm package name (as npm's own check says, a little stricter), or null. */
export function npmNameProblem(name) {
  if (typeof name !== 'string' || !name || name.length > 214) return 'an npm package name has 1 to 214 characters';
  const m = /^(?:@([^/]+)\/)?([^/@]+)$/.exec(name);
  if (!m || ![m[1], m[2]].every((p) => p === undefined || NPM_PART_RE.test(p))) return `"${name.slice(0, 60)}" is not an npm package name (lower-case letters, digits, . _ -, an optional @scope/)`;
  if (['node_modules', 'favicon.ico'].includes(name) || builtinModules.includes(name)) return `"${name}" is a name npm does not allow`;
  return null;
}

/**
 * The program of a definition as it is added: the real path of the file (links followed) and its sha256, or { error }.
 * Refused: no such file, not a regular file, a file or folder others can change, a file inside the workspace.
 */
export function pinProgram(file, { platform = process.platform, workspace = workspaceDir() } = {}) {
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return { error: `there is no file ${file} on this computer` };
  }
  if (!fs.statSync(real).isFile()) return { error: `the program ${real} is not a file` };
  if (platform !== 'win32') {
    if (!executable(real)) return { error: notExecutable(real) };
    const loose = changeableByOthers(real, platform);
    if (loose) return { error: `other users of this computer can change ${loose} (writable by its group or by everyone, or owned by someone else): Hoprig runs only a program that you alone or the system can change: copy it to a folder only you can change (such as ~/bin) and add it from there` };
  }
  if (insideWorkspace(real, workspace)) return { error: `the program ${real} is inside the workspace, where sessions write: put it outside` };
  return { bin: real, sha256: fileSha256(real) };
}

/** Why `typed` is not a program as the owner may name one (an absolute path, or a plain name found on PATH), or null. */
function typedProblem(typed, platform = process.platform) {
  if (typeof typed !== 'string' || !typed || typed.length > 500 || /[\x00-\x1f\x7f]/.test(typed)) return 'the program is an absolute path or a plain name found on PATH'; // eslint-disable-line no-control-regex
  const absolute = (platform === 'win32' ? path.win32 : path.posix).isAbsolute(typed) && (platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(typed));
  return absolute || PLAIN_BIN_RE.test(typed) ? null : 'the program is an absolute path or a plain name found on PATH';
}

/**
 * A definition checked and filled in: { def } or { error, field?, hint? }. `field`: the part the error is about (id,
 * title, port, bin, npm, args, dashboard), `hint`: the same without the part's name, for a page that writes its own
 * label in front ("Short name: lower-case letters…"); `error` keeps the words of the command's options. `others`: the definitions before it (their ids and ports
 * are taken). `forAdd`: the program must be there now, and it is pinned (pinProgram; a definition read from the file
 * is kept when its program is gone for a while: its status then says "not installed").
 */
export function checkDefinition(raw, { others = [], forAdd = false, cfg = safeConfig(), lookup = which, platform = process.platform, workspace } = {}) {
  const no = (error, field = null, hint = error) => ({ error, ...(field ? { field, hint } : {}) });
  if (!isObj(raw)) return no('a gateway is an object');
  const extra = Object.keys(raw).find((k) => !KEYS.includes(k));
  if (extra) return no(`"${extra.slice(0, 40)}" is not part of a gateway`);
  const { id, title } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return no('the id is lower-case letters, digits and -, starting with a letter (at most 31)', 'id', 'lower-case letters, digits and -, starting with a letter (at most 31)');
  if (SHIPPED.some((g) => g.id === id)) return no(`"${id}" is a gateway Hoprig ships`, 'id', `"${id}" is a gateway Hoprig ships: choose another`);
  if (NOT_IDS.includes(id)) return no(`"${id}" is taken: choose another id`, 'id', `"${id}" is taken: choose another`);
  if (others.some((g) => g.id === id)) return no(`there is a gateway "${id}" already`, 'id');
  if (typeof title !== 'string' || !TITLE_RE.test(title)) return no('the title is up to 40 letters, digits, spaces and . _ ( ) + -', 'title', 'up to 40 letters, digits, spaces and . _ ( ) + -');
  // The pages tell gateways apart by their titles ("Which gateway?", "via …", "Start …").
  const twin = [...SHIPPED, ...others].find((g) => g.title.toLowerCase() === title.toLowerCase());
  if (twin) return no(`the name ${twin.title} is another gateway's: choose another`, 'title');
  const port = raw.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return no('the port is a number from 1024 to 65535', 'port', 'a number from 1024 to 65535');
  // The port it will really use: addons.<id>.port, when config.json has one, wins over the definition's (portOf).
  const at = portOf({ id, port }, cfg);
  if (at === Number(cfg.server?.port || 7433)) return no(`port ${at} is this dashboard's`, 'port');
  if (at === (Number(cfg.router?.port) || DEFAULT_ROUTER_PORT)) return no(`port ${at} is the router's (Auto mode)`, 'port');
  const clash = [...SHIPPED, ...others].find((g) => portOf(g, cfg) === at);
  if (clash) return no(`port ${at} is ${clash.title}'s`, 'port');

  let npm = null;
  let bin;
  let sha256 = null;
  let typed = null;
  if (raw.npm !== undefined && raw.npm !== null) {
    const p = npmNameProblem(raw.npm);
    if (p) return no(p, 'npm');
    // npm on Windows installs a .cmd shim, which only a shell starts, and a gateway of the owner's own never goes
    // through one (localgateway.mjs): it would be accepted here and never start.
    if (platform === 'win32') return no('on Windows a gateway of your own is its program, not an npm package: name the program (an .exe, or node.exe with the package\'s script in the arguments)', 'npm');
    npm = raw.npm;
    bin = raw.bin === undefined || raw.bin === null ? npm.split('/').pop() : raw.bin;
    if (typeof bin !== 'string' || !PLAIN_BIN_RE.test(bin)) return no('with an npm package, the program is a plain name (the one the package installs)', 'bin', 'with an npm package, a plain name: the one the package installs');
    if (raw.sha256 !== undefined) return no('sha256 belongs to a program, not to an npm package');
    if (raw.typed !== undefined) return no('typed belongs to a program, not to an npm package');
  } else {
    bin = raw.bin;
    if (typeof bin !== 'string' || !bin || bin.length > 500 || /[\x00-\x1f\x7f]/.test(bin)) return no('say the package (npm) or the program (bin) of the gateway', 'bin', 'say which program it is (or, under More, its npm package)'); // eslint-disable-line no-control-regex
    // Absolute, and on Windows with its drive (path.isAbsolute also takes \\host\share\x.exe and \x.exe there).
    const absolute = (platform === 'win32' ? path.win32 : path.posix).isAbsolute(bin) && (platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(bin));
    if (!absolute) {
      // A name is looked up once, when it is added; config.json then names the file itself.
      if (!forAdd) return no('the program is the absolute path of a file', 'bin');
      if (!PLAIN_BIN_RE.test(bin)) return no('the program is an absolute path or a plain name found on PATH', 'bin', 'its full path, or a plain name found on PATH');
      const found = lookup(bin);
      if (!found) return no(`no program named ${bin} was found on PATH`, 'bin');
      bin = found;
    }
    if (forAdd) {
      const pin = pinProgram(bin, { platform, ...(workspace ? { workspace } : {}) });
      if (pin.error) return no(pin.error, 'bin');
      typed = raw.bin; // what he wrote, looked up again by confirm after an update (repinned)
      ({ bin, sha256 } = pin);
    } else {
      if (raw.sha256 !== undefined) {
        if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) return no('sha256 is the fingerprint of the program: 64 hex digits');
        sha256 = raw.sha256;
      }
      if (raw.typed !== undefined) {
        const p = typedProblem(raw.typed, platform);
        if (p) return no(`typed: ${p}`);
        typed = raw.typed;
      }
    }
  }

  let args = ['--port', 'PORT'];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || !raw.args.length || raw.args.length > 16) return no('args is a list of 1 to 16 words', 'args', '1 to 16 words');
    const bad = raw.args.find((a) => typeof a !== 'string' || !ARG_RE.test(a));
    if (bad !== undefined) return no(`"${String(bad).slice(0, 40)}": the arguments use only letters, digits and . _ = : , @ / + -`, 'args', `"${String(bad).slice(0, 40)}": only letters, digits and . _ = : , @ / + -`);
    if (!raw.args.some((a) => a.includes('PORT'))) return no('one of the arguments says where the port goes: PORT', 'args', 'one of them says where the port goes: PORT');
    args = [...raw.args];
  }
  const def = { id, title, npm, bin, sha256, typed, port, args, version: null, dashboard: null };
  // The words that keep it on this computer (as a shipped one's: --host 127.0.0.1), passed on a server and where the
  // dashboard is this computer only (localgateway.mjs hostArgs).
  if (raw.localOnly !== undefined) {
    if (!Array.isArray(raw.localOnly) || !raw.localOnly.length || raw.localOnly.length > 8 || raw.localOnly.some((a) => typeof a !== 'string' || !ARG_RE.test(a))) return no('localOnly is a list of 1 to 8 words with only letters, digits and . _ = : , @ / + -', 'localOnly', '1 to 8 words: only letters, digits and . _ = : , @ / + -');
    def.localOnly = [...raw.localOnly];
  }
  if (raw.dashboard !== undefined && raw.dashboard !== null) {
    if (typeof raw.dashboard !== 'string' || !DASHBOARD_RE.test(raw.dashboard)) return no('dashboard is the path of its page, such as /', 'dashboard', 'the path of its page on its port, such as /');
    def.dashboard = raw.dashboard;
  }
  // A word or words on the line where it prints its first password: that line is shown once on its page and kept out
  // of its log (localgateway.mjs start, firstlines.mjs).
  if (raw.firstPassword !== undefined && raw.firstPassword !== null && raw.firstPassword !== '') {
    if (typeof raw.firstPassword !== 'string' || !/^[^\x00-\x1f\x7f]{3,60}$/.test(raw.firstPassword)) return no('firstPassword is a word on the line where it prints its first password, 3 to 60 characters', 'firstPassword', 'a word on that line, such as password: 3 to 60 characters');
    def.firstPassword = raw.firstPassword;
  }
  if (raw.dataDir !== undefined && raw.dataDir !== null) {
    if (typeof raw.dataDir !== 'string' || raw.dataDir.length > 100 || !DATA_DIR_RE.test(raw.dataDir)) return no('dataDir is the folder under the home where it keeps its data, such as .mygateway', 'dataDir', 'a folder under the home, such as .mygateway');
    def.dataDir = raw.dataDir;
  }
  if (raw.summary !== undefined) {
    if (typeof raw.summary !== 'string' || !TEXT_RE.test(raw.summary)) return no('the summary is one line of up to 300 characters');
    def.summary = raw.summary;
  }
  if (raw.homepage !== undefined) {
    let u = null;
    try {
      u = new URL(raw.homepage);
    } catch {
      /* below */
    }
    if (!u || u.protocol !== 'https:' || String(raw.homepage).length > 200) return no('the homepage is an https address');
    def.homepage = u.href;
  }
  if (raw.profile !== undefined) {
    const p = raw.profile;
    if (!isObj(p) || Object.keys(p).some((k) => !['name', 'label', 'token'].includes(k))) return no('profile is { name, label, token }');
    if (p.name !== undefined && (typeof p.name !== 'string' || !PROFILE_NAME_RE.test(p.name))) return no('the profile name is lower-case letters, digits, - and _');
    if (p.label !== undefined && (typeof p.label !== 'string' || !LABEL_RE.test(p.label))) return no('the profile label is one line of up to 60 characters');
    if (p.token !== undefined && !TOKENS.includes(p.token)) return no(`the token is ${TOKENS.join(' or ')}`);
    def.profile = { ...p };
  }
  if (raw.words !== undefined) {
    const w = raw.words;
    if (!isObj(w) || Object.keys(w).some((k) => !WORDS.includes(k))) return no(`words is { ${WORDS.join(', ')} }`);
    if (Object.values(w).some((t) => typeof t !== 'string' || !TEXT_RE.test(t))) return no('each of the words is one line of up to 300 characters');
    def.words = { ...w };
  }
  return { def };
}

/** The port gateway `g` uses: config.json's addons.<id>.port when it has one, else its definition's. */
export const portOf = (g, cfg = safeConfig()) => Number(cfg.addons?.[g.id]?.port) || g.port;

function safeConfig() {
  try {
    return loadConfig();
  } catch {
    return {}; // a broken config.json: the shipped gateways still work, and the doctor reports it
  }
}

const rawList = (cfg) => (isObj(cfg.gateways) && Array.isArray(cfg.gateways.defined) ? cfg.gateways.defined : []);

/** The owner's definitions as they are now: { list (checked and filled in), skipped: [{ at, id, error }] }. */
export function definedGateways(cfg = safeConfig()) {
  const list = [];
  const skipped = [];
  rawList(cfg).forEach((raw, at) => {
    const r = checkDefinition(raw, { others: list, cfg });
    if (r.def) list.push(r.def);
    else skipped.push({ at, id: isObj(raw) && typeof raw.id === 'string' ? raw.id.slice(0, 40) : null, error: r.error });
  });
  return { list, skipped };
}

// One add-on per definition while it stays the same (the jobs of the dashboard and the status cache go by id).
const made = new Map();
function addonOf(def, shipped) {
  const key = `${shipped}:${JSON.stringify(def)}`;
  if (!made.has(key)) made.set(key, localGateway(def, { shipped }));
  return made.get(key);
}

/** Every gateway add-on: the shipped ones first, then the owner's. */
export function gatewayAddons(cfg = safeConfig()) {
  return [...SHIPPED.map((d) => addonOf(d, true)), ...definedGateways(cfg).list.map((d) => addonOf(d, false))];
}

/** A gateway's title by its id, or null. */
export const gatewayTitle = (id) => gatewayAddons().find((a) => a.id === id)?.title || null;

/** The add-on id a provider's PRERUN starts (`… addons start <id>`), or null. */
export function prerunAddonId(prerun) {
  const m = /(?:^|\s)addons start ([a-z][a-z0-9-]{0,30})\s*$/.exec(String(prerun || ''));
  return m ? m[1] : null;
}

/** The gateway a provider's PRERUN starts: its add-on, or null. */
export function gatewayOfPrerun(prerun, list = gatewayAddons()) {
  const id = prerunAddonId(prerun);
  return id ? list.find((a) => a.id === id) || null : null;
}

/**
 * The id of a gateway a provider's PRERUN starts that no gateway has any more (removed, or a definition that is not
 * loaded), or null: its sessions cannot start. An id no gateway may have (the public link, NOT_IDS) is not one.
 */
export function goneGatewayOf(prerun, list = gatewayAddons()) {
  const id = prerunAddonId(prerun);
  return id && !NOT_IDS.includes(id) && !list.some((a) => a.id === id) ? id : null;
}

/** The providers whose sessions start gateway `id` (their PRERUN), as the pages call them (label, else name). */
export const providersOf = (id) => listProfiles().filter((p) => prerunAddonId(p.prerun) === id).map((p) => p.label || p.name);

/**
 * A definition of config.json under the same id that is not loaded (definedGateways' skipped), as an error, or null. A
 * second entry under that id would never be told apart from it: the page would go on saying it was not loaded while
 * the new one runs.
 */
function notLoadedTwin(raw, cfg) {
  const id = isObj(raw) && typeof raw.id === 'string' ? raw.id : null;
  const s = id && definedGateways(cfg).skipped.find((x) => x.id === id);
  if (!s) return null;
  const hint = `there is a gateway "${id}" in config.json already that was not loaded (${s.error}): fix it there, or remove it with hoprig gateways remove ${id} (or Remove on its line in Settings → Add-ons)`;
  return { error: hint, field: 'id', hint };
}

/** The reason the definition `id` of config.json was not loaded, or null (it was, or there is none). */
export const notLoadedReason = (id, cfg = safeConfig()) => definedGateways(cfg).skipped.find((x) => x.id === id)?.error || null;

/**
 * A definition checked as a new one: as checkDefinition with forAdd, and its port must be free now. A program that
 * answers there already (the owner's own server, another service) would be taken for the gateway: its provider's key
 * would go to it. → { def } or { error }.
 */
export async function checkNew(raw, { others = definedGateways().list, cfg = safeConfig(), lookup = which } = {}) {
  const r = notLoadedTwin(raw, cfg) || checkDefinition(raw, { others, forAdd: true, cfg, lookup });
  if (r.error) return r;
  const at = portOf(r.def, cfg);
  if ((await knock({ port: at, host: '127.0.0.1' })) !== 'closed') return { error: `something on this computer answers on port ${at} already: choose a free port`, field: 'port', hint: `something on this computer answers on port ${at} already: choose a free port` };
  return r;
}

/**
 * Add a definition (checked as for a new one): { ok, def } or { ok: false, error }. The caller asked the owner first;
 * `expect`: the program the question showed ({ bin, sha256 }): when it resolves to another file now, or the file
 * changed in between, nothing is added.
 */
export async function addDefinition(raw, { expect = null } = {}) {
  // The port is knocked on first (it takes a moment); then config.json is read again, checked and written with
  // nothing awaited in between: an add, a key or a sharing change made meanwhile (another tab, the command) is kept.
  const before = safeConfig();
  const knocked = await checkNew(raw, { others: definedGateways(before).list, cfg: before });
  if (knocked.error) return { ok: false, ...knocked };
  const cfg = loadConfig();
  const r = notLoadedTwin(raw, cfg) || checkDefinition(raw, { others: definedGateways(cfg).list, forAdd: true, cfg });
  if (r.error) return { ok: false, ...r };
  if (portOf(r.def, cfg) !== portOf(knocked.def, before)) return { ok: false, error: 'the port changed while it was checked: try again' };
  if (expect && (expect.bin !== r.def.bin || (expect.sha256 || null) !== r.def.sha256)) return { ok: false, error: 'the program is not the one you were shown any more: check it again' };
  const g = isObj(cfg.gateways) ? cfg.gateways : {};
  saveConfig({ gateways: { ...g, defined: [...rawList(cfg), stored(r.def)] } });
  return { ok: true, def: r.def };
}

/**
 * The program of the owner's definition `id` pinned again as it is now (pinProgram), for the question before he
 * confirms it: { def (with that file, fingerprint and the program as he named it), was: 'changed' | 'no-fingerprint' |
 * null (it is the one he confirmed), from: the file he confirmed when the program is another file now, else null } or
 * { error }. When the confirmed file is gone or differs, what he typed when he added it (`typed`) is looked up again:
 * after an update that moved a link to a new versioned folder, it leads to the new file. `program`: the program he
 * names now (`hoprig gateways confirm <id> --program <path>`), for a definition from before `typed` was kept. Only a
 * program is pinned: an npm package's program is the one npm installed.
 */
export function repinned(id, cfg = safeConfig(), { program = null, lookup = which } = {}) {
  const def = definedGateways(cfg).list.find((d) => d.id === id);
  if (!def) {
    const why = notLoadedReason(id, cfg);
    return { error: why ? `the gateway "${id}" in config.json was not loaded (${why}): fix it there first` : `there is no gateway "${String(id).slice(0, 40)}" of yours` };
  }
  if (def.npm) return { error: `${def.title} is an npm package: Hoprig runs the program npm installed for it, so there is nothing to confirm` };
  const fromFile = (file, typed) => {
    const pin = pinProgram(file);
    if (pin.error) return { error: pin.error };
    const was = !def.sha256 ? 'no-fingerprint' : pin.bin !== def.bin || pin.sha256 !== def.sha256 ? 'changed' : null;
    return { def: { ...def, bin: pin.bin, sha256: pin.sha256, typed }, was, from: pin.bin !== def.bin ? def.bin : null };
  };
  const look = (typed) => {
    const p = typedProblem(typed);
    if (p) return { error: p };
    const file = typedProgram(typed, lookup);
    return file ? fromFile(file, typed) : { error: path.isAbsolute(typed) ? `there is no file ${typed} on this computer` : `no program named ${typed} was found on PATH` };
  };
  if (program !== null) return look(program);
  const pin = pinProgram(def.bin);
  if (!pin.error && pin.bin === def.bin && (!def.sha256 || pin.sha256 === def.sha256)) return { def: { ...def, sha256: pin.sha256 }, was: def.sha256 ? null : 'no-fingerprint', from: null };
  // The confirmed file is gone or differs.
  if (def.typed) return look(def.typed);
  if (!pin.error) return { def: { ...def, bin: pin.bin, sha256: pin.sha256 }, was: def.sha256 ? 'changed' : 'no-fingerprint', from: null }; // rewritten in place
  return { error: `${pin.error}, and config.json does not keep the program as you named it when you added ${def.title} (a definition from before Hoprig kept it): name the program it is now with hoprig gateways confirm ${id} --program <path>` };
}

/**
 * The owner confirmed the program of his definition `id` as it is now (`expect`: the { bin, sha256 } the question
 * showed him; `program`: the program he named, as for repinned): its file, fingerprint and the program as he named it
 * are kept in its definition; everything else of it, its sharing and the keys other computers have stay. Read, checked
 * and written with nothing awaited in between. → { ok, def } or { ok: false, error }.
 */
export function confirmProgram(id, { expect = null, program = null } = {}) {
  const cfg = loadConfig();
  const r = repinned(id, cfg, { program });
  if (r.error) return { ok: false, error: r.error };
  if (!expect || expect.bin !== r.def.bin || expect.sha256 !== r.def.sha256) return { ok: false, error: 'the program is not the one you were shown any more: check it again' };
  const defined = rawList(cfg).map((x) => (isObj(x) && x.id === id ? { ...x, bin: r.def.bin, sha256: r.def.sha256, ...(r.def.typed ? { typed: r.def.typed } : {}) } : x));
  saveConfig({ gateways: { ...cfg.gateways, defined } });
  return { ok: true, def: r.def };
}

/** What is written to config.json: the definition without the parts filled in by default. */
function stored(def) {
  const out = { id: def.id, title: def.title, port: def.port };
  if (def.npm) out.npm = def.npm;
  if (!def.npm || def.bin !== def.npm.split('/').pop()) out.bin = def.bin;
  if (def.sha256) out.sha256 = def.sha256;
  if (def.typed) out.typed = def.typed;
  if (def.args.join(' ') !== '--port PORT') out.args = def.args;
  for (const k of ['dashboard', 'summary', 'homepage', 'profile', 'words']) if (def[k]) out[k] = def[k];
  return out;
}

/**
 * Remove the owner's definition `id`, and in the same write everything kept about it: its sharing, the keys other
 * computers had for it, its port setting (addons.<id>). A program added later under the same id then starts with
 * sharing off, no keys and the port its own definition says. → { ok } or { ok: false, error }. Shipped gateways cannot
 * be removed.
 */
export function removeDefinition(id) {
  if (SHIPPED.some((g) => g.id === id)) return { ok: false, error: `the gateway ${id} is one Hoprig ships: it cannot be removed` };
  const cfg = loadConfig();
  const all = rawList(cfg);
  const rest = all.filter((x) => !(isObj(x) && x.id === id));
  if (rest.length === all.length) return { ok: false, error: `there is no gateway "${String(id).slice(0, 40)}" of yours` };
  const g = { ...cfg.gateways, defined: rest };
  if (isObj(g.shared)) g.shared = Object.fromEntries(Object.entries(g.shared).filter(([k]) => k !== id));
  if (Array.isArray(g.keys)) g.keys = g.keys.filter((k) => !(isObj(k) && k.gateway === id));
  const patch = { gateways: g };
  if (isObj(cfg.addons) && Object.hasOwn(cfg.addons, id)) patch.addons = Object.fromEntries(Object.entries(cfg.addons).filter(([k]) => k !== id));
  saveConfig(patch);
  return { ok: true };
}
