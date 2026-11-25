// The steps of a kit plan that are not commands (kits.mjs: a step with `do` instead of `argv`), run inside Hoprig by
// runSteps (setup.mjs): put a checked download in its place in development/, make an adoption link, write the kits
// block of the shell start files. Never with administrator rights, never through the page's sudo wrapper.
//
// A place is never written over: a folder, a file, a link or a broken link already there stops the step. The work is
// done in a temporary folder inside development/ (`.hoprig-tmp-<pid>-<random>`: the same disk, so the last move is one
// rename; a leading dot, so the map scan and this computer's description skip it) and renamed into the place in one
// step. On any failure (network, size, checksum, unpack, a stop) only what this step made is removed, by the paths
// recorded when it made them: the temporary folder and the empty folders it made on the way to the place. A run that
// is killed cannot do that: the next install removes such a folder once its process is gone (sweepLeftovers).
import fs from 'node:fs';
import path from 'node:path';
import { FetchError, chooseAndroid, chooseFlutter, download, httpsGet, readList, sizeWords } from './fetchkit.mjs';
import { KIND_WORDS, placeKind, tildeOf } from './devplaces.mjs';
import { missingTools, unpackChecked } from './unpack.mjs';
import { ensureKitsBlock } from '../setup/localbin.mjs';
import { DEV_TMP_PREFIX } from '../workspace/layout.mjs';

export const TMP_PREFIX = DEV_TMP_PREFIX;

/** The folders from `ws` down to `dir` that are not there yet, after checking that none on the way is a link. */
function folderWay(ws, dir) {
  const rel = path.relative(ws, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new FetchError('place', `${dir} is not inside the workspace`);
  const missing = [];
  let at = ws;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    const k = placeKind(at).kind;
    if (k === 'none') missing.push(at);
    else if (k !== 'folder') throw new FetchError('place', `${at} is ${KIND_WORDS[k]}, not a folder: Hoprig never puts a toolchain through it`, 'Move it aside, then run this again.');
  }
  return missing;
}

/** Make the folders `way` lists (each one recorded in `made` as it is made). */
function makeWay(way, made) {
  for (const d of way) {
    fs.mkdirSync(d);
    made.push(d);
  }
}

/** The place must be free (nothing at all there, not even a broken link). */
function placeFree(place, home) {
  const k = placeKind(place).kind;
  if (k !== 'none') throw new FetchError('taken', `${tildeOf(place, home)} is there already (${KIND_WORDS[k]}): Hoprig never writes over it`, 'If it is yours, leave it; else move it aside, then run this again.');
}

/** Undo what a failed step made: the temporary folder, then the empty folders made on the way (newest first). */
function undo(tmp, made) {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  for (const d of [...made].reverse()) {
    try {
      fs.rmdirSync(d);
    } catch {
      /* not empty: something else is in it now, and it stays */
    }
  }
}

/** Is the process `pid` still running? (one of another user counts as running) */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * Remove the temporary folders a run that was killed left in development/ (`.hoprig-tmp-<pid>-<random>`, the
 * process gone): only a real folder, holding nothing but Hoprig's own names (the archive flutter.<kind> or
 * android.zip, the folders into/ and sdk/). Anything else is left as it is. → how many were removed
 */
