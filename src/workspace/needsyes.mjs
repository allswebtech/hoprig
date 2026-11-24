// Which needs the owner accepted ON THIS COMPUTER (needs.mjs). A project.json is someone else's words until he says
// otherwise: a cloned project, or a pull that adds a need, opens nothing by itself. His yes is given at `hoprig get`
// (its one question), on the project's page and in the new-session sheet, or with `hoprig workspace needs allow`, and
// taken back the same ways. Kept in Hoprig's own settings ("acceptedNeeds": { "<project>": ["<need>"] }, by the map's
// names), never in a repository, never synced. `--with` and "Also open" are his word for one session: no yes needed.
import { loadConfig, saveConfig } from '../config.mjs';

/** Every accepted need here: { project: [need] }. */
export function acceptedNeeds() {
  try {
    const a = loadConfig().acceptedNeeds;
    return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  } catch {
    return {};
  }
}

export const isAccepted = (project, need, all = acceptedNeeds()) => Array.isArray(all[project]) && all[project].includes(need);

/** Accept (yes) or take back (no) one need of one project on this computer. → { project, need, accepted } */
export function setAccepted(project, need, yes) {
  const all = { ...acceptedNeeds() };
  const cur = new Set(Array.isArray(all[project]) ? all[project].filter((x) => typeof x === 'string') : []);
  if (yes) cur.add(need);
  else cur.delete(need);
  if (cur.size) all[project] = [...cur].sort();
  else delete all[project];
  saveConfig({ acceptedNeeds: all });
  return { project, need, accepted: !!yes };
}

export const acceptCommand = (project, need) => `hoprig workspace needs allow ${project} ${need}`;

export const NEEDS_USAGE = `  hoprig workspace needs [list] [--json]       each project's needs here, and whether you allowed its sessions
                                               to read each one on this computer
  hoprig workspace needs allow|revoke <project> <need>
                                               let the sessions of a project read a need it names, or take that
                                               back (kept on this computer only, never in the project)`;

/** `hoprig workspace needs …`. → exit code */
export async function needsMain(args, { ui, write, usage }) {
  const N = await import('./needs.mjs');
  const json = args.includes('--json');
  const [sub = 'list', project, need, ...more] = args.filter((a) => a !== '--json');
  if (more.length || (sub === 'list' ? project !== undefined : !need) || !['list', 'allow', 'revoke'].includes(sub)) return usage();
  if (sub === 'list') {
    const list = await N.needsHere();
    if (json) write(JSON.stringify({ needs: list }, null, 2) + '\n');
    else if (!list.length) ui.note('no project here names a need');
    else {
      for (const p of list) {
        for (const n of p.needs) {
          const allowed = p.accepted.includes(n);
          ui.line(allowed ? 'ok' : 'info', `${p.project} reads ${n}: ${allowed ? 'allowed on this computer' : `not allowed on this computer yet:  ${acceptCommand(p.project, n)}`}`);
        }
      }
    }
    return 0;
  }
  if (sub === 'revoke') {
    const r = setAccepted(project, need, false);
    if (json) write(JSON.stringify({ ok: true, ...r }, null, 2) + '\n');
    else ui.line('ok', `sessions in ${project} no longer get ${need} (from their next start)`);
    return 0;
  }
  const r = await N.acceptNeed(project, need).catch((e) => ({ error: e.message }));
  if (r.error) {
    if (json) write(JSON.stringify({ ok: false, error: r.error }, null, 2) + '\n');
    else ui.line('fail', r.error);
    return 1;
  }
  if (json) write(JSON.stringify({ ok: true, ...r }, null, 2) + '\n');
  else ui.line('ok', `sessions in ${project} read ${need} from their next start (on this computer only; its file tools cannot write there)`);
  return 0;
}
