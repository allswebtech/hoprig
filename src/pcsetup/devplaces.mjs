// Toolchains in the workspace's development/ folder (layout.mjs DEV_PLACES): what is at each place, and a tool that is
// already on this computer somewhere else. Such a tool is ADOPTED where it is: the place becomes a link to it (made
// only when the place does not exist, only as part of a kit the owner chose; devinstall.mjs), never a move, a copy
// or a change of the tool's own files. Nothing here starts a program: a first `flutter` run downloads things, so its
// version is read from Flutter's own files.
//
// Where Flutter is looked for, in order (checked against docs.flutter.dev/install, 24 Nov 2026): the workspace's
// place, `flutter` on PATH (its bin/flutter, links followed), FLUTTER_ROOT, ~/flutter, ~/development/flutter (the
// folder Flutter's own install page uses), ~/snap/flutter/common/flutter (where the snap keeps its SDK).
// nvm: the workspace's place, NVM_DIR, ~/.nvm, $XDG_CONFIG_HOME/nvm (nvm's install.sh puts it there when that is set).
import fs from 'node:fs';
import path from 'node:path';
import { DEV_PLACES, devPlace } from '../workspace/layout.mjs';
import { missingTools } from './unpack.mjs';
import { javaPlaces } from './java.mjs';
import { ownValue } from '../setup/localbin.mjs';

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:[-+][0-9A-Za-z.]{1,40})?$/;

/** A path for people: the home folder as "~". */
export const tildeOf = (p, home) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** What is at `p`, links not followed: { kind: 'none' | 'folder' | 'link' | 'broken' | 'file' | 'other', real? }. */
export function placeKind(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { kind: 'none' };
  }
  if (st.isSymbolicLink()) {
    try {
      return { kind: 'link', real: fs.realpathSync(p) };
    } catch {
      return { kind: 'broken' };
    }
  }
  return { kind: st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other' };
}
export const KIND_WORDS = { file: 'a file', broken: 'a link that leads nowhere', other: 'something that is not a folder', folder: 'a folder', link: 'a link' };

