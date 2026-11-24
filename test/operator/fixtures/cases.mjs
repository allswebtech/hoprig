// Recorded cases for the detectors, written with made-up names. Each one is a piece of the board (board.mjs)
// as it looked when the thing happened. NOW is the moment of the look.

export const NOW = Date.parse('2026-03-10T14:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
export { ago };

const session = (over) => ({
  name: 'alpha', tool: 'claude', provider: 'plan-a', state: 'working', statusAt: ago(1), startedAt: ago(90), progressAt: ago(1),
  limit: null, asks: [], askType: null, askAt: null, toolNow: null, agents: [], canSwitch: true, nextProvider: 'plan-b', ...over,
});
export { session };

// An agent of a workflow stopped by a weekly limit while the session itself went on waiting for it.
export const agentWeeklyLimit = {
  sessions: [session({ name: 'lane-build', state: 'working', agents: [{ id: 'a1b2c3', state: 'working', limit: { at: ago(35), text: "You've hit your weekly limit · resets Mar 12, 9am", resetsAt: '2026-03-12T09:00:00Z' } }] })],
};

// The whole session stopped at its five-hour limit, and no other provider is set up.
export const sessionLimitNoNext = {
  sessions: [session({ name: 'shop-fix', state: 'waiting', canSwitch: false, nextProvider: null, limit: { at: ago(12), text: 'Usage limit reached', resetsAt: null } })],
};

// A loop that waits for its own search and can never end: one shell call running for 40 minutes, nothing else.
export const neverEndingWait = {
  sessions: [session({ name: 'fixer', state: 'working', progressAt: ago(40), toolNow: { name: 'Bash', since: ago(40) } })],
};

// An agent that stopped on its first command for an OK nobody gave, 52 minutes long.
export const agentUnansweredOk = {
  sessions: [session({ name: 'review', state: 'attention', asks: ['f00d1e'], askType: 'permission', askAt: ago(52), progressAt: ago(52) })],
};

// A session that asks the owner a question.
export const mainQuestion = {
  sessions: [session({ name: 'plans', state: 'attention', asks: ['main'], askType: 'question', askAt: ago(4) })],
};

// Everything fine: one session working with fresh progress, one waiting for the next prompt.
export const calm = {
  sessions: [session({ name: 'alpha' }), session({ name: 'beta', state: 'waiting', progressAt: ago(30) })],
};

// What nobody can explain (detect/unknown.mjs). A Work run that failed with a reason no check knows: a test of the
// project broke in a way the session's words do not name.
const run = (over) => ({ id: '20260310-133000-a1b2c3d4', item: 'fix-cart', by: 'owner', title: 'Fix the cart total', state: 'failed', endedAt: ago(30), reason: 'The run ended in an error: TypeError: Cannot read properties of undefined (reading \'qty\')', project: 'shop', ...over });
export { run };
export const failedOddReason = { work: { runs: [run()], checks: [] } };
// The same task's runs ended in an error twice (the second after the owner sent it back).
export const failedTwice = { work: { runs: [
  run({ id: '20260310-134000-0000beef', endedAt: ago(20), reason: 'The run ended in an error: exit code 1' }),
  run({ id: '20260310-120000-0000cafe', endedAt: ago(120), reason: 'The run ended in an error: exit code 1' }),
], checks: [] } };
// Failures another detector or the product explains already: a limit, a sign-in, the time limit, a refused step.
export const failedKnown = { work: { runs: [
  run({ id: '20260310-131000-00000001', item: 'a', reason: 'The provider reached its usage limit' }),
  run({ id: '20260310-131000-00000002', item: 'b', reason: 'The run ended in an error: API Error: 401 please sign in again' }),
  run({ id: '20260310-131000-00000003', item: 'c', state: 'stopped', reason: 'Stopped at the time limit (30 minutes)' }),
  run({ id: '20260310-131000-00000004', item: 'd', reason: 'The run did not start: the Claude Code on this computer does not know the restricted mode' }),
  run({ id: '20260310-131000-00000005', item: 'e', by: 'look', reason: 'odd' }),
], checks: [] } };
// A mission's check that says after the fix what it said before it.
export const checkSameAfterFix = { work: { runs: [], checks: [{ mission: 'm-20260310-abc123', task: 'cart-total', title: 'Cart total', project: 'shop', words: ['npm test failed: cart.test.mjs total is 0'], at: ago(10), run: '20260310-135000-0000f00d' }] } };
