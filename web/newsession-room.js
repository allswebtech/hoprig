// The room of each computer where he picks one (the New session sheet, which the App's "+ New" opens too): when the chosen one is busy or full while another one has room AND can run this
// start (online, Claude Code there, a provider there), one line says so with a button that picks it. Nothing is picked
// for him. The rooms are this dashboard's own (GET ~/api/operator/rooms?look=1, src/operator/rooms.mjs).

/** The rooms view keyed as the sheet keys computers: '~' for this one, else the hub's name. */
export function roomsById(view) {
  const out = new Map();
  for (const c of (view && Array.isArray(view.computers) ? view.computers : [])) out.set(c.here ? '~' : c.name, { room: c.room, why: c.why });
  return out;
}

/**
 * The one line under the chips, or null. computers: [{ id, name, ok }] (ok: it can run this start), rooms: roomsById,
 * chosen: the chosen id. The other computer offered is this one when it has room, else the first in the list.
 */
export function roomHint({ computers, rooms, chosen }) {
  const mine = rooms.get(chosen);
  if (!mine || (mine.room !== 'busy' && mine.room !== 'full')) return null;
  const free = computers.filter((c) => c.id !== chosen && c.ok && rooms.get(c.id)?.room === 'free');
  const to = free.find((c) => c.id === '~') || free[0];
  if (!to) return null;
  const name = computers.find((c) => c.id === chosen)?.name || 'This computer';
  // The short why the rooms view holds ("It is full: its load is 1.8 per CPU."), so "full" is never read as its disk.
  const m = /^It is (?:full|busy): (.+?)\.?$/.exec(mine.why || '');
  return { text: `${name} is ${mine.room}${m ? ` (${m[1]})` : ''}: ${to.name} has room.`, to: to.id, label: `Use ${to.name}` };
}

/**
 * The hint's button: picks `id`, then puts the focus on that computer's chip. The button itself goes with the hint, and
 * the sheet would put the focus on the first chip, the computer he just left: one more key would pick it again.
 */
export function useHint(slot, id, choose) {
  choose(id);
  const chip = slot && slot.querySelector(`[data-choice="${id}"]`);
  if (chip) chip.focus();
}