/** A small file's text, or null (a version file is a few bytes: anything over 64 kB is not one). */
function readSmall(f) {
  try {
    const st = fs.statSync(f);
    return st.isFile() && st.size <= 65536 ? fs.readFileSync(f, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Flutter's version from its own files: bin/cache/flutter.version.json (newer), else the `version` file. */
export function flutterVersionAt(root) {
  const json = readSmall(path.join(root, 'bin', 'cache', 'flutter.version.json'));
  if (json) {
    try {
      const j = JSON.parse(json);
      const v = j.flutterVersion || j.frameworkVersion;
      if (VERSION_RE.test(String(v))) return v;
    } catch {
      /* not that file */
    }
  }
  const v = (readSmall(path.join(root, 'version')) || '').trim();
  return VERSION_RE.test(v) ? v : null;
}

/** nvm's version from its own package.json. */
export function nvmVersionAt(dir) {
  try {
    const v = JSON.parse(readSmall(path.join(dir, 'package.json')) || '{}').version;
    return VERSION_RE.test(String(v)) ? v : null;
  } catch {
    return null;
  }
}

const isFlutterRoot = (d, sys) => Boolean(d) && sys.exists(path.join(d, 'bin', 'flutter'));
const realOf = (sys, p) => (typeof sys.realpath === 'function' ? sys.realpath(p) : p);

/** The `flutter` on PATH: { bin (as PATH gives it), root (its Flutter folder, links followed) } or null. */
function flutterOnPath(sys) {
  if (!sys.has || !sys.has('flutter') || typeof sys.which !== 'function') return null;
  const bin = sys.which('flutter');
  const real = bin ? realOf(sys, bin) : null;
  return real && real.endsWith(`${path.sep}bin${path.sep}flutter`) ? { bin, root: path.dirname(path.dirname(real)) } : null;
}

/** The places Flutter is looked for outside the workspace, in order: [{ dir, from }]. */
export function flutterPlaces(sys) {
  const env = sys.env || {};
  const out = [];
  const onPath = flutterOnPath(sys);
  if (onPath) out.push({ dir: onPath.root, from: 'your PATH' });
  if (env.FLUTTER_ROOT && path.isAbsolute(env.FLUTTER_ROOT)) out.push({ dir: env.FLUTTER_ROOT, from: 'FLUTTER_ROOT' });
  for (const rel of [['flutter'], ['development', 'flutter'], ['snap', 'flutter', 'common', 'flutter']]) out.push({ dir: path.join(sys.home, ...rel), from: 'home' });
  return out;
}

/**
 * The Flutter item: { state, version, detail, found? (where, with ~), onPath, adopt? { from, place }, shellLine?, hold? }.
 * `shellLine`: the kits block (setup/localbin.mjs) should put the place's bin on PATH: Flutter is (or will be) at the
 * place and no other `flutter` is on PATH.
 */
export async function detectFlutter(sys) {
  const place = sys.ws ? devPlace(sys.ws, 'flutter') : null;
  const rel = DEV_PLACES.flutter.rel;
  const t = (p) => tildeOf(p, sys.home);
  const at = place ? placeKind(place) : { kind: 'none' };
  const onPath = flutterOnPath(sys);
  // On PATH through the place itself (the kits block's own line): that is the place's Flutter, not another one.
  const viaPlace = Boolean(onPath && place && onPath.bin === path.join(place, 'bin', 'flutter'));
  const shellLine = !onPath || viaPlace;
  if (at.kind === 'folder' && isFlutterRoot(place, sys)) return { state: 'ok', version: flutterVersionAt(place), detail: `in ${rel}`, found: t(place), onPath: Boolean(onPath), shellLine };
  if (at.kind === 'link' && isFlutterRoot(at.real, sys)) return { state: 'ok', version: flutterVersionAt(at.real), detail: `${rel} points at ${t(at.real)}: used where it is`, found: t(at.real), onPath: Boolean(onPath), shellLine };
  const taken = at.kind === 'none' ? null : `${rel} is there already (${KIND_WORDS[at.kind]}${at.kind === 'link' ? ` to ${t(at.real)}, which holds no Flutter` : at.kind === 'folder' ? ' without Flutter in it' : ''}): Hoprig never writes over it`;
  for (const p of flutterPlaces(sys)) {
    if (!isFlutterRoot(p.dir, sys) || (place && realOf(sys, p.dir) === realOf(sys, place))) continue;
    const same = onPath && realOf(sys, onPath.root) === realOf(sys, p.dir);
    return {
      state: 'ok', version: flutterVersionAt(p.dir), detail: `found at ${t(p.dir)}: used where it is${taken ? `; ${taken}` : ''}`, found: t(p.dir), onPath: Boolean(onPath),
      ...(place && at.kind === 'none' ? { adopt: { from: p.dir, place, rel } } : {}), shellLine: !same && !onPath,
    };
  }
  if (taken) return { state: 'missing', version: null, detail: taken, hold: `${taken}. If it is yours, leave it; else move it aside, then run this again.` };
  if (!place) return { state: 'missing', version: null, detail: 'not found; there is no workspace yet' };
  const lack = missingTools(sys.platform === 'darwin' ? 'zip' : 'tar.xz', sys);
  if (lack.length) {
    const words = `${lack.join(' and ')} ${lack.length > 1 ? 'are' : 'is'} not installed, and Flutter's archive needs ${lack.length > 1 ? 'them' : 'it'} to unpack`;
    return { state: 'missing', version: null, detail: words, hold: `${words}: install ${lack.length > 1 ? 'them' : 'it'} first (see below), then run this again. Nothing was downloaded.`, shellLine };
  }
  return { state: 'missing', version: null, detail: '', shellLine };
}

// The Android SDK is looked for (checked against developer.android.com/tools/variables and /studio/intro/update, 25 Nov
// 2026) at the workspace's place, ANDROID_HOME, ANDROID_SDK_ROOT (the older name), then where Android Studio puts it:
// ~/Android/Sdk on Linux, ~/Library/Android/sdk on macOS. A folder is an SDK when it holds sdkmanager
// (cmdline-tools/latest/bin, or the old tools/bin) or adb (platform-tools). Android Studio: the places java.mjs knows.
const SDK_MARKS = [['cmdline-tools', 'latest', 'bin', 'sdkmanager'], ['platform-tools', 'adb'], ['tools', 'bin', 'sdkmanager']];
const isSdkRoot = (d, sys) => Boolean(d) && SDK_MARKS.some((m) => sys.exists(path.join(d, ...m)));
/** sdkmanager inside an SDK folder (the command-line tools Hoprig puts there, or the owner's). */
export const sdkManagerAt = (sdk) => path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');

/** The command-line tools' version from their own source.properties (Pkg.Revision). */
export function androidToolsVersionAt(sdk) {
  const m = /^Pkg\.Revision=(\d{1,4}(?:\.\d{1,4}){0,2})\s*$/m.exec(readSmall(path.join(sdk, 'cmdline-tools', 'latest', 'source.properties')) || '');
  return m ? m[1] : null;
}

/**
 * The ANDROID_HOME the owner gives himself: in this run's environment, or in a shell start file outside the kits block
 * (a run from the dashboard's service has not read his .bashrc). → { value (a path, or null when it cannot be read) }
 * or null when he sets none.
 */
export function ownAndroidHome(sys) {
  const env = sys.env || {};
  if (env.ANDROID_HOME) return { value: path.isAbsolute(env.ANDROID_HOME) ? path.resolve(env.ANDROID_HOME) : null };
  if (sys.platform === 'win32' || !sys.home) return null;
  return ownValue('ANDROID_HOME', { home: sys.home, shell: env.SHELL || '', platform: sys.platform });
}

/** The places the Android SDK is looked for outside the workspace, in order: [{ dir, from }]. */
export function androidSdkPlaces(sys) {
  const env = sys.env || {};
  const out = [];
  for (const v of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) if (env[v] && path.isAbsolute(env[v])) out.push({ dir: env[v], from: v });
  const own = !env.ANDROID_HOME ? ownAndroidHome(sys) : null;
  if (own && own.value) out.push({ dir: own.value, from: 'your shell start files' });
  out.push({ dir: sys.platform === 'darwin' ? path.join(sys.home, 'Library', 'Android', 'sdk') : path.join(sys.home, 'Android', 'Sdk'), from: 'home' });
  return out;
}

/**
 * The Android SDK item: { state, version, detail, found?, sdk (the folder the owner's commands use), adopt?, shellLine?,
 * hold? }. `shellLine`: the kits block should set ANDROID_HOME to the place and put its tools on PATH (no ANDROID_HOME
 * of the owner's names another folder: his own line is never overruled).
 */
export async function detectAndroidSdk(sys) {
  const place = sys.ws ? devPlace(sys.ws, 'androidSdk') : null;
  const rel = DEV_PLACES.androidSdk.rel;
  const t = (p) => tildeOf(p, sys.home);
  const at = place ? placeKind(place) : { kind: 'none' };
  const own = ownAndroidHome(sys);
  const shellLine = !own || (Boolean(place) && own.value === place);
  const v = (d) => androidToolsVersionAt(d);
  if (at.kind === 'folder' && isSdkRoot(place, sys)) return { state: 'ok', version: v(place), detail: `in ${rel}`, found: t(place), sdk: place, shellLine };
  if (at.kind === 'link' && isSdkRoot(at.real, sys)) return { state: 'ok', version: v(at.real), detail: `${rel} points at ${t(at.real)}: used where it is`, found: t(at.real), sdk: place, shellLine };
  const taken = at.kind === 'none' ? null : `${rel} is there already (${KIND_WORDS[at.kind]}${at.kind === 'link' ? ` to ${t(at.real)}, which holds no Android SDK` : at.kind === 'folder' ? ' without an Android SDK in it' : ''}): Hoprig never writes over it`;
  for (const p of androidSdkPlaces(sys)) {
    if (!isSdkRoot(p.dir, sys) || (place && realOf(sys, p.dir) === realOf(sys, place))) continue;
    return {
      state: 'ok', version: v(p.dir), detail: `found at ${t(p.dir)}: used where it is${taken ? `; ${taken}` : ''}`, found: t(p.dir), sdk: p.dir,
      ...(place && at.kind === 'none' ? { adopt: { from: p.dir, place, rel } } : {}), shellLine: shellLine && Boolean(place) && at.kind === 'none',
    };
  }
  if (taken) return { state: 'missing', version: null, detail: taken, hold: `${taken}. If it is yours, leave it; else move it aside, then run this again.` };
  if (!place) return { state: 'missing', version: null, detail: 'not found; there is no workspace yet' };
  const lack = missingTools('zip', sys);
  if (lack.length) {
    const words = 'unzip is not installed, and the command-line tools come as a .zip';
    return { state: 'missing', version: null, detail: words, hold: `${words}: install it first, then run this again. Nothing was downloaded.`, sdk: place, shellLine };
  }
  return { state: 'missing', version: null, detail: '', sdk: place, shellLine };
}

const STUDIO_VERSION_RE = /^\d{1,4}(?:\.\d{1,4}){1,3}$/;
const studioMark = (platform) => (platform === 'darwin' ? ['Contents', 'MacOS', 'studio'] : ['bin', 'studio.sh']);

/** Android Studio's version from its own product-info.json. */
export function studioVersionAt(dir, platform) {
  const f = platform === 'darwin' ? path.join(dir, 'Contents', 'Resources', 'product-info.json') : path.join(dir, 'product-info.json');
  try {
    const v = JSON.parse(readSmall(f) || '{}').version;
    return STUDIO_VERSION_RE.test(String(v)) ? v : null;
  } catch {
    return null;
  }
}

/** The places Android Studio is looked for (the folders whose jbr java.mjs looks at). */
export function studioPlaces(sys) {
  return [...new Set(javaPlaces(sys).filter((p) => p.from === 'Android Studio').map((p) => (sys.platform === 'darwin' ? path.resolve(p.home, '..', '..', '..', '..') : path.dirname(p.home))))];
}

/**
 * The Android Studio item: found and used where it is, never downloaded. On Linux one found elsewhere is adopted by a
 * link at development/android/android-studio (only when that place is free); on macOS the app stays where it is and is
 * only shown (an app is opened from Applications).
 */
export async function detectStudio(sys) {
  const place = sys.ws && sys.platform !== 'darwin' ? devPlace(sys.ws, 'androidStudio') : null;
  const rel = DEV_PLACES.androidStudio.rel;
  const t = (p) => tildeOf(p, sys.home);
  const is = (d) => Boolean(d) && sys.exists(path.join(d, ...studioMark(sys.platform)));
  const at = place ? placeKind(place) : { kind: 'none' };
  if (at.kind === 'folder' && is(place)) return { state: 'ok', version: studioVersionAt(place, sys.platform), detail: `in ${rel}`, found: t(place) };
  if (at.kind === 'link' && is(at.real)) return { state: 'ok', version: studioVersionAt(at.real, sys.platform), detail: `${rel} points at ${t(at.real)}: used where it is`, found: t(at.real) };
  for (const dir of studioPlaces(sys)) {
    if (!is(dir) || (place && realOf(sys, dir) === realOf(sys, place))) continue;
    return { state: 'ok', version: studioVersionAt(dir, sys.platform), detail: `found at ${t(dir)}: used where it is`, found: t(dir), ...(place && at.kind === 'none' ? { adopt: { from: dir, place, rel } } : {}) };
  }
  return { state: 'missing', version: null, detail: 'not found: Hoprig does not download it' };
}

/**
 * nvm on this computer: { at (its folder) | null, from, place (the workspace's) | null, placeKind, adopt? } — `adopt`
 * when it is found outside the workspace and the place is free; `newAt` when none is found and a new one goes to the
 * place; `taken` when the place holds something else (a new nvm then goes nowhere: the place is never written over).
 */
export function findNvm({ env = {}, home, ws = null, exists = (f) => fs.existsSync(f) }) {
  const place = ws ? devPlace(ws, 'nvm') : null;
  const at = place ? placeKind(place) : { kind: 'none' };
  const has = (d) => Boolean(d) && exists(path.join(d, 'nvm.sh'));
  if (place && (at.kind === 'folder' || at.kind === 'link') && has(place)) return { at: place, from: 'workspace', place, placeKind: at.kind, real: at.real || place };
  const taken = at.kind !== 'none';
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? path.join(env.XDG_CONFIG_HOME, 'nvm') : null;
  for (const [dir, from] of [[env.NVM_DIR, 'NVM_DIR'], [path.join(home, '.nvm'), 'home'], [xdg, 'XDG_CONFIG_HOME']]) {
    if (!dir || !path.isAbsolute(dir) || !has(dir)) continue;
    return { at: dir, from, place, placeKind: at.kind, ...(place && !taken ? { adopt: { from: dir, place, rel: DEV_PLACES.nvm.rel } } : {}), ...(taken ? { taken: true } : {}) };
  }
  return { at: null, from: null, place, placeKind: at.kind, ...(place && !taken ? { newAt: place } : {}), ...(taken ? { taken: true } : {}) };
}

/**
 * The toolchains at the workspace's places, for this computer's file in the brain (workspace/computer.mjs): names and
 * versions only, never a path. An adopted one (a link) says so.
 */
export function devTools(ws) {
  const out = [];
  for (const [id, p] of Object.entries(DEV_PLACES)) {
    const where = devPlace(ws, id);
    const k = placeKind(where);
    if (k.kind !== 'folder' && k.kind !== 'link') continue;
    const dir = k.real || where;
    const version = id === 'flutter' ? flutterVersionAt(dir) : id === 'nvm' ? nvmVersionAt(dir) : id === 'androidSdk' ? androidToolsVersionAt(dir) : id === 'androidStudio' ? studioVersionAt(dir, process.platform) : null;
    out.push({ name: p.name, ...(version ? { version } : {}), ...(k.kind === 'link' ? { adopted: true } : {}) });
  }
  return out;
}
