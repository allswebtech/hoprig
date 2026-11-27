// "Allow everything" (bypassgate.mjs ALL): who may choose it, and the sentences said when a request is refused. One
// place, so the chat routes, the terminal start, Settings and the acknowledgement refuse the same way. It is chosen only
// by the owner on his own dashboard page: never by Tia's door, a token of another computer, a hook or a tool.
import { ALL, ALL_ROOT_LINE, allAllowed, bypassAllowed } from './bypassgate.mjs';

export const NOT_OWNER_LINE = 'Allow everything is chosen only by you, on this computer\'s own dashboard page: not by Tia, a token or another computer.';
export const SWITCH_OFF_LINE = 'Allow everything needs Allow bypass permissions mode: turn it on in Settings > New sessions first.';
export const UNSEEN_LINE = 'Allow everything has not been accepted on this computer yet. Choose it on your page and accept it once.';
export const HERS_LINE = 'A session Tia started never runs in Allow everything. It can run in Bypass permissions.';

/**
 * Why Allow everything may not be chosen by this request, or null. `page`: the request is the owner's own page (the caller
 * is 'page', not 'self' for Tia's door and not 'computer' for a token) and not hers (server/herdoor.mjs). `hers`: the
 * session is Tia's. Order: hers, not his page, root, the switch, the acknowledgement. → { status, message, code } | null
 */
export function allRefusal({ cfg, root, page, hers = false }) {
  if (hers) return { status: 409, message: HERS_LINE, code: 'all-hers' };
  if (page !== true) return { status: 403, message: NOT_OWNER_LINE, code: 'owner-page' };
  if (root === true) return { status: 409, message: ALL_ROOT_LINE, code: 'root-bypass' };
  if (!bypassAllowed(cfg, root)) return { status: 409, message: SWITCH_OFF_LINE, code: 'bypass-off' };
  if (!allAllowed(cfg, root)) return { status: 409, message: UNSEEN_LINE, code: 'all-unseen' };
  return null;
}

/** The refusal as the error a route throws (`HttpError` is the route context's class). */
export const allError = (HttpError, r) => Object.assign(new HttpError(r.status, r.message), { code: r.code, details: { code: r.code } });

export const isAll = (mode) => mode === ALL;
