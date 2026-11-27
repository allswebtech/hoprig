// Who may drop a project, change the groups of the map or push (a sync that pushes, a new brain on GitHub) from the
// Workspace page (docs/WORKSPACE.md): the owner's own page only. That is:
//   - this dashboard's page: signed in (the cookie) and, for a change, from this dashboard's own origin (the server
//     checks both before a route runs), and no bearer token at all;
//   - the page of a hub of the owner's: one this computer joined itself (`hoprig join`, a direct link: its token id
//     is in joined.json), or one that added this computer by SSH or with a pairing code (its token is marked `hub`),
//     relayed with the mark the hub sets only for its own signed-in page (relay.mjs OWNER_PAGE_HEADER), never for
//     Tia's door.
// Not Tia's door (in-process, or her mark on a relayed request), not a token another dashboard or a script got with
// `hoprig pair`, not a token without the mark. Each refusal is one plain sentence.
import { OWNER_PAGE_HEADER, SELF_HEADER } from '../machines/relay.mjs';

/** What a person is told when a drop, a group removal or the rules is tried by Tia: the step is his, on the sheet. */
export const SHEET_STEP = 'the owner\'s own step: Tia shows him the sheet on the Workspace page, she never does it';
const fail = (message) => Object.assign(new Error(message), { status: 403 });

/**
 * The token ids of the owner's hubs (read only): the hubs this computer joined itself (joined.json), and the tokens
 * made for a hub that added this computer by SSH or with a pairing code the owner made (tokens.mjs `hub`).
 */
async function joinedTokenIds() {
  const out = new Set();
  try {
    const { loadJoined } = await import('../machines/join.mjs');
    for (const h of loadJoined()) out.add(h.tokenId);
  } catch {
    /* none joined */
  }
  try {
    const { storedTokens } = await import('../machines/tokens.mjs');
    for (const t of storedTokens()) if (t.hub === true) out.add(t.id);
  } catch {
    /* no tokens */
  }
  return out;
}

/**
 * Throws 403 unless the request is the owner's own page (here, or a joined hub's, relayed). `what`: the act, in words
 * ("a drop"). `sctx`: the server's feature context (caller), `tokenId(req)`: the machine token's id or null.
 */
export async function ownerPageOnly(req, sctx, what, { tokenId = () => null, card = false } = {}) {
  const auth = String((req.headers && req.headers.authorization) || '');
  if (/^Bearer\s+tia_/i.test(auth)) throw fail(`${what} is ${SHEET_STEP}`);
  const by = sctx.caller ? sctx.caller(req) : 'page';
  // `card`: an act Tia's tool does only after the owner pressed Confirm on her card (an L2 card, e.g. a sync that
  // pushes): her door passes, here or through a hub this computer joined. A drop, a group or the rules: never.
  if (by === 'self') {
    if (card) return 'card';
    throw fail(`${what} is ${SHEET_STEP}`);
  }
  if (by === 'page') return 'page';
  // Another dashboard's token: only a hub this computer joined, and only for its own signed-in page.
  if (req.headers[SELF_HEADER] === '1' && !card) throw fail(`${what} is ${SHEET_STEP}`);
  const id = tokenId(req);
  // A hub that added this computer before tokens had the mark (or that runs an older Hoprig) holds a plain token: the
  // refusal names the one step that makes it count, on this computer's own page.
  if (!id || !(await joinedTokenIds()).has(id)) throw fail(`${what} comes only from your own page: on this computer's dashboard, or through a main computer of yours (one this computer joined, or that added it). If a main computer of yours added this computer, mark it as your main computer on this computer's own page: Computers, Add a computer, Advanced, Who may control this computer`);
  // A hub of the owner's whose request has neither mark: its relay does not set the page's mark yet (Hoprig 0.3.3 and
  // older set none). Marking its token does not help; the one step that does is updating Hoprig there.
  if (req.headers[OWNER_PAGE_HEADER] !== '1' && !(card && req.headers[SELF_HEADER] === '1')) throw fail(`${what} comes only from your own page, and this main computer did not say it is its page: the main computer's Hoprig is older than this computer's. Update Hoprig on the main computer, then press again`);
  return 'hub';
}
