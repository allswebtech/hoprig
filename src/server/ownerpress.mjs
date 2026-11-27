// A press that changes what is installed on a computer (an add-on gateway's install or update, a Fix of its setup).
// It is taken from the owner's own page, or from a hub that controls this computer (the owner's page there, relayed
// with the hub's token), each with the confirmation that names this computer; or from Tia only while a card of hers
// that the owner confirmed for exactly this act runs (src/assistant/confirmed.mjs). Never from Tia on her own.

const failed = (status, message, code) => Object.assign(new Error(message), { status, details: { code } });

/**
 * Refuses unless the request may make this press. `b`: its body; `name`: this computer's name, which `confirm` must
 * be (unless `plain`: the owner's page presses without it); `card(c)`: whether a confirmed card `c` is for exactly this act; `what`: the press in words.
 */
export function ownersPress(ctx, req, b, { name, card, what, plain }) {
  const who = ctx && typeof ctx.caller === 'function' ? ctx.caller(req) : 'page';
  if (who === 'self') {
    const c = ctx && typeof ctx.ownerCard === 'function' ? ctx.ownerCard(req) : null;
    if (!c || !card(c)) throw failed(403, `${what} is the owner's own: Tia proposes it as a card that he confirms`, 'owner-only');
  }
  if (plain) return; // a start or stop: the owner's own press needs no name typed, only her card is checked
  if (!b || typeof b.confirm !== 'string' || b.confirm !== name) throw failed(400, `confirm it for this computer: send confirm with its name (${name})`, 'confirm');
}