export function sweepLeftovers(dev) {
  let names;
  try {
    if (!fs.lstatSync(dev).isDirectory()) return 0;
    names = fs.readdirSync(dev);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    const m = new RegExp(`^${TMP_PREFIX.replace(/[.]/g, '\\.')}(\\d+)-`).exec(n);
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    const d = path.join(dev, n);
    try {
      if (!fs.lstatSync(d).isDirectory()) continue;
      const ours = fs.readdirSync(d).every((x) => {
        const st = fs.lstatSync(path.join(d, x));
        return (['into', 'sdk'].includes(x) && st.isDirectory()) || (/^(flutter\.(tar\.xz|zip)|android\.zip)$/.test(x) && st.isFile());
      });
      if (!ours) continue;
      fs.rmSync(d, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* changed while looked at: left */
    }
  }
  return removed;
}

/** Flutter's pick: the current stable release from Flutter's own list. */
async function pickFlutter(step, { get, signal }) {
  const { data } = step;
  const os = step.platform === 'darwin' ? 'macos' : 'linux';
  const listText = await readList(data.list.replace('<os>', os), { host: data.host, prefix: data.prefix, ceiling: data.listCeiling, get, signal });
  const p = chooseFlutter(listText, { platform: step.platform, arch: step.arch, host: data.host });
  return { ...p, name: 'Flutter', file: 'flutter', top: 'flutter', size: null, checksum: { type: 'sha256', hex: p.sha256 }, said: `Flutter ${p.version} is` };
}

/**
 * The Android SDK command-line tools' pick from the list sdkmanager reads. Their archive holds one cmdline-tools/
 * folder; sdkmanager wants it at <sdk>/cmdline-tools/latest (`nest`), so the SDK folder is put together inside the
 * temporary folder and still becomes the place by one rename.
 */
async function pickAndroid(step, { get, signal }) {
  const { data } = step;
  const listText = await readList(data.list, { host: data.host, prefix: data.prefix, ceiling: data.listCeiling, get, signal });
  const p = chooseAndroid(listText, { platform: step.platform, arch: step.arch, base: data.base, ceiling: data.ceiling });
  return { ...p, name: 'the Android SDK command-line tools', file: 'android', kind: 'zip', top: 'cmdline-tools', nest: ['cmdline-tools', 'latest'], checksum: { type: 'sha1', hex: p.sha1 }, said: `The Android SDK command-line tools${p.version ? ` ${p.version}` : ''} are` };
}

/** Put a kit's checked download at `step.place`: `pickIt` reads the vendor's list and says what to fetch. → { ok, said } */
async function installChecked(step, pickIt, { get, signal, onProgress, home }) {
  const { place, ws, data } = step;
  placeFree(place, home);
  const swept = sweepLeftovers(path.join(ws, 'development'));
  const pick = await pickIt(step, { get, signal });
  const lack = missingTools(pick.kind, step.tools);
  if (lack.length) throw new FetchError('tools', `${lack.join(' and ')} ${lack.length > 1 ? 'are' : 'is'} not installed, and the archive of ${pick.name} needs ${lack.length > 1 ? 'them' : 'it'}: nothing was downloaded`, `Install ${lack.join(' and ')}, then run this again.`);
  const made = [];
  let tmp = null;
  try {
    const dev = path.join(ws, 'development');
    makeWay(folderWay(ws, path.dirname(place)), made);
    // The process id in the name: a later run removes the folder of a run that was killed (sweepLeftovers).
    tmp = fs.mkdtempSync(path.join(dev, `${TMP_PREFIX}${process.pid}-`));
    const file = path.join(tmp, `${pick.file}.${pick.kind}`);
    await download(pick.url, { host: data.host, prefix: data.prefix, ceiling: data.ceiling, size: pick.size, checksum: pick.checksum, file, get, signal, onProgress });
    if (signal && signal.aborted) throw new FetchError('stopped', 'the install was stopped', 'Start it again when you want it.');
    const into = path.join(tmp, 'into');
    fs.mkdirSync(into);
    const top = await unpackChecked(file, pick.kind, into, pick.top, { signal, most: data.unpackCeiling });
    if (signal && signal.aborted) throw new FetchError('stopped', 'the install was stopped', 'Start it again when you want it.');
    // The folder that becomes the place: the archive's top folder, or (nest) a new folder `sdk` with it inside.
    let ready = top;
    if (pick.nest) {
      ready = path.join(tmp, 'sdk');
      const inner = path.join(ready, ...pick.nest);
      fs.mkdirSync(path.dirname(inner), { recursive: true });
      fs.renameSync(top, inner);
    }
    placeFree(place, home); // looked at again just before the one rename
    fs.renameSync(ready, place);
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
    return { ok: true, said: `${pick.said} in ${tildeOf(place, home)}${swept ? ` (and the half download of an earlier run that was stopped is removed)` : ''}` };
  } catch (e) {
    undo(tmp, made);
    throw e;
  }
}

/** The adoption link: the place points at the tool where it is. The tool itself is never touched. */
function makeLink(step, { home }) {
  placeFree(step.place, home);
  const made = [];
  try {
    makeWay(folderWay(step.ws, path.dirname(step.place)), made);
    fs.symlinkSync(step.from, step.place, 'dir');
  } catch (e) {
    undo(null, made);
    throw e instanceof FetchError ? e : new FetchError('place', `the link could not be made (${e.code || e.message})`);
  }
  return { ok: true, said: `${tildeOf(step.place, home)} points at ${tildeOf(step.from, home)}` };
}

/**
 * Run one step that is not a command. → { ok, said?, why?, todo? } — never throws: a refusal is said in words, with
 * what to do. `get` is the getter of the vendor's host (fetchkit.mjs httpsGet; tests hand their own).
 */
export async function runInside(step, { get = httpsGet, signal, onProgress = () => {} } = {}) {
  const { home, shell = '', platform = process.platform } = step;
  try {
    if (step.do === 'flutter') return await installChecked(step, pickFlutter, { get, signal, onProgress, home });
    if (step.do === 'android-sdk') return await installChecked(step, pickAndroid, { get, signal, onProgress, home });
    if (step.do === 'link') return makeLink(step, { home });
    if (step.do === 'shell') {
      const r = ensureKitsBlock({ home, shell, platform, lines: step.lines });
      return { ok: true, said: [...r.did, ...r.kept].join('; ') || 'the shell start files have these lines already' };
    }
    return { ok: false, why: `Hoprig does not know the step "${step.do}"` };
  } catch (e) {
    return { ok: false, code: e.code || null, why: e.message, todo: e.todo || null };
  }
}

/** A download's progress in words, at most every 10%: "Flutter: 150 MB of about 1.5 GB". */
export function progressWords(name) {
  let last = -1;
  return (bytes, total) => {
    const tenth = total ? Math.floor((bytes / total) * 10) : Math.floor(bytes / 2e8);
    if (tenth === last) return null;
    last = tenth;
    return `${name}: ${sizeWords(bytes, false)}${total ? ` of ${sizeWords(total)}` : ''}`;
  };
}
