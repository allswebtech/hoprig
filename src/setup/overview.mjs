// What is there and what is missing, for the whole product, in six groups: the doctor's view (and its --json, for
// the page). The dashboard's own checks come from checks.mjs, the computer's from src/pcsetup (pcStatus), the skills
// from src/skillhub. `hoprig pc status` stays the detailed view of the computer alone.
import { allChecks, sysInfo } from './checks.mjs';
import { forThisUser } from './system.mjs';

export const GROUPS = ['This computer', 'Claude Code and providers', 'Dashboard', 'Coding tools', 'Projects', 'Skills'];

const OWN = {
  node: 'This computer', app: 'This computer', config: 'This computer', 'dir-config': 'This computer', 'dir-profiles': 'This computer', 'dir-state': 'This computer',
  claude: 'Claude Code and providers', login: 'Claude Code and providers', profiles: 'Claude Code and providers',
  terminal: 'Dashboard', pty: 'Dashboard', password: 'Dashboard', service: 'Dashboard', port: 'Dashboard', access: 'Dashboard',
};

/** pcStatus's group → ours. Its Claude Code and login lines repeat ours, so they are left out. */
export function pcGroup(c) {
  if (c.group === 'claude') return c.id === 'rules' ? 'Claude Code and providers' : null;
  if (c.group === 'system') return 'This computer';
  if (c.group === 'projects') return 'Projects';
  if (String(c.group).startsWith('kit:')) return 'Coding tools';
  return 'This computer';
}

/** The skills state (skillsStatus) as check lines. */
export function skillChecks(st) {
  const out = [];
  const n = st.user.installed.length;
  out.push({ id: 'skills', label: 'Skills for you', status: n ? 'ok' : 'info', detail: n ? `${n} installed: ${st.user.installed.slice(0, 5).map((s) => s.name).join(', ')}${n > 5 ? ', …' : ''}` : 'none yet', fix: '' });
  for (const s of st.user.suggested) out.push({ id: `skill:${s.id}`, label: s.name, status: 'warn', detail: `not installed (${s.why[0]})`, fix: s.command });
  for (const u of st.updates) out.push({ id: `skill-update:${u.name}`, label: u.name, status: 'warn', detail: `a newer version is available${u.edited ? ' (you edited it here)' : ''}`, fix: `hoprig skills update ${u.name}` });
  if (!st.checked) out.push({ id: 'skills-updates', label: 'Skill updates', status: 'info', detail: 'not checked (offline)', fix: '' });
  return out;
}

/**
 * Every check with its `group`. `parts` replaces the computer and skills sources (tests). A hub codes nothing, so
 * it has no Coding tools, Projects or Skills groups. Missing coding tools are suggestions here (`!`), never a reason
 * for the doctor's exit code: the dashboard and Claude Code work without them.
 */
export async function overview({ sys, offline = false, hub = false, parts = {} } = {}) {
  // Every fix line is phrased for this user (system.mjs: forThisUser): no sudo for root, "as root:" where there is
  // no sudo, whichever part of the product wrote it.
  const who = sys || sysInfo();
  const phrased = (list) => list.map((c) => (c.fix ? { ...c, fix: forThisUser(c.fix, who) } : c));
  const own = (await allChecks({ sys, offline })).map((c) => ({ ...c, group: OWN[c.id] || 'This computer' }));
  if (hub) return phrased(own);
  const pc = parts.pc || (async () => (await import('../pcsetup/index.mjs')).pcStatus({ offline }));
  const skills = parts.skills || (async () => (await import('../skillhub/hub.mjs')).skillsStatus({ check: !offline }));
  // The workspace first in Projects: the tree, the brain's git server, the map (src/workspace/doctor.mjs; no fetch).
  const ws = parts.workspace || (async () => (await import('../workspace/doctor.mjs')).workspaceChecks());
  const [pcList, sk, wsLine] = await Promise.all([
    pc().catch((e) => [{ id: 'pc', label: 'This computer for coding', status: 'warn', detail: `could not be checked: ${e.message}`, fix: 'hoprig pc status', group: 'system' }]),
    skills().catch((e) => ({ error: e.message })),
    ws().catch((e) => [{ id: 'workspace', label: 'Workspace', status: 'warn', detail: `could not be checked: ${e.message}`, fix: 'hoprig workspace status' }]),
  ]);
  const fromPc = pcList
    .map((c) => ({ ...c, group: pcGroup(c) }))
    .filter((c) => c.group)
    .map((c) => (c.group === 'Coding tools' && c.status === 'fail' ? { ...c, status: 'warn' } : c));
  const fromSkills = sk.error
    ? [{ id: 'skills', label: 'Skills', status: 'warn', detail: `could not be checked: ${sk.error}`, fix: 'hoprig skills list', group: 'Skills' }]
    : skillChecks(sk).map((c) => ({ ...c, group: 'Skills' }));
  return phrased([...own, ...[].concat(wsLine).map((c) => ({ ...c, group: 'Projects' })), ...fromPc, ...fromSkills]);
}

/** The checks in display order, grouped: [{ title, checks }]. */
export function grouped(list) {
  return GROUPS.map((title) => ({ title, checks: list.filter((c) => c.group === title) })).filter((g) => g.checks.length);
}
