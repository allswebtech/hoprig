// `hoprig tools`: the coding tools from the command line.
//
//   hoprig tools [status] [--json]          each tool: on or off, installed version, newest version
//   hoprig tools install <tool> [version]   install it (Codex and OpenCode into Hoprig's tools folder, at the version
//                                           this Hoprig is tested with unless one is named) and turn it on
//   hoprig tools update <tool | all>        update it (all: every installed tool with a newer version)
//   hoprig tools on | off <tool>            turn a tool on or off (which tools the dashboard offers)
//
// `hoprig claude status | update | install` stays as it was.
import { loadConfig, saveConfig } from '../config.mjs';
import { TOOL_IDS, enabledToolIds, findTool, withTool } from './index.mjs';
import { readyToReplace } from './servers.mjs';

const USAGE = `usage:
  hoprig tools [status] [--json]          the coding tools: on or off, installed, newest
  hoprig tools install <tool> [version]   install one (${TOOL_IDS.join(', ')}) and turn it on
  hoprig tools update <tool | all>        update one, or every installed one
  hoprig tools on | off <tool>            which tools the dashboard offers
`;

const toolArg = (id, out) => {
  const t = findTool(id);
  if (!t) out(`"${id || ''}" is not a coding tool: ${TOOL_IDS.join(', ')}`);
  return t;
};

/** Returns an exit code. `io`: { out, err, config, save } (tests pass stand-ins). */
export async function main(args = [], io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  const config = io.config || loadConfig;
  const save = io.save || saveConfig;
  const print = (l) => out(`  ${l}`);
  const [sub = 'status', ...rest] = args;

  if (sub === 'status' || sub === '--json') {
    const on = enabledToolIds(config());
    const rows = await Promise.all(TOOL_IDS.map(async (id) => {
      const t = findTool(id);
      const i = await t.info().catch((e) => ({ installed: null, latest: null, error: e.message }));
      return { id, name: t.name, on: on.includes(id), installed: i.installed, latest: i.latest, updateAvailable: !!i.updateAvailable, ...(t.managed ? { pinned: t.pin, path: i.path || null } : {}) };
    }));
    if (args.includes('--json')) {
      out(JSON.stringify(rows, null, 2));
      return 0;
    }
    for (const r of rows) {
      const ver = r.installed ? r.installed : 'not installed';
      const newest = r.latest ? (r.updateAvailable ? `  →  ${r.latest} (hoprig tools update ${r.id})` : r.installed ? '  (newest)' : `  (newest ${r.latest})`) : '  (newest: unknown, offline?)';
      out(`${r.name.padEnd(12)} ${r.on ? 'on ' : 'off'}  ${ver}${newest}`);
    }
    return 0;
  }

  // npm replaces a tool's program files: the same rule as the Updates page (no open session, its server stopped).
  const ready = io.ready || readyToReplace;
  const mayReplace = async (t) => {
    if (!t.managed || !t.installedVersion()) return true;
    const why = await ready(t.id);
    if (why) out(`${why}. Nothing changed.`);
    return !why;
  };

  if (sub === 'install') {
    const t = toolArg(rest[0], err);
    if (!t) return 2;
    if (!(await mayReplace(t))) return 1;
    const r = await t.install({ version: rest[1], onLine: print });
    if (!r.ok) {
      out('That did not succeed (see above).');
      return 1;
    }
    save({ codingTools: withTool(config(), t.id, true) });
    out(`${t.name} ${r.version} is installed and on.`);
    return 0;
  }

  if (sub === 'update') {
    if (rest[0] === 'all') {
      let code = 0;
      for (const id of TOOL_IDS) {
        const t = findTool(id);
        const i = await t.info();
        if (!i.installed || !i.updateAvailable) continue;
        out(`${t.name} ${i.installed} → ${i.latest}`);
        if (!(await mayReplace(t))) {
          code = 1;
          continue;
        }
        const r = await t.update({ onLine: print });
        if (!r.ok) code = 1;
      }
      out(code ? 'Not everything was updated (see above).' : 'Every installed coding tool is up to date.');
      return code;
    }
    const t = toolArg(rest[0], err);
    if (!t) return 2;
    if (!t.installedVersion() && t.managed) {
      out(`${t.name} is not installed. Install it with: hoprig tools install ${t.id}`);
      return 1;
    }
    const i = await t.info();
    if (i.installed && i.latest && !i.updateAvailable) {
      out(`${t.name} ${i.installed} is the newest version.`);
      return 0;
    }
    if (!(await mayReplace(t))) return 1;
    const r = await t.update({ onLine: print });
    out(r.ok ? `${t.name} is now ${r.version}.` : 'The update did not succeed (see above).');
    return r.ok ? 0 : 1;
  }

  if (sub === 'on' || sub === 'off') {
    const t = toolArg(rest[0], err);
    if (!t) return 2;
    try {
      const next = withTool(config(), t.id, sub === 'on');
      save({ codingTools: next });
      out(`On: ${next.map((id) => findTool(id).name).join(', ')}.${sub === 'on' && t.managed && !t.installedVersion() ? ` Install it with: hoprig tools install ${t.id}` : ''}`);
      return 0;
    } catch (e) {
      err(e.message);
      return 1;
    }
  }

  err(USAGE);
  return 2;
}
