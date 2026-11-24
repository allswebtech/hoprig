// Did this request come through Tia's door? Her in-process call (ctx.dispatch, src/assistant/door.mjs), or another
// computer's dashboard relaying hers: its machine token AND the mark its relay sets for its own requests, never for a
// browser's (src/machines/index.mjs). A page, a plain token or a session cannot say it: no body field counts. Every
// route that starts a coding tool's process asks this one question, so a session she starts is hers on every path.
import { SELF_HEADER } from '../machines/relay.mjs';

/** True when `req` came through Tia's door. `ctx` is the server's feature ctx (its caller()). */
export function fromHerDoor(ctx, req) {
  const by = ctx && ctx.caller ? ctx.caller(req) : 'page';
  return by === 'self' || (by === 'computer' && !!req && !!req.headers && req.headers[SELF_HEADER] === '1');
}
