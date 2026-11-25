// Where Tia's start_session and start_chat start (src/operator/where.mjs decides): used ONLY when the owner chose the
// computers she may start work on (Settings → Tia, assistant.computers). Without that setting this returns null and
// she starts exactly where she did before it: where the call names, else on this computer.
//
// With it: a computer the call names must be one he chose (else refused: she never starts on one he did not allow);
// with none named, this computer unless it is full, else an allowed one with room that has the folder, a provider she
// may use and the coding tool (asked there only then, through that computer's own gate). A computer that lacks one is
// never brought it: its clause is said. The rooms are the dashboard's own (GET /api/operator/rooms?here=1: this
// computer read now, the others as last read; another computer's words never reach her).

import { chooseWhere } from '../operator/where.mjs';
import { LOCAL } from './shown.mjs';
import { chooseAccount, resolveTia } from './tia.mjs';
import { toolName } from './toolkit.mjs';

const STARTS = new Set(['start_session', 'start_chat']);
const SETTINGS_NEXT = 'start it on this computer, or tell the owner he can allow that computer in Settings → Tia (open_screen "settings/tia")';

/** What computer `c` lacks for this start, in one clause, or null. Asked there through its own gate. */
async function lacks(ops, c, args, raw) {
  try {
    await ops.browse({ computer: c, path: args.folder });
  } catch {
    return 'the project is not there';
  }
  const need = args.coding_tool || 'claude';
  try {
    const t = ((await ops.codingTools({ computer: c })).tools || []).find((x) => x.id === need);
    if (!t || !t.on || !t.installed) return `${toolName(need)} is not set up there`;
  } catch {
    return 'it could not be asked what it has';
  }
  try {
    const accounts = await ops.accounts({ computer: c });
    if (args.account) return (accounts.profiles || []).some((p) => p.name === args.account) ? null : `the provider ${args.account} is not there`;
    return chooseAccount(resolveTia(raw, accounts), accounts, need).error ? 'no provider she may use is there' : null;
  } catch {
    return 'it could not be asked what it has';
  }
}

/**
 * → null (not a start, or no computers chosen: as before), { refuse, next }, or { computer, why }. `placed`: the starts
 * placed in the last minutes (kept by the caller, in memory).
 */
/** The labels he gave his computers (the hub's), by name; this one is "this computer". */
async function labelsOf(ops) {
  try {
    return new Map((await ops.computers()).filter((c) => c && c.name !== LOCAL).map((c) => [c.name, String(c.label || c.name).slice(0, 40)]));
  } catch {
    return new Map();
  }
}
/** What the owner reads for a computer: "this computer", else his label for it. */
const placeOf = (labels, n) => (n === LOCAL ? 'this computer' : labels.get(n) || n);

/**
 * Whether this call is placed by room and so reads the starts placed before it (`placed`): a start with no computer
 * named that is new work, while he chose computers. Only such a call must wait for the ones before it.
 */
export function placedByRoom(name, args, tia) {
  if (!STARTS.has(name) || !Array.isArray(tia.computers) || !tia.computers.length || args.computer) return false;
  return !(args.mode === 'continue' || args.mode === 'resume' || args.conversation || args.fork_of);
}

export async function startWhere({ ops, name, args, tia, placed = [], now = Date.now() }) {
  const r = await whereOf({ ops, name, args, tia, placed, now });
  // `place`: the computer in his words, for her card and her answer; `computer` stays the inner name, for the data.
  if (r && r.computer) r.place = r.place || (r.computer === LOCAL ? 'this computer' : r.computer);
  return r;
}

async function whereOf({ ops, name, args, tia, placed, now }) {
  if (!STARTS.has(name) || !Array.isArray(tia.computers) || !tia.computers.length) return null;
  const allowed = new Set([LOCAL, ...tia.computers]);
  // Every start, also a continue or a resume, is refused on a computer he did not allow: this check comes first.
  if (args.computer && !allowed.has(args.computer)) return { refuse: `the owner has not allowed you to start work on ${args.computer}`, next: SETTINGS_NEXT };
  // An earlier conversation (mode continue or resume, a conversation id) is not new work: it lives on the computer that
  // holds it, so it starts where the call says, as before (on another computer "continue" would take another one).
  // A fork goes on from a chat on the computer that holds it.
  if (args.mode === 'continue' || args.mode === 'resume' || args.conversation || args.fork_of) return null;
  if (args.computer && args.computer !== LOCAL) {
    // Named and allowed: it still must have the project, the coding tool and a provider (asked through its own gate).
    const raw = (await ops.assistantSettings().catch(() => ({}))) || {};
    const missing = await lacks(ops, args.computer, args, raw);
    const place = placeOf(await labelsOf(ops), args.computer);
    if (missing) return { refuse: `${place} (${args.computer}) cannot take it: ${missing}`, next: 'start it on this computer, or tell the owner what that computer lacks; bringing it there is his, under Computers' };
    return { computer: args.computer, place, why: `${place} was named` };
  }
  if (args.computer === LOCAL) return { computer: LOCAL, place: 'this computer', why: 'this computer was named' };
  let view = { computers: [] };
  try {
    view = (await ops.rooms()) || view;
  } catch {
    /* an older dashboard: every room unknown, so she starts here */
  }
  const seen = new Map((view.computers || []).map((c) => [c.here ? LOCAL : c.name, c]));
  // "Start new work on <name> until this computer is calm" (operator/where-hold.mjs): only that computer is offered
  // (while it is one he chose), before this one, whose room stays what it is.
  const held = view.elsewhere && typeof view.elsewhere.to === 'string' && allowed.has(view.elsewhere.to) ? view.elsewhere.to : null;
  const labels = await labelsOf(ops);
  const candidates = [...allowed].filter((n) => !held || n === LOCAL || n === held).map((n) => {
    const v = seen.get(n) || {};
    return { name: n, label: n === LOCAL ? null : (typeof v.label === 'string' && v.label) || placeOf(labels, n), here: n === LOCAL, allowed: true, held: n === LOCAL && !!held, room: v.room || 'unknown', load1: v.load1 ?? null, cpus: v.cpus ?? null, at: v.seenAt ? Date.parse(v.seenAt) : null, lacks: null };
  });
  const raw = (await ops.assistantSettings().catch(() => ({}))) || {};
  const withPlace = (r) => ({ ...r, place: r.computer === LOCAL ? 'this computer' : candidates.find((x) => x.name === r.computer)?.label || r.computer });
  // Another computer is asked what it has only when it would be chosen, and each at most once.
  for (let i = 0; i < candidates.length; i++) {
    const r = chooseWhere({ candidates, placed, now });
    if (!r.computer || r.computer === LOCAL) return r.computer ? withPlace(r) : { refuse: r.why, next: 'tell the owner where it could run' };
    const c = candidates.find((x) => x.name === r.computer);
    c.lacks = await lacks(ops, c.name, args, raw);
    if (!c.lacks) return withPlace(r);
  }
  const r = chooseWhere({ candidates, placed, now });
  return r.computer ? withPlace(r) : { refuse: r.why, next: 'tell the owner where it could run' };
}
