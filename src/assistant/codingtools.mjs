// Tia and the coding tools of a computer (Settings → Coding tools, Settings → Updates): what she may look at, and the
// three actions of manage_computer that change them. They follow the checklist at the top of tools.mjs:
//
//   look (L0)          get_computer_status with coding_tools: true — which coding tools are on and installed, the
//                      providers that serve each, and every row of Settings → Updates (Hoprig, each coding tool, the
//                      tunnel helper): version, newest version, what an update does to running sessions, why it waits
//   check_updates (L1) look again now (the page's "Check now"): it asks the servers, changes nothing
//   update (L2)        update one item, or install a coding tool that is missing (it is turned on after), or "all"
//   coding_tool (L2)   turn a coding tool on or off (turn: on | off) (which coding tools new sessions and chats offer)
//
// The card shows what the computer says now (versions, what waits); the computer itself refuses what may not run
// (an update while that tool's sessions are open, the last coding tool turned off). Whether updates run by
// themselves and another coding tool's sign-in stay the owner's: the door (door.mjs) never lets those through. No
// action here touches a provider or a secret.
import { str } from './schema.mjs';
import { codingTool, comp, short, toolError, toolName } from './toolkit.mjs';

const ITEM = /^[a-z][a-z0-9-]{0,30}$/;
const VERSION = /^\d{1,6}(\.\d{1,6}){0,3}([-+][0-9A-Za-z.-]{1,30})?$/;
// The summary is built only from validated ids, versions and fixed words (the checklist in tools.mjs): what another
// computer says of itself (a name, a title, a version) stays in the fenced data.
const sumTool = (id) => (ITEM.test(String(id)) ? toolName(id) : 'a coding tool');
const sumVersion = (v) => (typeof v === 'string' && VERSION.test(v) ? v : v ? 'a version' : 'not installed');
const sumItem = (id) => (ITEM.test(String(id)) ? toolName(id) : 'an item');

/** A row of Settings → Updates in Tia's words. */
const rowView = (r) => ({
  item: r.id, title: short(r.title, 60), installed: r.installed ?? null, latest: r.latest ?? null,
  update_available: !!r.updateAvailable, action: r.action || null, waits: r.blocked ? short(r.blocked, 160) : null,
  why_not: r.why ? short(r.why, 160) : null, note: r.note ? short(r.note, 160) : null, when_running: short(r.whenRunning, 240),
  running: !!r.running, last: r.last ? { ok: !!r.last.ok, version: r.last.version || null, error: r.last.error ? short(r.last.error, 160) : null } : null,
});

/** get_computer_status with coding_tools: true (and the result of check_updates). */
export async function codingToolsView(ops, c, { fresh = false } = {}) {
  const [t, u] = await Promise.all([
    ops.codingTools({ computer: c }).catch((e) => ({ error: e })),
    (fresh ? ops.checkUpdates({ computer: c }) : ops.updates({ computer: c })).catch((e) => ({ error: e })),
  ]);
  // An older computer has neither page: say so, never "none".
  const unknown = (e) => `unknown on ${c} (${short(e.message, 100)})`;
  const tools = t.error ? unknown(t.error) : (t.tools || []).map((x) => ({
    coding_tool: x.id, name: x.name, on: !!x.on, installed: x.installed || null, providers: (x.providers || []).slice(0, 20),
  }));
  const rows = u.error ? null : (u.items || []).map(rowView);
  const said = Array.isArray(tools) ? tools.map((x) => `${sumTool(x.coding_tool)} ${sumVersion(x.installed)} (${x.on ? 'on' : 'off'})`).join(', ') : 'not known';
  const avail = rows ? rows.filter((r) => r.action === 'update' && r.update_available) : [];
  return {
    summary: `${fresh ? 'Looked again: c' : 'C'}oding tools on ${c}: ${said}. Updates: ${!rows ? 'not known' : avail.length ? `${avail.length} available (${avail.map((r) => sumItem(r.item)).join(', ')})` : 'nothing newer'}${u.running ? `; an update of ${sumItem(u.running)} runs now` : ''}.`,
    data: {
      computer: c, coding_tools: tools,
      updates: rows ? { by_themselves: u.mode === 'auto', running: u.running || null, items: rows } : unknown(u.error),
    },
    shown: { computer: [c] },
  };
}

