// One piece of a long read at a time, across every reader of the server (src/titles.mjs, src/chat/engines/claude-pieces.mjs):
// readers that run side by side each get their next piece in the same pass of the event loop, and those pieces would
// run back to back without a break. In a turn each piece runs alone, and the thread goes back to the server after it.
// Two immediates: a piece that ran in the loop's poll phase (after a read or a child's answer) would otherwise have the
// next one run in the check phase of the same pass, back to back, before a timer or a request had its turn. The second
// one runs in the next pass, after its timers and its poll phase.
const giveBack = () => new Promise((r) => setImmediate(() => setImmediate(r)));

/** Give the thread back for a whole pass of the event loop (its timers, its reads, its requests), then go on. */
export const passBack = giveBack;

/** A queue of turns: each `fn` runs when the one before it is done, and the thread goes back to the server after it. */
function turns() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn);
    chain = run.then(giveBack, giveBack);
    return run;
  };
}

/** Run `fn` (one piece: a read and what is done with it) when the piece before it, of any reader, is done. */
export const inTurn = turns();

/**
 * Start a program (`fn` starts it and returns; its answer is awaited outside the turn) when the start before it is
 * done. Starting a program holds the thread while the system copies the server's memory map for it: 4.5 to 11 ms each
 * (median 7.6) with the server at 200-220 MB, 58 ms at 840 MB. At Home's first open with fifty open sessions, set-up's
 * look at the tools started its programs in one pass: 132 ms of a 157 ms stretch (a CPU profile). A queue
 * of its own, so a start never waits behind the long reads. Used by the checks of the dashboard (setup/system.mjs
 * capture, server/platform/common.mjs run, the tmux backend); what the owner waits for at once (typing into a terminal,
 * the editor's git and search) starts outside it.
 */
export const startInTurn = turns();
