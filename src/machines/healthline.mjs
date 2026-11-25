// Health's "Open a terminal with this line": POST /api/health/line { id, confirm }.
//
// A check of the doctor's whose fix is a line to type and that has no Fix (a password only the owner knows, a program
// that asks him in a terminal): this computer opens a NEW terminal session in the home folder and types that line
// there, WITHOUT Enter. He reads it and presses Enter himself; nothing else does (src/server/lineready.mjs marks the
// session, and every path that types for someone else refuses it).
//
//   - The page sends only the check's id. The line is this computer's own doctor's line for that id, found here again:
//     a line never comes from the request, and never crosses the link from another computer.
//   - A line with a newline, a carriage return or any other control character is refused, never typed.
//   - The owner's own page only: here, or a hub's signed-in page relayed with its mark. Tia is refused, also with a
//     confirmed card (she never puts a line in front of him to press), and so is any token without the page's mark.
//   - The body holds `id` and `confirm` (this computer's name, as a Fix's does: src/server/ownerpress.mjs), nothing else.
import os from 'node:os';
import { OWNER_PAGE_HEADER, SELF_HEADER } from './relay.mjs';
import { uniqueName } from '../server/validate.mjs';
import { ownerPageOnly } from '../workspace/whomay.mjs';

const failed = (status, message, code) => Object.assign(new Error(message), { status, details: { code } });
const KEYS = new Set(['id', 'confirm']);
const LINE_MAX = 500;
// C0, DEL and C1: a line break would run what comes before it; an Escape would act on the terminal's screen.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Throws 403 unless `req` is the owner's own page here, or the page of a hub of his (a token this computer joined or
 * marked as his hub's) relayed with its mark. Never Tia's; never a token that sets the mark itself.
 */
async function ownPageOnly(ctx, req, tokenId) {
  const no = (why) => failed(403, `A line is put in a terminal for you only from your own page${why}`, 'owner-page');
  const h = (req && req.headers) || {};
  if (/^Bearer\s+tia_/i.test(String(h.authorization || ''))) throw no(': Tia never does it');
  const by = ctx && typeof ctx.caller === 'function' ? ctx.caller(req) : 'page';
  if (by === 'page') return;
  if (by === 'self') throw no(': Tia never does it, also with a card you confirmed');
  if (by !== 'computer' || h[SELF_HEADER] === '1' || h[OWNER_PAGE_HEADER] !== '1') throw no(', not from a token or from Tia on another computer');
  // Any token holder can send the mark; it counts only from a hub of the owner's (the Workspace page's own rule).
  try {
    await ownerPageOnly(req, ctx, 'A line put in a terminal for you', { tokenId });
  } catch (e) {
    throw failed(403, e.message, 'owner-page');
  }
}

/**
 * Whether a token's terminal (/ws/term, src/server/server.mjs) may type into a session that holds such a line: only
 * the page of a hub of the owner's, relayed with its mark, the same rule as the route's. Never a script's token.
 */
export async function ownLinePage(ctx, req) {
  try {
    await ownPageOnly(ctx, req, (await import('./index.mjs')).tokenIdOf);
    return true;
  } catch {
    return false;
  }
}

/**
 * The check of `id` whose line Health offers to put in a terminal (web/health.js): not fine, a fix line that needs
 * administrator rights, and neither a Fix, a part of the page nor a page sign-in that does it. Null otherwise.
 */
export function lineCheck(list, id) {
  const c = (list || []).find((x) => x && x.id === id && x.id !== 'service');
  if (!c || !(c.status === 'fail' || c.status === 'warn') || !c.fix || c.fixId || c.where || c.action || c.admin !== true) return null;
  return c;
}

/** The route. `checks()`: this computer's checks as Health lists them (healthChecks of the doctor's). */
export function healthLineRoute(ctx, { checks, name, tokenId = null }) {
  return ['POST', /^\/api\/health\/line$/, async (req) => {
    // `tokenId(req)`: the machine token's id or null. Loaded when a request comes, not at load: ./index.mjs reaches
    // this module through hub.mjs and health.mjs.
    const idOf = tokenId || (await import('./index.mjs')).tokenIdOf;
    const b = await ctx.readJson(req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw failed(400, 'send { id, confirm }', 'body');
    const extra = Object.keys(b).find((k) => !KEYS.has(k));
    if (extra) throw failed(400, `unknown key "${extra.slice(0, 40)}": send only the check's id and confirm`, 'key');
    await ownPageOnly(ctx, req, idOf);
    if (typeof b.id !== 'string' || !b.id || b.id.length > 200) throw failed(400, 'send the check\'s id', 'id');
    const here = name();
    if (typeof b.confirm !== 'string' || b.confirm !== here) throw failed(400, `confirm it for this computer: send confirm with its name (${here})`, 'confirm');
    const c = lineCheck(await checks(), b.id);
    if (!c) throw failed(400, 'that check has no line to type here (it is fine now, or a press on the page does it)', 'no-line');
    const line = String(c.fix);
    if (CONTROL.test(line) || line.length > LINE_MAX) throw failed(400, 'that check\'s line holds a line break or another control character, so it is not typed: type it yourself', 'control');
    const taken = (await ctx.backend.list()).map((t) => t.session);
    const session = uniqueName('health-line', taken);
    const t = await ctx.deck.terminal({ name: session, dir: os.homedir(), argv: null });
    // Marked before the first byte: from now on only the owner's own page and keys type into it.
    await ctx.deck.markLineReady(t.id);
    await ctx.deck.send(t.id, line, { enter: false });
    return { session: t.name || session };
  }];
}
