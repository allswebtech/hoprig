// Command-line tools a catalog skill needs (for example the reverse-engineering tool behind REA's skill): the
// installed version, the newest on npm, and the exact command that updates it. The command runs only on a yes.
import { withoutSecrets } from '../secretenv.mjs';
import { capture, compareVersions, npmArgv, parseVersion, showCommand, stream, which } from '../setup/system.mjs';
import { loadCatalog } from './catalog.mjs';

/** Every tool the catalog names, once. */
export const catalogTools = () => {
  const seen = new Map();
  for (const e of loadCatalog().entries) if (e.tool && !seen.has(e.tool.id)) seen.set(e.tool.id, { ...e.tool, for: e.id });
  return [...seen.values()];
};

/**
 * { id, bin, npm, installed, version, latest, updateAvailable, command (argv), commandText }. Reads the version
 * with the tool's own --version (a program the user installed, not anything from a skill) and asks npm for the
 * newest version (this sends the package name to the npm registry).
 */
export async function checkTool(tool, { run = capture } = {}) {
  const path = which(tool.bin);
  let version = null;
  if (path) {
    const r = await run([path, ...tool.versionArgs], { timeout: 20_000 });
    const v = parseVersion(`${r.stdout} ${r.stderr}`);
    version = v ? v.join('.') : null;
  }
  const r = await run(npmArgv(['view', tool.npm, 'version']), { env: withoutSecrets(process.env), timeout: 30_000 });
  const latest = r.ok && parseVersion(r.stdout) ? r.stdout.trim() : null;
  const command = npmArgv(['install', '--global', `${tool.npm}@${latest || 'latest'}`]);
  return {
    id: tool.id, bin: tool.bin, npm: tool.npm, homepage: tool.homepage || null, for: tool.for || null,
    installed: Boolean(path), version, latest,
    updateAvailable: Boolean(path && version && latest && compareVersions(version, latest) < 0),
    command, commandText: showCommand(command),
  };
}

/** Run the install/update command of a checked tool, its output going to onLine. Resolves { ok, output }. */
export function updateTool(checked, { onLine = () => {}, run = stream } = {}) {
  return run(checked.command, { env: withoutSecrets(process.env), onLine }); // a global npm install runs scripts
}
