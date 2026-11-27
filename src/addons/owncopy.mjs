// A shipped gateway's copy in Hoprig's own folder (<tools>/<id>, codetools/npmtool.mjs: an npm prefix that holds that
// package and nothing else), and what can be read about a copy without starting a program: its version from its
// package.json, its entry file, who may change its folder. Never `npm install -g`: the owner's global packages and PATH
// stay as they are. A gateway is started as Node plus the copy's entry file, one way on every system (no shell shim).
import fs from 'node:fs';
import path from 'node:path';
import { npmTool, VERSION_RE } from '../codetools/npmtool.mjs';
import { compareVersions } from '../setup/system.mjs';

/** The first version number in the text a program prints, or null. */
export const parseVersion = (text) => /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text || ''))?.[1] || null;

/** The package.json of package `pkg` above `file` (its real file), or null. */
export function packageJsonOf(file, pkg) {
  let dir;
  try {
    dir = path.dirname(fs.realpathSync(file));
  } catch {
    return null;
  }
  for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
    try {
      const f = path.join(dir, 'package.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.name === pkg) return f;
    } catch {
      /* not this folder */
    }
    if (path.dirname(dir) === dir) break;
  }
  return null;
}

/** The version a copy found on PATH has (a global npm copy), from the package.json above its real file; null when it says none. */
export function packageVersion(file, pkg) {
  const f = packageJsonOf(file, pkg);
  if (!f) return null;
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8')).version;
    return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Is `version` at least `floor`? A version that is not known is not. */
export const atLeast = (version, floor) => Boolean(version) && compareVersions(version, floor) >= 0;

/**
 * The own copy of the shipped gateway `def` (def.own.pin: the version Install puts there). `flags`: npm's flags for its
 * install scripts (localgateway.mjs installFlags). → the npmTool, plus entry(), version() and dir().
 */
export function ownCopyOf(def, flags = []) {
  const tool = npmTool({
    id: def.id,
    name: def.title,
    pkg: def.npm,
    pin: def.own.pin,
    binName: def.bin,
    parseVersion,
    // While npm runs, what the program might create (its data folder) goes into a throwaway folder, not the home.
    isolate: (dir) => ({ DATA_DIR: path.join(dir, 'data'), TMPDIR: path.join(dir, 'tmp') }),
    npmFlags: flags,
    allowScripts: def.allowScripts || [],
    allowLatest: true, // Update lets npm resolve the newest
  });
  /** The file Node runs, or null when the copy has none (not installed, or its package names no script). */
  const entry = () => {
    const argv = tool.argv([]);
    return argv[0] === process.execPath ? argv[1] : null;
  };
  return { ...tool, entry, version: () => tool.installedVersion() };
}

/**
 * Why this user cannot run the copy whose entry file is `entry`, as a sentence, or null when it can read it: the file
 * says no (a folder another user made unreadable, a root-owned install), or is not there.
 */
export function entryProblem(entry, title, id) {
  try {
    fs.accessSync(entry, fs.constants.R_OK);
    return null;
  } catch (e) {
    return e.code === 'ENOENT'
      ? `${title}'s program file ${entry} is not there: install it again with: hoprig addons install ${id}`
      : `this user may not read ${title}'s program file ${entry} (${e.code}): the folder belongs to another user, often root: install ${title} again as this user with: hoprig addons install ${id}`;
  }
}

/** Why a data folder that is there cannot be used by this user (it is not writable by it), as a sentence, or null. */
export function dataProblem(folder, title, uid = process.getuid?.()) {
  try {
    const st = fs.statSync(folder);
    fs.accessSync(folder, fs.constants.R_OK | fs.constants.W_OK);
    if (uid !== undefined && st.uid !== uid) return `its data folder ${folder} belongs to another user (user id ${st.uid}), not to this one`;
    return null;
  } catch (e) {
    if (e.code === 'ENOENT') return null; // the gateway makes it
    return `${title} cannot use its data folder ${folder} (${e.code}): it is not writable by this user. As an administrator: chown -R <this user> ${folder}`;
  }
}

/** The plain words of a program that could not start (Node's spawn error), with its code. */
export function spawnReason(e, file) {
  const code = e?.code || 'unknown';
  if (code === 'ENOENT') return `${file} was not found (${code})`;
  if (code === 'EACCES' || code === 'EPERM') return `this user is not allowed to run ${file} (${code})`;
  return `${e?.message || 'it did not start'} (${code})`;
}
