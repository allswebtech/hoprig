// The card of Tia's that the owner has just confirmed, while its act runs (core.mjs confirm). The dashboard's own
// in-process dispatch (server.mjs) puts it on the request it makes, so a route that is the owner's own (an add-on's
// install or update, a Fix of the setup) can tell "Tia, on his confirmed card for exactly this" from "Tia on her own".
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** Run `fn` as the act of the confirmed card `card` ({ id, tool, input }). */
export const runConfirmed = (card, fn) => store.run(Object.freeze({ id: card.id, tool: card.tool, input: Object.freeze({ ...card.input }) }), fn);

/** The confirmed card whose act is running now, or null (an act of Tia's own level, or no act at all). */
export const confirmedCard = () => store.getStore() || null;

/** The computer a card names, as the door names it: null for this computer. */
export const cardComputer = (c) => (c && c.input && c.input.computer && c.input.computer !== 'this' ? c.input.computer : null);

// The look that is running now (look.mjs): a read route of the catalog passes her door only inside it, so no other call of
// hers reads one. It carries nothing: a read changes nothing, and what it keeps is cut by catalog.mjs keep().
const looks = new AsyncLocalStorage();
/** Run `fn` as a read of the look tool. */
export const runAsLook = (fn) => looks.run(true, fn);
/** Whether a look is running now. */
export const lookRunning = () => looks.getStore() === true;