/** The Settings → Updates row of `item` (or every row "all" would update), for a card. Throws a guiding error. */
async function updatePlan(ops, a) {
  const c = comp(a);
  let v;
  try {
    v = await ops.updates({ computer: c });
  } catch (e) {
    // A computer from before Settings → Updates: only Claude Code is updated there, by its own route.
    if (e.status === 404 && a.item === 'claude') {
      const s = await ops.computerStatus({ computer: c });
      return { item: 'claude', title: 'Claude Code', action: 'update', installed: (s.claude && s.claude.version) || null, latest: (s.claude && s.claude.latest) || null, old: true, lines: ['Running sessions keep their version until they start again.'] };
    }
    throw e;
  }
  const rows = v.items || [];
  if (v.running) throw toolError(`an update of ${v.running} runs on ${c} now`, 'wait until it ends (get_computer_status with coding_tools: true), then propose it again');
  if (a.item === 'all') {
    const go = rows.filter((r) => r.action === 'update' && r.updateAvailable && !r.notInAll && !r.blocked);
    if (!go.length) throw toolError(`nothing on ${c} can be updated now`, 'get_computer_status with coding_tools: true shows each item and why it waits');
    return { item: 'all', title: 'everything that has an update', action: 'update', items: go.map((r) => `${r.title}: ${r.installed || '?'} → ${r.latest || 'newest'}`), lines: [] };
  }
  const r = rows.find((x) => x.id === a.item);
  if (!r) throw toolError(`there is no "${a.item}" in Settings → Updates of ${c}`, `items: ${rows.map((x) => x.id).join(', ') || 'none'}, or "all"`);
  if (!r.action) throw toolError(r.why || (r.installed ? `${r.title} is up to date on ${c}` : `${r.title} cannot be installed from here`), 'nothing to do; check_updates looks again');
  if (r.blocked) throw toolError(`${r.title} must wait on ${c}: ${short(r.blocked, 160)}`, 'tell the owner what waits; do not stop his sessions for it');
  const lines = [r.whenRunning, ...(r.note ? [r.note] : []), ...(r.action === 'install' && r.id !== 'hoprig' ? [`${r.title} is turned on after the install, so new sessions and chats offer it.`] : [])].filter(Boolean).map((l) => short(l, 300));
  return { item: r.id, title: r.title, action: r.action, installed: r.installed ?? null, latest: r.latest ?? null, lines };
}

/** manage_computer's fields and actions for the coding tools (spread into its definition in domains.mjs). */
export const CODING_TOOL_FIELDS = {
  item: str({ max: 31, pattern: ITEM, desc: 'update: an item of Settings → Updates from get_computer_status with coding_tools: true (a coding tool such as "claude" or "opencode", "hoprig", the tunnel helper), or "all".' }),
  coding_tool: codingTool,
};

export const CODING_TOOL_ACTIONS = {
  check_updates: {
    // It asks the servers for the newest versions; nothing changes on the computer.
    level: 'L1',
    run: (ops, a) => codingToolsView(ops, comp(a), { fresh: true }),
  },
  update: {
    level: 'L2',
    need: ['item'],
    before: (ops, a) => updatePlan(ops, a),
    cardLines: (a, b) => [
      b.item === 'all'
        ? `Update on ${comp(a)}: ${b.items.join('; ')}`
        : `${b.action === 'install' ? 'Install' : 'Update'} ${b.title} on ${comp(a)}${b.action === 'install' ? ` (${b.latest || 'the tested version'})` : `: ${b.installed || 'unknown'} → ${b.latest || 'the newest version'}`}`,
      ...b.lines,
      'It runs in the background; its output is on Settings → Updates of that computer.',
    ],
    async run(ops, a) {
      const c = comp(a);
      const b = await updatePlan(ops, a);
      if (b.old) {
        await ops.updateClaude({ computer: c });
        return { summary: `The Claude Code update on ${c} started.`, data: { computer: c, started: true, items: ['claude'] } };
      }
      const r = await ops.runUpdate({ computer: c, id: a.item });
      const skipped = (r.skipped || []).map((x) => ({ item: x.id, why: short(x.why, 160) }));
      return {
        summary: r.started
          ? `${b.action === 'install' ? 'The install' : 'The update'} of ${(r.ids || []).join(', ')} started on ${c}; get_computer_status with coding_tools: true shows the result when it ends.${skipped.length ? ` Left out: ${skipped.map((x) => x.item).join(', ')}.` : ''}`
          : `Nothing was started on ${c}.`,
        data: { computer: c, started: !!r.started, items: r.ids || [], skipped },
      };
    },
  },
  coding_tool: {
    level: 'L2',
    need: ['coding_tool', 'turn'],
    async before(ops, a) {
      const c = comp(a);
      const on = a.turn === 'on';
      const v = await ops.codingTools({ computer: c });
      const t = (v.tools || []).find((x) => x.id === a.coding_tool);
      if (!t) throw toolError(`${toolName(a.coding_tool)} is not offered on ${c}`, 'that computer runs an older Hoprig: tell the owner');
      if (!!t.on === on) throw toolError(`${t.name} is already ${a.turn} on ${c}`, 'nothing to do');
      if (on && !t.installed) throw toolError(`${t.name} is not installed on ${c}`, `manage_computer update with item "${t.id}" installs it and turns it on (a card)`);
      if (!on && !(v.tools || []).some((x) => x.on && x.id !== t.id)) throw toolError(`${t.name} is the only coding tool on ${c}: one always stays on`, 'turn another one on first');
      return { tool: t.id, name: t.name, on: !!t.on, installed: t.installed || null };
    },
    cardLines: (a, b) => [
      `Turn ${b.name} ${a.turn.toUpperCase()} on ${comp(a)} (installed: ${b.installed || 'no'})`,
      a.turn === 'on' ? 'New sessions and chats then offer it; it runs only on providers that serve it.' : 'New sessions and chats no longer offer it; nothing is uninstalled.',
    ],
    async run(ops, a) {
      const r = await ops.setCodingTool({ computer: comp(a), id: a.coding_tool, on: a.turn === 'on' });
      const on = (r.tools || []).filter((x) => x.on).map((x) => x.name);
      return { summary: `${toolName(a.coding_tool)} is ${a.turn} on ${comp(a)}; on now: ${on.join(', ') || 'unknown'}.`, data: { coding_tool: a.coding_tool, on: a.turn === 'on' } };
    },
  },
};
